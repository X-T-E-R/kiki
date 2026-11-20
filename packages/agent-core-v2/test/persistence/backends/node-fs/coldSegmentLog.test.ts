import { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { deflateRawSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'pathe';
import { open as openZip } from 'yauzl';

import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter, Event } from '#/_base/event';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { createServices, TestInstantiationService } from '#/_base/di/test';
import { atomicWrite } from '#/_base/utils/fs';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { exportSessionDirectory } from '#/app/sessionExport/sessionExportService';
import { scanSessionWire } from '#/app/sessionExport/wire-scan';
import { type AppendLogStore, coldManifestKey } from '#/persistence/backends/node-fs/appendLogStore';
import { createTestAppendLogStore } from '../../interface/stubs';
import {
  acquireSharedReadLease,
  SESSION_LOCK_SCOPE,
  sessionLockKey,
  sharedReadDirectory,
  trackReaderWorkerThread,
  waitSharedReadIdle,
} from '#/persistence/backends/node-fs/fileLock';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import {
  _setSparsePunchOverrideForTests,
  allocatedFileBytes,
  clearSparseAttributeCache,
  closeSparseFileWorker,
  detectOrphanedSparseJournal,
  punchSparseRanges,
  queryWin32SparseAttribute,
  writeSparseMarker,
} from '#/persistence/backends/node-fs/sparseFile';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import {
  COLD_SEGMENT_BYTES,
  COLD_ZSTD_SEGMENT_BYTES,
  openPinnedLogicalRead,
  readColdManifestSummary,
  readLogicalBytes,
  scanColdWireMarkers,
  sealColdSegments,
  unsealColdSegments,
  withColdExclusive,
} from '#/persistence/coldSegmentLog';
import {
  compactRetainedJournal,
  discardRetainedJournal,
  sealRetainedJournal,
  unsealRetainedJournal,
} from '#/persistence/retainedJournal';
import { ColdCompactionService } from '#/app/coldCompaction/coldCompactionService';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { SessionManager } from '#/app/sessionManager/sessionManagerService';
import {
  IFileSystemStorageService,
  StorageError,
  StorageErrors,
  type StorageReadOptions,
  type StorageReadRange,
  type StorageWriteOptions,
} from '#/persistence/interface/storage';
import type { ISessionLifecycleService, SessionCreatedEvent } from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { WorkspaceInstance } from '#/workspace/workspaceInstance/workspaceInstance';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { repairWireJournal, wireJournalBackupKey } from '#/wire/repair';

import { noopLogger, registerTestAgentWire } from '../../../wire/stubs';

const SCOPE = 'agents/main';
const OTHER = 'agents/other';
const KEY = AGENT_WIRE_RECORD_KEY;
const SEGMENT_BYTES = 128;

class RecordingStorage extends InMemoryStorageService {
  readonly opened: string[] = [];

  override async read(scope: string, key: string): Promise<Uint8Array | undefined> {
    this.opened.push(key);
    return super.read(scope, key);
  }

  override async *readStream(
    scope: string,
    key: string,
    range?: StorageReadRange,
  ): AsyncIterable<Uint8Array> {
    this.opened.push(key);
    yield* super.readStream(scope, key, range);
  }
}

const isSegmentKey = (key: string): boolean => key.endsWith('.zst') || key.endsWith('.deflate');

class FailOnSecondSegment extends InMemoryStorageService {
  private segmentWrites = 0;
  readonly writtenSegments: string[] = [];

  override async write(
    scope: string,
    key: string,
    data: Uint8Array,
    options?: { atomic?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    if (key.includes('.segments/') && isSegmentKey(key) && ++this.segmentWrites === 2) throw new Error('disk full');
    await super.write(scope, key, data, options);
    if (isSegmentKey(key)) this.writtenSegments.push(key);
  }
}

function line(value: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function buildJournal(): { bytes: Buffer; sealedCut: number } {
  const parts = [
    line({ type: 'metadata', protocol_version: '1.6', created_at: 1_700_000_000_000 }),
    line({ type: 'turn_begin', time: 1_700_000_000_000, userInput: 'NEEDLE_COLD', id: 'cold' }),
  ];
  while (Buffer.concat(parts).byteLength < SEGMENT_BYTES * 2) {
    parts.push(line({ type: 'note', id: `pad-${parts.length}`, pad: 'x'.repeat(48) }));
  }
  const sealedCut = Buffer.concat(parts).byteLength;
  parts.push(line({ type: 'turn_begin', time: 1_700_000_005_000, userInput: 'NEEDLE_HOT', id: 'hot' }));
  return { bytes: Buffer.concat(parts), sealedCut };
}

async function collect(log: AppendLogStore, scope = SCOPE): Promise<WireRecord[]> {
  const records: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(scope, KEY)) records.push(record);
  return records;
}

async function concatBytes(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function boundaryHash(bytes: Buffer, offset: number): string {
  if (offset === 0) return '';
  return createHash('sha256').update(bytes.subarray(Math.max(0, offset - 4096), offset)).digest('base64url');
}

function readZipEntry(path: string, target: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    openZip(path, { lazyEntries: true }, (openError, zip) => {
      if (openError !== null || zip === undefined) {
        reject(openError ?? new Error('zip did not open'));
        return;
      }
      const fail = (error: Error): void => {
        zip.close();
        reject(error);
      };
      zip.once('error', fail);
      zip.on('entry', (entry) => {
        if (entry.fileName !== target) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) {
            fail(streamError ?? new Error('zip entry did not open'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.once('end', () => {
            zip.close();
            resolve(Buffer.concat(chunks));
          });
          stream.once('error', fail);
        });
      });
      zip.readEntry();
    });
  });
}

describe('cold segment journal', () => {
  let disposables: DisposableStore;

  beforeEach(() => {
    disposables = new DisposableStore();
  });

  afterEach(async () => {
    await disposables.dispose();
  });

  it('seals independent segments and reads a logical page without earlier members or the plaintext prefix', async () => {
    const storage = new RecordingStorage();
    const log = createTestAppendLogStore(storage);
    disposables.add(log);
    const journal = buildJournal();
    await storage.write(SCOPE, KEY, journal.bytes);
    await storage.write(OTHER, KEY, line({ type: 'note', id: 'other' }));
    const mtime = await storage.mtime(SCOPE, KEY);
    storage.opened.length = 0;

    const sealed = await log.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });

    expect(sealed).toMatchObject({
      format: 2,
      codec: 'zstd',
      level: 3,
      segmentBytes: SEGMENT_BYTES,
      sealedCut: journal.sealedCut,
      logicalSize: journal.bytes.byteLength,
      originalRetained: true,
    });
    expect(sealed.segmentCount).toBeGreaterThan(1);
    expect(Buffer.from((await storage.read(SCOPE, KEY))!)).toEqual(journal.bytes);
    expect(await storage.mtime(SCOPE, KEY)).toBe(mtime);
    expect(await log.generation(SCOPE, KEY)).toBe('legacy');
    expect(await storage.read(SCOPE, `${KEY}.generation`)).toBeUndefined();
    expect(Buffer.concat([await concatBytes(readLogicalBytes(storage, SCOPE, KEY))])).toEqual(journal.bytes);

    storage.opened.length = 0;
    const page = await concatBytes(readLogicalBytes(storage, SCOPE, KEY, { start: SEGMENT_BYTES, end: SEGMENT_BYTES + 40 }));
    expect(page).toEqual(journal.bytes.subarray(SEGMENT_BYTES, SEGMENT_BYTES + 41));
    expect(storage.opened.filter((key) => key.endsWith('.zst'))).toEqual([
      expect.stringMatching(/\.segments\/[0-9a-f-]{36}\/000001\.zst$/),
    ]);
    expect(storage.opened).not.toContain(KEY);

    storage.opened.length = 0;
    const tail = await concatBytes(readLogicalBytes(storage, SCOPE, KEY, { start: journal.sealedCut, end: journal.bytes.byteLength - 1 }));
    expect(tail).toEqual(journal.bytes.subarray(journal.sealedCut));
    expect(storage.opened.filter((key) => key.endsWith('.zst'))).toEqual([]);
    expect(storage.opened).toContain(KEY);

    const windowStart = Math.max(0, journal.sealedCut - 4096);
    storage.opened.length = 0;
    const window = await concatBytes(readLogicalBytes(storage, SCOPE, KEY, { start: windowStart, end: journal.sealedCut - 1 }));
    expect(createHash('sha256').update(window).digest('base64url')).toBe(boundaryHash(journal.bytes, journal.sealedCut));
    expect(storage.opened).not.toContain(KEY);

    const records = await collect(log);
    expect(records.map((record) => record['id'])).toEqual(expect.arrayContaining(['cold', 'hot']));
    expect(await collect(log, OTHER)).toEqual([{ type: 'note', id: 'other' }]);
    expect(await storage.read(OTHER, coldManifestKey(KEY))).toBeUndefined();
  });

  it('reads and unseals legacy format-1 deflate-raw segments seamlessly after zstd becomes default', async () => {
    const storage = new RecordingStorage();
    const log = createTestAppendLogStore(storage);
    disposables.add(log);
    const journal = buildJournal();
    await storage.write(SCOPE, KEY, journal.bytes);

    const legacySeal = await log.sealCold(SCOPE, KEY, journal.sealedCut, {
      codec: 'deflate-raw',
      segmentBytes: SEGMENT_BYTES,
    });
    expect(legacySeal).toMatchObject({ format: 1, codec: 'deflate-raw', level: 6, segmentBytes: SEGMENT_BYTES });
    expect(await readColdManifestSummary(storage, SCOPE, KEY)).toMatchObject({ format: 1, codec: 'deflate-raw' });

    storage.opened.length = 0;
    const page = await concatBytes(readLogicalBytes(storage, SCOPE, KEY, { start: SEGMENT_BYTES, end: SEGMENT_BYTES + 40 }));
    expect(page).toEqual(journal.bytes.subarray(SEGMENT_BYTES, SEGMENT_BYTES + 41));
    expect(storage.opened.filter((key) => key.endsWith('.deflate'))).toHaveLength(1);
    expect(await concatBytes(readLogicalBytes(storage, SCOPE, KEY))).toEqual(journal.bytes);

    const unsealed = await unsealColdSegments(storage, SCOPE, KEY, { forceRestoreOriginal: true });
    expect(unsealed.hadManifest).toBe(true);
    expect(unsealed.verifiedSegments).toBe(legacySeal.segmentCount);
    expect(Buffer.from((await storage.read(SCOPE, KEY))!)).toEqual(journal.bytes);
  });

  it('keeps an exact generation string and uses the 4MiB zstd default for an empty cold prefix', async () => {
    const storage = new InMemoryStorageService();
    const log = createTestAppendLogStore(storage);
    disposables.add(log);
    const bytes = line({ type: 'note', id: 'tiny' });
    await storage.write(SCOPE, KEY, bytes);
    await storage.write(SCOPE, `${KEY}.generation`, Buffer.from('gen-1\n'));

    const sealed = await log.sealCold(SCOPE, KEY, 0);

    expect(sealed.codec).toBe('zstd');
    expect(sealed.segmentBytes).toBe(COLD_ZSTD_SEGMENT_BYTES);
    expect(sealed.segmentBytes).toBeLessThan(COLD_SEGMENT_BYTES);
    expect(sealed.segmentCount).toBe(0);
    expect(sealed.generation).toBe('gen-1\n');
    expect(await log.generation(SCOPE, KEY)).toBe('gen-1\n');
    expect(Buffer.from((await storage.read(SCOPE, `${KEY}.generation`))!)).toEqual(Buffer.from('gen-1\n'));
    expect(Buffer.from((await storage.read(SCOPE, KEY))!)).toEqual(bytes);
    expect(await concatBytes(readLogicalBytes(storage, SCOPE, KEY))).toEqual(bytes);
  });

  it('refuses a mid-record cut and keeps the journal when a segment write or cancel fails', async () => {
    const journal = buildJournal();
    const refused = new InMemoryStorageService();
    const refusedLog = createTestAppendLogStore(refused);
    disposables.add(refusedLog);
    await refused.write(SCOPE, KEY, journal.bytes);
    await expect(refusedLog.sealCold(SCOPE, KEY, 3, { segmentBytes: SEGMENT_BYTES })).rejects.toMatchObject({
      name: 'BugIndicatingError',
    });
    expect(await refused.read(SCOPE, coldManifestKey(KEY))).toBeUndefined();
    expect(Buffer.from((await refused.read(SCOPE, KEY))!)).toEqual(journal.bytes);

    const failing = new FailOnSecondSegment();
    const failingLog = createTestAppendLogStore(failing);
    disposables.add(failingLog);
    await failing.write(SCOPE, KEY, journal.bytes);
    await expect(failingLog.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES })).rejects.toThrow('disk full');
    expect(await failing.read(SCOPE, coldManifestKey(KEY))).toBeUndefined();
    expect(failing.writtenSegments.length).toBeGreaterThan(0);
    for (const segmentKey of failing.writtenSegments) expect(await failing.read(SCOPE, segmentKey)).toBeUndefined();
    expect(Buffer.from((await failing.read(SCOPE, KEY))!)).toEqual(journal.bytes);

    const cancelled = new InMemoryStorageService();
    const cancelledLog = createTestAppendLogStore(cancelled);
    disposables.add(cancelledLog);
    await cancelled.write(SCOPE, KEY, journal.bytes);
    const controller = new AbortController();
    controller.abort();
    await expect(cancelledLog.sealCold(SCOPE, KEY, journal.sealedCut, {
      segmentBytes: SEGMENT_BYTES,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await cancelled.read(SCOPE, coldManifestKey(KEY))).toBeUndefined();
    expect(Buffer.from((await cancelled.read(SCOPE, KEY))!)).toEqual(journal.bytes);
  });

  it('fails closed on a damaged manifest or missing segment, then rolls back to the retained journal', async () => {
    const storage = new InMemoryStorageService();
    const log = createTestAppendLogStore(storage);
    disposables.add(log);
    const journal = buildJournal();
    await storage.write(SCOPE, KEY, journal.bytes);
    await log.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
    const published = JSON.parse(Buffer.from((await storage.read(SCOPE, coldManifestKey(KEY)))!).toString('utf8')) as {
      segments: Array<{ key: string }>;
    };
    await storage.delete(SCOPE, published.segments[1]!.key);
    const missing = log.read<WireRecord>(SCOPE, KEY)[Symbol.asyncIterator]();
    await expect(missing.next()).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
    expect(Buffer.from((await storage.read(SCOPE, KEY))!)).toEqual(journal.bytes);

    await storage.write(SCOPE, coldManifestKey(KEY), Buffer.from('{'));
    await expect(collect(log)).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
    await log.discardCold(SCOPE, KEY);
    expect((await collect(log)).map((record) => record['id'])).toEqual(expect.arrayContaining(['cold', 'hot']));
    expect(Buffer.from((await storage.read(SCOPE, KEY))!)).toEqual(journal.bytes);
  });

  it('drops a stale seal when the journal itself is rewritten', async () => {
    const storage = new InMemoryStorageService();
    const log = createTestAppendLogStore(storage);
    disposables.add(log);
    const journal = buildJournal();
    await storage.write(SCOPE, KEY, journal.bytes);
    await log.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });

    await log.rewrite(SCOPE, KEY, [{ type: 'note', id: 'replaced' }]);

    expect(await storage.read(SCOPE, coldManifestKey(KEY))).toBeUndefined();
    expect(await collect(log)).toEqual([{ type: 'note', id: 'replaced' }]);
  });

  it('matches checkpoint identity and replays only the sealed tail', async () => {
    const storage = new InMemoryStorageService();
    const ix = disposables.add(new TestInstantiationService());
    const log = createTestAppendLogStore(storage);
    disposables.add(log);
    const wire = registerTestAgentWire(ix, SCOPE, {
      log,
      storage,
      logger: noopLogger,
      telemetry: noopTelemetryService,
    });
    const journal = buildJournal();
    await storage.write(SCOPE, KEY, journal.bytes);
    const before = await wire.journalIdentity!();

    await log.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });

    expect(await wire.journalIdentity!()).toEqual(before);
    expect(before.size).toBe(journal.bytes.byteLength);
    expect(before.headHash).toBe(createHash('sha256').update(journal.bytes.subarray(0, 64 * 1024)).digest('hex').slice(0, 32));
    const tail: WireRecord[] = [];
    for await (const record of wire.readJournal({ startByte: journal.sealedCut })) tail.push(record);
    expect(tail).toEqual([{ type: 'turn_begin', time: 1_700_000_005_000, userInput: 'NEEDLE_HOT', id: 'hot' }]);
    expect(Buffer.from((await storage.read(SCOPE, KEY))!)).toEqual(journal.bytes);
  });

  it('exports the retained wire bytes and still sees the cold-region user input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-export-'));
    const sessionDir = join(root, 'session');
    const storage = new FileStorageService(sessionDir);
    const log = createTestAppendLogStore(storage);
    const journal = buildJournal();
    try {
      await storage.write(SCOPE, KEY, journal.bytes);
      await writeFile(join(sessionDir, 'state.json'), '{}\n');
      await log.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
      const outputPath = join(root, 'export.zip');
      const exported = await exportSessionDirectory({
        request: { sessionId: 'ses_cold', outputPath, version: '0.0.0-test' },
        summary: { id: 'ses_cold', sessionDir },
      });
      expect(await readZipEntry(outputPath, 'agents/main/wire.jsonl')).toEqual(journal.bytes);
      expect(exported.manifest.sessionFirstActivity).toBe('2023-11-14T22:13:20.000Z');
      expect((await scanSessionWire(sessionDir)).firstUserInput).toBe('NEEDLE_COLD');
      expect(await readFile(join(sessionDir, SCOPE, KEY))).toEqual(journal.bytes);
    } finally {
      await log.dispose();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an oversized deflate at the inflate bound', async () => {
    const storage = new RecordingStorage();
    const log = createTestAppendLogStore(storage);
    disposables.add(log);
    const journal = buildJournal();
    await storage.write(SCOPE, KEY, journal.bytes);
    await log.sealCold(SCOPE, KEY, journal.sealedCut, { codec: 'deflate-raw', segmentBytes: SEGMENT_BYTES });
    const manifest = JSON.parse(Buffer.from((await storage.read(SCOPE, coldManifestKey(KEY)))!).toString('utf8')) as {
      segments: Array<{ key: string }>;
    };
    const bomb = deflateRawSync(Buffer.alloc(256 * 1024), { level: 6 });
    await storage.write(SCOPE, manifest.segments[0]!.key, bomb);
    await expect(concatBytes(readLogicalBytes(storage, SCOPE, KEY, { start: 0, end: 31 }))).rejects.toMatchObject({
      code: StorageErrors.codes.STORAGE_CORRUPTED,
      details: { reason: 'segment' },
      cause: { code: 'ERR_BUFFER_TOO_LARGE' },
    });

    const bulky = new RecordingStorage();
    const bulkyLog = createTestAppendLogStore(bulky);
    disposables.add(bulkyLog);
    await bulky.write(SCOPE, KEY, journal.bytes);
    await bulkyLog.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
    const published = JSON.parse(Buffer.from((await bulky.read(SCOPE, coldManifestKey(KEY)))!).toString('utf8')) as {
      segments: Array<{ key: string }>;
    };
    await bulky.write(SCOPE, published.segments[0]!.key, Buffer.alloc(64 * 1024));
    bulky.opened.length = 0;
    await expect(concatBytes(readLogicalBytes(bulky, SCOPE, KEY, { start: 0, end: 31 }))).rejects.toMatchObject({
      code: StorageErrors.codes.STORAGE_CORRUPTED,
      details: { reason: 'segment' },
    });
    expect(bulky.opened.filter(isSegmentKey)).toEqual([]);
    expect(Buffer.from((await bulky.read(SCOPE, KEY))!)).toEqual(journal.bytes);
  });

  it('keeps a published seal when a reseal is cancelled and holds the next seal behind it', async () => {
    const journal = buildJournal();
    let armCancel = false;
    const cancelStorage = new (class extends InMemoryStorageService {
      override async write(
        scope: string,
        key: string,
        data: Uint8Array,
        options?: { atomic?: boolean; signal?: AbortSignal },
      ): Promise<void> {
        if (armCancel && isSegmentKey(key)) throw new DOMException('The operation was aborted', 'AbortError');
        await super.write(scope, key, data, options);
      }
    })();
    const cancelLog = createTestAppendLogStore(cancelStorage);
    disposables.add(cancelLog);
    await cancelStorage.write(SCOPE, KEY, journal.bytes);
    await cancelLog.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
    const published = Buffer.from((await cancelStorage.read(SCOPE, coldManifestKey(KEY)))!);
    const segments = (JSON.parse(published.toString('utf8')) as { segments: Array<{ key: string }> }).segments;
    armCancel = true;
    await expect(cancelLog.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(Buffer.from((await cancelStorage.read(SCOPE, coldManifestKey(KEY)))!)).toEqual(published);
    for (const segment of segments) expect(await cancelStorage.read(SCOPE, segment.key)).toBeDefined();
    expect(await concatBytes(readLogicalBytes(cancelStorage, SCOPE, KEY))).toEqual(journal.bytes);
    expect(Buffer.from((await cancelStorage.read(SCOPE, KEY))!)).toEqual(journal.bytes);

    let manifestWrites = 0;
    let heldNow = false;
    let deflatesWhileHeld = 0;
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => { markHeld = resolve; });
    const gated = new (class extends InMemoryStorageService {
      override async write(
        scope: string,
        key: string,
        data: Uint8Array,
        options?: { atomic?: boolean; signal?: AbortSignal },
      ): Promise<void> {
        if (heldNow && isSegmentKey(key)) deflatesWhileHeld += 1;
        if (key.endsWith('.segments.json')) {
          manifestWrites += 1;
          if (manifestWrites === 2) {
            heldNow = true;
            markHeld();
            await hold;
            heldNow = false;
          }
        }
        await super.write(scope, key, data, options);
      }
    })();
    const gatedLog = createTestAppendLogStore(gated);
    disposables.add(gatedLog);
    await gated.write(SCOPE, KEY, journal.bytes);
    await gatedLog.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
    const firstManifest = Buffer.from((await gated.read(SCOPE, coldManifestKey(KEY)))!);
    const firstSeal = gatedLog.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
    await held;
    const secondSeal = gatedLog.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(deflatesWhileHeld).toBe(0);
    expect(Buffer.from((await gated.read(SCOPE, coldManifestKey(KEY)))!)).toEqual(firstManifest);
    releaseHold();
    await firstSeal;
    await secondSeal;
    const finalManifest = JSON.parse(Buffer.from((await gated.read(SCOPE, coldManifestKey(KEY)))!).toString('utf8')) as {
      segments: Array<{ key: string }>;
    };
    for (const segment of finalManifest.segments) expect(await gated.read(SCOPE, segment.key)).toBeDefined();
    expect(await concatBytes(readLogicalBytes(gated, SCOPE, KEY))).toEqual(journal.bytes);
    expect(Buffer.from((await gated.read(SCOPE, KEY))!)).toEqual(journal.bytes);
  });

  it('finishes an in-flight logical read before discard removes its segments', async () => {
    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let markRead!: () => void;
    const readingSegment = new Promise<void>((resolve) => { markRead = resolve; });
    let blocked = false;
    const storage = new (class extends InMemoryStorageService {
      override async read(scope: string, key: string): Promise<Uint8Array | undefined> {
        if (!blocked && isSegmentKey(key)) {
          blocked = true;
          markRead();
          await gate;
        }
        return super.read(scope, key);
      }
    })();
    const log = createTestAppendLogStore(storage);
    disposables.add(log);
    const journal = buildJournal();
    await storage.write(SCOPE, KEY, journal.bytes);
    await log.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
    const published = JSON.parse(Buffer.from((await storage.read(SCOPE, coldManifestKey(KEY)))!).toString('utf8')) as {
      segments: Array<{ key: string }>;
    };
    const pinnedKey = published.segments[0]!.key;
    const pending = concatBytes(readLogicalBytes(storage, SCOPE, KEY));
    await readingSegment;
    const discarding = log.discardCold(SCOPE, KEY);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(await storage.read(SCOPE, pinnedKey)).toBeDefined();
    releaseRead();
    expect(await pending).toEqual(journal.bytes);
    await discarding;
    expect(await storage.read(SCOPE, coldManifestKey(KEY))).toBeUndefined();
    expect(await concatBytes(readLogicalBytes(storage, SCOPE, KEY))).toEqual(journal.bytes);
    expect(Buffer.from((await storage.read(SCOPE, KEY))!)).toEqual(journal.bytes);
  });

  it('does not interleave a rewrite with a seal of the previous bytes', async () => {
    let arm = false;
    let releaseWrite!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let markWrite!: () => void;
    const writing = new Promise<void>((resolve) => { markWrite = resolve; });
    let deflatesWhileHeld = 0;
    let heldNow = false;
    const storage = new (class extends InMemoryStorageService {
      override async write(
        scope: string,
        key: string,
        data: Uint8Array,
        options?: { atomic?: boolean; signal?: AbortSignal },
      ): Promise<void> {
        if (heldNow && isSegmentKey(key)) deflatesWhileHeld += 1;
        if (arm && key === KEY) {
          arm = false;
          heldNow = true;
          markWrite();
          await gate;
          heldNow = false;
        }
        await super.write(scope, key, data, options);
      }
    })();
    const log = createTestAppendLogStore(storage);
    disposables.add(log);
    const journal = buildJournal();
    await storage.write(SCOPE, KEY, journal.bytes);
    await log.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
    arm = true;
    const rewriting = log.rewrite(SCOPE, KEY, [{ type: 'note', id: 'replaced' }]);
    await writing;
    const sealing = log.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(deflatesWhileHeld).toBe(0);
    expect(await storage.read(SCOPE, coldManifestKey(KEY))).toBeUndefined();
    releaseWrite();
    await rewriting;
    await expect(sealing).rejects.toMatchObject({ name: 'BugIndicatingError' });
    expect(await storage.read(SCOPE, coldManifestKey(KEY))).toBeUndefined();
    expect(await collect(log)).toEqual([{ type: 'note', id: 'replaced' }]);
  });

  it('does not publish or serve sealed bytes under a different generation', async () => {
    const journal = buildJournal();
    const next = Buffer.from(journal.bytes);
    const needle = Buffer.from('NEEDLE_COLD');
    next.set(Buffer.from('NEEDLE_NEW!'), next.indexOf(needle));
    expect(next.byteLength).toBe(journal.bytes.byteLength);
    let generationReads = 0;
    const fresh: string[] = [];
    const swapping = new (class extends InMemoryStorageService {
      override async read(scope: string, key: string): Promise<Uint8Array | undefined> {
        if (key === `${KEY}.generation`) {
          generationReads += 1;
          if (generationReads === 2) {
            await super.write(scope, KEY, next);
            await super.write(scope, `${KEY}.generation`, Buffer.from('gen-2\n'));
          }
        }
        return super.read(scope, key);
      }

      override async write(
        scope: string,
        key: string,
        data: Uint8Array,
        options?: { atomic?: boolean; signal?: AbortSignal },
      ): Promise<void> {
        await super.write(scope, key, data, options);
        if (isSegmentKey(key)) fresh.push(key);
      }
    })();
    const swappingLog = createTestAppendLogStore(swapping);
    disposables.add(swappingLog);
    await swapping.write(SCOPE, KEY, journal.bytes);
    await swapping.write(SCOPE, `${KEY}.generation`, Buffer.from('gen-1\n'));
    await expect(swappingLog.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES })).rejects.toMatchObject({
      code: StorageErrors.codes.STORAGE_CORRUPTED,
      details: { reason: 'generation' },
    });
    expect(await swapping.read(SCOPE, coldManifestKey(KEY))).toBeUndefined();
    for (const segmentKey of fresh) expect(await swapping.read(SCOPE, segmentKey)).toBeUndefined();
    expect(await concatBytes(readLogicalBytes(swapping, SCOPE, KEY))).toEqual(next);
    expect(Buffer.from((await swapping.read(SCOPE, KEY))!)).toEqual(next);

    const published = new InMemoryStorageService();
    const publishedLog = createTestAppendLogStore(published);
    disposables.add(publishedLog);
    await published.write(SCOPE, KEY, journal.bytes);
    await published.write(SCOPE, `${KEY}.generation`, Buffer.from('gen-1\n'));
    await publishedLog.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
    await published.write(SCOPE, KEY, next);
    await published.write(SCOPE, `${KEY}.generation`, Buffer.from('gen-2\n'));
    const iterator = readLogicalBytes(published, SCOPE, KEY)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      code: StorageErrors.codes.STORAGE_CORRUPTED,
      details: { reason: 'generation' },
    });
    expect(Buffer.from((await published.read(SCOPE, KEY))!)).toEqual(next);
  });

  it('shares the seal lock for one wire opened through two storage roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-identity-'));
    const wideScope = 'ws/ses/agents/main';
    let releaseHold!: () => void;
    const hold = new Promise<void>((done) => { releaseHold = done; });
    let markHeld!: () => void;
    const held = new Promise<void>((done) => { markHeld = done; });
    let arm = false;
    const wide = new (class extends FileStorageService {
      override async write(
        scope: string,
        key: string,
        data: Uint8Array,
        options: StorageWriteOptions = {},
      ): Promise<void> {
        if (arm && key.endsWith('.segments.json')) {
          arm = false;
          markHeld();
          await hold;
        }
        await super.write(scope, key, data, options);
      }
    })(root);
    const narrow = new FileStorageService(join(root, 'ws', 'ses'));
    const wideLog = createTestAppendLogStore(wide);
    const narrowLog = createTestAppendLogStore(narrow);
    const journal = buildJournal();
    try {
      expect(resolve(wide.pathFor(wideScope, KEY)).toLowerCase()).toBe(resolve(narrow.pathFor(SCOPE, KEY)).toLowerCase());
      await wide.write(wideScope, KEY, journal.bytes);
      await wideLog.sealCold(wideScope, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
      arm = true;
      const reseal = wideLog.sealCold(wideScope, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
      await held;
      let narrowSettled = false;
      const otherSeal = narrowLog.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES }).then(() => {
        narrowSettled = true;
      });
      await new Promise<void>((done) => { setTimeout(done, 1_500); });
      expect(narrowSettled).toBe(false);
      releaseHold();
      await reseal;
      await otherSeal;
      expect(await concatBytes(readLogicalBytes(narrow, SCOPE, KEY))).toEqual(journal.bytes);
      expect(await readFile(wide.pathFor(wideScope, KEY))).toEqual(journal.bytes);
    } finally {
      releaseHold();
      await wideLog.dispose();
      await narrowLog.dispose();
      await wide.close();
      await narrow.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps a reader pin when the same wire is discarded through the other storage root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-pin-'));
    const wideScope = 'ws/ses/agents/main';
    let releaseRead!: () => void;
    const gate = new Promise<void>((done) => { releaseRead = done; });
    let markRead!: () => void;
    const readingSegment = new Promise<void>((done) => { markRead = done; });
    let blocked = false;
    const narrow = new (class extends FileStorageService {
      override async read(scope: string, key: string, options: StorageReadOptions = {}): Promise<Uint8Array | undefined> {
        if (!blocked && isSegmentKey(key)) {
          blocked = true;
          markRead();
          await gate;
        }
        return super.read(scope, key, options);
      }
    })(join(root, 'ws', 'ses'));
    const wide = new FileStorageService(root);
    const wideLog = createTestAppendLogStore(wide);
    const journal = buildJournal();
    try {
      await wide.write(wideScope, KEY, journal.bytes);
      await wideLog.sealCold(wideScope, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
      const published = JSON.parse(Buffer.from((await wide.read(wideScope, coldManifestKey(KEY)))!).toString('utf8')) as {
        segments: Array<{ key: string }>;
      };
      const pinnedKey = published.segments[0]!.key;
      const pending = concatBytes(readLogicalBytes(narrow, SCOPE, KEY));
      await readingSegment;
      const discarding = wideLog.discardCold(wideScope, KEY);
      await new Promise<void>((done) => { setTimeout(done, 800); });
      expect(await wide.read(wideScope, pinnedKey)).toBeDefined();
      releaseRead();
      expect(await pending).toEqual(journal.bytes);
      await discarding;
      expect(await wide.read(wideScope, coldManifestKey(KEY))).toBeUndefined();
      expect(await readFile(wide.pathFor(wideScope, KEY))).toEqual(journal.bytes);
    } finally {
      releaseRead();
      await wideLog.dispose();
      await wide.close();
      await narrow.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('does not block a different home that uses the same scope and key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-homes-'));
    const homeA = join(root, 'home-a');
    const homeB = join(root, 'home-b');
    let releaseHold!: () => void;
    const hold = new Promise<void>((done) => { releaseHold = done; });
    let markHeld!: () => void;
    const held = new Promise<void>((done) => { markHeld = done; });
    let arm = false;
    const storageA = new (class extends FileStorageService {
      override async write(
        scope: string,
        key: string,
        data: Uint8Array,
        options: StorageWriteOptions = {},
      ): Promise<void> {
        if (arm && key.endsWith('.segments.json')) {
          arm = false;
          markHeld();
          await hold;
        }
        await super.write(scope, key, data, options);
      }
    })(homeA);
    const storageB = new FileStorageService(homeB);
    const logA = createTestAppendLogStore(storageA);
    const logB = createTestAppendLogStore(storageB);
    const journal = buildJournal();
    try {
      expect(resolve(storageA.pathFor(SCOPE, KEY)).toLowerCase()).not.toBe(resolve(storageB.pathFor(SCOPE, KEY)).toLowerCase());
      await storageA.write(SCOPE, KEY, journal.bytes);
      await storageB.write(SCOPE, KEY, journal.bytes);
      await logA.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
      arm = true;
      const reseal = logA.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
      await held;
      const other = await Promise.race([
        logB.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES }).then(() => 'finished' as const),
        new Promise<'waiting'>((done) => { setTimeout(() => done('waiting'), 4_000); }),
      ]);
      expect(other).toBe('finished');
      expect(await storageB.read(SCOPE, coldManifestKey(KEY))).toBeDefined();
      releaseHold();
      await reseal;
      expect(await readFile(storageA.pathFor(SCOPE, KEY))).toEqual(journal.bytes);
      expect(await readFile(storageB.pathFor(SCOPE, KEY))).toEqual(journal.bytes);
    } finally {
      releaseHold();
      await logA.dispose();
      await logB.dispose();
      await storageA.close();
      await storageB.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('cancels a queued pin without letting the next reader overtake an active seal', async () => {
    const storage = new InMemoryStorageService();
    const bytes = buildJournal().bytes;
    await storage.write(SCOPE, KEY, bytes);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const active = new Promise<void>((resolve) => { entered = resolve; });
    const sealing = withColdExclusive(storage, SCOPE, KEY, async () => { entered(); await hold; });
    await active;
    const controller = new AbortController();
    const cancelled = openPinnedLogicalRead(storage, SCOPE, KEY, controller.signal);
    let nextEntered = false;
    const next = openPinnedLogicalRead(storage, SCOPE, KEY).then((pin) => { nextEntered = true; return pin; });
    controller.abort(new Error('cancel queued pin'));
    try {
      await expect(cancelled).rejects.toThrow('cancel queued pin');
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(nextEntered).toBe(false);
    } finally { release(); await sealing; }
    const pinned = await next;
    try { expect(await concatBytes(pinned.read())).toEqual(bytes); }
    finally { pinned.close(); }
  });

  it('seals a retained journal only through the last complete record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-retained-'));
    const sessionDir = join(root, 'session');
    const wirePath = join(sessionDir, 'agents', 'main', KEY);
    const complete = Buffer.from('{"type":"note","id":"kept"}\n');
    const partial = Buffer.from('{"type":"note","id":"tail"}');
    const bytes = Buffer.concat([complete, partial]);
    try {
      await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
      await writeFile(wirePath, bytes);
      const sealed = await sealRetainedJournal(wirePath, { segmentBytes: SEGMENT_BYTES });
      expect(sealed.sealedCut).toBe(complete.byteLength);
      expect(sealed.originalRetained).toBe(true);
      const storage = new FileStorageService(sessionDir);
      try {
        expect(await concatBytes(readLogicalBytes(storage, SCOPE, KEY))).toEqual(bytes);
      } finally {
        await storage.close();
      }
      expect(await readFile(wirePath)).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('compacts zstd format-2 journals with sparse reclamation, incremental segment reuse, checkpoint boundary sparing, and SHA-256 verified unseal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-zstd-sparse-'));
    const sessionDir = join(root, 'session');
    const agentDir = join(sessionDir, 'agents', 'main');
    const wirePath = join(agentDir, KEY);
    try {
      await mkdir(join(agentDir, 'replay-checkpoints'), { recursive: true });
      const lines: Buffer[] = [];
      let checkpointWireSize = 0;
      let runningBytes = 0;
      for (let i = 0; i < 180; i += 1) {
        const record = Buffer.from(`${JSON.stringify({
          type: 'note',
          id: `rec-${i}`,
          body: `REPEATED_SYSTEM_PROMPT_BLOCK_${'ABCD1234'.repeat(420)}_${i}`,
        })}\n`);
        lines.push(record);
        runningBytes += record.byteLength;
        if (i === 95) checkpointWireSize = runningBytes;
      }
      const initialBytes = Buffer.concat(lines);
      expect(initialBytes.byteLength).toBeGreaterThan(550 * 1024);
      const checkpointBoundaryExpected = initialBytes.subarray(checkpointWireSize - 4096, checkpointWireSize);
      await writeFile(wirePath, initialBytes);
      await writeFile(
        join(agentDir, 'replay-checkpoints', 'engine-v1'),
        JSON.stringify({
          format: 1,
          replayAbi: 3,
          wire: { size: checkpointWireSize, mtimeMs: 12345 },
          stateNames: [],
          graph: { nodes: [] },
        }),
      );

      const statBefore = await stat(wirePath, { bigint: true });
      const compacted1 = await compactRetainedJournal(wirePath, {
        segmentBytes: 128 * 1024,
        hotTailBytes: 64 * 1024,
      });
      expect(compacted1.skipped).toBe(false);
      expect(compacted1.seal?.format).toBe(2);
      expect(compacted1.seal?.codec).toBe('zstd');
      expect(compacted1.seal?.level).toBe(3);

      const statAfter = await stat(wirePath, { bigint: true });
      expect(statAfter.ino).toBe(statBefore.ino);
      expect(statAfter.size).toBe(statBefore.size);
      expect(statAfter.mtimeNs).toBe(statBefore.mtimeNs);
      expect(statAfter.ctimeNs).toBe(statBefore.ctimeNs);

      if (process.platform === 'win32') {
        expect(compacted1.seal?.originalRetained).toBe(false);
        expect((compacted1.seal?.sparseRanges?.length ?? 0)).toBeGreaterThan(0);
        expect(compacted1.physicalBytesAfter).toBeLessThan(Math.floor(compacted1.physicalBytesBefore * 0.6));

        const rawOnDisk = await readFile(wirePath);
        expect(rawOnDisk.subarray(0, 65536)).toEqual(initialBytes.subarray(0, 65536));
        expect(rawOnDisk.subarray(compacted1.seal!.sealedCut)).toEqual(initialBytes.subarray(compacted1.seal!.sealedCut));
        expect(rawOnDisk.subarray(checkpointWireSize - 4096, checkpointWireSize)).toEqual(checkpointBoundaryExpected);
        expect(rawOnDisk.subarray(65536, 131072).every((byte) => byte === 0)).toBe(true);
      }

      const storage = new FileStorageService(sessionDir);
      const log = createTestAppendLogStore(storage);
      disposables.add(log);
      try {
        expect(await concatBytes(readLogicalBytes(storage, SCOPE, KEY))).toEqual(initialBytes);

        for (let j = 0; j < 80; j += 1) {
          log.append(SCOPE, KEY, {
            type: 'note',
            id: `appended-${j}`,
            body: `APPENDED_BLOCK_${'WXYZ9876'.repeat(420)}_${j}`,
          } as unknown as WireRecord);
        }
        await log.flush();
      } finally {
        await log.dispose();
        await storage.close();
      }

      const expectedAfterAppend = Buffer.concat([
        initialBytes,
        Buffer.from(
          Array.from({ length: 80 }, (_, j) => `${JSON.stringify({
            type: 'note',
            id: `appended-${j}`,
            body: `APPENDED_BLOCK_${'WXYZ9876'.repeat(420)}_${j}`,
          })}\n`).join(''),
        ),
      ]);

      const compacted2 = await compactRetainedJournal(wirePath, {
        segmentBytes: 128 * 1024,
        hotTailBytes: 64 * 1024,
      });
      expect(compacted2.skipped).toBe(false);
      expect((compacted2.seal?.reusedSegmentCount ?? 0)).toBeGreaterThan(0);
      expect(compacted2.seal!.sealedCut).toBeGreaterThan(compacted1.seal!.sealedCut);
      expect((compacted2.seal?.segmentCount ?? 0)).toBeGreaterThan(compacted1.seal?.segmentCount ?? 0);

      const noopCompact = await compactRetainedJournal(wirePath, {
        segmentBytes: 128 * 1024,
        hotTailBytes: 64 * 1024,
      });
      expect(noopCompact.seal?.reusedSegmentCount).toBe(compacted2.seal?.segmentCount);

      const unsealed = await unsealRetainedJournal(wirePath);
      expect(unsealed.hadManifest).toBe(true);
      if (process.platform === 'win32') {
        expect(unsealed.restoredOriginal).toBe(true);
        expect(unsealed.verifiedSegments).toBe(compacted2.seal?.segmentCount);
      }
      const restoredDiskBytes = await readFile(wirePath);
      expect(createHash('sha256').update(restoredDiskBytes).digest('hex')).toBe(
        createHash('sha256').update(expectedAfterAppend).digest('hex'),
      );
      await expect(stat(`${wirePath}.segments.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('refuses to overwrite wire.jsonl or delete segments on unseal when a cold zstd segment is corrupted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-zstd-corrupt-'));
    const sessionDir = join(root, 'session');
    const agentDir = join(sessionDir, 'agents', 'main');
    const wirePath = join(agentDir, KEY);
    try {
      await mkdir(agentDir, { recursive: true });
      const payload = Buffer.from(
        Array.from({ length: 120 }, (_, i) => `${JSON.stringify({
          type: 'note',
          id: `item-${i}`,
          text: 'CORRUPT_GUARD_PAYLOAD_'.repeat(160),
        })}\n`).join(''),
      );
      await writeFile(wirePath, payload);
      const compacted = await compactRetainedJournal(wirePath, {
        segmentBytes: 128 * 1024,
        hotTailBytes: 64 * 1024,
      });
      expect(compacted.skipped).toBe(false);
      const segRoot = `${wirePath}.segments`;
      const [sealDir] = await readdir(segRoot);
      const [firstSeg] = await readdir(join(segRoot, sealDir!));
      const firstSegPath = join(segRoot, sealDir!, firstSeg!);
      const fh = await open(firstSegPath, 'r+');
      try {
        await fh.write(Buffer.from([0xff, 0x00, 0xaa, 0x55]), 0, 4, 0);
      } finally {
        await fh.close();
      }
      const storage = new FileStorageService(sessionDir);
      try {
        await expect(
          unsealColdSegments(storage, SCOPE, KEY, { forceRestoreOriginal: true }),
        ).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
      } finally {
        await storage.close();
      }
      expect((await stat(`${wirePath}.segments.json`)).isFile()).toBe(true);
      expect((await stat(firstSegPath)).isFile()).toBe(true);
    } finally {
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('runs idle cold compaction only on quiescent unlocked sessions and restores cleanly on unsealSession', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cold-idle-service-'));
    const wsId = 'wd_idle_test';
    const coldSessionId = 'session_11111111-1111-4111-8111-111111111111';
    const hotSessionId = 'session_22222222-2222-4222-8222-222222222222';
    const coldWirePath = join(homeDir, 'sessions', wsId, coldSessionId, 'agents', 'sub-1', KEY);
    const hotWirePath = join(homeDir, 'sessions', wsId, hotSessionId, 'agents', 'sub-1', KEY);
    const body = Buffer.from(
      Array.from({ length: 120 }, (_, i) => `${JSON.stringify({
        type: 'note',
        id: `idle-${i}`,
        text: 'IDLE_COMPACTION_PAYLOAD_'.repeat(160),
      })}\n`).join(''),
    );
    const storage = new FileStorageService(homeDir);
    let service: ColdCompactionService | undefined;
    try {
      await mkdir(join(homeDir, 'sessions', wsId, coldSessionId, 'agents', 'sub-1'), { recursive: true });
      await mkdir(join(homeDir, 'sessions', wsId, hotSessionId, 'agents', 'sub-1'), { recursive: true });
      await writeFile(coldWirePath, body);
      await writeFile(hotWirePath, body);

      const now = Date.now();
      const summaries: SessionSummary[] = [
        { id: hotSessionId, workspaceId: wsId, createdAt: now - 10_000, updatedAt: now - 5_000, archived: false },
        { id: coldSessionId, workspaceId: wsId, createdAt: now - 7_200_000, updatedAt: now - 3_600_000, archived: false },
      ];
      const bootstrap = {
        scope: (domain: string) => domain,
      } as unknown as IBootstrapService;
      const index = {
        get: async (id: string) => summaries.find((item) => item.id === id),
        listRecent: async () => ({ items: summaries }),
      } as unknown as ISessionIndex;
      const manager = {
        get: () => undefined,
        withLifecycleSerialization: async <T>(_id: string, work: () => Promise<T>) => work(),
      } as unknown as ISessionManager;

      service = new ColdCompactionService(bootstrap, storage, index, manager, {
        get: () => ({ enabled: false, minIdleAgeMs: 1_800_000, maxSessionsPerSweep: 1, reclaimSparse: true }),
      } as never);

      const count = await service.runIdlePass();
      if (process.platform === 'win32') {
        expect(count).toBe(1);
        expect(await allocatedFileBytes(coldWirePath)).toBeLessThan(body.byteLength);
      }
      expect((await stat(`${coldWirePath}.segments.json`)).isFile()).toBe(true);
      await expect(stat(`${hotWirePath}.segments.json`)).rejects.toMatchObject({ code: 'ENOENT' });

      const unsealed = await service.unsealSession(coldSessionId);
      expect(unsealed?.unsealedJournals).toBe(1);
      expect(await readFile(coldWirePath)).toEqual(body);
    } finally {
      await service?.dispose();
      await storage.close();
      closeSparseFileWorker();
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('preserves monotonic sealedCut across the 4 MiB main hot-tail cliff and clips sparseRanges on explicit backward reseals (P0-1)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-p0-1-'));
    const sessionDir = join(root, 'session');
    const agentDir = join(sessionDir, 'agents', 'main');
    const wirePath = join(agentDir, KEY);
    try {
      await mkdir(agentDir, { recursive: true });
      const lineStr = `${JSON.stringify({ type: 'note', text: 'MAIN_CLIFF_'.repeat(300) })}\n`;
      const initialCount = Math.ceil((3.5 * 1024 * 1024) / Buffer.byteLength(lineStr));
      const initialBuf = Buffer.from(lineStr.repeat(initialCount));
      expect(initialBuf.byteLength).toBeGreaterThan(3.4 * 1024 * 1024);
      expect(initialBuf.byteLength).toBeLessThan(3.8 * 1024 * 1024);
      await writeFile(wirePath, initialBuf);

      const first = await compactRetainedJournal(wirePath, { segmentBytes: 512 * 1024 });
      expect(first.skipped).toBe(false);
      expect(first.seal!.sealedCut).toBeGreaterThan(3 * 1024 * 1024);

      const extraCount = Math.ceil((650 * 1024) / Buffer.byteLength(lineStr));
      const extraBuf = Buffer.from(lineStr.repeat(extraCount));
      const grownBuf = Buffer.concat([initialBuf, extraBuf]);
      expect(grownBuf.byteLength).toBeGreaterThan(4.05 * 1024 * 1024);
      await writeFile(wirePath, grownBuf);

      const second = await compactRetainedJournal(wirePath, { segmentBytes: 512 * 1024 });
      expect(second.skipped).toBe(false);
      expect(second.seal!.sealedCut).toBeGreaterThanOrEqual(first.seal!.sealedCut);
      for (const range of second.seal!.sparseRanges ?? []) {
        expect(range.end).toBeLessThanOrEqual(second.seal!.sealedCut);
      }

      const storage = new FileStorageService(sessionDir);
      try {
        expect(await concatBytes(readLogicalBytes(storage, SCOPE, KEY))).toEqual(grownBuf);

        const smallerTarget = Buffer.byteLength(lineStr) * Math.floor(initialCount / 2);
        const shrunkSeal = await sealColdSegments(storage, SCOPE, KEY, smallerTarget, {
          codec: 'zstd',
          level: 3,
          segmentBytes: 512 * 1024,
          reclaim: true,
        });
        expect(shrunkSeal.sealedCut).toBe(smallerTarget);
        for (const range of shrunkSeal.sparseRanges ?? []) {
          expect(range.end).toBeLessThanOrEqual(smallerTarget);
        }
        expect(await concatBytes(readLogicalBytes(storage, SCOPE, KEY))).toEqual(grownBuf);
      } finally {
        await storage.close();
      }
    } finally {
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps cold sparse journal intact and readable when AppendLogStore.rewrite fails mid-write with ENOSPC (P0-2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-p0-2-'));
    const sessionDir = join(root, 'session');
    const agentDir = join(sessionDir, 'agents', 'main');
    const wirePath = join(agentDir, KEY);
    try {
      await mkdir(agentDir, { recursive: true });
      const records = Array.from({ length: 220 }, (_, i) => ({
        type: 'note',
        id: `orig-${i}`,
        text: `REWRITE_SAFE_${'ABCD'.repeat(350)}_${i}`,
      }));
      const expectedBytes = Buffer.from(records.map((rec) => `${JSON.stringify(rec)}\n`).join(''));
      await writeFile(wirePath, expectedBytes);

      const compacted = await compactRetainedJournal(wirePath, {
        segmentBytes: 128 * 1024,
        hotTailBytes: 64 * 1024,
      });
      expect(compacted.skipped).toBe(false);

      const failingStorage = new (class extends FileStorageService {
        override async writeStream(
          scope: string,
          key: string,
          stream: AsyncIterable<Uint8Array>,
          options?: StorageWriteOptions,
        ): Promise<void> {
          if (scope === SCOPE && key === KEY) {
            for await (const _chunk of stream) {
              throw new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'simulated ENOSPC during rewrite');
            }
          }
          return super.writeStream(scope, key, stream, options);
        }
      })(sessionDir);
      const failingLog = createTestAppendLogStore(failingStorage);
      disposables.add(failingLog);
      try {
        await expect(
          failingLog.rewrite(SCOPE, KEY, [{ type: 'note', id: 'replacement' } as unknown as WireRecord]),
        ).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_DISK_FULL });
      } finally {
        await failingLog.dispose();
        await failingStorage.close();
      }

      const verifyStorage = new FileStorageService(sessionDir);
      try {
        expect(await concatBytes(readLogicalBytes(verifyStorage, SCOPE, KEY))).toEqual(expectedBytes);
      } finally {
        await verifyStorage.close();
      }
    } finally {
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('preserves originalRetained: false when sparse punching fails after zeroing an initial range and recovers on unseal (P0-3)', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'cold-p0-3-'));
    const sessionDir = join(root, 'session');
    const agentDir = join(sessionDir, 'agents', 'main');
    const wirePath = join(agentDir, KEY);
    try {
      await mkdir(agentDir, { recursive: true });
      const lines = Array.from({ length: 220 }, (_, i) => `${JSON.stringify({
        type: 'note',
        id: `p03-${i}`,
        text: `PARTIAL_PUNCH_PAYLOAD_${'9876543210'.repeat(220)}_${i}`,
      })}\n`);
      const originalBytes = Buffer.from(lines.join(''));
      await writeFile(wirePath, originalBytes);

      const midOffset = 256 * 1024 + 2048;
      await mkdir(join(agentDir, 'replay-checkpoints'), { recursive: true });
      await writeFile(
        join(agentDir, 'replay-checkpoints', 'engine-v1'),
        JSON.stringify({ format: 1, wire: { size: midOffset } }),
      );

      _setSparsePunchOverrideForTests(async (filePath, ranges, defaultPunch) => {
        expect(ranges.length).toBeGreaterThanOrEqual(2);
        const partial = await defaultPunch(filePath, [ranges[0]!]);
        expect(partial.status).toBe('punched');
        return {
          status: 'mutated_or_unknown',
          supported: true,
          punchedRanges: ranges,
          allocatedBytesBefore: partial.allocatedBytesBefore,
          allocatedBytesAfter: partial.allocatedBytesAfter,
          error: 'simulated failure on second sparse range',
        };
      });

      await expect(
        compactRetainedJournal(wirePath, {
          segmentBytes: 128 * 1024,
          hotTailBytes: 64 * 1024,
        }),
      ).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_IO_FAILED });
      _setSparsePunchOverrideForTests(undefined);

      const rawAfterPartial = await readFile(wirePath);
      expect(rawAfterPartial.subarray(65536, 131072).every((b) => b === 0)).toBe(true);

      const manifestOnDisk = JSON.parse(await readFile(`${wirePath}.segments.json`, 'utf8')) as {
        originalRetained: boolean;
      };
      expect(manifestOnDisk.originalRetained).toBe(false);

      const storage = new FileStorageService(sessionDir);
      try {
        expect(await concatBytes(readLogicalBytes(storage, SCOPE, KEY))).toEqual(originalBytes);
      } finally {
        await storage.close();
      }

      const unsealed = await unsealRetainedJournal(wirePath);
      expect(unsealed.restoredOriginal).toBe(true);
      expect(await readFile(wirePath)).toEqual(originalBytes);
    } finally {
      _setSparsePunchOverrideForTests(undefined);
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('propagates manifest read/corruption errors without compressing holes, restores dense bytes on --no-reclaim, and guards engine-v1 offsets (P0-4, P2-2, P2-5)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-p0-4-'));
    const sessionDir = join(root, 'session');
    const agentDir = join(sessionDir, 'agents', 'main');
    const wirePath = join(agentDir, KEY);
    try {
      await mkdir(join(agentDir, 'replay-checkpoints'), { recursive: true });
      const lines = Array.from({ length: 180 }, (_, i) => `${JSON.stringify({
        type: 'note',
        id: `p04-${i}`,
        text: `MANIFEST_GUARD_${'LMNOPQRS'.repeat(240)}_${i}`,
      })}\n`);
      const originalBytes = Buffer.from(lines.join(''));
      await writeFile(wirePath, originalBytes);

      const checkpointWireOffset = 196608 + 1024;
      const expectedBoundary = originalBytes.subarray(checkpointWireOffset - 4096, checkpointWireOffset);
      await writeFile(
        join(agentDir, 'replay-checkpoints', 'engine-v1'),
        JSON.stringify({
          format: 1,
          paddingStatesBeforeWire: 'S'.repeat(6000),
          wire: { size: checkpointWireOffset },
        }),
      );

      const compacted = await compactRetainedJournal(wirePath, {
        segmentBytes: 128 * 1024,
        hotTailBytes: 64 * 1024,
      });
      expect(compacted.skipped).toBe(false);
      if (process.platform === 'win32') {
        const rawDisk = await readFile(wirePath);
        expect(rawDisk.subarray(checkpointWireOffset - 4096, checkpointWireOffset)).toEqual(expectedBoundary);
      }

      const ioFailStorage = new (class extends FileStorageService {
        override async read(scope: string, key: string, options?: StorageReadOptions): Promise<Uint8Array | undefined> {
          if (key === coldManifestKey(KEY)) {
            throw new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'simulated EIO reading manifest');
          }
          return super.read(scope, key, options);
        }
      })(sessionDir);
      try {
        await expect(
          sealColdSegments(ioFailStorage, SCOPE, KEY, compacted.seal!.sealedCut, {
            codec: 'zstd',
            level: 3,
            segmentBytes: 128 * 1024,
            reclaim: true,
          }),
        ).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_IO_FAILED });
      } finally {
        await ioFailStorage.close();
      }

      const savedManifestBytes = await readFile(`${wirePath}.segments.json`);
      await writeFile(`${wirePath}.segments.json`, '{"format":2,"originalRetained":false}');
      await expect(unsealRetainedJournal(wirePath)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      await expect(discardRetainedJournal(wirePath)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      await writeFile(`${wirePath}.segments.json`, savedManifestBytes);

      const denseAgain = await compactRetainedJournal(wirePath, {
        segmentBytes: 128 * 1024,
        hotTailBytes: 64 * 1024,
        reclaim: false,
      });
      expect(denseAgain.seal?.originalRetained).toBe(true);
      expect(await readFile(wirePath)).toEqual(originalBytes);

      await unsealRetainedJournal(wirePath);
      await writeFile(join(agentDir, 'replay-checkpoints', 'engine-v1'), '{unparseable-checkpoint');
      const safeFallback = await compactRetainedJournal(wirePath, {
        segmentBytes: 128 * 1024,
        hotTailBytes: 64 * 1024,
        reclaim: true,
      });
      expect(safeFallback.seal?.originalRetained).toBe(true);
      expect(await readFile(wirePath)).toEqual(originalBytes);
    } finally {
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('holds off first sparse punch until an already-open unsealed logical reader closes (P1-1)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-p1-1-'));
    const sessionDir = join(root, 'session');
    const agentDir = join(sessionDir, 'agents', 'main');
    const wirePath = join(agentDir, KEY);
    const storage = new FileStorageService(sessionDir);
    try {
      await mkdir(agentDir, { recursive: true });
      const lines = Array.from({ length: 200 }, (_, i) => `${JSON.stringify({
        type: 'note',
        id: `p11-${i}`,
        text: `DENSE_READER_RACE_${'UVWXYZ'.repeat(280)}_${i}`,
      })}\n`);
      const expected = Buffer.from(lines.join(''));
      await writeFile(wirePath, expected);

      const pinned = await openPinnedLogicalRead(storage, SCOPE, KEY);
      expect(pinned.sealed).toBe(false);
      const iterator = pinned.read(undefined, { chunkBytes: 32 * 1024 })[Symbol.asyncIterator]();
      const firstStep = await iterator.next();
      expect(firstStep.done).toBe(false);

      let compactSettled = false;
      const compacting = compactRetainedJournal(wirePath, {
        segmentBytes: 128 * 1024,
        hotTailBytes: 64 * 1024,
      }).then((res) => {
        compactSettled = true;
        return res;
      });

      await new Promise((r) => setTimeout(r, 80));
      if (process.platform === 'win32') {
        expect(compactSettled).toBe(false);
      }

      const chunks: Uint8Array[] = [firstStep.value];
      for (;;) {
        const nextStep = await iterator.next();
        if (nextStep.done) break;
        chunks.push(nextStep.value);
      }
      pinned.close();

      const compacted = await compacting;
      expect(compacted.skipped).toBe(false);
      expect(Buffer.concat(chunks.map((c) => Buffer.from(c)))).toEqual(expected);
    } finally {
      await storage.close();
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it('writes dense logical bytes into wire.jsonl.bak when repairing a sparse-compacted journal with a truncated tail (P1-2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-p1-2-'));
    const sessionDir = join(root, 'session');
    const agentDir = join(sessionDir, 'agents', 'main');
    const wirePath = join(agentDir, KEY);
    const storage = new FileStorageService(sessionDir);
    const log = createTestAppendLogStore(storage);
    disposables.add(log);
    try {
      await mkdir(agentDir, { recursive: true });
      const validRecords = Array.from({ length: 220 }, (_, i) => ({
        type: 'note',
        id: `valid-${i}`,
        text: `REPAIR_LOGICAL_BACKUP_${'KLMN'.repeat(350)}_${i}`,
      }));
      const validBytes = Buffer.from(validRecords.map((r) => `${JSON.stringify(r)}\n`).join(''));
      await writeFile(wirePath, validBytes);

      const compacted = await compactRetainedJournal(wirePath, {
        segmentBytes: 128 * 1024,
        hotTailBytes: 64 * 1024,
      });
      expect(compacted.skipped).toBe(false);

      const corruptTail = Buffer.from('{"type":"note","broken":');
      const fh = await open(wirePath, 'a');
      try {
        await fh.write(corruptTail);
      } finally {
        await fh.close();
      }

      const outcome = await repairWireJournal(
        {
          appendLog: log,
          storage,
          log: noopLogger,
          telemetry: noopTelemetryService,
        },
        SCOPE,
        KEY,
        validRecords,
        { lineNumber: validRecords.length + 1, reason: 'truncated' },
      );
      expect(outcome).toBe('repaired');

      const backupBytes = await storage.read(SCOPE, wireJournalBackupKey(KEY));
      expect(backupBytes).toBeDefined();
      expect(Buffer.from(backupBytes!)).toEqual(Buffer.concat([validBytes, corruptTail]));
      expect(Buffer.from(backupBytes!).includes(0)).toBe(false);
      expect(await concatBytes(readLogicalBytes(storage, SCOPE, KEY))).toEqual(validBytes);
    } finally {
      await log.dispose();
      await storage.close();
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it('preempts idle compaction in <100 ms on foreground session access and advances sweepCursor across sweeps (P1-5, P2-4)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cold-p1-5-'));
    const wsId = 'wd_preempt';
    const s1 = 'session_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const s2 = 'session_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const s3 = 'session_cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const s4 = 'session_dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const payload = Buffer.from(
      Array.from({ length: 240 }, (_, i) => `${JSON.stringify({
        type: 'note',
        id: `preempt-${i}`,
        text: `${i.toString(36)}_${'PREEMPT_PAYLOAD_'.repeat(240)}`,
      })}\n`).join(''),
    );
    const storage = new FileStorageService(homeDir);
    let service: ColdCompactionService | undefined;
    try {
      for (const sid of [s1, s2, s3, s4]) {
        for (let a = 0; a < (sid === s1 ? 8 : 1); a += 1) {
          const dir = join(homeDir, 'sessions', wsId, sid, 'agents', `sub-${a}`);
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, KEY), payload);
        }
      }

      const now = Date.now();
      const summaries: SessionSummary[] = [
        { id: s1, workspaceId: wsId, createdAt: now - 9_000_000, updatedAt: now - 5_000_000, archived: false },
        { id: s2, workspaceId: wsId, createdAt: now - 9_000_000, updatedAt: now - 6_000_000, archived: false },
        { id: s3, workspaceId: wsId, createdAt: now - 9_000_000, updatedAt: now - 7_000_000, archived: false },
        { id: s4, workspaceId: wsId, createdAt: now - 9_000_000, updatedAt: now - 8_000_000, archived: false },
      ];
      let listCalls = 0;
      const willAccess = new Emitter<string>();
      const bootstrap = { scope: (domain: string) => domain } as unknown as IBootstrapService;
      const index = {
        get: async (id: string) => summaries.find((item) => item.id === id),
        listRecent: async (opts?: { beforePosition?: { updatedAt: number; id: string }; limit?: number }) => {
          listCalls += 1;
          const startIdx = opts?.beforePosition === undefined
            ? 0
            : summaries.findIndex((item) => item.id === opts.beforePosition!.id) + 1;
          const slice = summaries.slice(startIdx, startIdx + (opts?.limit ?? 32));
          return {
            items: slice,
            nextCursor: startIdx + slice.length < summaries.length ? 'more' : undefined,
          };
        },
      } as unknown as ISessionIndex;
      const manager = {
        onWillAccessSession: willAccess.event,
        get: () => undefined,
        withLifecycleSerialization: async <T>(_id: string, work: () => Promise<T>) => work(),
      } as unknown as ISessionManager;

      let reclaimSparse = true;
      service = new ColdCompactionService(bootstrap, storage, index, manager, {
        get: () => ({ enabled: false, minIdleAgeMs: 1_800_000, maxSessionsPerSweep: 1, reclaimSparse }),
      } as never);

      const s1Scope = `sessions/${wsId}/${s1}`;
      const sweepPromise = service.runIdlePass(1);
      while (true) {
        let probe: { release(): Promise<void> } | undefined;
        try {
          probe = await storage.acquireLock(SESSION_LOCK_SCOPE, sessionLockKey(s1Scope), { waitForMs: 0 });
          await probe.release();
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 2));
      }

      const t0 = performance.now();
      willAccess.fire(s1);
      const fgLock = await storage.acquireLock(SESSION_LOCK_SCOPE, sessionLockKey(s1Scope), { waitForMs: 2_000 });
      const elapsedMs = performance.now() - t0;
      await fgLock.release();
      expect(elapsedMs).toBeLessThan(100);
      expect(await sweepPromise).toBe(1);
      expect((await stat(join(homeDir, 'sessions', wsId, s2, 'agents', 'sub-0', `${KEY}.segments.json`))).isFile()).toBe(true);

      reclaimSparse = false;
      const pass2Count = await service.runIdlePass(1);
      expect(pass2Count).toBe(1);
      expect((await stat(join(homeDir, 'sessions', wsId, s3, 'agents', 'sub-0', `${KEY}.segments.json`))).isFile()).toBe(true);

      const pass3Count = await service.runIdlePass(1);
      expect(pass3Count).toBe(1);
      expect(listCalls).toBeGreaterThanOrEqual(3);
      expect((await stat(join(homeDir, 'sessions', wsId, s4, 'agents', 'sub-0', `${KEY}.segments.json`))).isFile()).toBe(true);
    } finally {
      await service?.dispose();
      await storage.close();
      closeSparseFileWorker();
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps AppendLogStore.rewrite() crash-atomic across every fault-injection boundary and clears FILE_ATTRIBUTE_SPARSE_FILE on unseal (Round-2 #2, #3, #5)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-r2-rewrite-'));
    const oldRecords: WireRecord[] = Array.from({ length: 180 }, (_, idx) => ({
      type: 'note',
      id: `old-${idx}`,
      body: `OLD_PAYLOAD_${idx}_${'A'.repeat(1_850)}`,
    }));
    const newRecords: WireRecord[] = Array.from({ length: 75 }, (_, idx) => ({
      type: 'note',
      id: `new-${idx}`,
      body: `NEW_PAYLOAD_${idx}_${'B'.repeat(1_250)}`,
    }));
    const oldBytes = Buffer.from(oldRecords.map((rec) => `${JSON.stringify(rec)}\n`).join(''));
    const newBytes = Buffer.from(newRecords.map((rec) => `${JSON.stringify(rec)}\n`).join(''));

    const createSealedCase = async (subName: string): Promise<{ dir: string; wirePath: string }> => {
      const dir = join(root, subName);
      await mkdir(join(dir, SCOPE), { recursive: true });
      const wirePath = join(dir, SCOPE, KEY);
      await writeFile(wirePath, oldBytes);
      const compacted = await compactRetainedJournal(wirePath, {
        codec: 'zstd',
        reclaim: true,
        segmentBytes: 64 * 1024,
        hotTailBytes: 32 * 1024,
      });
      expect(compacted.skipped).toBe(false);
      expect(compacted.seal).toBeDefined();
      if (process.platform === 'win32') {
        expect(compacted.seal?.originalRetained).toBe(false);
        expect(await queryWin32SparseAttribute(wirePath)).toBe('sparse');
        expect((await stat(`${wirePath}.sparse`)).isFile()).toBe(true);
      }
      return { dir, wirePath };
    };

    const verifyReopenedJournal = async (dir: string): Promise<'old' | 'new'> => {
      const checkStorage = new FileStorageService(dir);
      const checkLog = createTestAppendLogStore(checkStorage);
      try {
        const reopenedRecords = await collect(checkLog);
        const logical = await concatBytes(readLogicalBytes(checkStorage, SCOPE, KEY));
        if (Buffer.compare(logical, oldBytes) === 0) {
          expect(reopenedRecords).toEqual(oldRecords);
          return 'old';
        }
        expect(Buffer.compare(logical, newBytes)).toBe(0);
        expect(reopenedRecords).toEqual(newRecords);
        return 'new';
      } finally {
        await checkLog.dispose();
        await checkStorage.close();
      }
    };

    try {
      const unsealCase = await createSealedCase('unseal-dense');
      const beforeMtime = (await stat(unsealCase.wirePath)).mtimeMs;
      await unsealRetainedJournal(unsealCase.wirePath);
      if (process.platform === 'win32') {
        expect(await queryWin32SparseAttribute(unsealCase.wirePath)).toBe('dense');
      }
      await expect(stat(`${unsealCase.wirePath}.sparse`)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(`${unsealCase.wirePath}.segments.json`)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(`${unsealCase.wirePath}.segments`)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(Math.abs((await stat(unsealCase.wirePath)).mtimeMs - beforeMtime)).toBeLessThan(5);
      expect(await readFile(unsealCase.wirePath)).toEqual(oldBytes);

      {
        const caseA = await createSealedCase('fault-before-unseal');
        class FailSegmentReadStorage extends FileStorageService {
          override async read(scope: string, key: string, options?: StorageReadOptions): Promise<Uint8Array | undefined> {
            if (key.includes('.segments/') && key.endsWith('.zst')) {
              throw new Error('simulated crash reading segment during unseal');
            }
            return super.read(scope, key, options);
          }
        }
        const st = new FailSegmentReadStorage(caseA.dir);
        const lg = createTestAppendLogStore(st);
        await expect(lg.rewrite(SCOPE, KEY, newRecords)).rejects.toThrow('simulated crash reading segment');
        await lg.dispose();
        await st.close();
        expect(await verifyReopenedJournal(caseA.dir)).toBe('old');
      }

      {
        const caseB = await createSealedCase('fault-after-unseal-before-writestream');
        class FailBeforeWriteStreamStorage extends FileStorageService {
          override async writeStream(
            scope: string,
            key: string,
            chunks: AsyncIterable<Uint8Array>,
            options?: StorageWriteOptions,
          ): Promise<void> {
            if (key === KEY) {
              expect(options?.preserveDestinationOnError).toBe(true);
              throw new Error('simulated crash after unseal before replacement stream');
            }
            return super.writeStream(scope, key, chunks, options);
          }
        }
        const st = new FailBeforeWriteStreamStorage(caseB.dir);
        const lg = createTestAppendLogStore(st);
        await expect(lg.rewrite(SCOPE, KEY, newRecords)).rejects.toThrow('simulated crash after unseal');
        await lg.dispose();
        await st.close();
        if (process.platform === 'win32') {
          expect(await queryWin32SparseAttribute(caseB.wirePath)).toBe('dense');
        }
        await expect(stat(`${caseB.wirePath}.segments.json`)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(`${caseB.wirePath}.sparse`)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await verifyReopenedJournal(caseB.dir)).toBe('old');
      }

      {
        const caseC = await createSealedCase('fault-mid-staging');
        class FailMidStreamStorage extends FileStorageService {
          override async writeStream(
            scope: string,
            key: string,
            chunks: AsyncIterable<Uint8Array>,
            options?: StorageWriteOptions,
          ): Promise<void> {
            if (key === KEY) {
              async function* partial(): AsyncGenerator<Uint8Array> {
                let emitted = 0;
                for await (const chunk of chunks) {
                  yield chunk;
                  emitted += chunk.byteLength;
                  if (emitted > 8_192) throw new Error('simulated mid-staging crash');
                }
              }
              return super.writeStream(scope, key, partial(), options);
            }
            return super.writeStream(scope, key, chunks, options);
          }
        }
        const st = new FailMidStreamStorage(caseC.dir);
        const lg = createTestAppendLogStore(st);
        await expect(lg.rewrite(SCOPE, KEY, newRecords)).rejects.toMatchObject({
          code: StorageErrors.codes.STORAGE_IO_FAILED,
        });
        await lg.dispose();
        await st.close();
        const leftovers = (await readdir(join(caseC.dir, SCOPE))).filter((name) => name.includes('.stage.'));
        expect(leftovers).toEqual([]);
        expect(await verifyReopenedJournal(caseC.dir)).toBe('old');
      }

      if (process.platform === 'win32') {
        const caseD = await createSealedCase('fault-sharing-violation');
        const shareBlockerSealed = new DatabaseSync(caseD.wirePath, { readOnly: true });
        try {
          const st = new FileStorageService(caseD.dir);
          const lg = createTestAppendLogStore(st);
          await expect(lg.rewrite(SCOPE, KEY, newRecords)).rejects.toThrow();
          await lg.dispose();
          await st.close();
        } finally {
          shareBlockerSealed.close();
        }
        expect(await verifyReopenedJournal(caseD.dir)).toBe('old');

        await unsealRetainedJournal(caseD.wirePath);
        const shareBlockerDense = new DatabaseSync(caseD.wirePath, { readOnly: true });
        try {
          await expect(
            atomicWrite(caseD.wirePath, newBytes, undefined, undefined, undefined, true),
          ).rejects.toThrow();
          const st = new FileStorageService(caseD.dir);
          const lg = createTestAppendLogStore(st);
          await expect(lg.rewrite(SCOPE, KEY, newRecords)).rejects.toThrow();
          await lg.dispose();
          await st.close();
        } finally {
          shareBlockerDense.close();
        }
        expect((await stat(caseD.wirePath)).isFile()).toBe(true);
        expect(await verifyReopenedJournal(caseD.dir)).toBe('old');
      }

      {
        const caseE = await createSealedCase('fault-during-generation-write');
        class FailGenerationWriteStorage extends FileStorageService {
          override async write(
            scope: string,
            key: string,
            data: Uint8Array,
            options?: StorageWriteOptions,
          ): Promise<void> {
            if (key === `${KEY}.generation`) {
              expect(options?.preserveDestinationOnError).toBe(true);
              throw new Error('simulated crash during .generation commit');
            }
            return super.write(scope, key, data, options);
          }
        }
        const st = new FailGenerationWriteStorage(caseE.dir);
        const lg = createTestAppendLogStore(st);
        await expect(lg.rewrite(SCOPE, KEY, newRecords)).rejects.toThrow('simulated crash during .generation commit');
        await lg.dispose();
        await st.close();
        await expect(stat(`${caseE.wirePath}.segments.json`)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(`${caseE.wirePath}.sparse`)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await verifyReopenedJournal(caseE.dir)).toBe('old');
      }

      {
        const caseF = await createSealedCase('fault-after-generation-before-writestream');
        let genWritten = false;
        class FailAfterGenerationStorage extends FileStorageService {
          override async write(
            scope: string,
            key: string,
            data: Uint8Array,
            options?: StorageWriteOptions,
          ): Promise<void> {
            await super.write(scope, key, data, options);
            if (key === `${KEY}.generation`) genWritten = true;
          }

          override async writeStream(
            scope: string,
            key: string,
            chunks: AsyncIterable<Uint8Array>,
            options?: StorageWriteOptions,
          ): Promise<void> {
            if (key === KEY) {
              expect(genWritten).toBe(true);
              throw new Error('simulated crash after .generation write before wire replace');
            }
            return super.writeStream(scope, key, chunks, options);
          }
        }
        const st = new FailAfterGenerationStorage(caseF.dir);
        const lg = createTestAppendLogStore(st);
        await expect(lg.rewrite(SCOPE, KEY, newRecords)).rejects.toThrow(
          'simulated crash after .generation write before wire replace',
        );
        await lg.dispose();
        await st.close();
        await expect(stat(`${caseF.wirePath}.segments.json`)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(`${caseF.wirePath}.sparse`)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await verifyReopenedJournal(caseF.dir)).toBe('old');
      }

      {
        const caseG = await createSealedCase('rewrite-complete');
        const st = new FileStorageService(caseG.dir);
        const lg = createTestAppendLogStore(st);
        await lg.rewrite(SCOPE, KEY, newRecords);
        await lg.dispose();
        await st.close();
        await expect(stat(`${caseG.wirePath}.segments.json`)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(`${caseG.wirePath}.sparse`)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await verifyReopenedJournal(caseG.dir)).toBe('new');
      }
    } finally {
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it('drains active dense pinned readers before rewrite() and keeps dense FileHandle pins revision-consistent (Round-2 #4)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-r2-dense-pin-'));
    const storage = new FileStorageService(root);
    const log = createTestAppendLogStore(storage);
    try {
      const oldRecords: WireRecord[] = Array.from({ length: 120 }, (_, idx) => ({
        type: 'note',
        id: `dense-old-${idx}`,
        body: `DENSE_OLD_${idx}_${'X'.repeat(1_500)}`,
      }));
      const newRecords: WireRecord[] = Array.from({ length: 80 }, (_, idx) => ({
        type: 'note',
        id: `dense-new-${idx}`,
        body: `DENSE_NEW_${idx}_${'Y'.repeat(1_100)}`,
      }));
      await log.append(SCOPE, KEY, oldRecords);
      await log.flush(SCOPE, KEY);

      const wirePath = join(root, SCOPE, KEY);
      const oldBytes = await readFile(wirePath);
      const half = Math.floor(oldBytes.byteLength / 2);

      const pinned = await openPinnedLogicalRead(storage, SCOPE, KEY);
      expect(pinned.size).toBe(oldBytes.byteLength);
      const page1 = await concatBytes(pinned.read({ start: 0, end: half - 1 }));
      expect(page1).toEqual(oldBytes.subarray(0, half));

      let rewriteDone = false;
      const rewritePromise = log.rewrite(SCOPE, KEY, newRecords).then(() => {
        rewriteDone = true;
      });
      await new Promise((r) => setTimeout(r, 40));
      expect(rewriteDone).toBe(false);

      const page2 = await concatBytes(pinned.read({ start: half, end: oldBytes.byteLength - 1 }));
      expect(page2).toEqual(oldBytes.subarray(half));

      await pinned.close();
      await rewritePromise;
      expect(rewriteDone).toBe(true);

      const newBytes = await readFile(wirePath);
      const pinnedAfter = await openPinnedLogicalRead(storage, SCOPE, KEY);
      try {
        expect(await concatBytes(pinnedAfter.read())).toEqual(newBytes);
      } finally {
        await pinnedAfter.close();
      }
    } finally {
      await log.dispose();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('reaps .reader leases from terminated worker_threads workers via threadId liveness and retries failed unlinks (Round-2 #6)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-r2-worker-lease-'));
    const wirePath = join(root, KEY);
    const payload = Buffer.from(
      Array.from({ length: 180 }, (_, i) => `${JSON.stringify({
        type: 'note',
        id: `wl-${i}`,
        text: `WORKER_LEASE_${i}_${'Z'.repeat(1_600)}`,
      })}\n`).join(''),
    );
    await writeFile(wirePath, payload);

    let worker1: Worker | undefined;
    let worker2: Worker | undefined;
    try {
      const probeLease = await acquireSharedReadLease(wirePath);
      const readersDir = sharedReadDirectory(wirePath);
      const probeFiles = await readdir(readersDir);
      expect(probeFiles.length).toBe(1);
      const templatePayload = JSON.parse(await readFile(join(readersDir, probeFiles[0]!), 'utf8')) as Record<
        string,
        unknown
      >;
      await probeLease.release();

      worker1 = new Worker(
        `
        const { threadId, parentPort } = require('node:worker_threads');
        process.on('workerMessage', () => {});
        parentPort.postMessage({ threadId });
        setInterval(() => {}, 10000);
        `,
        { eval: true },
      );
      const { threadId: tid1 } = await new Promise<{ threadId: number }>((resolveMsg, rejectMsg) => {
        worker1!.once('message', resolveMsg);
        worker1!.once('error', rejectMsg);
      });
      const orphanLeaseFile = join(readersDir, `${process.pid}-untracked-${tid1}.reader`);
      await mkdir(readersDir, { recursive: true });
      await writeFile(
        orphanLeaseFile,
        JSON.stringify({
          ...templatePayload,
          threadId: tid1,
          token: `untracked-${tid1}`,
        }),
        'utf8',
      );

      await expect(waitSharedReadIdle(wirePath, AbortSignal.timeout(80))).rejects.toThrow();

      await worker1.terminate();
      worker1 = undefined;

      await waitSharedReadIdle(wirePath, AbortSignal.timeout(2_000));
      await expect(stat(orphanLeaseFile)).rejects.toMatchObject({ code: 'ENOENT' });

      worker2 = new Worker(
        `
        const { threadId, parentPort } = require('node:worker_threads');
        process.on('workerMessage', () => {});
        parentPort.postMessage({ threadId });
        setInterval(() => {}, 10000);
        `,
        { eval: true },
      );
      const { threadId: tid2 } = await new Promise<{ threadId: number }>((resolveMsg, rejectMsg) => {
        worker2!.once('message', resolveMsg);
        worker2!.once('error', rejectMsg);
      });
      trackReaderWorkerThread(worker2, wirePath);
      const trackedLeaseFile = join(readersDir, `${process.pid}-tracked-${tid2}.reader`);
      await mkdir(readersDir, { recursive: true });
      await writeFile(
        trackedLeaseFile,
        JSON.stringify({
          ...templatePayload,
          threadId: tid2,
          token: `tracked-${tid2}`,
        }),
        'utf8',
      );
      await worker2.terminate();
      worker2 = undefined;
      await vi.waitFor(async () => {
        await expect(stat(trackedLeaseFile)).rejects.toMatchObject({ code: 'ENOENT' });
      }, { timeout: 2_000 });

      if (process.platform === 'win32') {
        const retryLease = await acquireSharedReadLease(wirePath);
        const activeFiles = (await readdir(readersDir)).filter((name) => name.endsWith('.reader'));
        expect(activeFiles.length).toBe(1);
        const heldLeasePath = join(readersDir, activeFiles[0]!);
        const leaseBlocker = new DatabaseSync(heldLeasePath, { readOnly: true });
        try {
          await retryLease.release();
          expect((await stat(heldLeasePath)).isFile()).toBe(true);
        } finally {
          leaseBlocker.close();
        }
        await waitSharedReadIdle(wirePath, AbortSignal.timeout(2_000));
        await expect(stat(heldLeasePath)).rejects.toMatchObject({ code: 'ENOENT' });
      }

      const compacted = await compactRetainedJournal(wirePath, {
        codec: 'zstd',
        reclaim: true,
        segmentBytes: 64 * 1024,
        hotTailBytes: 32 * 1024,
      });
      expect(compacted.skipped).toBe(false);
      expect(compacted.seal).toBeDefined();
    } finally {
      await worker1?.terminate();
      await worker2?.terminate();
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('hands off SESSION_LOCK_SCOPE to real SessionManager.resume(waitForMs=0) when ColdCompactionService is parked on a held reader (Round-2 #7)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cold-r2-handoff-'));
    const wsId = 'wd_handoff';
    const sessionId = 'session_11111111-2222-4333-8444-555555555555';
    const sessionScope = `sessions/${wsId}/${sessionId}`;
    const agentScope = `${sessionScope}/agents/main`;
    const agentDir = join(homeDir, 'sessions', wsId, sessionId, 'agents', 'main');
    await mkdir(agentDir, { recursive: true });

    const initialBytes = Buffer.from(
      Array.from({ length: 180 }, (_, i) => `${JSON.stringify({
        type: 'note',
        id: `init-${i}`,
        text: `INIT_SEAL1_${i}_${'M'.repeat(1_750)}`,
      })}\n`).join(''),
    );
    const appendedBytes = Buffer.from(
      Array.from({ length: 120 }, (_, i) => `${JSON.stringify({
        type: 'note',
        id: `app-${i}`,
        text: `APPEND_SEAL2_${i}_${'N'.repeat(1_750)}`,
      })}\n`).join(''),
    );
    const wirePath = join(agentDir, KEY);
    await writeFile(wirePath, initialBytes);

    const storage = new FileStorageService(homeDir);
    const disposables = new DisposableStore();
    let coldService: ColdCompactionService | undefined;
    let heldSessionLock: { release(): Promise<void> } | undefined;
    let pinnedOldSeal: Awaited<ReturnType<typeof openPinnedLogicalRead>> | undefined;
    try {
      const now = Date.now();
      let summary: SessionSummary = {
        id: sessionId,
        workspaceId: wsId,
        createdAt: now - 9_000_000,
        updatedAt: now - 5_000_000,
        archived: false,
      };
      const didCreate = new Emitter<SessionCreatedEvent>();
      disposables.add(didCreate);
      const fakeController = {
        onWillCreateSession: Event.None,
        onDidCreateSession: didCreate.event,
        onWillCloseSession: Event.None,
        onDidCloseSession: Event.None,
        onDidArchiveSession: Event.None,
        onDidForkSession: Event.None,
        create: async () => ({ id: sessionId }) as ISessionScopeHandle,
        get: () => undefined,
        list: () => [],
        resume: async (id: string) => {
          heldSessionLock = await storage.acquireLock(SESSION_LOCK_SCOPE, sessionLockKey(sessionScope), {
            waitForMs: 0,
          });
          const handle = { id } as ISessionScopeHandle;
          didCreate.fire({ sessionId: id, handle, source: 'resume' });
          return handle;
        },
        close: async () => {},
        unload: async () => true,
        archive: async () => {},
        restore: async () => ({ id: sessionId }) as ISessionScopeHandle,
        delete: async () => {},
        fork: async () => ({ id: sessionId }) as ISessionScopeHandle,
        createChild: async () => ({ id: sessionId }) as ISessionScopeHandle,
        dispose: () => {},
      } as unknown as ISessionLifecycleService;

      const workspace = {
        id: wsId,
        program: {
          sessionControllerGeneration: 'gen-1',
          createSessionController: () => fakeController,
        },
      } as unknown as WorkspaceInstance;

      const services = createServices(disposables, {
        strict: false,
        additionalServices: (reg) => {
          reg.definePartialInstance(IBootstrapService, { scope: (name: string) => name });
          reg.definePartialInstance(IFileSystemStorageService, storage);
          reg.definePartialInstance(IWorkspaceInstanceManager, {
            acquire: async () => ({ instance: workspace, dispose: () => {} }),
            get: () => workspace,
          });
          reg.definePartialInstance(ISessionIndex, {
            get: async (id: string) => (id === sessionId ? summary : undefined),
            listRecent: async () => ({ items: [summary], nextCursor: undefined }),
          });
          reg.definePartialInstance(IConfigService, {
            ready: Promise.resolve(),
            get: ((domain: string) => {
              if (domain === 'cold_compaction') {
                return { enabled: false, minIdleAgeMs: 1_800_000, maxSessionsPerSweep: 1, reclaimSparse: true };
              }
              return {};
            }) as IConfigService['get'],
          });
          reg.definePartialInstance(IFlagService, { enabled: () => false });
          reg.define(ISessionManager, SessionManager);
        },
      });
      const manager = services.get(ISessionManager);
      coldService = new ColdCompactionService(
        services.get(IBootstrapService),
        storage,
        services.get(ISessionIndex),
        manager,
        services.get(IConfigService),
      );

      const firstSeal = await coldService.compactSession(sessionId, {
        workspaceId: wsId,
        segmentBytes: 64 * 1024,
        hotTailBytes: 32 * 1024,
        reclaim: true,
      });
      expect(firstSeal?.compactedJournals).toBe(1);
      const manifest1 = JSON.parse(await readFile(`${wirePath}.segments.json`, 'utf8')) as { sealId: string };

      const appendHandle = await open(wirePath, 'a');
      try {
        await appendHandle.writeFile(appendedBytes);
        await appendHandle.sync();
      } finally {
        await appendHandle.close();
      }

      summary = { ...summary, updatedAt: now - 4_000_000 };
      const fullExpectedBytes = Buffer.concat([initialBytes, appendedBytes]);
      pinnedOldSeal = await openPinnedLogicalRead(storage, agentScope, KEY);
      expect(pinnedOldSeal.size).toBe(fullExpectedBytes.byteLength);

      const idleSweep = coldService.runIdlePass(1);
      await vi.waitFor(async () => {
        const current = JSON.parse(await readFile(`${wirePath}.segments.json`, 'utf8')) as { sealId: string };
        expect(current.sealId).not.toBe(manifest1.sealId);
      }, { timeout: 10_000 });

      const t0 = performance.now();
      const resumed = await manager.resume(sessionId);
      const elapsedMs = performance.now() - t0;
      expect(resumed).toMatchObject({ id: sessionId });
      expect(heldSessionLock).toBeDefined();
      expect(elapsedMs).toBeLessThan(500);
      expect(await idleSweep).toBe(0);

      expect(await concatBytes(pinnedOldSeal.read())).toEqual(fullExpectedBytes);
      await pinnedOldSeal.close();
      pinnedOldSeal = undefined;

      await heldSessionLock?.release();
      heldSessionLock = undefined;

      const fullLogical = await concatBytes(readLogicalBytes(storage, agentScope, KEY));
      expect(fullLogical).toEqual(fullExpectedBytes);
    } finally {
      if (pinnedOldSeal !== undefined) await Promise.resolve(pinnedOldSeal.close()).catch(() => undefined);
      if (heldSessionLock !== undefined) await Promise.resolve(heldSessionLock.release()).catch(() => undefined);
      await coldService?.dispose();
      await disposables.dispose();
      await storage.close();
      closeSparseFileWorker();
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('spawns zero powershell/csc processes, caches Win32 sparse-attribute checks on dense reads, and degrades cleanly on legacy 1-arg helper (Round-2 #1)', async () => {
    const sparseSource = await readFile(
      resolve(import.meta.dirname, '../../../../src/persistence/backends/node-fs/sparseFile.ts'),
      'utf8',
    );
    const fileLockSource = await readFile(
      resolve(import.meta.dirname, '../../../../src/persistence/backends/node-fs/fileLock.ts'),
      'utf8',
    );
    for (const src of [sparseSource, fileLockSource]) {
      expect(src.toLowerCase()).not.toContain('powershell');
      expect(src.toLowerCase()).not.toContain('pwsh');
      expect(src.toLowerCase()).not.toContain('add-type');
      expect(src.toLowerCase()).not.toContain('csc.exe');
    }

    const root = await mkdtemp(join(tmpdir(), 'cold-r2-no-ps-'));
    const storage = new FileStorageService(root);
    const spawned: Array<{ file: string; args: string[] }> = [];
    closeSparseFileWorker();
    clearSparseAttributeCache();
    const childProto = ChildProcess.prototype as unknown as {
      spawn(options: { file: string; args: string[] }): number;
    };
    const origImpl = childProto.spawn;
    const spawnSpy = vi.spyOn(childProto, 'spawn');
    spawnSpy.mockImplementation(function (this: ChildProcess, options: { file: string; args: string[] }) {
      spawned.push({ file: options.file, args: [...options.args] });
      return origImpl.call(this, options);
    });
    const prevHelperEnv = process.env['KIKI_WINDOWS_PROCESS_HELPER'];
    try {
      const denseDir = join(root, SCOPE);
      await mkdir(denseDir, { recursive: true });
      const wirePath = join(denseDir, KEY);
      const densePayload = Buffer.from(
        Array.from({ length: 160 }, (_, i) => `${JSON.stringify({
          type: 'note',
          id: `nops-${i}`,
          text: `NO_POWERSHELL_${i}_${'Q'.repeat(1_550)}`,
        })}\n`).join(''),
      );
      expect(densePayload.byteLength).toBeGreaterThan(131_072);
      await writeFile(wirePath, densePayload);

      expect(await concatBytes(readLogicalBytes(storage, SCOPE, KEY))).toEqual(densePayload);
      for (const call of spawned) {
        expect(call.file.toLowerCase()).toContain('windows-process-helper.exe');
        expect(call.file.toLowerCase()).not.toContain('powershell');
      }
      if (process.platform === 'win32') {
        expect(spawned.length).toBeLessThanOrEqual(1);
      } else {
        expect(spawned).toEqual([]);
      }
      spawned.length = 0;
      expect(await concatBytes(readLogicalBytes(storage, SCOPE, KEY))).toEqual(densePayload);
      const densePin = await openPinnedLogicalRead(storage, SCOPE, KEY);
      expect(await concatBytes(densePin.read())).toEqual(densePayload);
      await densePin.close();
      expect(spawned).toEqual([]);

      await compactRetainedJournal(wirePath, {
        codec: 'zstd',
        reclaim: true,
        segmentBytes: 64 * 1024,
        hotTailBytes: 32 * 1024,
      });
      for (const call of spawned) {
        expect(call.file.toLowerCase()).toContain('windows-process-helper.exe');
        expect(call.file.toLowerCase()).not.toContain('powershell');
        expect(call.file.toLowerCase()).not.toContain('pwsh');
        expect(call.file.toLowerCase()).not.toContain('csc');
      }

      spawned.length = 0;
      expect(await concatBytes(readLogicalBytes(storage, SCOPE, KEY))).toEqual(densePayload);
      const sealedPin = await openPinnedLogicalRead(storage, SCOPE, KEY);
      expect(await concatBytes(sealedPin.read())).toEqual(densePayload);
      await sealedPin.close();
      expect(spawned).toEqual([]);

      if (process.platform === 'win32') {
        const orphanDir = join(root, OTHER);
        await mkdir(orphanDir, { recursive: true });
        const orphanWire = join(orphanDir, KEY);
        await writeFile(orphanWire, densePayload);
        await compactRetainedJournal(orphanWire, {
          codec: 'zstd',
          reclaim: true,
          segmentBytes: 64 * 1024,
          hotTailBytes: 32 * 1024,
        });
        await rm(`${orphanWire}.segments.json`);
        spawned.length = 0;
        await expect(concatBytes(readLogicalBytes(storage, OTHER, KEY))).rejects.toMatchObject({
          code: StorageErrors.codes.STORAGE_CORRUPTED,
        });
        expect(spawned).toEqual([]);
      }

      await unsealRetainedJournal(wirePath);
      for (const call of spawned) {
        expect(call.file.toLowerCase()).toContain('windows-process-helper.exe');
      }

      if (process.platform === 'win32') {
        closeSparseFileWorker();
        process.env['KIKI_WINDOWS_PROCESS_HELPER'] = 'C:\\Windows\\System32\\whoami.exe';
        const fallbackCompacted = await compactRetainedJournal(wirePath, {
          codec: 'zstd',
          reclaim: true,
          segmentBytes: 64 * 1024,
          hotTailBytes: 32 * 1024,
        });
        expect(fallbackCompacted.seal?.originalRetained).toBe(true);
        expect(fallbackCompacted.seal?.sparseRanges).toEqual([]);
        await expect(stat(`${wirePath}.sparse`)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await concatBytes(readLogicalBytes(storage, SCOPE, KEY))).toEqual(densePayload);
      }
    } finally {
      if (prevHelperEnv === undefined) delete process.env['KIKI_WINDOWS_PROCESS_HELPER'];
      else process.env['KIKI_WINDOWS_PROCESS_HELPER'] = prevHelperEnv;
      closeSparseFileWorker();
      spawnSpy.mockRestore();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 35_000);

  it('detects orphaned sparse journals whose first hole starts past 65536 and preserves confirmed punched marker offsets across reseals (Round-3 R2-1a)', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'cold-r3-sparse-offset-'));
    const storage = new FileStorageService(root);
    try {
      const payload = Buffer.from(
        Array.from({ length: 340 }, (_, i) => `${JSON.stringify({
          type: 'note',
          id: `r3-1a-${i}`,
          text: `SPARSE_OFFSET_${i}_${'K'.repeat(1_550)}`,
        })}\n`).join(''),
      );
      expect(payload.byteLength).toBeGreaterThan(520_000);

      const cut1 = payload.indexOf(0x0a, 393_216) + 1;
      const cut2 = payload.indexOf(0x0a, 458_752) + 1;

      const scope1 = 'agents/hole-131072';
      await mkdir(join(root, scope1), { recursive: true });
      const wire1 = join(root, scope1, KEY);
      await writeFile(wire1, payload);
      expect(await concatBytes(readLogicalBytes(storage, scope1, KEY))).toEqual(payload);

      const seal1 = await sealColdSegments(storage, scope1, KEY, cut1, {
        codec: 'zstd',
        reclaim: true,
        segmentBytes: 64 * 1024,
        preserveOffsets: [98_304],
      });
      expect(seal1.originalRetained).toBe(false);
      expect(seal1.sparseRanges?.[0]?.start).toBe(131_072);
      await rm(`${wire1}.segments.json`);
      await rm(`${wire1}.sparse`);

      await expect(concatBytes(readLogicalBytes(storage, scope1, KEY))).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      await expect(openPinnedLogicalRead(storage, scope1, KEY)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });

      const scope2 = 'agents/hole-327680';
      await mkdir(join(root, scope2), { recursive: true });
      const wire2 = join(root, scope2, KEY);
      await writeFile(wire2, payload);
      expect(await concatBytes(readLogicalBytes(storage, scope2, KEY))).toEqual(payload);

      const seal2 = await sealColdSegments(storage, scope2, KEY, cut2, {
        codec: 'zstd',
        reclaim: true,
        segmentBytes: 64 * 1024,
        keepHeadBytes: 327_680,
      });
      expect(seal2.originalRetained).toBe(false);
      expect(seal2.sparseRanges?.[0]?.start).toBe(327_680);
      await rm(`${wire2}.segments.json`);
      await rm(`${wire2}.sparse`);

      await expect(concatBytes(readLogicalBytes(storage, scope2, KEY))).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });

      const scope3 = 'agents/reseal-marker-preserve';
      await mkdir(join(root, scope3), { recursive: true });
      const wire3 = join(root, scope3, KEY);
      await writeFile(wire3, payload);
      const initialSeal3 = await sealColdSegments(storage, scope3, KEY, cut1, {
        codec: 'zstd',
        reclaim: true,
        segmentBytes: 64 * 1024,
        preserveOffsets: [98_304],
      });
      expect(initialSeal3.sparseRanges?.[0]?.start).toBe(131_072);

      _setSparsePunchOverrideForTests(async () => ({
        status: 'unsupported_before_mutation',
        supported: false,
        punchedRanges: [],
      }));
      try {
        const reseal3 = await sealColdSegments(storage, scope3, KEY, cut2, {
          codec: 'zstd',
          reclaim: true,
          segmentBytes: 64 * 1024,
          preserveOffsets: [],
        });
        expect(reseal3.originalRetained).toBe(false);
        expect(reseal3.sparseRanges).toEqual(initialSeal3.sparseRanges);
      } finally {
        _setSparsePunchOverrideForTests(undefined);
      }

      const marker3 = JSON.parse(await readFile(`${wire3}.sparse`, 'utf8')) as {
        probeOffset: number;
        confirmedOffsets: number[];
      };
      expect(marker3.probeOffset).toBe(131_072);
      expect(marker3.confirmedOffsets).toContain(131_072);
      expect(marker3.confirmedOffsets).not.toContain(65_536);

      await rm(`${wire3}.segments.json`);
      await expect(concatBytes(readLogicalBytes(storage, scope3, KEY))).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
    } finally {
      _setSparsePunchOverrideForTests(undefined);
      closeSparseFileWorker();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 35_000);

  it('sweeps orphaned .segments/<oldSealId> directories after foreground preemption on both subsequent seal and unseal (Round-3 R2-7)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-r3-orphan-sweep-'));
    const storage = new FileStorageService(root);
    try {
      const part1 = Buffer.from(
        Array.from({ length: 140 }, (_, i) => `${JSON.stringify({
          type: 'note',
          id: `s1-${i}`,
          text: `SWEEP_PART1_${i}_${'R'.repeat(1_600)}`,
        })}\n`).join(''),
      );
      const part2 = Buffer.from(
        Array.from({ length: 90 }, (_, i) => `${JSON.stringify({
          type: 'note',
          id: `s2-${i}`,
          text: `SWEEP_PART2_${i}_${'S'.repeat(1_600)}`,
        })}\n`).join(''),
      );

      const runPreemptedReseal = async (scopeName: string): Promise<{ wirePath: string; activeSealId: string }> => {
        await mkdir(join(root, scopeName), { recursive: true });
        const wirePath = join(root, scopeName, KEY);
        await writeFile(wirePath, part1);
        const first = await compactRetainedJournal(wirePath, {
          codec: 'zstd',
          reclaim: true,
          segmentBytes: 64 * 1024,
          hotTailBytes: 32 * 1024,
        });
        expect(first.skipped).toBe(false);
        const seal1Id = (JSON.parse(await readFile(`${wirePath}.segments.json`, 'utf8')) as { sealId: string }).sealId;

        const fh = await open(wirePath, 'a');
        try {
          await fh.writeFile(part2);
          await fh.sync();
        } finally {
          await fh.close();
        }

        const pinned = await openPinnedLogicalRead(storage, scopeName, KEY);
        const preempt = new AbortController();
        const resealPromise = compactRetainedJournal(wirePath, {
          codec: 'zstd',
          reclaim: true,
          incremental: true,
          segmentBytes: 64 * 1024,
          hotTailBytes: 32 * 1024,
          signal: preempt.signal,
        });

        let seal2Id = seal1Id;
        await vi.waitFor(async () => {
          seal2Id = (JSON.parse(await readFile(`${wirePath}.segments.json`, 'utf8')) as { sealId: string }).sealId;
          expect(seal2Id).not.toBe(seal1Id);
        }, { timeout: 10_000 });

        preempt.abort(new Error('preempted during reader drain'));
        await expect(resealPromise).rejects.toThrow('preempted during reader drain');

        const dirsWhilePinned = await readdir(`${wirePath}.segments`);
        expect(dirsWhilePinned.sort()).toEqual([seal1Id, seal2Id].sort());
        expect(await concatBytes(pinned.read())).toEqual(Buffer.concat([part1, part2]));
        await pinned.close();
        return { wirePath, activeSealId: seal2Id };
      };

      const caseSeal = await runPreemptedReseal('agents/sweep-on-seal');
      const followup = await compactRetainedJournal(caseSeal.wirePath, {
        codec: 'zstd',
        reclaim: true,
        incremental: true,
        segmentBytes: 64 * 1024,
        hotTailBytes: 32 * 1024,
      });
      expect(followup.skipped).toBe(false);
      const finalManifest = JSON.parse(await readFile(`${caseSeal.wirePath}.segments.json`, 'utf8')) as {
        sealId: string;
      };
      const remainingDirs = await readdir(`${caseSeal.wirePath}.segments`);
      expect(remainingDirs).toEqual([finalManifest.sealId]);

      const caseUnseal = await runPreemptedReseal('agents/sweep-on-unseal');
      await unsealRetainedJournal(caseUnseal.wirePath);
      await expect(stat(`${caseUnseal.wirePath}.segments`)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(`${caseUnseal.wirePath}.segments.json`)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(caseUnseal.wirePath)).toEqual(Buffer.concat([part1, part2]));

      const caseInterruptedUnseal = await runPreemptedReseal('agents/sweep-after-interrupted-unseal');
      class CrashAfterManifestDeleteStorage extends FileStorageService {
        override async delete(scope: string, key: string): Promise<void> {
          if (key === coldManifestKey(KEY)) {
            await expect(stat(join(root, scope, `${KEY}.sparse`))).rejects.toMatchObject({
              code: 'ENOENT',
            });
            await super.delete(scope, key);
            throw new Error('interrupted right after manifest delete');
          }
          return super.delete(scope, key);
        }
      }
      const crashStorage = new CrashAfterManifestDeleteStorage(root);
      try {
        await expect(
          unsealColdSegments(crashStorage, 'agents/sweep-after-interrupted-unseal', KEY),
        ).rejects.toThrow('interrupted right after manifest delete');
      } finally {
        await crashStorage.close();
      }
      expect((await readdir(`${caseInterruptedUnseal.wirePath}.segments`)).length).toBe(2);
      expect(await concatBytes(readLogicalBytes(storage, 'agents/sweep-after-interrupted-unseal', KEY))).toEqual(
        Buffer.concat([part1, part2]),
      );
      await unsealRetainedJournal(caseInterruptedUnseal.wirePath);
      await expect(stat(`${caseInterruptedUnseal.wirePath}.segments`)).rejects.toMatchObject({ code: 'ENOENT' });

      const caseInterruptedDiscard = await runPreemptedReseal('agents/sweep-after-interrupted-discard');
      const crashStorage2 = new CrashAfterManifestDeleteStorage(root);
      try {
        await expect(
          unsealColdSegments(crashStorage2, 'agents/sweep-after-interrupted-discard', KEY),
        ).rejects.toThrow('interrupted right after manifest delete');
      } finally {
        await crashStorage2.close();
      }
      await discardRetainedJournal(caseInterruptedDiscard.wirePath);
      await expect(stat(`${caseInterruptedDiscard.wirePath}.segments`)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      closeSparseFileWorker();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it('detects out-of-band sparse punches after a warm false check and catches keepHeadBytes:0 98KiB sparse journals (Round-4 #3, #4)', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'cold-r4-sparse-edge-'));
    const storage = new FileStorageService(root);
    try {
      const scopeWarm = 'agents/warm-false-then-punch';
      await mkdir(join(root, scopeWarm), { recursive: true });
      const wireWarm = join(root, scopeWarm, KEY);
      const bigPayload = Buffer.from(
        Array.from({ length: 340 }, (_, i) => `${JSON.stringify({
          type: 'note',
          id: `warm-${i}`,
          text: `WARM_PAYLOAD_${i}_${'W'.repeat(1_550)}`,
        })}\n`).join(''),
      );
      expect(bigPayload.byteLength).toBeGreaterThan(520_000);
      await writeFile(wireWarm, bigPayload);

      expect(await detectOrphanedSparseJournal(wireWarm)).toBe(false);
      expect(await concatBytes(readLogicalBytes(storage, scopeWarm, KEY))).toEqual(bigPayload);

      const statBefore = await stat(wireWarm, { bigint: true });
      const punched = await punchSparseRanges(wireWarm, [{ start: 327_680, end: 393_216 }]);
      expect(punched.status).toBe('punched');
      const statAfter = await stat(wireWarm, { bigint: true });
      expect(statAfter.size).toBe(statBefore.size);
      expect(statAfter.mtimeNs).toBe(statBefore.mtimeNs);

      expect(await detectOrphanedSparseJournal(wireWarm)).toBe(true);
      await expect(concatBytes(readLogicalBytes(storage, scopeWarm, KEY))).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });

      const scopeSmall = 'agents/keep-head-zero-98k';
      await mkdir(join(root, scopeSmall), { recursive: true });
      const wireSmall = join(root, scopeSmall, KEY);
      const firstHalf = Buffer.alloc(65_536, 0x41);
      firstHalf[65_535] = 0x0a;
      const secondHalf = Buffer.alloc(32_768, 0x42);
      secondHalf[32_767] = 0x0a;
      const payload98k = Buffer.concat([firstHalf, secondHalf]);
      expect(payload98k.byteLength).toBe(98_304);
      await writeFile(wireSmall, payload98k);

      const sealSmall = await sealColdSegments(storage, scopeSmall, KEY, 65_536, {
        codec: 'zstd',
        reclaim: true,
        segmentBytes: 65_536,
        keepHeadBytes: 0,
      });
      expect(sealSmall.originalRetained).toBe(false);
      expect(sealSmall.sparseRanges).toEqual([{ start: 0, end: 65_536 }]);
      await rm(`${wireSmall}.segments.json`);
      await rm(`${wireSmall}.sparse`);

      expect(await detectOrphanedSparseJournal(wireSmall)).toBe(true);
      await expect(concatBytes(readLogicalBytes(storage, scopeSmall, KEY))).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      await expect(openPinnedLogicalRead(storage, scopeSmall, KEY)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
    } finally {
      closeSparseFileWorker();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('detects mid-journal sparse holes when sidecars are missing and helper is unavailable while preserving .zst segments on unseal (Round-5 #1)', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'cold-r5-unknown-attr-'));
    const storage = new FileStorageService(root);
    const prevHelperEnv = process.env['KIKI_WINDOWS_PROCESS_HELPER'];
    try {
      const scope = 'agents/unknown-attr-hole-327k';
      await mkdir(join(root, scope), { recursive: true });
      const wirePath = join(root, scope, KEY);
      const payload = Buffer.from(
        Array.from({ length: 340 }, (_, i) => `${JSON.stringify({
          type: 'note',
          id: `r5-1-${i}`,
          text: `UNKNOWN_HELPER_${i}_${'U'.repeat(1_550)}`,
        })}\n`).join(''),
      );
      const cut = payload.indexOf(0x0a, 458_752) + 1;
      await writeFile(wirePath, payload);

      const sealed = await sealColdSegments(storage, scope, KEY, cut, {
        codec: 'zstd',
        reclaim: true,
        segmentBytes: 64 * 1024,
        keepHeadBytes: 327_680,
      });
      expect(sealed.originalRetained).toBe(false);
      expect(sealed.sparseRanges?.[0]?.start).toBe(327_680);

      const segEntriesBefore = (await readdir(`${wirePath}.segments`, { recursive: true })).filter((entry) =>
        entry.endsWith('.zst'),
      );
      expect(segEntriesBefore.length).toBeGreaterThan(0);

      await rm(`${wirePath}.segments.json`);
      await rm(`${wirePath}.sparse`);

      closeSparseFileWorker();
      process.env['KIKI_WINDOWS_PROCESS_HELPER'] = '';

      expect(await queryWin32SparseAttribute(wirePath)).toBe('unknown');
      expect(await detectOrphanedSparseJournal(wirePath)).toBe(true);
      await expect(unsealRetainedJournal(wirePath)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });

      const segEntriesAfter = (await readdir(`${wirePath}.segments`, { recursive: true })).filter((entry) =>
        entry.endsWith('.zst'),
      );
      expect(segEntriesAfter.sort()).toEqual(segEntriesBefore.sort());
    } finally {
      if (prevHelperEnv === undefined) delete process.env['KIKI_WINDOWS_PROCESS_HELPER'];
      else process.env['KIKI_WINDOWS_PROCESS_HELPER'] = prevHelperEnv;
      closeSparseFileWorker();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not fail a committed AppendLogStore.rewrite() when removing a stale .sparse marker hits a transient sharing violation (Round-5 #3)', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'cold-r5-rewrite-marker-'));
    const storage = new FileStorageService(root);
    const log = createTestAppendLogStore(storage);
    let markerBlocker: DatabaseSync | undefined;
    try {
      const oldRecords: WireRecord[] = Array.from({ length: 40 }, (_, i) => ({
        type: 'note',
        id: `old-m-${i}`,
        body: `OLD_MARKER_${i}_${'A'.repeat(400)}`,
      }));
      const newRecords: WireRecord[] = Array.from({ length: 30 }, (_, i) => ({
        type: 'note',
        id: `new-m-${i}`,
        body: `NEW_MARKER_${i}_${'B'.repeat(400)}`,
      }));
      const extraRecord: WireRecord = { type: 'note', id: 'extra-after-rewrite', body: 'APPENDED_OK' };

      for (const rec of oldRecords) log.append(SCOPE, KEY, rec);
      await log.flush(SCOPE, KEY);
      const wirePath = join(root, SCOPE, KEY);
      await writeSparseMarker(wirePath, { confirmedRanges: [{ start: 65_536, end: 131_072 }] });

      const projections: Array<{ rewrite?: boolean; generation: string }> = [];
      log.registerProjection({
        key: KEY,
        prepare: () => undefined,
        commit: async (commitInfo) => {
          projections.push({ rewrite: commitInfo.rewrite, generation: commitInfo.generation });
        },
        onError: () => {},
      });

      markerBlocker = new DatabaseSync(`${wirePath}.sparse`, { readOnly: true });
      await log.rewrite(SCOPE, KEY, newRecords);

      expect(projections).toHaveLength(1);
      expect(projections[0]?.rewrite).toBe(true);
      expect(await collect(log)).toEqual(newRecords);

      log.append(SCOPE, KEY, extraRecord);
      await log.flush(SCOPE, KEY);
      expect(await collect(log)).toEqual([...newRecords, extraRecord]);

      const reopenStorage = new FileStorageService(root);
      const reopenLog = createTestAppendLogStore(reopenStorage);
      try {
        expect(await collect(reopenLog)).toEqual([...newRecords, extraRecord]);
      } finally {
        await reopenLog.dispose();
        await reopenStorage.close();
      }

      markerBlocker.close();
      markerBlocker = undefined;

      await vi.waitFor(async () => {
        await expect(stat(`${wirePath}.sparse`)).rejects.toMatchObject({ code: 'ENOENT' });
      }, { timeout: 2_000 });
    } finally {
      markerBlocker?.close();
      await log.dispose();
      await storage.close();
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it('refuses to sweep recoverable .zst segments when segments.json is missing on a dense zero-filled, empty, or absent wire.jsonl (Round-6 #1)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-r6-preserve-zst-'));
    const storage = new FileStorageService(root);
    try {
      const payload = Buffer.from(
        Array.from({ length: 340 }, (_, i) => `${JSON.stringify({
          type: 'note',
          id: `r6-1-${i}`,
          text: `DENSE_ZERO_CHECK_${i}_${'D'.repeat(1_550)}`,
        })}\n`).join(''),
      );
      const cut = payload.indexOf(0x0a, 458_752) + 1;

      const scopeDenseZero = 'agents/dense-zero-filled';
      await mkdir(join(root, scopeDenseZero), { recursive: true });
      const wireDenseZero = join(root, scopeDenseZero, KEY);
      await writeFile(wireDenseZero, payload);
      await sealColdSegments(storage, scopeDenseZero, KEY, cut, {
        codec: 'zstd',
        reclaim: false,
        segmentBytes: 64 * 1024,
      });
      const zstBeforeDense = (await readdir(`${wireDenseZero}.segments`, { recursive: true })).filter((entry) =>
        entry.endsWith('.zst'),
      );
      expect(zstBeforeDense.length).toBeGreaterThan(0);

      const fh = await open(wireDenseZero, 'r+');
      try {
        await fh.write(Buffer.alloc(65_536, 0), 0, 65_536, 327_680);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rm(`${wireDenseZero}.segments.json`);
      if (process.platform === 'win32') {
        expect(await queryWin32SparseAttribute(wireDenseZero)).toBe('dense');
      }

      await expect(unsealRetainedJournal(wireDenseZero)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      await expect(discardRetainedJournal(wireDenseZero)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      const zstAfterDense = (await readdir(`${wireDenseZero}.segments`, { recursive: true })).filter((entry) =>
        entry.endsWith('.zst'),
      );
      expect(zstAfterDense.sort()).toEqual(zstBeforeDense.sort());

      const scopeZeroLen = 'agents/empty-wire';
      await mkdir(join(root, scopeZeroLen), { recursive: true });
      const wireZeroLen = join(root, scopeZeroLen, KEY);
      await writeFile(wireZeroLen, payload);
      await sealColdSegments(storage, scopeZeroLen, KEY, cut, {
        codec: 'zstd',
        reclaim: false,
        segmentBytes: 64 * 1024,
      });
      const zstBeforeZero = (await readdir(`${wireZeroLen}.segments`, { recursive: true })).filter((entry) =>
        entry.endsWith('.zst'),
      );
      await writeFile(wireZeroLen, '');
      await rm(`${wireZeroLen}.segments.json`);

      await expect(unsealColdSegments(storage, scopeZeroLen, KEY)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      await expect(discardRetainedJournal(wireZeroLen)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      expect(
        (await readdir(`${wireZeroLen}.segments`, { recursive: true })).filter((e) => e.endsWith('.zst')).sort(),
      ).toEqual(zstBeforeZero.sort());

      const scopeAbsent = 'agents/absent-wire';
      await mkdir(join(root, scopeAbsent), { recursive: true });
      const wireAbsent = join(root, scopeAbsent, KEY);
      await writeFile(wireAbsent, payload);
      await sealColdSegments(storage, scopeAbsent, KEY, cut, {
        codec: 'zstd',
        reclaim: false,
        segmentBytes: 64 * 1024,
      });
      const zstBeforeAbsent = (await readdir(`${wireAbsent}.segments`, { recursive: true })).filter((entry) =>
        entry.endsWith('.zst'),
      );
      await rm(wireAbsent);
      await rm(`${wireAbsent}.segments.json`);

      await expect(unsealColdSegments(storage, scopeAbsent, KEY)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      expect(
        (await readdir(`${wireAbsent}.segments`, { recursive: true })).filter((e) => e.endsWith('.zst')).sort(),
      ).toEqual(zstBeforeAbsent.sort());
    } finally {
      closeSparseFileWorker();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('aborts readColdManifestSummary unit-scan immediately on AbortSignal when helper is unavailable (Round-6 #3)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-r6-abort-scan-'));
    const storage = new FileStorageService(root);
    const prevHelperEnv = process.env['KIKI_WINDOWS_PROCESS_HELPER'];
    let readSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const scope = 'agents/dense-multi-unit';
      await mkdir(join(root, scope), { recursive: true });
      const wirePath = join(root, scope, KEY);
      const unitLine = Buffer.alloc(65_536, 0x41);
      unitLine[65_535] = 0x0a;
      const bigDense = Buffer.concat(Array.from({ length: 48 }, () => unitLine));
      expect(bigDense.byteLength).toBe(48 * 65_536);
      await writeFile(wirePath, bigDense);

      closeSparseFileWorker();
      process.env['KIKI_WINDOWS_PROCESS_HELPER'] = '';

      const probeHandle = await open(wirePath, 'r');
      const fhProto = Object.getPrototypeOf(probeHandle) as {
        read: (...args: unknown[]) => Promise<unknown>;
      };
      await probeHandle.close();

      let wireReads = 0;
      let abortOnReadIndex = 1;
      let activeController = new AbortController();
      const origRead = fhProto.read;
      readSpy = vi.spyOn(fhProto, 'read').mockImplementation(async function (this: unknown, ...args: unknown[]) {
        wireReads += 1;
        const res = await origRead.apply(this, args);
        if (wireReads === abortOnReadIndex) {
          activeController.abort(new Error('preempt-unit-scan'));
        }
        return res;
      });

      await expect(
        readColdManifestSummary(storage, scope, KEY, activeController.signal),
      ).rejects.toThrow('preempt-unit-scan');
      expect(wireReads).toBeLessThanOrEqual(2);

      wireReads = 0;
      abortOnReadIndex = 7;
      activeController = new AbortController();
      await expect(
        readColdManifestSummary(storage, scope, KEY, activeController.signal),
      ).rejects.toThrow('preempt-unit-scan');
      expect(wireReads).toBe(7);
    } finally {
      readSpy?.mockRestore();
      if (prevHelperEnv === undefined) delete process.env['KIKI_WINDOWS_PROCESS_HELPER'];
      else process.env['KIKI_WINDOWS_PROCESS_HELPER'] = prevHelperEnv;
      closeSparseFileWorker();
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('propagates transient EIO on segment listing instead of swallowing and sweeping recoverable .zst segments (Round-7 #1)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-r7-list-eio-'));
    const scope = 'agents/transient-list-eio';
    await mkdir(join(root, scope), { recursive: true });
    const wirePath = join(root, scope, KEY);
    const baseStorage = new FileStorageService(root);
    try {
      const fullPayload = Buffer.from('{"a":123}\n{"b":"RECOVERABLE_ZSTD_PAYLOAD"}\n');
      await writeFile(wirePath, fullPayload);
      await sealColdSegments(baseStorage, scope, KEY, fullPayload.byteLength, {
        codec: 'zstd',
        reclaim: false,
        segmentBytes: 64 * 1024,
      });
      const zstBefore = (await readdir(`${wirePath}.segments`, { recursive: true })).filter((entry) =>
        entry.endsWith('.zst'),
      );
      expect(zstBefore.length).toBe(1);

      await rm(wirePath);
      await rm(`${wirePath}.segments.json`);

      let listCalls = 0;
      class TransientListEioStorage extends FileStorageService {
        override async list(listScope: string, prefix?: string): Promise<readonly string[]> {
          if (prefix === `${KEY}.segments/` && ++listCalls === 1) {
            throw Object.assign(new Error('EIO: simulated transient segment list failure'), { code: 'EIO' });
          }
          return super.list(listScope, prefix);
        }
      }
      const eioStorage = new TransientListEioStorage(root);
      try {
        await expect(unsealColdSegments(eioStorage, scope, KEY)).rejects.toThrow(
          'EIO: simulated transient segment list failure',
        );
      } finally {
        await eioStorage.close();
      }
      expect(listCalls).toBe(1);
      const zstAfter = (await readdir(`${wirePath}.segments`, { recursive: true })).filter((entry) =>
        entry.endsWith('.zst'),
      );
      expect(zstAfter).toEqual(zstBefore);
    } finally {
      await baseStorage.close();
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('verifies byte-for-byte prefix coverage of orphaned .segments/* against wire.jsonl on fs and memory backends (Round-7 #2)', async () => {
    const rec1 = Buffer.from('{"a":123}\n');
    const rec2 = Buffer.from('{"b":"ONLY_IN_ZSTD_123456"}\n');
    expect(rec1.byteLength).toBe(10);
    const fullBytes = Buffer.concat([rec1, rec2]);

    const root = await mkdtemp(join(tmpdir(), 'cold-r7-prefix-cover-'));
    const storage = new FileStorageService(root);
    try {
      const scopeTrunc = 'agents/truncated-10b';
      await mkdir(join(root, scopeTrunc), { recursive: true });
      const wireTrunc = join(root, scopeTrunc, KEY);
      await writeFile(wireTrunc, fullBytes);
      await sealColdSegments(storage, scopeTrunc, KEY, fullBytes.byteLength, {
        codec: 'zstd',
        reclaim: false,
        segmentBytes: 64 * 1024,
      });
      const zstFiles = (await readdir(`${wireTrunc}.segments`, { recursive: true })).filter((entry) =>
        entry.endsWith('.zst'),
      );
      expect(zstFiles.length).toBe(1);
      const savedZstBytes = await readFile(join(`${wireTrunc}.segments`, zstFiles[0]!));

      await writeFile(wireTrunc, rec1);
      await rm(`${wireTrunc}.segments.json`);

      await expect(unsealRetainedJournal(wireTrunc)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      await expect(discardRetainedJournal(wireTrunc)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      expect(await readFile(join(`${wireTrunc}.segments`, zstFiles[0]!))).toEqual(savedZstBytes);

      const tamperedSameLen = Buffer.concat([rec1, Buffer.from('{"b":"TAMPERED_ZSTD_12345"}\n')]);
      expect(tamperedSameLen.byteLength).toBe(fullBytes.byteLength);
      await writeFile(wireTrunc, tamperedSameLen);
      await expect(unsealRetainedJournal(wireTrunc)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      expect(await readFile(join(`${wireTrunc}.segments`, zstFiles[0]!))).toEqual(savedZstBytes);

      const mem = new InMemoryStorageService();
      await mem.write(SCOPE, KEY, fullBytes);
      await sealColdSegments(mem, SCOPE, KEY, fullBytes.byteLength, {
        codec: 'zstd',
        reclaim: false,
        segmentBytes: 64 * 1024,
      });
      expect((await mem.list(SCOPE, `${KEY}.segments/`)).length).toBe(1);
      await mem.write(SCOPE, KEY, rec1);
      await mem.delete(SCOPE, coldManifestKey(KEY));

      await expect(unsealColdSegments(mem, SCOPE, KEY)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      expect((await mem.list(SCOPE, `${KEY}.segments/`)).length).toBe(1);
    } finally {
      await storage.close();
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('refuses to reseal or compact and preserves all orphaned .zst segments when segments.json is missing on a truncated journal (Round-8 #1)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-cold-r8-reseal-orphan-'));
    const storage = new FileStorageService(root);
    try {
      const scope = 'sess-r8-reseal-orphan';
      const sessionDir = join(root, scope);
      await mkdir(sessionDir, { recursive: true });
      const wirePath = join(sessionDir, KEY);

      const records: Buffer[] = [];
      for (let i = 0; i < 16; i += 1) {
        const tag = String(i).padStart(2, '0');
        const baseLen = Buffer.byteLength(JSON.stringify({ tag, pad: '' }) + '\n');
        const line = JSON.stringify({ tag, pad: `seg_${tag}_`.padEnd(128 - baseLen, 'x') }) + '\n';
        expect(Buffer.byteLength(line)).toBe(128);
        records.push(Buffer.from(line));
      }
      const fullBytes = Buffer.concat(records);
      const truncatedWire = Buffer.from('{"a":"1"}\n');

      await writeFile(wirePath, fullBytes);
      const initialSeal = await sealRetainedJournal(wirePath, {
        codec: 'zstd',
        reclaim: false,
        segmentBytes: 128,
      });
      expect(initialSeal.segmentCount).toBe(16);

      const listZstSnapshots = async (segRoot: string): Promise<Map<string, Buffer>> => {
        const entries = await readdir(segRoot, { recursive: true, withFileTypes: true });
        const out = new Map<string, Buffer>();
        const rels = entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.zst'))
          .map((entry) => `${entry.parentPath.replaceAll('\\', '/')}/${entry.name}`.slice(
            `${segRoot.replaceAll('\\', '/')}/`.length,
          ))
          .toSorted();
        for (const rel of rels) {
          out.set(rel, await readFile(join(segRoot, rel)));
        }
        return out;
      };

      const savedFsSegments = await listZstSnapshots(`${wirePath}.segments`);
      expect(savedFsSegments.size).toBe(16);

      await writeFile(wirePath, truncatedWire);
      await rm(`${wirePath}.segments.json`);

      await expect(
        sealRetainedJournal(wirePath, { codec: 'zstd', reclaim: false, segmentBytes: 128 }),
      ).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });

      await expect(
        compactRetainedJournal(wirePath, { codec: 'zstd', reclaim: true, segmentBytes: 128 }),
      ).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });

      await expect(stat(`${wirePath}.segments.json`)).rejects.toMatchObject({ code: 'ENOENT' });
      const afterFailedReseal = await listZstSnapshots(`${wirePath}.segments`);
      expect([...afterFailedReseal.keys()]).toEqual([...savedFsSegments.keys()]);
      for (const [rel, expectedBuf] of savedFsSegments) {
        expect(afterFailedReseal.get(rel)).toEqual(expectedBuf);
      }

      await writeFile(wirePath, fullBytes);
      const validReseal = await sealRetainedJournal(wirePath, {
        codec: 'zstd',
        reclaim: false,
        segmentBytes: 256,
      });
      expect(validReseal.segmentCount).toBe(8);
      const afterValidReseal = await listZstSnapshots(`${wirePath}.segments`);
      expect(afterValidReseal.size).toBe(8);

      const mem = new InMemoryStorageService();
      await mem.write(SCOPE, KEY, fullBytes);
      const memSeal = await sealColdSegments(mem, SCOPE, KEY, fullBytes.byteLength, {
        codec: 'zstd',
        reclaim: false,
        segmentBytes: 128,
      });
      expect(memSeal.segmentCount).toBe(16);
      const memSegKeysBefore = (await mem.list(SCOPE, `${KEY}.segments/`)).toSorted();
      expect(memSegKeysBefore.length).toBe(16);
      const memSnapshots = new Map<string, Uint8Array>();
      for (const segKey of memSegKeysBefore) {
        memSnapshots.set(segKey, Buffer.from((await mem.read(SCOPE, segKey))!));
      }

      await mem.write(SCOPE, KEY, truncatedWire);
      await mem.delete(SCOPE, coldManifestKey(KEY));

      await expect(
        sealColdSegments(mem, SCOPE, KEY, truncatedWire.byteLength, {
          codec: 'zstd',
          reclaim: false,
          segmentBytes: 128,
        }),
      ).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });

      expect(await mem.read(SCOPE, coldManifestKey(KEY))).toBeUndefined();
      const memSegKeysAfter = (await mem.list(SCOPE, `${KEY}.segments/`)).toSorted();
      expect(memSegKeysAfter).toEqual(memSegKeysBefore);
      for (const [segKey, expectedBytes] of memSnapshots) {
        expect(Buffer.from((await mem.read(SCOPE, segKey))!)).toEqual(expectedBytes);
      }
    } finally {
      await storage.close();
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('deletes segments highest-index-first and stops on EIO so retry unseal verifies remaining 0..k prefix and finishes cleanup (Round-8 #2)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-cold-r8-desc-delete-'));
    class FailDeleteSeg1FsStorage extends FileStorageService {
      failSeg1 = false;
      readonly deleteAttempts: string[] = [];

      override async delete(delScope: string, delKey: string): Promise<void> {
        if (delKey.includes('.segments/')) {
          this.deleteAttempts.push(delKey);
        }
        if (this.failSeg1 && delKey.endsWith('/000001.zst')) {
          throw Object.assign(new Error('EIO: simulated delete failure on 000001.zst'), { code: 'EIO' });
        }
        return super.delete(delScope, delKey);
      }
    }

    class FailDeleteSeg1MemStorage extends InMemoryStorageService {
      failSeg1 = false;
      readonly deleteAttempts: string[] = [];

      override async delete(delScope: string, delKey: string): Promise<void> {
        if (delKey.includes('.segments/')) {
          this.deleteAttempts.push(delKey);
        }
        if (this.failSeg1 && delKey.endsWith('/000001.zst')) {
          throw Object.assign(new Error('EIO: simulated mem delete failure on 000001.zst'), { code: 'EIO' });
        }
        return super.delete(delScope, delKey);
      }
    }

    const storage = new FailDeleteSeg1FsStorage(root);
    try {
      const scope = 'sess-r8-desc-fs';
      const sessionDir = join(root, scope);
      await mkdir(sessionDir, { recursive: true });
      const wirePath = join(sessionDir, KEY);

      const records: Buffer[] = [];
      for (let i = 0; i < 3; i += 1) {
        const tag = String(i).padStart(2, '0');
        const baseLen = Buffer.byteLength(JSON.stringify({ tag, pad: '' }) + '\n');
        const line = JSON.stringify({ tag, pad: `seg_${tag}_`.padEnd(128 - baseLen, 'y') }) + '\n';
        expect(Buffer.byteLength(line)).toBe(128);
        records.push(Buffer.from(line));
      }
      const fullBytes = Buffer.concat(records);
      await writeFile(wirePath, fullBytes);

      const sealed = await sealColdSegments(storage, scope, KEY, fullBytes.byteLength, {
        codec: 'zstd',
        reclaim: false,
        segmentBytes: 128,
      });
      expect(sealed.segmentCount).toBe(3);

      const sealDirs = await readdir(`${wirePath}.segments`);
      expect(sealDirs.length).toBe(1);
      const sealDir = join(`${wirePath}.segments`, sealDirs[0]!);
      expect((await readdir(sealDir)).toSorted()).toEqual(['000000.zst', '000001.zst', '000002.zst']);

      storage.failSeg1 = true;
      await expect(unsealColdSegments(storage, scope, KEY)).rejects.toThrow(
        'EIO: simulated delete failure on 000001.zst',
      );
      expect(storage.deleteAttempts.map((k) => k.slice(-10))).toEqual(['000002.zst', '000001.zst']);
      expect((await readdir(sealDir)).toSorted()).toEqual(['000000.zst', '000001.zst']);

      storage.deleteAttempts.length = 0;
      await expect(unsealColdSegments(storage, scope, KEY)).rejects.toThrow(
        'EIO: simulated delete failure on 000001.zst',
      );
      expect(storage.deleteAttempts.map((k) => k.slice(-10))).toEqual(['000001.zst']);
      expect((await readdir(sealDir)).toSorted()).toEqual(['000000.zst', '000001.zst']);

      storage.failSeg1 = false;
      storage.deleteAttempts.length = 0;
      const retryResult = await unsealColdSegments(storage, scope, KEY);
      expect(retryResult.hadManifest).toBe(false);
      expect(storage.deleteAttempts.map((k) => k.slice(-10))).toEqual(['000001.zst', '000000.zst']);
      await expect(stat(`${wirePath}.segments`)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(wirePath)).toEqual(fullBytes);

      const mem = new FailDeleteSeg1MemStorage();
      await mem.write(SCOPE, KEY, fullBytes);
      const memSealed = await sealColdSegments(mem, SCOPE, KEY, fullBytes.byteLength, {
        codec: 'zstd',
        reclaim: false,
        segmentBytes: 128,
      });
      expect(memSealed.segmentCount).toBe(3);

      mem.failSeg1 = true;
      await expect(unsealColdSegments(mem, SCOPE, KEY)).rejects.toThrow(
        'EIO: simulated mem delete failure on 000001.zst',
      );
      expect(mem.deleteAttempts.map((k) => k.slice(-10))).toEqual(['000002.zst', '000001.zst']);
      expect((await mem.list(SCOPE, `${KEY}.segments/`)).map((k) => k.slice(-10)).toSorted()).toEqual([
        '000000.zst',
        '000001.zst',
      ]);

      mem.failSeg1 = false;
      mem.deleteAttempts.length = 0;
      await unsealColdSegments(mem, SCOPE, KEY);
      expect(mem.deleteAttempts.map((k) => k.slice(-10))).toEqual(['000001.zst', '000000.zst']);
      expect(await mem.list(SCOPE, `${KEY}.segments/`)).toEqual([]);
      expect(Buffer.from((await mem.read(SCOPE, KEY))!)).toEqual(fullBytes);
    } finally {
      await storage.close();
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('tolerates and sweeps unpublished atomic-write staging segment files (.tmp/.stage) while still catching truncated journals (Round-9)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kiki-cold-r9-staging-tmp-'));
    class RecordingFsStorage extends FileStorageService {
      readonly deleteAttempts: string[] = [];

      override async delete(delScope: string, delKey: string): Promise<void> {
        if (delKey.includes('.segments/')) {
          this.deleteAttempts.push(delKey);
        }
        return super.delete(delScope, delKey);
      }
    }
    class RecordingMemStorage extends InMemoryStorageService {
      readonly deleteAttempts: string[] = [];

      override async delete(delScope: string, delKey: string): Promise<void> {
        if (delKey.includes('.segments/')) {
          this.deleteAttempts.push(delKey);
        }
        return super.delete(delScope, delKey);
      }
    }

    const storage = new RecordingFsStorage(root);
    try {
      const scope = 'sess-r9-fs';
      const sessionDir = join(root, scope);
      await mkdir(sessionDir, { recursive: true });
      const wirePath = join(sessionDir, KEY);

      const records: Buffer[] = [];
      for (let i = 0; i < 2; i += 1) {
        const tag = String(i).padStart(2, '0');
        const baseLen = Buffer.byteLength(JSON.stringify({ tag, pad: '' }) + '\n');
        const line = JSON.stringify({ tag, pad: `seg_${tag}_`.padEnd(128 - baseLen, 'z') }) + '\n';
        expect(Buffer.byteLength(line)).toBe(128);
        records.push(Buffer.from(line));
      }
      const fullBytes = Buffer.concat(records);
      const truncatedWire = Buffer.from('{"a":"1"}\n');

      await writeFile(wirePath, fullBytes);
      const baseSeal = await sealRetainedJournal(wirePath, {
        codec: 'zstd',
        reclaim: false,
        segmentBytes: 128,
      });
      expect(baseSeal.segmentCount).toBe(2);
      const sealDirs = await readdir(`${wirePath}.segments`);
      const crashedSealId = sealDirs[0]!;
      const seg0Bytes = await readFile(join(`${wirePath}.segments`, crashedSealId, '000000.zst'));
      await unsealRetainedJournal(wirePath);

      const stageFsCrash = async (includePublishedSeg0: boolean): Promise<string> => {
        const dir = join(`${wirePath}.segments`, crashedSealId);
        await mkdir(dir, { recursive: true });
        if (includePublishedSeg0) {
          await writeFile(join(dir, '000000.zst'), seg0Bytes);
          await writeFile(join(dir, '000001.zst.tmp.12345.deadbeef'), Buffer.from('half-written-zstd-tmp'));
          await writeFile(join(dir, '000001.zst.stage.12345.cafebabe'), Buffer.from('half-written-zstd-stage'));
        } else {
          await writeFile(join(dir, '000000.zst.tmp.12345.deadbeef'), Buffer.from('unpublished-seg0-tmp'));
        }
        return dir;
      };

      await stageFsCrash(true);
      expect(await readColdManifestSummary(storage, scope, KEY)).toBeUndefined();
      storage.deleteAttempts.length = 0;
      await unsealColdSegments(storage, scope, KEY);
      expect(storage.deleteAttempts.map((k) => k.slice(`${KEY}.segments/${crashedSealId}/`.length))).toEqual([
        '000001.zst.tmp.12345.deadbeef',
        '000001.zst.stage.12345.cafebabe',
        '000000.zst',
      ]);
      await expect(stat(`${wirePath}.segments`)).rejects.toMatchObject({ code: 'ENOENT' });

      await stageFsCrash(true);
      const resealedAfterCrash = await sealRetainedJournal(wirePath, {
        codec: 'zstd',
        reclaim: false,
        segmentBytes: 128,
      });
      expect(resealedAfterCrash.segmentCount).toBe(2);
      const dirsAfterReseal = await readdir(`${wirePath}.segments`);
      expect(dirsAfterReseal.length).toBe(1);
      expect(dirsAfterReseal[0]).not.toBe(crashedSealId);
      await unsealRetainedJournal(wirePath);

      await stageFsCrash(true);
      const fsLog1 = createTestAppendLogStore(storage);
      try {
        await fsLog1.rewrite(scope, KEY, [{ type: 'note', id: 'rewritten-after-seg0-plus-tmp' } as unknown as WireRecord]);
      } finally {
        await fsLog1.dispose();
      }
      await expect(stat(`${wirePath}.segments`)).rejects.toMatchObject({ code: 'ENOENT' });

      await writeFile(wirePath, fullBytes);
      await stageFsCrash(false);
      expect(await readColdManifestSummary(storage, scope, KEY)).toBeUndefined();
      await unsealColdSegments(storage, scope, KEY);
      await expect(stat(`${wirePath}.segments`)).rejects.toMatchObject({ code: 'ENOENT' });

      await stageFsCrash(false);
      const resealedTmpOnly = await sealRetainedJournal(wirePath, {
        codec: 'zstd',
        reclaim: false,
        segmentBytes: 128,
      });
      expect(resealedTmpOnly.segmentCount).toBe(2);
      await unsealRetainedJournal(wirePath);

      await stageFsCrash(false);
      const fsLog2 = createTestAppendLogStore(storage);
      try {
        await fsLog2.rewrite(scope, KEY, [{ type: 'note', id: 'rewritten-after-tmp-only' } as unknown as WireRecord]);
      } finally {
        await fsLog2.dispose();
      }
      await expect(stat(`${wirePath}.segments`)).rejects.toMatchObject({ code: 'ENOENT' });

      await writeFile(wirePath, truncatedWire);
      const truncCrashDir = await stageFsCrash(true);
      await expect(readColdManifestSummary(storage, scope, KEY)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      await expect(
        sealRetainedJournal(wirePath, { codec: 'zstd', reclaim: false, segmentBytes: 128 }),
      ).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
      await expect(unsealColdSegments(storage, scope, KEY)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      const fsLogTrunc = createTestAppendLogStore(storage);
      try {
        await expect(
          fsLogTrunc.rewrite(scope, KEY, [{ type: 'note', id: 'blocked-on-trunc' } as unknown as WireRecord]),
        ).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
      } finally {
        await fsLogTrunc.dispose();
      }
      expect(await readFile(join(truncCrashDir, '000000.zst'))).toEqual(seg0Bytes);

      const mem = new RecordingMemStorage();
      await mem.write(SCOPE, KEY, fullBytes);
      const stageMemCrash = async (includePublishedSeg0: boolean): Promise<void> => {
        if (includePublishedSeg0) {
          await mem.write(SCOPE, `${KEY}.segments/${crashedSealId}/000000.zst`, seg0Bytes);
          await mem.write(
            SCOPE,
            `${KEY}.segments/${crashedSealId}/000001.zst.tmp.12345.deadbeef`,
            Buffer.from('half-written-mem-tmp'),
          );
        } else {
          await mem.write(
            SCOPE,
            `${KEY}.segments/${crashedSealId}/000000.zst.tmp.12345.deadbeef`,
            Buffer.from('unpublished-mem-seg0-tmp'),
          );
        }
      };

      await stageMemCrash(true);
      expect(await readColdManifestSummary(mem, SCOPE, KEY)).toBeUndefined();
      mem.deleteAttempts.length = 0;
      await unsealColdSegments(mem, SCOPE, KEY);
      expect(mem.deleteAttempts.map((k) => k.slice(`${KEY}.segments/${crashedSealId}/`.length))).toEqual([
        '000001.zst.tmp.12345.deadbeef',
        '000000.zst',
      ]);
      expect(await mem.list(SCOPE, `${KEY}.segments/`)).toEqual([]);

      await stageMemCrash(false);
      expect(await readColdManifestSummary(mem, SCOPE, KEY)).toBeUndefined();
      const memReseal = await sealColdSegments(mem, SCOPE, KEY, fullBytes.byteLength, {
        codec: 'zstd',
        reclaim: false,
        segmentBytes: 128,
      });
      expect(memReseal.segmentCount).toBe(2);
      await unsealColdSegments(mem, SCOPE, KEY);

      await stageMemCrash(true);
      const memLog = createTestAppendLogStore(mem);
      try {
        await memLog.rewrite(SCOPE, KEY, [{ type: 'note', id: 'mem-rewritten' } as unknown as WireRecord]);
      } finally {
        await memLog.dispose();
      }
      expect(await mem.list(SCOPE, `${KEY}.segments/`)).toEqual([]);

      await mem.write(SCOPE, KEY, truncatedWire);
      await stageMemCrash(true);
      await expect(readColdManifestSummary(mem, SCOPE, KEY)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      await expect(
        sealColdSegments(mem, SCOPE, KEY, truncatedWire.byteLength, {
          codec: 'zstd',
          reclaim: false,
          segmentBytes: 128,
        }),
      ).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_CORRUPTED });
      await expect(unsealColdSegments(mem, SCOPE, KEY)).rejects.toMatchObject({
        code: StorageErrors.codes.STORAGE_CORRUPTED,
      });
      expect(Buffer.from((await mem.read(SCOPE, `${KEY}.segments/${crashedSealId}/000000.zst`))!)).toEqual(seg0Bytes);
    } finally {
      await storage.close();
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('does not skip records inside sealed .segments.json wires when AppendLogStore.read uses rawSubstrings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-sealed-marker-'));
    const storage = new FileStorageService(root);
    const log = createTestAppendLogStore(storage);
    const scope = 'sessions/ws/sealed-marker/agents/sub';
    try {
      const filler = 'x'.repeat(32 * 1024);
      const records: WireRecord[] = [
        { type: 'prompt.model_switch', id: 'sealed-switch-1', toModel: 'gpt-test' } as unknown as WireRecord,
      ];
      for (let i = 0; i < 40; i += 1) {
        records.push({ type: 'note', id: `pad-${i}`, body: filler } as unknown as WireRecord);
      }
      for (const rec of records) {
        await log.append(scope, KEY, rec);
      }
      await log.flush(scope, KEY);
      const totalSize = (await storage.size(scope, KEY)) ?? 0;
      expect(totalSize).toBeGreaterThan(1024 * 1024);

      const sealed = await sealColdSegments(storage, scope, KEY, totalSize, {
        codec: 'zstd',
        reclaim: true,
        segmentBytes: 256 * 1024,
        keepHeadBytes: 0,
      });
      expect(sealed.segmentCount).toBeGreaterThan(0);

      const wirePath = storage.pathFor(scope, KEY)!;
      expect(await scanColdWireMarkers(wirePath, ['prompt.model_switch'])).toBeUndefined();

      const seen: WireRecord[] = [];
      for await (const record of log.read<WireRecord>(scope, KEY, {
        rawSubstrings: [Buffer.from('prompt.model_switch', 'utf8')],
      })) {
        seen.push(record);
      }
      expect(seen.map((r) => (r as unknown as { id?: string }).id)).toEqual(['sealed-switch-1']);
    } finally {
      await log.dispose();
      await storage.close();
      closeSparseFileWorker();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps shared scanColdWireMarkers flight alive when one waiter aborts and aborts cleanly when sole waiter aborts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cold-marker-refcount-'));
    const wirePath = join(root, 'wire.jsonl');
    try {
      const chunk = `${JSON.stringify({ type: 'note', body: 'z'.repeat(64 * 1024) })}\n`;
      const payload = chunk.repeat(64) + `${JSON.stringify({ type: 'note', marker: 'ExitPlanMode' })}\n`;
      await writeFile(wirePath, payload, 'utf8');
      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const p1 = scanColdWireMarkers(wirePath, ['ExitPlanMode'], ac1.signal);
      const p2 = scanColdWireMarkers(wirePath, ['prompt.model_switch', 'ExitPlanMode'], ac2.signal);
      ac1.abort(new Error('caller-1-cancelled'));
      await expect(p1).rejects.toThrow('caller-1-cancelled');
      const res2 = await p2;
      expect(res2).toBeDefined();
      expect(res2!.matches.get('ExitPlanMode')).toBe(true);
      expect(res2!.matches.get('prompt.model_switch')).toBe(false);

      const acSole = new AbortController();
      const pSole = scanColdWireMarkers(wirePath, ['ExitPlanMode'], acSole.signal);
      acSole.abort(new Error('sole-caller-cancelled'));
      await expect(pSole).rejects.toThrow('sole-caller-cancelled');
      const afterAbort = await scanColdWireMarkers(wirePath, ['ExitPlanMode']);
      expect(afterAbort?.matches.get('ExitPlanMode')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
