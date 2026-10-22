import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'pathe';
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
import { StorageErrors, type StorageReadRange } from '#/persistence/interface/storage';
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

  override async write(
    scope: string,
    key: string,
    data: Uint8Array,
    options?: { atomic?: boolean; signal?: AbortSignal },
  ): Promise<void> {
    if (key.includes('.segments/') && ++this.segmentWrites === 2) throw new Error('disk full');
    await super.write(scope, key, data, options);
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
    expect(storage.opened.filter((key) => key.endsWith('.deflate'))).toEqual([`${KEY}.segments/000001.deflate`]);
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
    expect(await failing.read(SCOPE, `${KEY}.segments/000000.deflate`)).toBeUndefined();
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
    await storage.delete(SCOPE, `${KEY}.segments/000001.deflate`);
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
});
