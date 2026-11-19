// test/wal.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';
import { WAL } from '../src/wal.js';
import { encodeFrame, FrameParser, CorruptFrameError, TYPE_SET, TYPE_DEL } from '../src/codec.js';
import { barrier, waitFor } from './helpers.js';

const B = (s) => Buffer.from(s);

/** Drive one everysec background-sync tick deterministically (review #28):
 *  tests open the WAL with a huge syncIntervalMs so the real timer never
 *  fires, then call the extracted tick directly instead of racing sleeps
 *  against a 25ms interval. Returns the tick's settle promise (null when the
 *  tick was skipped — clean WAL / stacked / closed gate). */
const tick = (wal) => wal.backgroundTick();

function freshStats() {
  return {
    walBytesWritten: 0,
    walFsyncs: 0,
    walWriteErrors: 0,
    walFsyncErrors: 0,
    lastWalFsyncError: null,
    walQueuedBytes: 0,
    walMaxQueuedBytes: 0,
    walGroupCommits: 0,
    walGroupCommitFrames: 0,
  };
}

async function tmpWalPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-wal-'));
  return { dir, file: path.join(dir, 'db.wal') };
}

function parseAll(buf) {
  return [...new FrameParser().feed(buf)];
}

test('append then read back preserves frames and order', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'everysec' });
    await wal.open();
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('a'), value: B('1') }));
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('b'), value: B('2') }));
    await wal.append(encodeFrame({ type: TYPE_DEL, key: B('a') }));
    await wal.close();

    const frames = parseAll(await fs.readFile(file));
    assert.equal(frames.length, 3);
    assert.equal(frames[0].key.toString(), 'a');
    assert.equal(frames[1].key.toString(), 'b');
    assert.equal(frames[2].type, TYPE_DEL);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('group commit: many concurrent appends all land in order', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'no' });
    await wal.open();
    const N = 1000;
    const ops = [];
    for (let i = 0; i < N; i++) {
      ops.push(wal.append(encodeFrame({ type: TYPE_SET, key: B(`k${i}`), value: B(`${i}`) })));
    }
    await Promise.all(ops);
    await wal.close();

    const frames = parseAll(await fs.readFile(file));
    assert.equal(frames.length, N);
    // Spot-check ordering.
    assert.equal(frames[0].key.toString(), 'k0');
    assert.equal(frames[N - 1].key.toString(), `k${N - 1}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test("fsyncPolicy 'always' works", async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'always' });
    await wal.open();
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('durable'), value: B('yes') }));
    await wal.close();
    const frames = parseAll(await fs.readFile(file));
    assert.equal(frames[0].key.toString(), 'durable');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('recovery truncates a torn/corrupt tail at the error offset', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'no' });
    await wal.open();
    const N = 50;
    for (let i = 0; i < N; i++) {
      await wal.append(encodeFrame({ type: TYPE_SET, key: B(`key${i}`), value: B('v') }));
    }
    await wal.close();

    const validSize = (await fs.stat(file)).size;
    // Simulate a crash that left a half-written frame at the end.
    const partial = encodeFrame({ type: TYPE_SET, key: B('torn'), value: B('x'.repeat(100)) }).subarray(0, 13);
    await fs.appendFile(file, partial);

    const buf = await fs.readFile(file);
    const parser = new FrameParser();
    const frames = [];
    let err = null;
    try {
      for (const f of parser.feed(buf)) frames.push(f);
      parser.finish();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof CorruptFrameError, 'expected a corrupt-frame error');
    assert.equal(err.offset, validSize, 'error offset should equal end of valid data');
    assert.equal(frames.length, N, 'all valid frames before the tail are recovered');

    // Truncate at the error offset and verify the file is clean again.
    await fs.truncate(file, err.offset);
    const after = parseAll(await fs.readFile(file));
    assert.equal(after.length, N);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('seal(): rejects new appends with WAL_SEALED, queued frames stay flushable', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'no' });
    await wal.open();
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('a'), value: B('1') }));
    wal.seal();
    wal.seal(); // idempotent
    await assert.rejects(wal.append(encodeFrame({ type: TYPE_SET, key: B('b'), value: B('2') })), (err) => {
      assert.equal(err.code, 'WAL_SEALED');
      return true;
    });
    await wal.close(); // flushes the pre-seal frame
    const frames = parseAll(await fs.readFile(file));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].key.toString(), 'a');
    // after close the legacy "WAL is closed" rejection is preserved
    await assert.rejects(wal.append(encodeFrame({ type: TYPE_SET, key: B('c'), value: B('3') })), /WAL is closed/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test("everysec: idle WAL performs zero background fsyncs; only dirty intervals sync", async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const stats = freshStats();
    // Huge interval: the real timer never fires during the test — every tick
    // below is driven explicitly (see `tick`), so the fsync counts are exact
    // by construction, not by sleeping past a 25ms interval (review #28).
    const wal = new WAL(file, { fsyncPolicy: 'everysec', syncIntervalMs: 3_600_000, stats });
    await wal.open();

    // Idle ticks are skipped without an fsync.
    assert.equal(await tick(wal), null, 'an idle tick is skipped');
    assert.equal(await tick(wal), null);
    assert.equal(stats.walFsyncs, 0, 'idle everysec WAL must not fsync');

    // A write dirties the WAL: exactly one background fsync, then quiet again.
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('k'), value: B('v') }));
    await tick(wal);
    assert.equal(stats.walFsyncs, 1, 'one background fsync per dirty window');
    assert.equal(await tick(wal), null, 'clean again: the next tick is skipped');
    assert.equal(stats.walFsyncs, 1, 'fsync count does not grow once synced');

    // Another write: one more fsync, no burst.
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('k2'), value: B('v2') }));
    await tick(wal);
    assert.equal(stats.walFsyncs, 2);

    // close() keeps its unconditional final sync even though the WAL is clean.
    await wal.close();
    assert.equal(stats.walFsyncs, 3, 'close() always performs the final sync');
    assert.equal(stats.walFsyncErrors, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('close() performs a final fsync even when there were no writes at all', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const stats = freshStats();
    const wal = new WAL(file, { fsyncPolicy: 'everysec', syncIntervalMs: 25, stats });
    await wal.open();
    await wal.close();
    assert.equal(stats.walFsyncs, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('background sync failure is recorded but neither rejects writes nor clears dirty', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const stats = freshStats();
    // Explicitly driven ticks again (see `tick`): the failure and the retry
    // land exactly where the test puts them, no sleep windows (review #28).
    const wal = new WAL(file, { fsyncPolicy: 'everysec', syncIntervalMs: 3_600_000, stats });
    await wal.open();

    const fh = wal.fh;
    const orig = fh.sync.bind(fh);
    const boom = new Error('injected fsync failure');
    fh.sync = () => Promise.reject(boom);

    // Writes are acknowledged from the page cache: the failing background
    // fsync never rejects them.
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('k'), value: B('v') }));
    await tick(wal);
    assert.equal(stats.walFsyncErrors, 1, 'the failing tick records exactly one error');
    assert.equal(stats.lastWalFsyncError, boom, 'sticky error is observable');
    assert.equal(stats.walFsyncs, 0, 'no successful fsync meanwhile');

    // A failed sync must not clear the dirty mark: once the failure goes away
    // the next tick retries and the WAL converges to synced.
    fh.sync = orig;
    await tick(wal);
    assert.equal(stats.walFsyncs, 1, 'sync retried after the failure');
    assert.equal(stats.lastWalFsyncError, boom, 'sticky error is not cleared by a later success');
    assert.equal(wal.poison, null, 'a background sync failure must never poison the WAL');

    // Clean again: no more background fsyncs.
    assert.equal(await tick(wal), null, 'synced: the next tick is skipped');
    assert.equal(stats.walFsyncs, 1);
    await wal.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('close() waits for an in-flight background sync before closing the fd (review #13)', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const stats = freshStats();
    const wal = new WAL(file, { fsyncPolicy: 'everysec', syncIntervalMs: 3_600_000, stats });
    await wal.open();
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('k'), value: B('v') }));

    // Park the background sync inside fh.sync, then start close(): it must
    // drain the tracker instead of closing the fd under the flying sync.
    const fh = wal.fh;
    const gate = barrier(fh, 'sync', 1);
    const events: string[] = [];
    const origClose = fh.close.bind(fh);
    fh.close = async () => {
      events.push('fd-close');
      await origClose();
    };

    const bg = tick(wal);
    void bg!.then(() => events.push('bg-sync-settled'));
    await gate.entered; // the background sync is provably in flight

    const closing = wal.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    // close()'s only path to resolution goes through the parked tracker
    // drain, so no amount of yielding can settle it here.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(closed, false, 'close() must wait for the in-flight background sync');

    gate.release();
    await bg;
    await closing;
    assert.deepEqual(events, ['bg-sync-settled', 'fd-close'], 'the fd closes only after the background sync settled');
    assert.equal(stats.walFsyncs, 2, 'the background sync plus close() final sync');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('queue depth and group-commit counters track the append buffer', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const stats = freshStats();
    const wal = new WAL(file, { fsyncPolicy: 'no', stats });
    await wal.open();

    // Sequential appends: each lands in its own group commit.
    for (let i = 0; i < 5; i++) {
      await wal.append(encodeFrame({ type: TYPE_SET, key: B(`s${i}`), value: B('v') }));
    }
    assert.equal(stats.walGroupCommits, 5);
    assert.equal(stats.walGroupCommitFrames, 5);
    assert.equal(stats.walQueuedBytes, 0, 'queue drains after each flush');

    // Concurrent appends coalesce: fewer commits than frames.
    const N = 200;
    const ops = [];
    for (let i = 0; i < N; i++) {
      ops.push(wal.append(encodeFrame({ type: TYPE_SET, key: B(`c${i}`), value: B('v') })));
    }
    await Promise.all(ops);
    assert.equal(stats.walGroupCommitFrames, 5 + N);
    assert.ok(stats.walGroupCommits < 5 + N, `expected coalescing, got ${stats.walGroupCommits} commits`);
    assert.ok(stats.walMaxQueuedBytes > 0, 'high-water mark recorded the burst');
    assert.equal(stats.walQueuedBytes, 0);
    await wal.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('appendLoc stamps frames with the id of the flush batch carrying them', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'no' });
    await wal.open();
    const a = wal.appendLoc(encodeFrame({ type: TYPE_SET, key: B('a'), value: B('1') }));
    const b = wal.appendLoc(encodeFrame({ type: TYPE_SET, key: B('b'), value: B('2') }));
    assert.equal(a.batchId, b.batchId, 'same-tick appends share the next batch id');
    assert.ok(a.batchId > 0);
    await Promise.all([a.done, b.done]);
    const c = wal.appendLoc(encodeFrame({ type: TYPE_SET, key: B('c'), value: B('3') }));
    assert.ok(c.batchId > a.batchId, 'the id advances once a batch drained');
    await c.done;
    await wal.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('a failed flush poisons the WAL: WAL_POISONED rejections until truncate + refreshSize + clearPoison', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const stats = freshStats();
    const wal = new WAL(file, { fsyncPolicy: 'no', stats });
    await wal.open();
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('ok'), value: B('1') }));

    const fh = (wal as unknown as { fh: { writev: (...a: unknown[]) => Promise<unknown> } }).fh;
    const orig = fh.writev.bind(fh);
    // The first writev of the failing batch parks until a second frame is
    // queued behind it, then fails: the batch frame and the queued frame must
    // see different rejections.
    let releaseWritev!: () => void;
    const writevGate = new Promise<void>((r) => (releaseWritev = r));
    let calls = 0;
    fh.writev = async (...a: unknown[]) => {
      calls++;
      if (calls === 1) {
        await writevGate;
        throw new Error('injected writev failure');
      }
      return orig(...a);
    };

    const batchFrame = wal.append(encodeFrame({ type: TYPE_SET, key: B('bad'), value: B('x') }));
    await waitFor(() => calls === 1, 'the failing writev to be in flight');
    const queuedFrame = wal.append(encodeFrame({ type: TYPE_SET, key: B('queued'), value: B('y') }));
    releaseWritev();

    const order: string[] = [];
    await Promise.all([
      batchFrame.catch((e) => { order.push('batch'); throw e; }),
      queuedFrame.catch((e) => { order.push('queued'); throw e; }),
    ]).then(
      () => { throw new Error('expected both frames to reject'); },
      () => {},
    );
    assert.deepEqual(order, ['queued', 'batch'], 'queued frames reject first so group rollbacks unwind newest-first');
    assert.equal(stats.walWriteErrors, 1, 'writev-class failure counted');
    assert.equal(stats.walFsyncErrors, 0, 'not an fsync-class failure');

    const poison = wal.poison;
    assert.ok(poison, 'WAL is poisoned');
    assert.match(String(poison.error), /injected writev failure/);

    // While poisoned: appends reject WAL_POISONED (distinct from WAL_SEALED),
    // flush() throws, sync() is a silent no-op.
    await assert.rejects(
      wal.append(encodeFrame({ type: TYPE_SET, key: B('later'), value: B('z') })),
      (err) => {
        assert.equal((err as { code?: string }).code, 'WAL_POISONED');
        return true;
      },
    );
    await assert.rejects(wal.flush(), (err) => {
      assert.equal((err as { code?: string }).code, 'WAL_POISONED');
      return true;
    });
    await wal.sync();

    // In-place recovery (what MiniDb does): truncate the un-acked tail,
    // re-sync bookkeeping, clear the poison — then the write path resumes.
    const sizeBefore = (await fs.stat(file)).size;
    assert.equal(poison.failedAtOffset, sizeBefore, 'the injected writev threw before writing a byte');
    await fs.truncate(file, poison.failedAtOffset);
    await wal.refreshSize();
    wal.clearPoison();
    assert.equal(wal.poison, null);
    await wal.append(encodeFrame({ type: TYPE_SET, key: B('c'), value: B('3') }));
    await wal.close();

    const frames = parseAll(await fs.readFile(file));
    assert.deepEqual(
      frames.map((f) => f.key.toString()),
      ['ok', 'c'],
      'rejected frames never reach the file',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test("an fsync failure with fsyncPolicy 'always' poisons the WAL and counts as walFsyncErrors", async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const stats = freshStats();
    const wal = new WAL(file, { fsyncPolicy: 'always', stats });
    await wal.open();
    const fh = (wal as unknown as { fh: { sync: () => Promise<void> } }).fh;
    fh.sync = () => Promise.reject(new Error('injected fsync failure'));

    await assert.rejects(wal.append(encodeFrame({ type: TYPE_SET, key: B('k'), value: B('v') })), /injected fsync failure/);
    assert.equal(stats.walFsyncErrors, 1, 'fsync-class failure counted by sync() itself');
    assert.equal(stats.walWriteErrors, 0, 'not a writev-class failure');
    assert.ok(wal.poison, 'an unacknowledged batch poisons even though its bytes landed');

    // A poisoned close() does not throw and skips the final flush/fsync.
    await wal.close();
    assert.equal((wal as unknown as { fh: unknown }).fh, null, 'the handle is still released');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

// ---- WAL.flush() barrier, short writes, and WAL poison / rollback ------------

type WalFh = { writev: (...a: unknown[]) => Promise<unknown>; sync: () => Promise<void> };
const walFh = (db: MiniDb<unknown>): WalFh => (db as unknown as { wal: { fh: WalFh } }).wal.fh;
const MEM_OPTS = { valueCodec: 'string' as const, fsyncPolicy: 'no' as const, activeExpireIntervalMs: 0 };

function failNextWritev(db: MiniDb<unknown>): void {
  const fh = walFh(db);
  const orig = fh.writev.bind(fh);
  let fail = true;
  fh.writev = async (...a: unknown[]) => {
    if (fail) { fail = false; throw new Error('injected WAL failure'); }
    return orig(...a);
  };
}

function stubTextApplyThrow(db: MiniDb<{ t: string }>, onCall = 1): void {
  const ti = (db as unknown as { text: Map<string, { addPrepared: (k: string, t: readonly string[]) => void }> }).text.get('ft')!;
  const orig = ti.addPrepared.bind(ti);
  let calls = 0;
  ti.addPrepared = (k: string, t: readonly string[]) => {
    if (++calls === onCall) throw new Error('injected apply failure');
    orig(k, t);
  };
}

test('WAL.flush() drains frames queued behind an in-flight batch', async () => {
  const { dir, file } = await tmpWalPath();
  try {
    const wal = new WAL(file, { fsyncPolicy: 'always' });
    await wal.open();
    const fh = (wal as unknown as { fh: { writev: (...a: unknown[]) => Promise<unknown> } }).fh;
    const gate = barrier(fh, 'writev', 1);
    const pA = wal.append(Buffer.alloc(1024 * 1024, 0x61));
    await gate.entered;
    const pB = wal.append(B('B'));
    const flushing = wal.flush();
    gate.release();
    await flushing;
    const pending = (wal as unknown as { queue: unknown[] }).queue.length;
    gate.restore();
    await wal.close();
    await pA;
    await pB;
    assert.equal(pending, 0, 'flush() must leave nothing queued');
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('WAL and snapshot tolerate short writes (fragmented writev)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-wal-'));
  const probe = await fs.open(path.join(dir, '_probe'), 'w');
  const proto = Object.getPrototypeOf(probe) as { writev: (...a: unknown[]) => Promise<unknown> };
  await probe.close();
  await fs.rm(path.join(dir, '_probe'), { force: true });
  const orig = proto.writev;
  proto.writev = async function (buffers: ReadonlyArray<{ length: number; subarray: (a: number, b: number) => unknown }>, position?: number | null) {
    const first = buffers[0];
    if (!first) return orig.call(this, buffers, position);
    return orig.call(this, [first.subarray(0, Math.min(first.length, 11))], position);
  };
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string', compactThresholdBytes: 1, autoCompact: false });
    for (let i = 0; i < 30; i++) await db.set(`k${i}`, `value-${i}-${'x'.repeat(40)}`);
    await db.compact();
    await db.set('after', 'tail');
    await db.close();

    const db2 = await MiniDb.open({ dir, valueCodec: 'string' });
    for (let i = 0; i < 30; i++) assert.equal(db2.get(`k${i}`), `value-${i}-${'x'.repeat(40)}`);
    assert.equal(db2.get('after'), 'tail');
    await db2.close();
  } finally {
    proto.writev = orig;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('WAL poison: failed writev truncates tail and rolls back store, indexes, batch, and disk-mode offsets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-wal-'));
  try {
    let db = await MiniDb.open<string>({ dir, ...MEM_OPTS, valueMode: 'disk' });
    await db.set('keep', 'v0');
    failNextWritev(db as MiniDb<unknown>);
    const err = await db.set('failed', 'not-written').then(() => null, (e) => e as Error & { ambiguous?: boolean });
    assert.ok(err && /injected WAL failure/.test(String(err)) && err.ambiguous === true);
    assert.equal(db.get('failed'), undefined);
    assert.equal(db.stats.walWriteErrors, 1);
    assert.equal(db.stats.walFsyncErrors, 0);
    await db.set('ok', 'persisted');
    assert.equal(db.get('ok'), 'persisted');
    failNextWritev(db as MiniDb<unknown>);
    await assert.rejects(db.batch([{ op: 'set', key: 'keep', value: 'v99' }, { op: 'set', key: 'b2', value: 'v2' }]), /injected WAL failure/);
    assert.equal(db.get('keep'), 'v0');
    assert.equal(db.get('b2'), undefined);
    await db.close();

    db = await MiniDb.open<string>({ dir, ...MEM_OPTS, valueMode: 'disk' });
    assert.equal(db.get('failed'), undefined);
    assert.equal(db.get('b2'), undefined);
    assert.equal(db.get('keep'), 'v0');
    assert.equal(db.get('ok'), 'persisted');
    await db.close();

    // Secondary index rollback on WAL failure.
    const jdir = path.join(dir, 'json');
    const jdb = await MiniDb.open<{ city: string }>({ dir: jdir, valueCodec: 'json', fsyncPolicy: 'always' });
    await jdb.createIndex('byCity', { field: 'city' });
    failNextWritev(jdb as MiniDb<unknown>);
    await assert.rejects(jdb.set('new', { city: 'London' }), /injected WAL failure/);
    assert.equal(jdb.get('new'), undefined);
    assert.deepEqual(jdb.findEq('byCity', 'London'), []);
    await jdb.set('ok', { city: 'Berlin' });
    assert.equal(jdb.get('ok')?.city, 'Berlin');
    await jdb.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('WAL poison: half-written group is revoked and fsync failure on always policy rolls back', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-wal-'));
  try {
    let db = await MiniDb.open<string>({ dir, ...MEM_OPTS });
    const fh = walFh(db as MiniDb<unknown>);
    const orig = fh.writev.bind(fh);
    let calls = 0;
    fh.writev = async (bufs: unknown[]) => (++calls === 1 ? orig([bufs[0]]) : Promise.reject(new Error('injected after first frame')));
    const res = await Promise.allSettled([db.set('first', 'fail'), db.set('second', 'fail')]);
    assert.deepEqual(res.map((r) => r.status), ['rejected', 'rejected']);
    assert.equal(db.get('first'), undefined);
    assert.equal(db.get('second'), undefined);
    await db.close();
    db = await MiniDb.open<string>({ dir, ...MEM_OPTS });
    assert.equal(db.get('first'), undefined);
    assert.equal(db.get('second'), undefined);
    await db.close();

    const fdir = path.join(dir, 'fsync');
    let fdb = await MiniDb.open<string>({ dir: fdir, valueCodec: 'string', fsyncPolicy: 'always', activeExpireIntervalMs: 0 });
    const ffh = walFh(fdb as MiniDb<unknown>);
    const origSync = ffh.sync.bind(ffh);
    let failSync = true;
    ffh.sync = async () => { if (failSync) { failSync = false; throw new Error('injected fsync failure'); } return origSync(); };
    const err = await fdb.set('rejected', 'reappears').then(() => null, (e) => e as Error & { ambiguous?: boolean });
    assert.ok(err && /injected fsync failure/.test(String(err)) && err.ambiguous === true);
    assert.equal(fdb.get('rejected'), undefined);
    assert.equal(fdb.stats.walFsyncErrors, 1);
    assert.equal(fdb.stats.walWriteErrors, 0);
    await fdb.close();
    fdb = await MiniDb.open<string>({ dir: fdir, valueCodec: 'string', fsyncPolicy: 'always', activeExpireIntervalMs: 0 });
    assert.equal(fdb.get('rejected'), undefined);
    await fdb.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('WAL poison: same-key failed group restores pre-group value; cross-group keeps committed value', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-wal-'));
  try {
    const d1 = path.join(dir, 'same');
    let db = await MiniDb.open<string>({ dir: d1, ...MEM_OPTS });
    await db.set('k', 'old');
    failNextWritev(db as MiniDb<unknown>);
    const res = await Promise.allSettled([db.set('k', 'A'), db.set('k', 'B')]);
    assert.deepEqual(res.map((r) => r.status), ['rejected', 'rejected']);
    assert.equal(db.get('k'), 'old');
    await db.close();
    db = await MiniDb.open<string>({ dir: d1, ...MEM_OPTS });
    assert.equal(db.get('k'), 'old');
    await db.close();

    const d2 = path.join(dir, 'cross');
    db = await MiniDb.open<string>({ dir: d2, ...MEM_OPTS });
    await db.set('k', 'A');
    failNextWritev(db as MiniDb<unknown>);
    await assert.rejects(db.set('k', 'B'), /injected WAL failure/);
    assert.equal(db.get('k'), 'A');
    await db.close();
    db = await MiniDb.open<string>({ dir: d2, ...MEM_OPTS });
    assert.equal(db.get('k'), 'A');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('WAL poison: applyOp contract violation (single set & mid-batch) poisons WAL and rolls back', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-wal-'));
  try {
    let db = await MiniDb.open<{ t: string }>({ dir, valueCodec: 'json', fsyncPolicy: 'no', activeExpireIntervalMs: 0 });
    await db.createTextIndex('ft', { fields: ['t'] });
    stubTextApplyThrow(db, 1);
    const e1 = await db.set('doc', { t: 'hello world' }).then(() => null, (e) => e as Error & { ambiguous?: boolean });
    assert.ok(e1 && /injected apply failure/.test(String(e1)) && e1.ambiguous === true);
    assert.equal(db.get('doc'), undefined);
    assert.deepEqual(db.search('ft', 'hello'), []);

    stubTextApplyThrow(db, 2);
    const e2 = await db.batch([{ op: 'set', key: 'x1', value: { t: 'first' } }, { op: 'set', key: 'x2', value: { t: 'second' } }])
      .then(() => null, (e) => e as Error & { ambiguous?: boolean });
    assert.ok(e2 && /injected apply failure/.test(String(e2)) && e2.ambiguous === true);
    assert.equal(db.get('x1'), undefined);
    assert.equal(db.get('x2'), undefined);
    assert.deepEqual(db.search('ft', 'first'), []);
    assert.deepEqual(db.search('ft', 'second'), []);

    await db.set('after', { t: 'fine' });
    await db.close();
    db = await MiniDb.open<{ t: string }>({ dir, valueCodec: 'json', fsyncPolicy: 'no', activeExpireIntervalMs: 0 });
    assert.equal(db.get('doc'), undefined);
    assert.equal(db.get('x1'), undefined);
    assert.equal(db.get('x2'), undefined);
    assert.equal(db.get('after')?.t, 'fine');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('WAL poison: failed recovery truncate enters writeDisabled while staying readable and closable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-wal-'));
  const db = await MiniDb.open<string>({ dir, ...MEM_OPTS });
  await db.set('k', 'v');
  failNextWritev(db as MiniDb<unknown>);
  const origTruncate = fs.truncate;
  (fs as unknown as { truncate: unknown }).truncate = async () => { throw new Error('injected truncate failure'); };
  try {
    await assert.rejects(db.set('bad', 'x'), /injected WAL failure/);
    await waitFor(() => db.writeDisabled !== null, 'writeDisabled to be set');
  } finally {
    (fs as unknown as { truncate: unknown }).truncate = origTruncate;
  }
  assert.match(String(db.writeDisabled), /injected truncate failure/);
  await assert.rejects(db.set('more', 'x'), /writes are disabled/);
  await assert.rejects(db.batch([{ op: 'set', key: 'b2', value: 'x' }]), /writes are disabled/);
  assert.equal(db.get('k'), 'v');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test('everysec background sync failure counts errors without poisoning WAL or rejecting writes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-wal-'));
  const db = await MiniDb.open<string>({ dir, valueCodec: 'string', fsyncPolicy: 'everysec', syncIntervalMs: 10, activeExpireIntervalMs: 0 });
  const fh = walFh(db as MiniDb<unknown>);
  const origSync = fh.sync.bind(fh);
  const boom = new Error('injected background fsync failure');
  fh.sync = () => Promise.reject(boom);
  try {
    await db.set('k', 'v');
    await waitFor(() => db.stats.walFsyncErrors >= 1, 'walFsyncErrors to be counted');
    assert.equal(db.stats.lastWalFsyncError, boom);
    assert.equal(db.wal.poison, null);
    await db.set('k2', 'v2');
    assert.equal(db.get('k'), 'v');
    assert.equal(db.get('k2'), 'v2');
  } finally {
    fh.sync = origSync;
  }
  await db.close();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

test('WAL poison: queued applyOp violation behind in-flight batch lets that batch commit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-wal-'));
  try {
    let db = await MiniDb.open<{ t: string }>({ dir, valueCodec: 'json', fsyncPolicy: 'no', activeExpireIntervalMs: 0 });
    await db.createTextIndex('ft', { fields: ['t'] });
    const gate = barrier(walFh(db as MiniDb<unknown>), 'writev', 1);
    const opA = db.set('a', { t: 'first' });
    await gate.entered;
    stubTextApplyThrow(db, 1);
    await assert.rejects(db.set('b', { t: 'second' }), /injected apply failure/);
    assert.ok(db.wal.poison);
    gate.release();
    gate.restore();
    await opA;
    await waitFor(() => db.wal.poison === null, 'in-place recovery to finish');
    assert.equal(db.get('a')?.t, 'first');
    assert.equal(db.get('b'), undefined);
    await db.set('c', { t: 'third' });
    await db.close();
    db = await MiniDb.open<{ t: string }>({ dir, valueCodec: 'json', fsyncPolicy: 'no', activeExpireIntervalMs: 0 });
    assert.equal(db.get('a')?.t, 'first');
    assert.equal(db.get('b'), undefined);
    assert.equal(db.get('c')?.t, 'third');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

test('WAL poison: sealed WAL applyOp rollback, stale-coordinate truncate skip, and close() mid-failing write', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-wal-'));
  try {
    // 1) Sealed WAL does not poison on applyOp violation and rolls back per-op.
    const d1 = path.join(dir, 'sealed');
    let db1 = await MiniDb.open<{ t: string }>({ dir: d1, valueCodec: 'json', fsyncPolicy: 'no', activeExpireIntervalMs: 0 });
    await db1.createTextIndex('ft', { fields: ['t'] });
    await db1.set('old', { t: 'keep' });
    stubTextApplyThrow(db1, 1);
    db1.wal.seal();
    await assert.rejects(db1.set('bad', { t: 'x' }), /injected apply failure/);
    assert.equal(db1.wal.poison, null);
    assert.equal(db1.get('bad'), undefined);
    assert.deepEqual(db1.search('ft', 'keep').map((h) => h.key), ['old']);
    await db1.close();
    db1 = await MiniDb.open<{ t: string }>({ dir: d1, valueCodec: 'json', fsyncPolicy: 'no', activeExpireIntervalMs: 0 });
    assert.equal(db1.get('bad'), undefined);
    assert.equal(db1.get('old')?.t, 'keep');
    await db1.close();

    // 2) Stale-coordinate truncate is skipped when WAL file was replaced.
    const d2 = path.join(dir, 'stale');
    let db2 = await MiniDb.open<string>({ dir: d2, ...MEM_OPTS });
    for (let i = 0; i < 10; i++) await db2.set(`k${i}`, `v${i}`);
    await db2.wal.flush();
    const staleOffset = (await fs.stat(path.join(d2, 'db.wal'))).size;
    assert.ok(staleOffset > 0);
    db2.wal.poisonPending(new Error('injected poison'));
    assert.equal(db2.wal.poison!.failedAtOffset, staleOffset);
    await fs.writeFile(path.join(d2, 'db.wal'), Buffer.alloc(0));
    await (db2 as unknown as { recoverWalInPlace(w: unknown): Promise<void> }).recoverWalInPlace(db2.wal);
    assert.equal((await fs.stat(path.join(d2, 'db.wal'))).size, 0);
    assert.equal(db2.wal.poison, null);
    await db2.set('post', 'ok');
    await db2.close();
    db2 = await MiniDb.open<string>({ dir: d2, ...MEM_OPTS });
    assert.equal(db2.size, 1);
    assert.equal(db2.get('post'), 'ok');
    await db2.close();

    // 3) close() in same tick as failing write resolves cleanly.
    const d3 = path.join(dir, 'close-mid');
    let db3 = await MiniDb.open<string>({ dir: d3, ...MEM_OPTS });
    const fh = walFh(db3 as MiniDb<unknown>);
    const orig = fh.writev.bind(fh);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    fh.writev = async (...a: unknown[]) => (++calls === 1 ? (await gate, Promise.reject(new Error('injected WAL failure'))) : orig(...a));
    const op = db3.set('bad', 'x');
    await waitFor(() => calls === 1, 'failing writev in flight');
    const closing = db3.close();
    release();
    await assert.rejects(op, /injected WAL failure/);
    await closing;
    db3 = await MiniDb.open<string>({ dir: d3, ...MEM_OPTS });
    assert.equal(db3.get('bad'), undefined);
    await db3.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
