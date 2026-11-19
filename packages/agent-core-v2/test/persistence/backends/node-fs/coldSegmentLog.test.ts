import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join, resolve } from 'pathe';
import { open as openZip } from 'yauzl';

import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { TestInstantiationService } from '#/_base/di/test';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { exportSessionDirectory } from '#/app/sessionExport/sessionExportService';
import { scanSessionWire } from '#/app/sessionExport/wire-scan';
import { type AppendLogStore, coldManifestKey } from '#/persistence/backends/node-fs/appendLogStore';
import { createTestAppendLogStore } from '../../interface/stubs';
import { SESSION_LOCK_SCOPE, sessionLockKey } from '#/persistence/backends/node-fs/fileLock';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import {
  _setSparsePunchOverrideForTests,
  allocatedFileBytes,
  closeSparseFileWorker,
} from '#/persistence/backends/node-fs/sparseFile';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import {
  COLD_SEGMENT_BYTES,
  openPinnedLogicalRead,
  readLogicalBytes,
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
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { ISessionIndex, SessionSummary } from '#/app/sessionIndex/sessionIndex';
import type { ISessionManager } from '#/app/sessionManager/sessionManager';
import {
  StorageError,
  StorageErrors,
  type StorageReadOptions,
  type StorageReadRange,
  type StorageWriteOptions,
} from '#/persistence/interface/storage';
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

class FailOnSecondSegment extends InMemoryStorageService {
  private segmentWrites = 0;
  readonly writtenSegments: string[] = [];

  override async write(
    scope: string,
    key: string,
    data: Uint8Array,
    options?: { atomic?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    if (key.includes('.segments/') && key.endsWith('.deflate') && ++this.segmentWrites === 2) throw new Error('disk full');
    await super.write(scope, key, data, options);
    if (key.endsWith('.deflate')) this.writtenSegments.push(key);
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
      format: 1,
      codec: 'deflate-raw',
      level: 6,
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
    expect(storage.opened.filter((key) => key.endsWith('.deflate'))).toEqual([
      expect.stringMatching(/\.segments\/[0-9a-f-]{36}\/000001\.deflate$/),
    ]);
    expect(storage.opened).not.toContain(KEY);

    storage.opened.length = 0;
    const tail = await concatBytes(readLogicalBytes(storage, SCOPE, KEY, { start: journal.sealedCut, end: journal.bytes.byteLength - 1 }));
    expect(tail).toEqual(journal.bytes.subarray(journal.sealedCut));
    expect(storage.opened.filter((key) => key.endsWith('.deflate'))).toEqual([]);
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

  it('keeps an exact generation string and uses the 8MiB default for an empty cold prefix', async () => {
    const storage = new InMemoryStorageService();
    const log = createTestAppendLogStore(storage);
    disposables.add(log);
    const bytes = line({ type: 'note', id: 'tiny' });
    await storage.write(SCOPE, KEY, bytes);
    await storage.write(SCOPE, `${KEY}.generation`, Buffer.from('gen-1\n'));

    const sealed = await log.sealCold(SCOPE, KEY, 0);

    expect(sealed.segmentBytes).toBe(COLD_SEGMENT_BYTES);
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
    await log.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES });
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
    expect(bulky.opened.filter((key) => key.endsWith('.deflate'))).toEqual([]);
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
        if (armCancel && key.endsWith('.deflate')) throw new DOMException('The operation was aborted', 'AbortError');
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
        if (heldNow && key.endsWith('.deflate')) deflatesWhileHeld += 1;
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
        if (!blocked && key.endsWith('.deflate')) {
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
        if (heldNow && key.endsWith('.deflate')) deflatesWhileHeld += 1;
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
        if (key.endsWith('.deflate')) fresh.push(key);
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
        if (!blocked && key.endsWith('.deflate')) {
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
});
