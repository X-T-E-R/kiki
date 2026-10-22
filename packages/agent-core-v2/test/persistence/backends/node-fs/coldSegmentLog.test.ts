import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join, resolve } from 'pathe';
import { open as openZip } from 'yauzl';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { exportSessionDirectory } from '#/app/sessionExport/sessionExportService';
import { scanSessionWire } from '#/app/sessionExport/wire-scan';
import { AppendLogStore, coldManifestKey } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { COLD_SEGMENT_BYTES, readLogicalBytes } from '#/persistence/coldSegmentLog';
import { sealRetainedJournal } from '#/persistence/retainedJournal';
import { StorageErrors, type StorageReadOptions, type StorageReadRange, type StorageWriteOptions } from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

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

  afterEach(() => {
    disposables.dispose();
  });

  it('seals independent segments and reads a logical page without earlier members or the plaintext prefix', async () => {
    const storage = new RecordingStorage();
    const log = new AppendLogStore(storage);
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
    const log = new AppendLogStore(storage);
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
    const refusedLog = new AppendLogStore(refused);
    disposables.add(refusedLog);
    await refused.write(SCOPE, KEY, journal.bytes);
    await expect(refusedLog.sealCold(SCOPE, KEY, 3, { segmentBytes: SEGMENT_BYTES })).rejects.toMatchObject({
      name: 'BugIndicatingError',
    });
    expect(await refused.read(SCOPE, coldManifestKey(KEY))).toBeUndefined();
    expect(Buffer.from((await refused.read(SCOPE, KEY))!)).toEqual(journal.bytes);

    const failing = new FailOnSecondSegment();
    const failingLog = new AppendLogStore(failing);
    disposables.add(failingLog);
    await failing.write(SCOPE, KEY, journal.bytes);
    await expect(failingLog.sealCold(SCOPE, KEY, journal.sealedCut, { segmentBytes: SEGMENT_BYTES })).rejects.toThrow('disk full');
    expect(await failing.read(SCOPE, coldManifestKey(KEY))).toBeUndefined();
    expect(failing.writtenSegments.length).toBeGreaterThan(0);
    for (const segmentKey of failing.writtenSegments) expect(await failing.read(SCOPE, segmentKey)).toBeUndefined();
    expect(Buffer.from((await failing.read(SCOPE, KEY))!)).toEqual(journal.bytes);

    const cancelled = new InMemoryStorageService();
    const cancelledLog = new AppendLogStore(cancelled);
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
    const log = new AppendLogStore(storage);
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
    const log = new AppendLogStore(storage);
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
    const log = new AppendLogStore(storage);
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
    const log = new AppendLogStore(storage);
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
    const log = new AppendLogStore(storage);
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
    const bulkyLog = new AppendLogStore(bulky);
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
    const cancelLog = new AppendLogStore(cancelStorage);
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
    const gatedLog = new AppendLogStore(gated);
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
    const log = new AppendLogStore(storage);
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
    const log = new AppendLogStore(storage);
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
    const swappingLog = new AppendLogStore(swapping);
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
    const publishedLog = new AppendLogStore(published);
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
    const wideLog = new AppendLogStore(wide);
    const narrowLog = new AppendLogStore(narrow);
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
    const wideLog = new AppendLogStore(wide);
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
    const logA = new AppendLogStore(storageA);
    const logB = new AppendLogStore(storageB);
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
});
