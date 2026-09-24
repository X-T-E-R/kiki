// src/compaction.ts
//
// WAL compaction (a.k.a. snapshot + rewrite).
//
// This is a NON-BLOCKING variant, modelled on Redis's BGREWRITEAOF and
// Bitcask's merge: while the (potentially large) snapshot is being written,
// writers keep appending to the live WAL — the WAL itself acts as the
// "rewrite buffer". Writes are blocked only for the *rotation* critical
// section at the very end (a flush + a bounded tail copy + two renames).
//
// Phases:
//   1. fence        — flush the WAL, record baseOffset = wal.size. Every write
//                     durable at/before baseOffset is already reflected in the
//                     store (applyOp runs synchronously before the WAL write is
//                     awaited).
//   2. snapshot     — writeSnapshot(store, tmp). NON-BLOCKING. Writers keep
//                     appending to the WAL and mutating the store while we
//                     iterate. The snapshot need NOT be point-in-time: the WAL
//                     tail copied below is replayed last-writer-wins on top of
//                     it, repairing any fuzziness.
//   2.5 pre-copy    — stream WAL[baseOffset .. head] into db.wal.tmp, draining
//                     the bulk of the post-fence tail. NON-BLOCKING. Loops while
//                     the copy is CONVERGING (the remaining delta shrinks fast
//                     enough) and gives up after a few passes otherwise —
//                     chasing a tail under writes that append as fast as the
//                     copy drains would otherwise never terminate, stalling
//                     compaction for as long as the write storm lasts.
//   3. rotation     — BLOCKING critical section: set _rotateLock so new writers
//                     park, seal the old WAL (post-seal appends fail fast and
//                     are retried by the op against the new WAL), flush, then
//                     copy the remaining tail. With the WAL sealed and writers
//                     parked the head no longer moves, so this copy provably
//                     finishes; the pause scales with the tail the pre-copy did
//                     not drain — the same bounded end-of-rewrite pause Redis
//                     accepts for its AOF diff flush.
//   4. bookkeeping  — stats + awaiting onCompacted() (stage 5: build and
//                     publish the new index generation — store image, index
//                     images, text postings — as one transaction with the
//                     rotated snapshot/WAL; legacy mode rebuilds derived text
//                     postings instead).
//
// Crash safety: recovery is `load db.snapshot` + `replay db.wal`, last-writer
// wins. We rename the snapshot BEFORE the WAL. If a crash lands between the two
// renames, the new snapshot is paired with the old full WAL — replaying the
// whole old WAL on top of the new snapshot is idempotent for pre-fence frames
// and correct for post-fence frames, so the state is still consistent. The
// reverse order (WAL first) would pair an old snapshot with a truncated new WAL
// and lose pre-fence data. The argument only holds when each rename is durable
// before the next one lands, so the rotation's directory fsyncs are STRICT: a
// failed dir fsync aborts the rotation (rolling back through the catch in
// runCompaction) rather than silently weakening the invariant. Platforms that
// cannot fsync a directory degrade explicitly instead — a one-time warning and
// stats.dirFsyncUnsupported = true.

import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { WAL } from './wal.js';
import { renameReplace, withWindowsEpermRetry } from './rename-replace.js';
import { writeSnapshot } from './snapshot.js';
import type { Store, ValueLoc } from './store.js';
import type { FsyncPolicy, WalStats } from './wal.js';

/** Structural interface of the bits compaction needs from a MiniDb. */
export interface CompactionTarget {
  dir: string;
  walPath: string;
  fsyncPolicy: FsyncPolicy;
  /** Background-sync interval the replacement WALs inherit (see WALOptions). */
  syncIntervalMs?: number;
  store: Store;
  valueMode: 'memory' | 'disk';
  wal: WAL;
  compactThresholdBytes: number;
  compactWalRatio: number;
  compactMinWalBytes: number;
  compacting: boolean;
  _compactDone: Promise<void> | null;
  /** Set only during the short rotation critical section; writers park on it.
   *  Null outside rotation, so the snapshot phase is fully non-blocking. */
  _rotateLock: Promise<void> | null;
  lastCompactError: unknown;
  stats: WalStats & {
    compactions: number;
    snapshotBytesWritten: number;
    compactErrors?: number;
    /** Cumulative phase timings (wall-clock ms). Optional so structural test
     *  doubles need not carry them; MiniDb always provides them. */
    compactionDurationMs?: number;
    compactionSnapshotDurationMs?: number;
    compactionRotationDurationMs?: number;
    /** Set (once) when a directory fsync reported EINVAL/ENOTSUP: this
     *  platform cannot make renames durable via the directory, so rotation
     *  durability is knowingly degraded (warned once) rather than aborted. */
    dirFsyncUnsupported?: boolean;
  };
  /** Reader for disk-backed values. On Windows each destination handle is
   *  released only for its own rename and reattached before the next await;
   *  remapped pointers always match the newly attached file. */
  valueReader?: {
    closeSnapshot(): void;
    closeWal(): void;
    reopenSnapshot(): void;
    reopenWal(): void;
    reopenBoth(): void;
    readAsync?(loc: ValueLoc): Promise<Buffer>;
  };
  /** Optional hook invoked (and awaited) after the snapshot + WAL rotation
   *  succeeds, so the owner can publish derived on-disk state (stage 5's
   *  index generation; legacy mode: text postings) against the new live set. */
  onCompacted?: () => void | Promise<void>;
  /** Stage 6 maintenance integration: the rotation critical section is the
   *  compaction's "publishing" phase — the scheduler WAITS for it on
   *  shutdown instead of cancelling mid-rotation. Called with 'publishing'
   *  as the rotation starts and 'running' as it ends (both in the failure
   *  path and the success path). */
  onMaintenancePhase?: (phase: 'running' | 'publishing') => void;
}

export function shouldCompact(db: CompactionTarget): boolean {
  if (!db.wal) return false;
  if (db.wal.size >= db.compactThresholdBytes) return true;
  if (db.valueMode !== 'memory' || db.wal.size < db.compactMinWalBytes) return false;
  return db.wal.size >= Math.max(1, db.store.bytes) * db.compactWalRatio;
}

const COPY_CHUNK = 1 << 20; // 1 MiB read/write coalescing
// A post-fence WAL delta at or below this size is cheap enough to copy inside
// the rotation critical section, so the pre-copy loop stops draining.
const SMALL_DELTA = 64 * 1024; // 64 KiB

// Windows cannot rename over an open destination; rotation uses the shared
// retrying replace helper (see rename-replace.ts).
const rotateReplace = (src: string, dst: string): Promise<void> => renameReplace(src, dst);
// Pre-copy convergence bounds: each pass costs roughly `gap / copyRate` and
// appends `gap * (appendRate / copyRate)` new bytes during the copy. Give up
// when a pass fails to shrink the gap meaningfully (appendRate ≳ copyRate),
// or after this many passes regardless — the rotation critical section (with
// the WAL sealed and writers parked) then absorbs the remaining tail.
const MAX_PRECOPY_PASSES = 5;
const CONVERGE_RATIO = 0.7;

export function isUnsupportedDirectoryFsyncError(
  code: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return code === 'EINVAL' || code === 'ENOTSUP' || (platform === 'win32' && code === 'EPERM');
}

export async function fsyncDir(
  dir: string,
  opts: { strict?: boolean; stats?: { dirFsyncUnsupported?: boolean } } = {},
): Promise<void> {
  let fh: FileHandle | null = null;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Some platforms cannot fsync a directory at all. That is a permanent
    // environment property, not a rotation fault: mark the degraded durability
    // state and continue without directory fsync in both modes.
    if (isUnsupportedDirectoryFsyncError(code)) {
      if (opts.stats) opts.stats.dirFsyncUnsupported = true;
      return;
    }
    // Strict mode (the rotation path): a failed directory fsync breaks the
    // rename-durability invariant, so the caller must abort — never swallow.
    if (opts.strict) throw e;
    /* best-effort otherwise */
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/** Stream src[start:end] into dst, fsync'ing dst before returning. With
 *  `append: true` the bytes are appended to an existing dst; otherwise dst is
 *  created/truncated. Uses its own file handles, independent of the WAL's
 *  append handle, so it is safe to read the live WAL while writers append. A
 *  zero-length range still creates/truncates dst (so the new WAL file exists
 *  even when there is no post-fence tail). */
export async function copyFileRange(
  srcPath: string,
  dstPath: string,
  start: number,
  end: number,
  opts: { append?: boolean } = {},
): Promise<void> {
  if (end < start) throw new RangeError(`copyFileRange: end (${end}) < start (${start})`);
  const dst = await fs.open(dstPath, opts.append ? 'a' : 'w');
  try {
    if (end > start) {
      const src = await fs.open(srcPath, 'r');
      try {
        const buf = Buffer.allocUnsafe(COPY_CHUNK);
        let pos = start;
        while (pos < end) {
          const len = Math.min(buf.length, end - pos);
          const { bytesRead } = await src.read(buf, 0, len, pos);
          if (bytesRead === 0) break; // reached EOF earlier than expected
          let written = 0;
          while (written < bytesRead) {
            const { bytesWritten } = await dst.write(buf, written, bytesRead - written);
            if (bytesWritten === 0) throw new Error('copyFileRange: write made no progress (short write)');
            written += bytesWritten;
          }
          pos += bytesRead;
        }
      } finally {
        await src.close().catch(() => {});
      }
    }
    await dst.sync();
  } finally {
    await dst.close().catch(() => {});
  }
}

export async function compact(db: CompactionTarget): Promise<void> {
  if (db.compacting) return db._compactDone ?? undefined;

  db.compacting = true;
  db._compactDone = (async () => {
    const t0 = performance.now();
    try {
      await runCompaction(db);
      // The onCompacted hook is part of the compaction: a run whose hook
      // throws is counted as a compactError, not a successful compaction.
      await db.onCompacted?.();
      db.stats.compactions++;
      db.stats.compactionDurationMs = (db.stats.compactionDurationMs ?? 0) + (performance.now() - t0);
      db.lastCompactError = null;
    } catch (err) {
      db.stats.compactErrors = (db.stats.compactErrors ?? 0) + 1;
      db.lastCompactError = err;
      throw err;
    } finally {
      db.compacting = false;
      // A failed rotation must not leave writers parked forever.
      db._rotateLock = null;
    }
  })();
  return db._compactDone;
}

async function runCompaction(db: CompactionTarget): Promise<void> {
  const tmp = path.join(db.dir, 'db.snapshot.tmp');
  const snap = path.join(db.dir, 'db.snapshot');
  const walTmp = path.join(db.dir, 'db.wal.tmp');

  // Phase 1: fence. Every write durable at/before baseOffset is already
  // reflected in the store, because applyOp() runs synchronously in the same
  // tick as wal.append(), before the op awaits the WAL write.
  await db.wal.flush();
  const baseOffset = db.wal.size;

  // Phase 2: snapshot. NON-BLOCKING — writers keep appending to the WAL and
  // mutating the store while we iterate. Fuzziness is repaired by the tail.
  // Stage 6: in disk valueMode the snapshot's value reads run through the
  // async grouped reader (bounded concurrency, slice budget) instead of one
  // synchronous positioned read per record on the event loop.
  const snapT0 = performance.now();
  const snapRes = await writeSnapshot(db.store, tmp, {
    readValueAsync: db.valueReader?.readAsync ? (loc) => db.valueReader!.readAsync!(loc) : undefined,
  });
  db.stats.snapshotBytesWritten += snapRes.bytes;
  db.stats.compactionSnapshotDurationMs = (db.stats.compactionSnapshotDurationMs ?? 0) + (performance.now() - snapT0);

  // Phase 2.5: pre-copy the post-fence WAL tail into db.wal.tmp. NON-BLOCKING.
  // Each pass flushes to get a stable `head`, then copies the bytes that landed
  // since the previous pass. The loop only continues while it is CONVERGING:
  // under sustained writes whose append rate approaches the copy rate the gap
  // stops shrinking, and looping until it was small enough would never
  // terminate (stalling compaction for the whole write storm — observed in the
  // field as compactions=0 forever while the WAL grew unboundedly). Give up to
  // the rotation critical section instead, which finishes because the sealed
  // WAL + parked writers freeze the head.
  let copiedUpTo = baseOffset;
  let appended = false;
  let prevGap = Number.POSITIVE_INFINITY;
  for (let pass = 0; pass < MAX_PRECOPY_PASSES; pass++) {
    await db.wal.flush();
    const head = db.wal.size;
    const gap = head - copiedUpTo;
    if (gap <= SMALL_DELTA) break;
    if (pass > 0 && gap > prevGap * CONVERGE_RATIO) break; // not converging: rotate with a parked writer set
    await copyFileRange(db.walPath, walTmp, copiedUpTo, head, { append: appended });
    appended = true;
    copiedUpTo = head;
    prevGap = gap;
  }

  // Phase 3: rotation. BLOCKING critical section.
  //
  // Setting _rotateLock is synchronous and happens-before the seal below. New
  // writers park on the lock; an in-flight writer that passed the gate check
  // just before the lock landed cannot have its append slip between the final
  // flush and close(), because seal() makes any post-seal append fail fast
  // (the op retries against the new WAL once the rotation is done). With the
  // old WAL sealed, its head no longer moves after this drain loop, so the
  // loop provably terminates — at the cost of a write pause proportional to
  // the tail the pre-copy could not drain.
  //
  // Recovery: the seal is one-way and the old WAL object is single-use, so a
  // failure anywhere between the seal and the new WAL's open would leave every
  // later write hitting WAL_SEALED/'WAL is closed' forever. The catch below
  // rolls the db forward to a writable state by swapping in a FRESH WAL on
  // db.walPath (it appends at the real EOF of whatever file the path now
  // holds). A snapshot-only rename also needs its pointers remapped before a
  // reader can reopen the new snapshot; the old full WAL offsets stay intact.
  // Past the WAL rename, both files and their pointers switch together. If
  // WAL recovery itself fails (e.g. persistent EMFILE), the next process open
  // can still recover the consistent on-disk snapshot/WAL pair.
  let releaseRotation!: () => void;
  db._rotateLock = new Promise<void>((resolve) => {
    releaseRotation = resolve;
  });
  const rotateT0 = performance.now();
  // Stage 6: from here to the remap/reader reopen, a shutdown must wait for
  // the rotation rather than cancelling it mid-flight.
  db.onMaintenancePhase?.('publishing');
  const windowsReader = process.platform === 'win32' ? db.valueReader : undefined;
  let snapshotRotated = false;
  let snapshotRemapped = false;
  let rotated = false;
  let remapped = false;
  const remapSnapshot = (): void => {
    if (snapshotRemapped) return;
    db.store.remapLocs((k: string, loc: ValueLoc) =>
      loc.file === 'wal' && loc.off >= baseOffset ? undefined : snapRes.locs.get(k));
    snapshotRemapped = true;
  };
  // The WAL-offset shift is NOT idempotent; never apply it twice on recovery.
  const remap = (): void => {
    if (remapped) return;
    db.store.remapLocs((k: string, loc: ValueLoc) => {
      if (loc.file === 'wal' && loc.off >= baseOffset) {
        return { file: 'wal', off: loc.off - baseOffset, len: loc.len };
      }
      return snapRes.locs.get(k);
    });
    remapped = true;
  };
  try {
    db.wal.seal();
    for (;;) {
      await db.wal.flush();
      const endOffset = db.wal.size;
      // `!appended` guarantees the (possibly empty) new WAL file is created
      // even when there is no post-fence tail to copy.
      if (endOffset === copiedUpTo && appended) break;
      await copyFileRange(db.walPath, walTmp, copiedUpTo, endOffset, { append: appended });
      appended = true;
      copiedUpTo = endOffset;
    }

    await db.wal.close();

    // Snapshot first, then WAL — see the crash-safety note in the file header.
    // On Windows release ONLY the destination reader for each rename attempt;
    // an EPERM retry reopens it before sleeping. The WAL reader stays attached
    // across the snapshot rename and strict directory fsync, including failures.
    if (windowsReader) {
      await withWindowsEpermRetry(async () => {
        windowsReader.closeSnapshot();
        try {
          await fs.rename(tmp, snap);
        } catch (err) {
          windowsReader.reopenSnapshot();
          throw err;
        }
      });
    } else {
      await rotateReplace(tmp, snap);
    }
    snapshotRotated = true;
    if (windowsReader) {
      remapSnapshot();
      windowsReader.reopenSnapshot();
    }
    // Directory fsyncs are strict: a real failure aborts this rotation.
    await fsyncDir(db.dir, { strict: true, stats: db.stats });

    if (windowsReader) {
      await withWindowsEpermRetry(async () => {
        windowsReader.closeWal();
        try {
          await fs.rename(walTmp, db.walPath);
        } catch (err) {
          windowsReader.reopenWal();
          throw err;
        }
      });
    } else {
      await rotateReplace(walTmp, db.walPath);
    }
    rotated = true;
    // Pair the new offsets and reader fds in the same synchronous segment,
    // before the next await (fsync / fresh WAL open). No long-lived closed WAL
    // handle remains in the rotation's asynchronous windows.
    remap();
    db.valueReader?.reopenBoth();
    await fsyncDir(db.dir, { strict: true, stats: db.stats });

    const fresh = new WAL(db.walPath, { fsyncPolicy: db.fsyncPolicy, syncIntervalMs: db.syncIntervalMs, stats: db.stats });
    db.wal = fresh;
    await fresh.open();
  } catch (err) {
    // Repair the reader before any asynchronous WAL recovery. A failure before
    // the WAL rename keeps old WAL offsets but may already have replaced the
    // snapshot. Reopen each side independently, even if the other side fails.
    try {
      if (rotated) remap();
      else if (snapshotRotated) remapSnapshot();
    } catch { /* best-effort recovery */ }
    try { db.valueReader?.reopenSnapshot(); } catch { /* best-effort recovery */ }
    try { db.valueReader?.reopenWal(); } catch { /* best-effort recovery */ }
    try {
      // Swap the sealed/closed WAL for a fresh append handle at the real EOF.
      await db.wal.close().catch(() => {});
      const fresh = new WAL(db.walPath, { fsyncPolicy: db.fsyncPolicy, syncIntervalMs: db.syncIntervalMs, stats: db.stats });
      await fresh.open();
      db.wal = fresh;
    } catch {
      // Best-effort recovery only — on-disk state is consistent regardless.
    }
    throw err;
  } finally {
    releaseRotation();
    db._rotateLock = null;
    db.onMaintenancePhase?.('running');
    // Wall time of the rotation critical section — the window writers were
    // parked (their per-op waits accumulate separately in MiniDb's
    // compactionRotationPauseMs).
    db.stats.compactionRotationDurationMs = (db.stats.compactionRotationDurationMs ?? 0) + (performance.now() - rotateT0);
  }
}
