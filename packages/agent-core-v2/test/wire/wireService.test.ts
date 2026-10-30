import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, open, rm, stat, utimes, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { resetUnexpectedErrorHandler, setUnexpectedErrorHandler } from '#/_base/errors/unexpectedError';
import { ILogService } from '#/_base/log/log';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import type { ContentPart } from '#/kosong/contract/message';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService, StorageError, StorageErrors } from '#/persistence/interface/storage';
import { WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';
import { wireJournalBackupKey } from '#/wire/repair';
import { WireError, WireErrors } from '#/wire/errors';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { WIRE_TRANSCRIPT_RECEIPT_KEY, digestWireBytes, parseWireTranscriptReceipt } from '#/wire/transcriptReceipt';

import { recordingWireLog, registerTestAgentWire, testWireScope, noopLogger } from './stubs';

const SCOPE = 'wire';
const KEY = 'journal-test';

let disposables: DisposableStore;
let ix: TestInstantiationService;
let wire: IWireService;
let log: IAppendLogStore;
let storage: InMemoryStorageService;

beforeEach(() => {
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  storage = new InMemoryStorageService();
  ix.stub(IFileSystemStorageService, storage);
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  log = ix.get(IAppendLogStore);
  wire = registerTestAgentWire(ix, testWireScope(SCOPE, KEY), {
    log,
    storage,
    logger: noopLogger,
    telemetry: noopTelemetryService,
  });
});

afterEach(() => disposables.dispose());

async function readRecords(
  target: IAppendLogStore = log,
  scope = SCOPE,
  key = KEY,
): Promise<WireRecord[]> {
  const out: WireRecord[] = [];
  for await (const record of target.read<WireRecord>(testWireScope(scope, key), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

async function collect(journal: AsyncIterable<WireRecord>): Promise<WireRecord[]> {
  const out: WireRecord[] = [];
  for await (const record of journal) {
    out.push(record);
  }
  return out;
}

function wireOverLog(
  stubLog: IAppendLogStore,
  key: string,
  dependencies: { blob?: IAgentBlobService } = {},
): IWireService {
  const stubIx = disposables.add(new TestInstantiationService());
  return registerTestAgentWire(stubIx, testWireScope(SCOPE, key), { log: stubLog, ...dependencies });
}

describe('wire transcript digest', () => {
  it.each([
    { text: '', lines: 0, endsWithNewline: false },
    { text: '\n\n\n', lines: 3, endsWithNewline: true },
    { text: 'first\r\n中文\nlast', lines: 2, endsWithNewline: false },
    { text: `${'x'.repeat(65_536)}\n`, lines: 1, endsWithNewline: true },
  ])('preserves the digest and line counts across chunk boundaries: $lines lines', async ({ text, lines, endsWithNewline }) => {
    const bytes = Buffer.from(text);
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield new Uint8Array();
      for (let offset = 0; offset < bytes.length; offset += 7) {
        const chunk = bytes.subarray(offset, offset + 7);
        yield offset % 2 === 0 ? chunk : new Uint8Array(chunk);
        yield new Uint8Array();
      }
    }
    expect(await digestWireBytes(chunks())).toEqual({
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      lines,
      endsWithNewline,
    });
  });

  it('propagates a stream failure without returning a partial proof', async () => {
    const failure = new Error('stream failed');
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield Buffer.from('first\n');
      throw failure;
    }
    await expect(digestWireBytes(chunks())).rejects.toBe(failure);
  });
});

describe('WireService seal', () => {
  it('writes the metadata envelope once and ignores repeated calls', async () => {
    await wire.seal();
    await wire.seal();

    expect(await readRecords()).toEqual([
      {
        type: 'metadata',
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: expect.any(Number),
      },
    ]);
  });

  it('does not seal a journal that already has records', async () => {
    log.append(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY, {
      type: 'wire.test.existing',
      time: 1,
    });
    await log.flush();

    await wire.seal();

    expect(await readRecords()).toEqual([{ type: 'wire.test.existing', time: 1 }]);
  });

  it('durably opens before acceptance and seals only after all accepted wire records flush', async () => {
    await wire.seal();
    expect(wire.beginTranscriptEpoch).toBeDefined();
    await wire.beginTranscriptEpoch!();
    const scope = testWireScope(SCOPE, KEY);
    const open = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
      (await storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!,
    ).toString('utf8')));
    expect(open).toMatchObject({ state: 'open', trusted: true });
    wire.appendRecord({ type: 'turn.prompt', turnId: 0 });
    await wire.sealTranscriptEpoch!();
    const sealed = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
      (await storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!,
    ).toString('utf8')));
    expect(sealed).toMatchObject({ format: 2, state: 'sealed', epoch: open?.epoch, trusted: true, wire: { size: expect.any(Number), tailBytes: expect.any(Number), tailSha256: expect.any(String) } });
    const reopened = registerTestAgentWire(disposables.add(new TestInstantiationService()), scope, {
      log, storage, logger: noopLogger, telemetry: noopTelemetryService,
    });
    await reopened.seal();
    await reopened.beginTranscriptEpoch!();
    const next = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
      (await storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!,
    ).toString('utf8')));
    expect(next).toMatchObject({ state: 'open', trusted: true });
    expect(next?.epoch).not.toBe(open?.epoch);
  });

  it('verifies only the current trusted live epoch while its durable acceptance fence is intact', async () => {
    await wire.seal();
    await wire.beginTranscriptEpoch!();
    expect(wire.isTranscriptLiveEpochVerified!()).toBe(false);
    expect(await wire.verifyTranscriptLiveEpoch!()).toBe(true);
    expect(wire.isTranscriptLiveEpochVerified!()).toBe(true);
    wire.appendRecord({ type: 'turn.prompt', turnId: 0 });
    expect(wire.isTranscriptLiveEpochVerified!()).toBe(false);
    expect(await wire.verifyTranscriptLiveEpoch!()).toBe(true);
    expect(wire.isTranscriptLiveEpochVerified!()).toBe(true);
    const scope = testWireScope(SCOPE, KEY);
    const reopened = registerTestAgentWire(disposables.add(new TestInstantiationService()), scope, {
      log, storage, logger: noopLogger, telemetry: noopTelemetryService,
    });
    expect(await reopened.verifyTranscriptLiveEpoch!()).toBe(false);
    await reopened.seal();
    await reopened.beginTranscriptEpoch!();
    expect(await reopened.verifyTranscriptLiveEpoch!()).toBe(false);
    expect(await wire.verifyTranscriptLiveEpoch!()).toBe(false);
  });

  it('coalesces concurrent live epoch proofs but rechecks subsequent reads and external changes', async () => {
    await wire.seal();
    await wire.beginTranscriptEpoch!();
    const original = storage.readStream.bind(storage);
    let reads = 0;
    storage.readStream = async function* (...args: Parameters<typeof original>) {
      if (args[1] === AGENT_WIRE_RECORD_KEY) reads++;
      yield* original(...args);
    };
    expect(await Promise.all(Array.from({ length: 8 }, () => wire.verifyTranscriptLiveEpoch!())))
      .toEqual(Array.from({ length: 8 }, () => true));
    expect(reads).toBe(1);
    expect(await wire.verifyTranscriptLiveEpoch!()).toBe(true);
    expect(reads).toBe(2);
    log.append(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY, { type: 'wire.test.external' });
    await log.flush();
    expect(await wire.verifyTranscriptLiveEpoch!()).toBe(false);
    expect(wire.isTranscriptLiveEpochVerified!()).toBe(false);
    expect(reads).toBe(3);
  });

  it('extends a live epoch proof from the verified prefix instead of rehashing the journal', async () => {
    await wire.seal();
    for (let turnId = 0; turnId < 64; turnId++) wire.appendRecord({ type: 'turn.prompt', turnId, text: 'x'.repeat(4096) });
    await wire.flush();
    await wire.beginTranscriptEpoch!();
    const scope = testWireScope(SCOPE, KEY);
    const original = storage.readStream.bind(storage);
    let bytes = 0;
    storage.readStream = async function* (...args: Parameters<typeof original>) {
      for await (const chunk of original(...args)) {
        if (args[1] === AGENT_WIRE_RECORD_KEY) bytes += chunk.byteLength;
        yield chunk;
      }
    };
    expect(await wire.verifyTranscriptLiveEpoch!()).toBe(true);
    const journalSize = (await storage.size(scope, AGENT_WIRE_RECORD_KEY))!;
    expect(bytes).toBeLessThan(16_384);
    for (let turnId = 64; turnId < 72; turnId++) {
      bytes = 0;
      const record = { type: 'turn.prompt', turnId };
      wire.appendRecord(record);
      expect(await wire.verifyTranscriptLiveEpoch!()).toBe(true);
      expect(bytes).toBeLessThan(4096 + 2 * Buffer.byteLength(`${JSON.stringify(record)}\n`) + 1);
    }
    expect(journalSize).toBeGreaterThan(64 * 4096);
    const tail = Buffer.from((await storage.read(scope, AGENT_WIRE_RECORD_KEY))!);
    tail[tail.byteLength - 10] = '0'.charCodeAt(0) === tail[tail.byteLength - 10] ? '1'.charCodeAt(0) : '0'.charCodeAt(0);
    await storage.write(scope, AGENT_WIRE_RECORD_KEY, tail);
    wire.appendRecord({ type: 'turn.prompt', turnId: 73 });
    expect(await wire.verifyTranscriptLiveEpoch!()).toBe(false);
  });

  it.each(['verify', 'seal'] as const)('rejects a rewritten prefix outside the cached boundary during %s', async (operation) => {
    await wire.seal();
    wire.appendRecord({ type: 'turn.prompt', turnId: 0, text: `original-prefix${'x'.repeat(8192)}` });
    await wire.flush();
    await wire.beginTranscriptEpoch!();
    const scope = testWireScope(SCOPE, KEY);
    const original = Buffer.from((await storage.read(scope, AGENT_WIRE_RECORD_KEY))!).toString('utf8');
    await storage.write(scope, AGENT_WIRE_RECORD_KEY, Buffer.from(original.replace('original-prefix', 'modified-prefix')));
    if (operation === 'verify') {
      expect(await wire.verifyTranscriptLiveEpoch!()).toBe(false);
    } else {
      const unexpected: unknown[] = [];
      setUnexpectedErrorHandler((error) => unexpected.push(error));
      try {
        await wire.sealTranscriptEpoch!();
        const receipt = parseWireTranscriptReceipt(JSON.parse(Buffer.from((await storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!).toString('utf8')));
        expect(receipt).toMatchObject({ state: 'sealed', trusted: false });
        expect(unexpected).toHaveLength(1);
      } finally { resetUnexpectedErrorHandler(); }
    }
  });

  it('detects an external prefix rewrite before a managed append can mask its metadata change', async () => {
    await wire.seal();
    wire.appendRecord({ type: 'turn.prompt', turnId: 0, text: `original-prefix${'x'.repeat(8192)}` });
    await wire.beginTranscriptEpoch!();
    const scope = testWireScope(SCOPE, KEY);
    const original = Buffer.from((await storage.read(scope, AGENT_WIRE_RECORD_KEY))!).toString('utf8');
    await storage.write(scope, AGENT_WIRE_RECORD_KEY, Buffer.from(original.replace('original-prefix', 'modified-prefix')));
    wire.appendRecord({ type: 'turn.prompt', turnId: 1 });
    expect(await wire.verifyTranscriptLiveEpoch!()).toBe(false);
    expect(wire.isTranscriptLiveEpochVerified!()).toBe(false);
  });

  it('re-reads only the epoch appended region on every proof when storage cannot provide a file identity', async () => {
    const originalStat = storage.stat.bind(storage);
    storage.stat = async (...args) => {
      const info = await originalStat(...args);
      return info === undefined ? undefined : { ...info, identity: undefined };
    };
    await wire.seal();
    wire.appendRecord({ type: 'turn.prompt', turnId: 0, text: 'x'.repeat(8192) });
    await wire.beginTranscriptEpoch!();
    const scope = testWireScope(SCOPE, KEY);
    const original = storage.readStream.bind(storage);
    let bytes = 0;
    storage.readStream = async function* (...args: Parameters<typeof original>) {
      for await (const chunk of original(...args)) {
        if (args[1] === AGENT_WIRE_RECORD_KEY) bytes += chunk.byteLength;
        yield chunk;
      }
    };
    const base = (await storage.size(scope, AGENT_WIRE_RECORD_KEY))!;
    expect(base).toBeGreaterThan(8192);
    wire.appendRecord({ type: 'turn.prompt', turnId: 1 });
    for (let attempt = 0; attempt < 2; attempt++) {
      bytes = 0;
      expect(await wire.verifyTranscriptLiveEpoch!()).toBe(true);
      expect(bytes).toBe((await storage.size(scope, AGENT_WIRE_RECORD_KEY))! - (base - 4096));
    }
  });

  it.each(['in-place', 'then-append', 'replace', 'shrink'] as const)('invalidates a real file proof after %s changes with restored mtime', async (change) => {
    const base = await mkdtemp(join(tmpdir(), 'wire-source-revision-'));
    const host = new DisposableStore();
    try {
      const fileStorage = new FileStorageService(base);
      const fileIx = host.add(new TestInstantiationService());
      fileIx.stub(IFileSystemStorageService, fileStorage);
      fileIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
      const fileLog = fileIx.get(IAppendLogStore);
      const fileWire = registerTestAgentWire(fileIx, 'main', { log: fileLog, storage: fileStorage, logger: noopLogger, telemetry: noopTelemetryService });
      await fileWire.seal();
      fileWire.appendRecord({ type: 'turn.prompt', turnId: 0, text: `${'x'.repeat(8192)}original-prefix${'y'.repeat(8192)}` });
      await fileWire.flush();
      const path = fileStorage.pathFor('main', AGENT_WIRE_RECORD_KEY);
      const fixedTime = 1_700_000_000;
      await utimes(path, fixedTime, fixedTime);
      await fileWire.beginTranscriptEpoch!();
      expect(await fileWire.verifyTranscriptLiveEpoch!()).toBe(true);
      const before = await fileStorage.stat('main', AGENT_WIRE_RECORD_KEY);
      const original = Buffer.from((await fileStorage.read('main', AGENT_WIRE_RECORD_KEY))!).toString('utf8');
      const changed = Buffer.from(original.replace('original-prefix', 'modified-prefix'));
      if (change === 'replace') await fileStorage.write('main', AGENT_WIRE_RECORD_KEY, changed);
      else {
        const handle = await open(path, 'r+');
        try {
          if (change === 'shrink') await handle.truncate(changed.byteLength - 300);
          else await handle.write(changed, 0, changed.byteLength, 0);
        } finally { await handle.close(); }
      }
      await utimes(path, fixedTime, fixedTime);
      expect((await stat(path)).mtimeMs).toBe(fixedTime * 1000);
      expect(await fileStorage.stat('main', AGENT_WIRE_RECORD_KEY)).not.toEqual(before);
      if (change === 'then-append') fileWire.appendRecord({ type: 'turn.prompt', turnId: 1 });
      expect(await fileWire.verifyTranscriptLiveEpoch!()).toBe(false);
    } finally {
      await host.dispose();
      await rm(base, { recursive: true, force: true });
    }
  });

  it('revalidates the epoch tail of cold segments instead of reusing a physical-file revision for logical bytes', async () => {
    await wire.seal();
    wire.appendRecord({ type: 'turn.prompt', turnId: 0, text: 'x'.repeat(16384) });
    await wire.beginTranscriptEpoch!();
    const scope = testWireScope(SCOPE, KEY);
    await log.sealCold(scope, AGENT_WIRE_RECORD_KEY, (await storage.size(scope, AGENT_WIRE_RECORD_KEY))!, { segmentBytes: 4096 });
    const original = storage.read.bind(storage);
    let segments = 0;
    storage.read = async (...args) => {
      if (args[1].endsWith('.deflate')) segments++;
      return original(...args);
    };
    expect(await wire.verifyTranscriptLiveEpoch!()).toBe(true);
    const tailSegments = segments;
    expect(tailSegments).toBeGreaterThan(0);
    expect(tailSegments).toBeLessThan(5);
    segments = 0;
    expect(await wire.verifyTranscriptLiveEpoch!()).toBe(true);
    expect(segments).toBe(tailSegments);
    const manifest = JSON.parse(Buffer.from((await original(scope, `${AGENT_WIRE_RECORD_KEY}.segments.json`))!).toString('utf8')) as { segments: { key: string }[] };
    await storage.write(scope, manifest.segments.at(-1)!.key, Buffer.from('invalid compressed bytes'));
    await expect(wire.verifyTranscriptLiveEpoch!()).rejects.toMatchObject({ code: 'storage.corrupted' });
    expect(wire.isTranscriptLiveEpochVerified!()).toBe(false);
  });

  it('rejects a proof when an external rewrite occurs during the boundary read', async () => {
    await wire.seal();
    wire.appendRecord({ type: 'turn.prompt', turnId: 0, text: `original-prefix${'x'.repeat(8192)}` });
    await wire.beginTranscriptEpoch!();
    const scope = testWireScope(SCOPE, KEY);
    const before = Buffer.from((await storage.read(scope, AGENT_WIRE_RECORD_KEY))!).toString('utf8');
    const original = storage.readStream.bind(storage);
    storage.readStream = async function* (...args: Parameters<typeof original>) {
      yield* original(...args);
      if (args[1] === AGENT_WIRE_RECORD_KEY) await storage.write(scope, AGENT_WIRE_RECORD_KEY, Buffer.from(before.replace('original-prefix', 'modified-prefix')));
    };
    expect(await wire.verifyTranscriptLiveEpoch!()).toBe(false);
    expect(wire.isTranscriptLiveEpochVerified!()).toBe(false);
  });

  it('does not share live epoch proofs across an append or discard a newer accepted fence', async () => {
    await wire.seal();
    await wire.beginTranscriptEpoch!();
    const original = storage.readStream.bind(storage);
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let reachedFirst!: () => void;
    const reached = new Promise<void>((resolve) => { reachedFirst = resolve; });
    let reads = 0;
    storage.readStream = async function* (...args: Parameters<typeof original>) {
      if (args[1] === AGENT_WIRE_RECORD_KEY && ++reads === 1) {
        reachedFirst();
        await gate;
      }
      yield* original(...args);
    };
    const older = wire.verifyTranscriptLiveEpoch!();
    await reached;
    try {
      wire.appendRecord({ type: 'turn.prompt', turnId: 0 });
      expect(await wire.verifyTranscriptLiveEpoch!()).toBe(true);
    } finally {
      releaseFirst();
    }
    expect(await older).toBe(false);
    expect(reads).toBe(2);
    expect(wire.isTranscriptLiveEpochVerified!()).toBe(true);
  });

  it('releases a failed shared live epoch proof so the next read can retry', async () => {
    await wire.seal();
    await wire.beginTranscriptEpoch!();
    const original = storage.readStream.bind(storage);
    const failure = new Error('proof stream failed');
    let reads = 0;
    storage.readStream = async function* (...args: Parameters<typeof original>) {
      if (args[1] === AGENT_WIRE_RECORD_KEY && ++reads === 1) throw failure;
      yield* original(...args);
    };
    const results = await Promise.allSettled([wire.verifyTranscriptLiveEpoch!(), wire.verifyTranscriptLiveEpoch!()]);
    expect(results).toEqual([{ status: 'rejected', reason: failure }, { status: 'rejected', reason: failure }]);
    expect(reads).toBe(1);
    expect(wire.isTranscriptLiveEpochVerified!()).toBe(false);
    expect(await wire.verifyTranscriptLiveEpoch!()).toBe(true);
    expect(reads).toBe(2);
  });

  it('never upgrades a legacy wire or an interrupted epoch to complete', async () => {
    log.append(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY, { type: 'turn.prompt', turnId: 0 });
    await log.flush();
    await wire.seal();
    await wire.beginTranscriptEpoch!();
    await wire.sealTranscriptEpoch!();
    const receipt = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
      (await storage.read(testWireScope(SCOPE, KEY), WIRE_TRANSCRIPT_RECEIPT_KEY))!,
    ).toString('utf8')));
    expect(receipt).toMatchObject({ state: 'sealed', trusted: false });
  });

  it('seals the observed journal without certifying it when accepted bytes diverge', async () => {
    await wire.seal();
    await wire.beginTranscriptEpoch!();
    wire.appendRecord({ type: 'turn.prompt', turnId: 0, input: [{ type: 'text', text: 'a' }] });
    await wire.flush();
    const scope = testWireScope(SCOPE, KEY);
    const original = Buffer.from((await storage.read(scope, AGENT_WIRE_RECORD_KEY))!).toString('utf8');
    const changed = original.replace('"text":"a"', '"text":"b"');
    expect(changed).not.toBe(original);
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
    await storage.write(scope, AGENT_WIRE_RECORD_KEY, Buffer.from(changed));
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      await wire.sealTranscriptEpoch!();
      const sealed = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
        (await storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!,
      ).toString('utf8')));
      const observed = Buffer.from((await storage.read(scope, AGENT_WIRE_RECORD_KEY))!);
      const tail = observed.subarray(Math.max(0, observed.byteLength - 4096));
      expect(sealed).toMatchObject({ state: 'sealed', trusted: false, wire: {
        size: observed.byteLength, tailBytes: tail.byteLength, tailSha256: createHash('sha256').update(tail).digest('hex'),
      } });
      expect(Buffer.from((await storage.read(scope, AGENT_WIRE_RECORD_KEY))!).toString('utf8')).toBe(changed);
      expect(await wire.verifyTranscriptLiveEpoch!()).toBe(false);
      expect(wire.isTranscriptLiveEpochVerified!()).toBe(false);
      expect(unexpected).toEqual([expect.objectContaining({ message: 'Transcript wire contents do not match accepted events' })]);
      const reopened = registerTestAgentWire(disposables.add(new TestInstantiationService()), scope, {
        log, storage, logger: noopLogger, telemetry: noopTelemetryService,
      });
      await reopened.seal();
      await reopened.beginTranscriptEpoch!();
      const next = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
        (await storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!,
      ).toString('utf8')));
      expect(next).toMatchObject({ state: 'open', trusted: false });
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  const SECOND_WRITER = [
    "const fs = require('node:fs');",
    'const [path, mode] = process.argv.slice(1);',
    'const original = fs.readFileSync(path);',
    "const changed = Buffer.from(original.toString('utf8').replace('original-prefix', 'modified-prefix'));",
    "if (changed.equals(original) || changed.byteLength !== original.byteLength) throw new Error('unexpected writer input');",
    "const fd = fs.openSync(path, 'r+');",
    "if (mode === 'truncate') fs.ftruncateSync(fd, 0);",
    'fs.writeSync(fd, changed, 0, changed.byteLength, 0);',
    'fs.fsyncSync(fd);',
    'fs.closeSync(fd);',
    'process.stdout.write(String(process.pid));',
  ].join('\n');

  async function realFileEpoch(base: string, host: DisposableStore, openAppend?: (path: string) => Promise<FileHandle>) {
    const fileStorage = new FileStorageService(base, undefined, undefined, true, openAppend);
    const fileIx = host.add(new TestInstantiationService());
    fileIx.stub(IFileSystemStorageService, fileStorage);
    fileIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const fileLog = fileIx.get(IAppendLogStore);
    const fileWire = registerTestAgentWire(fileIx, 'main', { log: fileLog, storage: fileStorage, logger: noopLogger, telemetry: noopTelemetryService });
    await fileWire.seal();
    fileWire.appendRecord({ type: 'turn.prompt', turnId: 0, text: `original-prefix${'x'.repeat(16384)}` });
    await fileWire.flush();
    await fileWire.beginTranscriptEpoch!();
    expect(await fileWire.verifyTranscriptLiveEpoch!()).toBe(true);
    return { fileStorage, fileLog, fileWire };
  }

  async function sealAndReopen(target: IWireService, scope: string, store: IFileSystemStorageService, host: DisposableStore, onSealed?: () => void) {
    const live = await target.verifyTranscriptLiveEpoch!();
    await target.sealTranscriptEpoch!();
    onSealed?.();
    const sealed = parseWireTranscriptReceipt(JSON.parse(Buffer.from((await store.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!).toString('utf8')));
    const reopened = registerTestAgentWire(host.add(new TestInstantiationService()), scope, {
      log: new AppendLogStore(store), storage: store, logger: noopLogger, telemetry: noopTelemetryService,
    });
    await reopened.seal();
    await reopened.beginTranscriptEpoch!();
    reopened.appendRecord({ type: 'turn.prompt', turnId: 9, text: 'after-reopen' });
    await reopened.flush();
    return { live, sealed: { state: sealed?.state, trusted: sealed?.trusted, reanchor: sealed?.reanchor === true }, reopened: await reopened.verifyTranscriptLiveEpoch!() };
  }

  const TRUSTED = { live: true, sealed: { state: 'sealed', trusted: true, reanchor: false }, reopened: true };
  const UNRECOVERABLE = {
    live: false,
    sealed: { state: 'sealed', trusted: false, reanchor: false },
    reopened: false,
  };
  const REANCHORED = {
    live: false,
    sealed: { state: 'sealed', trusted: false, reanchor: true },
    reopened: true,
  };

  it.each(['uncommitted', 'partial', 'sync'] as const)('recovers an append failure and re-anchors trust at the next epoch, mode=%s', async (mode) => {
    await wire.seal();
    await wire.beginTranscriptEpoch!();
    expect(await wire.verifyTranscriptLiveEpoch!()).toBe(true);
    const scope = testWireScope(SCOPE, KEY);
    const append = storage.append.bind(storage);
    let failing = true;
    const error = new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'injected full disk', {
      details: { committed: mode !== 'uncommitted', errno: 'ENOSPC' },
    });
    storage.append = async (target, key, bytes, options) => {
      if (failing && key === AGENT_WIRE_RECORD_KEY) {
        if (mode !== 'uncommitted') await append(target, key, mode === 'partial' ? bytes.subarray(0, 13) : bytes, options);
        throw error;
      }
      await append(target, key, bytes, options);
    };
    setUnexpectedErrorHandler(() => {});
    try {
      const accepted = { type: 'turn.prompt', turnId: 0, input: [{ type: 'text', text: 'recovered 中文' }] } as WireRecord;
      wire.appendRecord(accepted);
      await expect(wire.flush()).rejects.toBe(error);
      failing = false;
      await wire.flush();
      const text = Buffer.from((await storage.read(scope, AGENT_WIRE_RECORD_KEY))!).toString('utf8');
      expect(text.split('\n').filter(Boolean)).toHaveLength(2);
      expect(text).toContain(`${JSON.stringify(accepted)}\n`);
      expect(await sealAndReopen(wire, scope, storage, disposables)).toEqual(mode === 'uncommitted' ? TRUSTED : REANCHORED);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  async function patchPrefixByte(fileStorage: FileStorageService, truncate: boolean) {
    const path = fileStorage.pathFor('main', AGENT_WIRE_RECORD_KEY);
    const original = Buffer.from((await fileStorage.read('main', AGENT_WIRE_RECORD_KEY))!);
    const offset = original.indexOf('original-prefix');
    const changed = Buffer.from(original);
    changed[offset] = 0x4d;
    const handle = await open(path, 'r+');
    try {
      if (truncate) await handle.truncate(0);
      await handle.write(changed, 0, changed.byteLength, 0);
      await handle.sync();
    } finally { await handle.close(); }
  }

  it.each([
    { name: 'no failed append (control)', failure: undefined, truncate: false, bytes: 0, expected: 'unrecoverable' },
    { name: 'committed:false, nothing written', failure: false, truncate: false, bytes: 0, expected: 'unrecoverable' },
    { name: 'committed:true, nothing written', failure: true, truncate: false, bytes: 0, expected: 'unrecoverable' },
    { name: 'committed:true, truncate-rewrite then 13 bytes', failure: true, truncate: true, bytes: 13, expected: 'undetectable' },
    { name: 'committed:true, in-place rewrite then 13 bytes', failure: true, truncate: false, bytes: 13, expected: 'undetectable' },
  ] as const)('classifies a base prefix rewrite outside the tail, $name', async ({ failure, truncate, bytes, expected }) => {
    const base = await mkdtemp(join(tmpdir(), 'wire-prefix-rewrite-'));
    const host = new DisposableStore();
    setUnexpectedErrorHandler(() => {});
    try {
      const { fileStorage, fileWire } = await realFileEpoch(base, host);
      const append = fileStorage.append.bind(fileStorage);
      let failing = failure !== undefined;
      const error = new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'injected append failure', {
        details: { errno: 'ENOSPC', committed: failure ?? false },
      });
      fileStorage.append = async (scope, key, data, options) => {
        if (failing && key === AGENT_WIRE_RECORD_KEY) {
          failing = false;
          await patchPrefixByte(fileStorage, truncate);
          if (bytes > 0) await append(scope, key, data.subarray(0, bytes), options);
          throw error;
        }
        await append(scope, key, data, options);
      };
      if (failure === undefined) await patchPrefixByte(fileStorage, truncate);
      fileWire.appendRecord({ type: 'turn.prompt', turnId: 1, text: 'accepted-tail' });
      if (failure !== undefined) await expect(fileWire.flush()).rejects.toBe(error);
      await fileWire.flush();
      expect(Buffer.from((await fileStorage.read('main', AGENT_WIRE_RECORD_KEY))!).toString('utf8')).not.toContain('original-prefix');
      expect(await sealAndReopen(fileWire, 'main', fileStorage, host)).toEqual(expected === 'unrecoverable' ? UNRECOVERABLE : REANCHORED);
    } finally {
      resetUnexpectedErrorHandler();
      await host.dispose();
      await rm(base, { recursive: true, force: true });
    }
  });

  it('does not let a failure that changed nothing make a later rewrite in the same epoch re-anchor', async () => {
    const base = await mkdtemp(join(tmpdir(), 'wire-benign-failure-'));
    const host = new DisposableStore();
    setUnexpectedErrorHandler(() => {});
    try {
      const { fileStorage, fileWire } = await realFileEpoch(base, host);
      const append = fileStorage.append.bind(fileStorage);
      let failing = true;
      const error = new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'injected append failure', {
        details: { errno: 'ENOSPC', committed: false },
      });
      fileStorage.append = async (scope, key, data, options) => {
        if (failing && key === AGENT_WIRE_RECORD_KEY) {
          failing = false;
          throw error;
        }
        await append(scope, key, data, options);
      };
      fileWire.appendRecord({ type: 'turn.prompt', turnId: 1, text: 'accepted-tail' });
      await expect(fileWire.flush()).rejects.toBe(error);
      await fileWire.flush();
      expect(await fileWire.verifyTranscriptLiveEpoch!()).toBe(true);
      fileWire.appendRecord({ type: 'turn.prompt', turnId: 2, text: 'more' });
      await fileWire.flush();
      await patchPrefixByte(fileStorage, false);
      expect(await sealAndReopen(fileWire, 'main', fileStorage, host)).toEqual(UNRECOVERABLE);
    } finally {
      resetUnexpectedErrorHandler();
      await host.dispose();
      await rm(base, { recursive: true, force: true });
    }
  });

  it('cannot detect a base prefix rewrite absorbed by a successful append, like the failed-append growth class', async () => {
    const base = await mkdtemp(join(tmpdir(), 'wire-absorbed-rewrite-'));
    const host = new DisposableStore();
    try {
      const { fileStorage, fileWire } = await realFileEpoch(base, host);
      const append = fileStorage.append.bind(fileStorage);
      let rewriting = true;
      fileStorage.append = async (scope, key, data, options) => {
        if (rewriting && key === AGENT_WIRE_RECORD_KEY) {
          rewriting = false;
          await patchPrefixByte(fileStorage, true);
        }
        await append(scope, key, data, options);
      };
      fileWire.appendRecord({ type: 'turn.prompt', turnId: 1, text: 'accepted-tail' });
      await fileWire.flush();
      expect(Buffer.from((await fileStorage.read('main', AGENT_WIRE_RECORD_KEY))!).toString('utf8')).not.toContain('original-prefix');
      expect(await sealAndReopen(fileWire, 'main', fileStorage, host)).toEqual(TRUSTED);
    } finally {
      await host.dispose();
      await rm(base, { recursive: true, force: true });
    }
  });

  it('does not re-anchor when the bytes appended after a failed append diverge', async () => {
    await wire.seal();
    await wire.beginTranscriptEpoch!();
    const scope = testWireScope(SCOPE, KEY);
    const append = storage.append.bind(storage);
    let failing = true;
    const error = new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'injected full disk', {
      details: { committed: true, errno: 'ENOSPC' },
    });
    storage.append = async (target, key, bytes, options) => {
      if (failing && key === AGENT_WIRE_RECORD_KEY) {
        await append(target, key, bytes.subarray(0, 13), options);
        throw error;
      }
      await append(target, key, bytes, options);
    };
    setUnexpectedErrorHandler(() => {});
    try {
      wire.appendRecord({ type: 'turn.prompt', turnId: 0, input: [{ type: 'text', text: 'a' }] } as WireRecord);
      await expect(wire.flush()).rejects.toBe(error);
      failing = false;
      await wire.flush();
      const original = Buffer.from((await storage.read(scope, AGENT_WIRE_RECORD_KEY))!).toString('utf8');
      await storage.write(scope, AGENT_WIRE_RECORD_KEY, Buffer.from(original.replace('"text":"a"', '"text":"b"')));
      await wire.sealTranscriptEpoch!();
      const sealed = parseWireTranscriptReceipt(JSON.parse(Buffer.from((await storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!).toString('utf8')));
      expect(sealed).toMatchObject({ state: 'sealed', trusted: false });
      expect(sealed?.reanchor).toBeUndefined();
      const reopened = registerTestAgentWire(disposables.add(new TestInstantiationService()), scope, {
        log: new AppendLogStore(storage), storage, logger: noopLogger, telemetry: noopTelemetryService,
      });
      await reopened.seal();
      await reopened.beginTranscriptEpoch!();
      expect(await reopened.verifyTranscriptLiveEpoch!()).toBe(false);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it.each([
    { mode: 'plain', expected: 'trusted' },
    { mode: 'uncommitted', expected: 'trusted' },
    { mode: 'started-zero', expected: 'trusted' },
    { mode: 'partial', expected: 'reanchored' },
    { mode: 'full-sync', expected: 'reanchored' },
    { mode: 'repeat-sync', expected: 'reanchored' },
  ] as const)('recovers a real file append without full hashing, mode=$mode', async ({ mode, expected }) => {
    const base = await mkdtemp(join(tmpdir(), 'wire-normal-append-'));
    const host = new DisposableStore();
    setUnexpectedErrorHandler(() => {});
    try {
      const { fileStorage, fileLog, fileWire } = await realFileEpoch(base, host);
      const revisionBefore = await fileLog.sourceRevision!('main', AGENT_WIRE_RECORD_KEY);
      const append = fileStorage.append.bind(fileStorage);
      let calls = 0;
      const failure = new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'injected append failure', {
        details: { errno: 'ENOSPC', committed: mode !== 'uncommitted' },
      });
      fileStorage.append = async (scope, key, bytes, options) => {
        if (key === AGENT_WIRE_RECORD_KEY && mode !== 'plain') {
          calls++;
          if (calls === 1) {
            if (mode === 'partial') await append(scope, key, bytes.subarray(0, 13), options);
            if (mode === 'full-sync' || mode === 'repeat-sync') await append(scope, key, bytes, options);
            throw failure;
          }
          if (mode === 'repeat-sync' && calls === 2) {
            await append(scope, key, bytes, options);
            throw failure;
          }
        }
        await append(scope, key, bytes, options);
      };
      const reads = { counting: true, full: 0 };
      const readStream = fileStorage.readStream.bind(fileStorage);
      fileStorage.readStream = (scope, key, range, options) => {
        if (reads.counting && key === AGENT_WIRE_RECORD_KEY && (range === undefined || range.start === 0)) reads.full++;
        return readStream(scope, key, range, options);
      };
      fileWire.appendRecord({ type: 'turn.prompt', turnId: 1, text: 'accepted-tail' });
      if (mode !== 'plain') {
        await expect(fileWire.flush()).rejects.toBe(failure);
        if (mode === 'repeat-sync') await expect(fileWire.flush()).rejects.toBe(failure);
      }
      await fileWire.flush();
      fileWire.appendRecord({ type: 'turn.prompt', turnId: 2, text: 'ordinary-follow-up' });
      await fileWire.flush();
      const text = Buffer.from((await fileStorage.read('main', AGENT_WIRE_RECORD_KEY))!).toString('utf8');
      expect(text.split('accepted-tail')).toHaveLength(2);
      expect(text.split('ordinary-follow-up')).toHaveLength(2);
      const revisionAfter = (await fileLog.sourceRevision!('main', AGENT_WIRE_RECORD_KEY))?.revision;
      if (expected === 'trusted') expect(revisionAfter).toBe(revisionBefore?.revision);
      else expect(revisionAfter).toBeGreaterThan(revisionBefore!.revision);
      expect(await sealAndReopen(fileWire, 'main', fileStorage, host, () => { reads.counting = false; })).toEqual(expected === 'trusted' ? TRUSTED : REANCHORED);
      expect(reads.full).toBe(0);
    } finally {
      resetUnexpectedErrorHandler();
      await host.dispose();
      await rm(base, { recursive: true, force: true });
    }
  });

  it.each([
    { change: 'replace', committed: false, expected: 'unrecoverable' },
    { change: 'in-place', committed: false, expected: 'unrecoverable' },
    { change: 'in-place', committed: true, expected: 'unrecoverable' },
    { change: 'truncate-rewrite', committed: false, expected: 'unrecoverable' },
    { change: 'truncate-rewrite', committed: true, expected: 'unrecoverable' },
    { change: 'truncate-rewrite-partial', committed: true, expected: 'undetectable' },
    { change: 'truncate-rewrite-full', committed: true, expected: 'undetectable' },
  ] as const)('never certifies an epoch whose base was rewritten during a failed append, $change committed=$committed', async ({ change, committed, expected }) => {
    const base = await mkdtemp(join(tmpdir(), 'wire-failed-append-'));
    const host = new DisposableStore();
    setUnexpectedErrorHandler(() => {});
    try {
      const { fileStorage, fileWire } = await realFileEpoch(base, host);
      const path = fileStorage.pathFor('main', AGENT_WIRE_RECORD_KEY);
      const original = Buffer.from((await fileStorage.read('main', AGENT_WIRE_RECORD_KEY))!);
      const changed = Buffer.from(original.toString('utf8').replace('original-prefix', 'modified-prefix'));
      expect(changed.subarray(-4096).equals(original.subarray(-4096))).toBe(true);
      const append = fileStorage.append.bind(fileStorage);
      let failing = true;
      const failure = new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'injected append failure', {
        details: { errno: 'ENOSPC', committed },
      });
      fileStorage.append = async (scope, key, bytes, options) => {
        if (failing && key === AGENT_WIRE_RECORD_KEY) {
          if (change === 'replace') await fileStorage.write(scope, key, changed);
          else {
            const handle = await open(path, 'r+');
            try {
              if (change !== 'in-place') await handle.truncate(0);
              await handle.write(changed, 0, changed.byteLength, 0);
              await handle.sync();
            } finally { await handle.close(); }
          }
          if (change === 'truncate-rewrite-partial') await append(scope, key, bytes.subarray(0, 13), options);
          if (change === 'truncate-rewrite-full') await append(scope, key, bytes, options);
          throw failure;
        }
        await append(scope, key, bytes, options);
      };
      fileWire.appendRecord({ type: 'turn.prompt', turnId: 1, text: 'accepted-tail' });
      await expect(fileWire.flush()).rejects.toBe(failure);
      failing = false;
      await fileWire.flush();
      expect(Buffer.from((await fileStorage.read('main', AGENT_WIRE_RECORD_KEY))!).toString('utf8')).toContain('modified-prefix');
      expect(await sealAndReopen(fileWire, 'main', fileStorage, host)).toEqual(expected === 'unrecoverable' ? UNRECOVERABLE : REANCHORED);
    } finally {
      resetUnexpectedErrorHandler();
      await host.dispose();
      await rm(base, { recursive: true, force: true });
    }
  });

  it.each([
    { moment: 'before-write', change: 'truncate', count: 13, expected: 'undetectable' },
    { moment: 'after-write', change: 'in-place', count: 13, expected: 'undetectable' },
    { moment: 'after-write', change: 'in-place', count: 0, expected: 'unrecoverable' },
  ] as const)('never certifies an epoch another process rewrote inside the append handle window, $moment $change bytes=$count', async ({ moment, change, count, expected }) => {
    const base = await mkdtemp(join(tmpdir(), 'wire-second-writer-'));
    const host = new DisposableStore();
    setUnexpectedErrorHandler(() => {});
    let failing = false;
    let writerPid: string | undefined;
    const writer = (path: string) => { writerPid = execFileSync(process.execPath, ['-e', SECOND_WRITER, path, change], { encoding: 'utf8' }); };
    try {
      const { fileStorage, fileLog, fileWire } = await realFileEpoch(base, host, async (path) => {
        const handle = await open(path, 'a');
        if (!failing) return handle;
        return {
          stat: handle.stat.bind(handle), sync: handle.sync.bind(handle), close: handle.close.bind(handle),
          writeFile: async (bytes: Uint8Array) => {
            if (moment === 'before-write') writer(path);
            if (count > 0) await handle.writeFile(bytes.subarray(0, count));
            if (moment === 'after-write') writer(path);
            throw Object.assign(new Error('injected writeFile ENOSPC'), { code: 'ENOSPC' });
          },
        } as unknown as FileHandle;
      });
      const revisionBefore = await fileLog.sourceRevision!('main', AGENT_WIRE_RECORD_KEY);
      failing = true;
      fileWire.appendRecord({ type: 'turn.prompt', turnId: 1, text: 'accepted-tail' });
      await expect(fileWire.flush()).rejects.toMatchObject({ code: 'storage.disk_full', details: { committed: true } });
      failing = false;
      expect(writerPid).not.toBe(String(process.pid));
      await fileWire.flush();
      const text = Buffer.from((await fileStorage.read('main', AGENT_WIRE_RECORD_KEY))!).toString('utf8');
      expect(text).toContain('modified-prefix');
      expect(text).not.toContain('original-prefix');
      expect((await fileLog.sourceRevision!('main', AGENT_WIRE_RECORD_KEY))?.revision).toBeGreaterThan(revisionBefore!.revision);
      expect(await sealAndReopen(fileWire, 'main', fileStorage, host)).toEqual(expected === 'unrecoverable' ? UNRECOVERABLE : REANCHORED);
    } finally {
      resetUnexpectedErrorHandler();
      await host.dispose();
      await rm(base, { recursive: true, force: true });
    }
  });

  it('still rejects the epoch when an uncertain append finds changed bytes', async () => {
    await wire.seal();
    await wire.beginTranscriptEpoch!();
    const scope = testWireScope(SCOPE, KEY);
    const append = storage.append.bind(storage);
    let failing = true;
    const error = new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'injected full disk', {
      details: { committed: true, errno: 'ENOSPC' },
    });
    storage.append = async (target, key, bytes, options) => {
      if (failing && key === AGENT_WIRE_RECORD_KEY) {
        await append(target, key, Buffer.from('X'.repeat(13)), options);
        throw error;
      }
      await append(target, key, bytes, options);
    };
    setUnexpectedErrorHandler(() => {});
    try {
      wire.appendRecord({ type: 'turn.prompt', turnId: 0, input: [{ type: 'text', text: 'lost' }] } as WireRecord);
      await expect(wire.flush()).rejects.toBe(error);
      failing = false;
      await expect(wire.flush()).rejects.toMatchObject({ code: 'storage.corrupted' });
      await wire.sealTranscriptEpoch!().catch(() => undefined);
      expect(wire.isTranscriptLiveEpochVerified!()).toBe(false);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('seals a trusted receipt when an accepted record lands during the first digest', async () => {
    await wire.seal();
    await wire.beginTranscriptEpoch!();
    const scope = testWireScope(SCOPE, KEY);
    const original = storage.readStream.bind(storage);
    let wireReads = 0;
    storage.readStream = async function* (...args: Parameters<typeof original>) {
      if (args[1] === AGENT_WIRE_RECORD_KEY && wireReads++ === 0) {
        wire.appendRecord({ type: 'turn.prompt', turnId: 0 });
      }
      yield* original(...args);
    };
    await wire.sealTranscriptEpoch!();
    const persisted = await storage.read(scope, AGENT_WIRE_RECORD_KEY);
    const sealed = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
      (await storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!,
    ).toString('utf8')));
    expect(Buffer.from(persisted!).toString('utf8')).toContain('"type":"turn.prompt"');
    expect(sealed).toMatchObject({
      state: 'sealed', trusted: true, wire: { size: persisted!.byteLength, tailSha256: expect.any(String) },
    });
    expect(wireReads).toBeGreaterThan(1);
  });

  it('leaves the open acceptance epoch in place when the receipt write fails', async () => {
    await wire.seal();
    await wire.beginTranscriptEpoch!();
    const scope = testWireScope(SCOPE, KEY);
    const failure = new Error('receipt write failed');
    const original = storage.write.bind(storage);
    storage.write = async (scopeKey, key, data, options) => {
      if (key === WIRE_TRANSCRIPT_RECEIPT_KEY) throw failure;
      return original(scopeKey, key, data, options);
    };
    await expect(wire.sealTranscriptEpoch!()).rejects.toBe(failure);
    const receipt = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
      (await storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!,
    ).toString('utf8')));
    expect(receipt).toMatchObject({ state: 'open', trusted: true });
  });

  it('reports a receipt write failure after a divergent journal without sealing it as trusted', async () => {
    await wire.seal();
    await wire.beginTranscriptEpoch!();
    wire.appendRecord({ type: 'turn.prompt', turnId: 0, input: [{ type: 'text', text: 'a' }] });
    await wire.flush();
    const scope = testWireScope(SCOPE, KEY);
    const originalBytes = Buffer.from((await storage.read(scope, AGENT_WIRE_RECORD_KEY))!).toString('utf8');
    const changed = originalBytes.replace('"text":"a"', '"text":"b"');
    await storage.write(scope, AGENT_WIRE_RECORD_KEY, Buffer.from(changed));
    const failure = new Error('receipt write failed');
    const original = storage.write.bind(storage);
    storage.write = async (scopeKey, key, data, options) => {
      if (key === WIRE_TRANSCRIPT_RECEIPT_KEY) throw failure;
      return original(scopeKey, key, data, options);
    };
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      await expect(wire.sealTranscriptEpoch!()).rejects.toBe(failure);
      const receipt = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
        (await storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!,
      ).toString('utf8')));
      expect(receipt).toMatchObject({ state: 'open', trusted: true });
      expect(receipt?.wire).toBeUndefined();
      expect(Buffer.from((await storage.read(scope, AGENT_WIRE_RECORD_KEY))!).toString('utf8')).toBe(changed);
      expect(wire.isTranscriptLiveEpochVerified!()).toBe(false);
      expect(unexpected).toEqual([expect.objectContaining({ message: 'Transcript wire contents do not match accepted events' })]);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('keeps the durable acceptance epoch open when dehydration fails before a later append', async () => {
    await wire.seal();
    await wire.beginTranscriptEpoch!();
    const failure = new Error('dehydration failed');
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      wire.appendRecord({ type: 'turn.prompt', turnId: 0 }, async () => { throw failure; });
      wire.appendRecord({ type: 'turn.ended', turnId: 0 });
      await expect(wire.sealTranscriptEpoch!()).rejects.toBe(failure);
      expect(unexpected).toEqual([failure]);
      expect((await readRecords()).map((record) => record.type)).toEqual(['metadata', 'turn.ended']);
      const receipt = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
        (await storage.read(testWireScope(SCOPE, KEY), WIRE_TRANSCRIPT_RECEIPT_KEY))!,
      ).toString('utf8')));
      expect(receipt).toMatchObject({ state: 'open', trusted: true });
    } finally {
      resetUnexpectedErrorHandler();
    }
  });
});

describe('WireService appendRecord', () => {
  it('appends flat records without a dehydrator', async () => {
    wire.appendRecord({ type: 'wire.test.append', value: 1, time: 10 });
    wire.appendRecord({ type: 'wire.test.append', value: 2, time: 11 });

    expect(await readRecords()).toEqual([
      { type: 'wire.test.append', value: 1, time: 10 },
      { type: 'wire.test.append', value: 2, time: 11 },
    ]);
  });

  it('runs records through the dehydrate queue in append order', async () => {
    const order: string[] = [];
    wire.appendRecord({ type: 'wire.test.a', time: 1 }, async (record) => {
      order.push('a');
      return { ...record, dehydrated: true };
    });
    wire.appendRecord({ type: 'wire.test.b', time: 2 }, async (record) => {
      order.push('b');
      return record;
    });
    await wire.flush();

    expect(order).toEqual(['a', 'b']);
    expect(await readRecords()).toEqual([
      { type: 'wire.test.a', time: 1, dehydrated: true },
      { type: 'wire.test.b', time: 2 },
    ]);
  });

  it('queues a plain append behind a pending dehydrate', async () => {
    const records: WireRecord[] = [];
    const queued = wireOverLog(recordingWireLog(records), 'queued');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    queued.appendRecord({ type: 'wire.test.gated', time: 1 }, async (record) => {
      await gate;
      return record;
    });
    queued.appendRecord({ type: 'wire.test.plain', time: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(records).toEqual([]);

    release();
    await queued.flush();
    expect(records).toEqual([
      { type: 'wire.test.gated', time: 1 },
      { type: 'wire.test.plain', time: 2 },
    ]);
  });

  it('hands the dehydrator a blob offload transform backed by the blob service', async () => {
    const offloaded: unknown[][] = [];
    const blob: IAgentBlobService = {
      _serviceBrand: undefined,
      offloadParts: async (parts) => {
        offloaded.push([...parts]);
        return parts.map((part) => ({ type: 'blob_ref', part })) as unknown as ContentPart[];
      },
      loadParts: async (parts) => parts,
      isBlobRef: () => false,
    };
    const records: WireRecord[] = [];
    const withBlob = wireOverLog(recordingWireLog(records), 'blob', { blob });

    withBlob.appendRecord(
      { type: 'wire.test.blob', parts: [{ type: 'text', text: 'x' }], time: 1 },
      async (record, transform) => ({
        ...record,
        parts: await transform(record['parts'] as readonly unknown[]),
      }),
    );
    await withBlob.flush();

    expect(offloaded).toEqual([[{ type: 'text', text: 'x' }]]);
    expect(records).toEqual([
      {
        type: 'wire.test.blob',
        parts: [{ type: 'blob_ref', part: { type: 'text', text: 'x' } }],
        time: 1,
      },
    ]);
  });

  it.each([false, true])('retains synchronous append failures without blocking later records (queued: %s)', async (queued) => {
    const expected = new Error('append exploded');
    const records: WireRecord[] = [];
    const failing = recordingWireLog(records);
    const append = failing.append.bind(failing);
    failing.append = (scope, key, record, options) => {
      if ((record as WireRecord).type === 'wire.test.fail') throw expected;
      append(scope, key, record, options);
    };
    const stub = wireOverLog(failing, 'failing');

    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      stub.appendRecord({ type: 'wire.test.fail', time: 1 }, queued ? async (record) => record : undefined);
      stub.appendRecord({ type: 'wire.test.good', time: 2 });
      await expect(stub.flush()).rejects.toBe(expected);
      await expect(stub.flush()).rejects.toBe(expected);
      expect(unexpected).toEqual([expected]);
      expect(records).toEqual([{ type: 'wire.test.good', time: 2 }]);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('reports a dehydrate gap to every barrier while later appends remain usable', async () => {
    const expected = new Error('dehydrate exploded');
    const records: WireRecord[] = [];
    const stub = wireOverLog(recordingWireLog(records), 'dehydrate-fail');

    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      stub.appendRecord({ type: 'wire.test.bad', time: 1 }, async () => {
        throw expected;
      });
      stub.appendRecord({ type: 'wire.test.good', time: 2 });
      await Promise.all([
        expect(stub.flush()).rejects.toBe(expected),
        expect(stub.flush()).rejects.toBe(expected),
      ]);
      stub.appendRecord({ type: 'wire.test.later', time: 3 }, async (record) => record);
      await expect(stub.flush()).rejects.toBe(expected);
      await expect(stub.flush()).rejects.toBe(expected);

      expect(unexpected).toEqual([expected]);
      expect(records).toEqual([
        { type: 'wire.test.good', time: 2 },
        { type: 'wire.test.later', time: 3 },
      ]);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('keeps asynchronous storage failures sticky until an explicit store recovery drains retained records', async () => {
    const expected = new Error('disk full');
    const append = storage.append.bind(storage);
    let writes = 0;
    storage.append = async (...args: Parameters<typeof storage.append>) => {
      writes++;
      if (writes <= 2) throw expected;
      return append(...args);
    };
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      wire.appendRecord({ type: 'wire.test.first', time: 1 });
      await expect(wire.flush()).rejects.toBe(expected);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unexpected).toContain(expected);
      expect(writes).toBe(2);
      storage.append = append;
      wire.appendRecord({ type: 'wire.test.second', time: 2 });
      await expect(wire.flush()).rejects.toBe(expected);
      await expect(wire.flush()).rejects.toBe(expected);
      expect(writes).toBe(2);
      expect(await storage.read(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY)).toBeUndefined();

      await log.rewrite(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY, []);
      await wire.flush();
      expect(await readRecords()).toEqual([
        { type: 'wire.test.first', time: 1 },
        { type: 'wire.test.second', time: 2 },
      ]);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });
});

describe('WireService readJournal', () => {
  it('bootstraps the metadata envelope onto an empty journal', async () => {
    expect(await collect(wire.readJournal())).toEqual([]);

    expect(await readRecords()).toEqual([
      {
        type: 'metadata',
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: expect.any(Number),
      },
    ]);
  });

  it('heals an envelope-less legacy journal through the v1.4 to v1.5 migration', async () => {
    log.append(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY, {
      type: 'goal.create',
      goalId: 'g1',
      objective: 'legacy',
      time: 7,
    });
    await log.flush();

    const yielded = await collect(wire.readJournal());

    expect(yielded).toEqual([
      {
        type: 'goal.create',
        goalId: 'g1',
        objective: 'legacy',
        time: 7,
        wallClockResumedAt: 7,
      },
    ]);
    expect(await readRecords()).toEqual([
      {
        type: 'metadata',
        protocol_version: WIRE_PROTOCOL_VERSION,
        created_at: expect.any(Number),
      },
      ...yielded,
    ]);
  });

  it('migrates a v1.4 journal and rewrites it at the current protocol version', async () => {
    log.append(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY, {
      type: 'metadata',
      protocol_version: '1.4',
      created_at: 1,
    });
    log.append(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY, {
      type: 'goal.create',
      goalId: 'g1',
      time: 9,
    });
    await log.flush();

    const yielded = await collect(wire.readJournal());

    expect(yielded).toEqual([
      { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'goal.create', goalId: 'g1', time: 9, wallClockResumedAt: 9 },
    ]);
    expect(await readRecords()).toEqual(yielded);
  });

  it('reads a current-version journal without rewriting it', async () => {
    const seeded: WireRecord[] = [
      { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'wire.test.current', value: 1, time: 2 },
    ];
    let rewrites = 0;
    const counting = recordingWireLog(seeded);
    const rewrite = counting.rewrite.bind(counting);
    counting.rewrite = async (scope, key, next) => {
      rewrites += 1;
      return rewrite(scope, key, next);
    };
    const stub = wireOverLog(counting, 'current');

    expect(await collect(stub.readJournal())).toEqual(seeded);
    expect(rewrites).toBe(0);
  });

  it('reads a newer-version journal without stamping or rewriting it', async () => {
    const seeded: WireRecord[] = [
      { type: 'metadata', protocol_version: '9.9', created_at: 1 },
      { type: 'wire.test.newer', value: 1, time: 2 },
    ];
    let rewrites = 0;
    const counting = recordingWireLog(seeded);
    const rewrite = counting.rewrite.bind(counting);
    counting.rewrite = async (scope, key, next) => {
      rewrites += 1;
      return rewrite(scope, key, next);
    };
    const stub = wireOverLog(counting, 'newer');

    expect(await collect(stub.readJournal())).toEqual(seeded);
    expect(rewrites).toBe(0);
  });

  it('rejects a malformed metadata envelope as corrupted storage', async () => {
    const stub = wireOverLog(
      recordingWireLog([{ type: 'metadata' }]),
      'malformed-metadata',
    );

    const failure = await collect(stub.readJournal()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageError);
    expect(failure).toMatchObject({
      code: StorageErrors.codes.STORAGE_CORRUPTED,
    });
  });

  it('skips malformed lines and reports them through onUnexpectedError', async () => {
    const seeded: WireRecord[] = [
      'garbage' as unknown as WireRecord,
      { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
      42 as unknown as WireRecord,
      { type: 'wire.test.ok', time: 3 },
    ];
    const stub = wireOverLog(recordingWireLog(seeded), 'malformed-lines');

    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      const yielded = await collect(stub.readJournal());

      expect(yielded).toEqual([
        { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
        { type: 'wire.test.ok', time: 3 },
      ]);
      expect(unexpected).toHaveLength(2);
      expect(unexpected[0]).toMatchObject({
        code: 'wire.unknown_record',
        details: { type: undefined, index: 0 },
      });
      expect(unexpected[1]).toMatchObject({
        code: 'wire.unknown_record',
        details: { type: undefined, index: 1 },
      });
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('throws when the journal version has no migration path', async () => {
    const stub = wireOverLog(
      recordingWireLog([{ type: 'metadata', protocol_version: '0.9', created_at: 1 }]),
      'no-migration',
    );

    await expect(collect(stub.readJournal())).rejects.toThrow(
      'Missing wire migration for version 0.9',
    );
  });
});

describe('WireService corruption repair', () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const BACKUP_KEY = wireJournalBackupKey(AGENT_WIRE_RECORD_KEY);

  interface RepairCapture {
    readonly warnings: Array<{ message: string; payload?: unknown }>;
    readonly events: Array<{ name: string; payload: unknown }>;
  }

  function wireWithCapture(key: string, capture: RepairCapture): IWireService {
    const logger: ILogService = {
      _serviceBrand: undefined,
      level: 'off',
      error: () => {},
      warn: (message, payload) => capture.warnings.push({ message, payload }),
      info: () => {},
      debug: () => {},
      child: () => logger,
      setLevel: () => {},
      flush: async () => {},
    };
    const telemetry: ITelemetryService = {
      ...noopTelemetryService,
      track2: ((name: string, payload: unknown) => {
        capture.events.push({ name, payload });
      }) as ITelemetryService['track2'],
    };
    const localIx = disposables.add(new TestInstantiationService());
    return registerTestAgentWire(localIx, testWireScope(SCOPE, key), {
      log,
      storage,
      logger,
      telemetry,
    });
  }

  async function rawBytes(key = AGENT_WIRE_RECORD_KEY): Promise<string | undefined> {
    const bytes = await storage.read(testWireScope(SCOPE, KEY), key);
    return bytes === undefined ? undefined : dec.decode(bytes);
  }

  async function seedCorrupt(raw: string): Promise<void> {
    await storage.write(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY, enc.encode(raw));
  }

  function currentMetadata(createdAt = 1): string {
    return JSON.stringify({
      type: 'metadata',
      protocol_version: WIRE_PROTOCOL_VERSION,
      created_at: createdAt,
    });
  }

  it('heals a torn final line, keeps the valid prefix, and backs up the original bytes', async () => {
    const valid = `${currentMetadata()}\n${JSON.stringify({ type: 'wire.test.ok', time: 3 })}\n`;
    const torn = `${JSON.stringify({ type: 'wire.test.torn', time: 4 }).slice(0, 12)}`;
    await seedCorrupt(valid + torn);

    const yielded = await collect(wire.readJournal());

    expect(yielded).toEqual([
      { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'wire.test.ok', time: 3 },
    ]);
    expect(await rawBytes()).toBe(valid);
    expect(await rawBytes(BACKUP_KEY)).toBe(valid + torn);
    expect(await collect(wire.readJournal())).toEqual(yielded);
  });

  it('truncates at a corrupted middle line, dropping later valid lines', async () => {
    const prefix = `${currentMetadata()}\n${JSON.stringify({ type: 'wire.test.a', time: 1 })}\n`;
    const raw = `${prefix}GARBAGE\n${JSON.stringify({ type: 'wire.test.b', time: 2 })}\n`;
    await seedCorrupt(raw);

    const yielded = await collect(wire.readJournal());

    expect(yielded).toEqual([
      { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'wire.test.a', time: 1 },
    ]);
    expect(await rawBytes()).toBe(prefix);
    expect(await rawBytes(BACKUP_KEY)).toBe(raw);
  });

  it('does not surface AppendLogCorruptedError from the restore read path', async () => {
    await seedCorrupt(`${currentMetadata()}\nGARBAGE\n`);

    await expect(collect(wire.readJournal())).resolves.toEqual([
      { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
    ]);
  });

  it('keeps the first backup when the journal corrupts again after a repair', async () => {
    const first = `${currentMetadata()}\nGARBAGE-1\n`;
    await seedCorrupt(first);
    await collect(wire.readJournal());
    const second = `${currentMetadata()}\nGARBAGE-2\n`;
    await seedCorrupt(second);

    await collect(wire.readJournal());

    expect(await rawBytes(BACKUP_KEY)).toBe(first);
  });

  it('repairs through the migration rewrite path when corruption meets an old version', async () => {
    const legacy = `${JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1 })}\n`;
    const raw = `${legacy}${JSON.stringify({ type: 'wire.test.legacy', time: 9 })}\nGARBAGE\n`;
    await seedCorrupt(raw);

    const yielded = await collect(wire.readJournal());

    expect(yielded).toEqual([
      { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'wire.test.legacy', time: 9 },
    ]);
    expect(await rawBytes()).toBe(
      `${currentMetadata()}\n${JSON.stringify({ type: 'wire.test.legacy', time: 9 })}\n`,
    );
    expect(await rawBytes(BACKUP_KEY)).toBe(raw);
  });

  it('reports a corrupted middle line through a warn log and the wire_repair event', async () => {
    const capture: RepairCapture = { warnings: [], events: [] };
    const svc = wireWithCapture(KEY, capture);
    const prefix = `${currentMetadata()}\n${JSON.stringify({ type: 'wire.test.a', time: 1 })}\n`;
    const raw = `${prefix}GARBAGE\n${JSON.stringify({ type: 'wire.test.b', time: 2 })}\n`;
    await seedCorrupt(raw);

    await collect(svc.readJournal());

    expect(capture.warnings).toHaveLength(1);
    expect(capture.warnings[0]!.message).toBe(
      'corrupted wire journal truncated to its valid prefix',
    );
    expect(capture.warnings[0]!.payload).toMatchObject({
      lineNumber: 3,
      reason: 'corrupted',
      outcome: 'repaired',
      droppedCount: 2,
      backupCreated: true,
    });
    expect(capture.events).toEqual([
      {
        name: 'wire_repair',
        payload: {
          kind: 'corrupted',
          outcome: 'repaired',
          dropped_count: 2,
          backup_created: true,
        },
      },
    ]);
  });

  it('reports a torn tail as truncation through the wire_repair event', async () => {
    const capture: RepairCapture = { warnings: [], events: [] };
    const svc = wireWithCapture(KEY, capture);
    const raw = `${currentMetadata()}\n${JSON.stringify({ type: 'wire.test.a' }).slice(0, 10)}`;
    await seedCorrupt(raw);

    await collect(svc.readJournal());

    expect(capture.events).toEqual([
      {
        name: 'wire_repair',
        payload: {
          kind: 'truncated',
          outcome: 'repaired',
          dropped_count: 1,
          backup_created: true,
        },
      },
    ]);
  });

  it('keeps restoring from the valid prefix when the on-disk repair itself fails', async () => {
    const capture: RepairCapture = { warnings: [], events: [] };
    const svc = wireWithCapture(KEY, capture);
    const prefix = `${currentMetadata()}\n`;
    const raw = `${prefix}GARBAGE\n`;
    await seedCorrupt(raw);
    const originalWrite = storage.write.bind(storage);
    storage.write = async (scope, key, data, options) => {
      if (key === AGENT_WIRE_RECORD_KEY) throw new Error('disk full');
      return originalWrite(scope, key, data, options);
    };

    const yielded = await collect(svc.readJournal());

    expect(yielded).toEqual([
      { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
    ]);
    expect(capture.events).toEqual([
      {
        name: 'wire_repair',
        payload: {
          kind: 'corrupted',
          outcome: 'failed',
          dropped_count: 1,
          backup_created: true,
        },
      },
    ]);
  });

  it('retries a failed repair before the next append and heals the journal first', async () => {
    const capture: RepairCapture = { warnings: [], events: [] };
    const svc = wireWithCapture(KEY, capture);
    const prefix = `${currentMetadata()}\n`;
    const raw = `${prefix}GARBAGE\n`;
    await seedCorrupt(raw);
    const originalWrite = storage.write.bind(storage);
    storage.write = async (scope, key, data, options) => {
      if (key === AGENT_WIRE_RECORD_KEY) throw new Error('disk full');
      return originalWrite(scope, key, data, options);
    };
    await collect(svc.readJournal());
    storage.write = originalWrite;

    svc.appendRecord({ type: 'wire.test.new', time: 7 });
    await svc.flush();

    expect(await rawBytes()).toBe(`${prefix}${JSON.stringify({ type: 'wire.test.new', time: 7 })}\n`);
    expect(await rawBytes(BACKUP_KEY)).toBe(raw);
    expect(await collect(svc.readJournal())).toEqual([
      { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
      { type: 'wire.test.new', time: 7 },
    ]);
    expect(capture.events).toEqual([
      {
        name: 'wire_repair',
        payload: {
          kind: 'corrupted',
          outcome: 'failed',
          dropped_count: 1,
          backup_created: true,
        },
      },
      {
        name: 'wire_repair',
        payload: {
          kind: 'corrupted',
          outcome: 'repaired',
          dropped_count: 1,
          backup_created: false,
        },
      },
    ]);
  });

  it('refuses to append behind the corrupted tail while a failed repair keeps failing', async () => {
    const capture: RepairCapture = { warnings: [], events: [] };
    const svc = wireWithCapture(KEY, capture);
    const prefix = `${currentMetadata()}\n`;
    const raw = `${prefix}GARBAGE\n`;
    await seedCorrupt(raw);
    const originalWrite = storage.write.bind(storage);
    storage.write = async (scope, key, data, options) => {
      if (key === AGENT_WIRE_RECORD_KEY) throw new Error('disk full');
      return originalWrite(scope, key, data, options);
    };
    await collect(svc.readJournal());

    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      svc.appendRecord({ type: 'wire.test.doomed', time: 8 });
      await expect(svc.flush()).rejects.toThrow('Wire journal repair did not complete');
      await expect(svc.flush()).rejects.toThrow('Wire journal repair did not complete');

      expect(await rawBytes()).toBe(raw);
      expect(unexpected).toHaveLength(1);
      expect(unexpected[0]).toBeInstanceOf(WireError);
      expect((unexpected[0] as WireError).code).toBe(WireErrors.codes.RECORDS_WRITE_FAILED);
      expect(capture.events).toEqual([
        {
          name: 'wire_repair',
          payload: {
            kind: 'corrupted',
            outcome: 'failed',
            dropped_count: 1,
            backup_created: true,
          },
        },
        {
          name: 'wire_repair',
          payload: {
            kind: 'corrupted',
            outcome: 'failed',
            dropped_count: 1,
            backup_created: false,
          },
        },
      ]);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it.each([AGENT_WIRE_RECORD_KEY, BACKUP_KEY])('does not erase a discarded fact after repair recovers (%s)', async (failedKey) => {
    const prefix = `${currentMetadata()}\n`;
    await seedCorrupt(`${prefix}GARBAGE\n`);
    const originalWrite = storage.write.bind(storage);
    storage.write = async (scope, key, data, options) => {
      if (key === failedKey) throw new Error('disk full');
      return originalWrite(scope, key, data, options);
    };
    await collect(wire.readJournal());
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      wire.appendRecord({ type: 'wire.test.doomed', time: 1 });
      await expect(wire.flush()).rejects.toThrow('Wire journal repair did not complete');
      storage.write = originalWrite;
      wire.appendRecord({ type: 'wire.test.recovered', time: 2 });
      await expect(wire.flush()).rejects.toThrow('Wire journal repair did not complete');
      await expect(wire.flush()).rejects.toThrow('Wire journal repair did not complete');
      expect(await rawBytes()).toBe(`${prefix}${JSON.stringify({ type: 'wire.test.recovered', time: 2 })}\n`);
      expect(unexpected).toHaveLength(1);
    } finally {
      storage.write = originalWrite;
      resetUnexpectedErrorHandler();
    }
  });

  it('surfaces the discarded record to flush callers when the repair never reaches the rewrite', async () => {
    const capture: RepairCapture = { warnings: [], events: [] };
    const svc = wireWithCapture(KEY, capture);
    const prefix = `${currentMetadata()}\n`;
    const raw = `${prefix}GARBAGE\n`;
    await seedCorrupt(raw);
    const originalWrite = storage.write.bind(storage);
    storage.write = async (scope, key, data, options) => {
      if (key === BACKUP_KEY) throw new Error('disk full');
      return originalWrite(scope, key, data, options);
    };
    await collect(svc.readJournal());

    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      svc.appendRecord({ type: 'wire.test.doomed', time: 9 });
      await expect(svc.flush()).rejects.toThrow('Wire journal repair did not complete');

      expect(await rawBytes()).toBe(raw);
      expect(unexpected).toHaveLength(1);
      expect(unexpected[0]).toBeInstanceOf(WireError);
      expect((unexpected[0] as WireError).code).toBe(WireErrors.codes.RECORDS_WRITE_FAILED);
      expect(capture.events).toEqual([
        {
          name: 'wire_repair',
          payload: {
            kind: 'corrupted',
            outcome: 'failed',
            dropped_count: 1,
            backup_created: false,
          },
        },
        {
          name: 'wire_repair',
          payload: {
            kind: 'corrupted',
            outcome: 'failed',
            dropped_count: 1,
            backup_created: false,
          },
        },
      ]);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });
});

describe('WireService journalIdentity', () => {
  it('binds identity to the journal head bytes across a same-size rewrite', async () => {
    const target = testWireScope(SCOPE, KEY);
    const lineA = { type: 'wire.test.head', value: 'aaaa', time: 1 };
    const lineB = { type: 'wire.test.head', value: 'bbbb', time: 1 };

    const empty = await wire.journalIdentity!();
    expect(empty.size).toBe(0);
    expect(empty.mtimeMs).toBe(0);

    log.append(target, AGENT_WIRE_RECORD_KEY, lineA);
    await log.flush();
    const first = await wire.journalIdentity!();
    expect(first.size).toBeGreaterThan(0);
    expect(first.headHash).toMatch(/^[0-9a-f]{32}$/);
    expect(await wire.journalIdentity!()).toEqual(first);
    expect(first.headHash).not.toBe(empty.headHash);

    await log.rewrite(target, AGENT_WIRE_RECORD_KEY, [lineB]);
    const second = await wire.journalIdentity!();
    expect(second.size).toBe(first.size);
    expect(second.headHash).not.toBe(first.headHash);
  });
});

describe('WireService flush', () => {
  it('flushes only its own scope and key', async () => {
    const targetLog = recordingWireLog([]);
    const targets: unknown[][] = [];
    targetLog.flush = async (...target: [] | [string, string]) => { targets.push(target); };
    const stub = wireOverLog(targetLog, 'targeted-flush');
    await stub.flush();
    expect(targets).toEqual([[testWireScope(SCOPE, 'targeted-flush'), AGENT_WIRE_RECORD_KEY]]);
  });

  it('drains accepted records to storage before rejecting a pre-store gap', async () => {
    const expected = new Error('dehydrate exploded');
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      wire.appendRecord({ type: 'wire.test.bad', time: 1 }, async () => { throw expected; });
      wire.appendRecord({ type: 'wire.test.good', time: 2 });
      await expect(wire.flush()).rejects.toBe(expected);
      const bytes = await storage.read(testWireScope(SCOPE, KEY), AGENT_WIRE_RECORD_KEY);
      expect(new TextDecoder().decode(bytes)).toBe(`${JSON.stringify({ type: 'wire.test.good', time: 2 })}\n`);
      expect(unexpected).toEqual([expected]);
    } finally {
      resetUnexpectedErrorHandler();
    }
  });

  it('drains the dehydrate queue before resolving', async () => {
    const records: WireRecord[] = [];
    const stub = wireOverLog(recordingWireLog(records), 'flush');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    stub.appendRecord({ type: 'wire.test.gated', time: 1 }, async (record) => {
      await gate;
      return record;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(records).toEqual([]);

    let flushed = false;
    const flushPromise = stub.flush().then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(flushed).toBe(false);

    release();
    await flushPromise;
    expect(flushed).toBe(true);
    expect(records).toEqual([{ type: 'wire.test.gated', time: 1 }]);
  });
});
