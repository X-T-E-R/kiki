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
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService, StorageError, StorageErrors } from '#/persistence/interface/storage';
import { WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';
import { wireJournalBackupKey } from '#/wire/repair';
import { WireError, WireErrors } from '#/wire/errors';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

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
