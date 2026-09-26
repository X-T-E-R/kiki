import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  IRetainedUsageService,
  RETAINED_USAGE_VERSION,
  type RetainedDeletedSessionUsage,
  type RetainedUsageListQuery,
} from '#/app/retainedUsage/retainedUsage';
import { RetainedUsageService } from '#/app/retainedUsage/retainedUsageService';
import type { SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import {
  IFileSystemStorageService,
  type StorageReadOptions,
  type StorageReadRange,
} from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY } from '#/wire/record';

import { stubBootstrap } from '../bootstrap/stubs';

class BlockingFileStorageService extends FileStorageService {
  readonly started: Promise<void>;
  private markStarted!: () => void;

  constructor(baseDir: string) {
    super(baseDir);
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
  }

  override async *readStream(
    _scope: string,
    _key: string,
    _range?: StorageReadRange,
    options: StorageReadOptions = {},
  ): AsyncIterable<Uint8Array> {
    yield* [];
    this.markStarted();
    options.signal?.throwIfAborted();
    await new Promise<void>((_resolve, reject) => {
      const abort = (): void => reject(options.signal?.reason);
      options.signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

class MeasuringFileStorageService extends FileStorageService {
  bytesRead = 0;
  chunksRead = 0;

  override async *readStream(
    scope: string,
    key: string,
    range?: StorageReadRange,
    options: StorageReadOptions = {},
  ): AsyncIterable<Uint8Array> {
    for await (const chunk of super.readStream(scope, key, range, options)) {
      this.bytesRead += chunk.byteLength;
      this.chunksRead += 1;
      yield chunk;
    }
  }
}

const usage = {
  inputOther: 11,
  output: 7,
  inputCacheRead: 5,
  inputCacheCreation: 3,
};

const summary: SessionSummary = {
  id: 'session-1',
  workspaceId: 'workspace-1',
  cwd: '/workspace',
  title: 'Retained session',
  createdAt: 100,
  updatedAt: 200,
  archived: false,
  usage: {
    total: usage,
    byModel: { 'model-a': usage },
    wireComplete: true,
  },
};

function listQuery(overrides: Partial<RetainedUsageListQuery> = {}): RetainedUsageListQuery {
  return {
    deadlineAt: Number.MAX_SAFE_INTEGER,
    recordLimit: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
}

async function listItems(
  service: IRetainedUsageService,
  overrides: Partial<RetainedUsageListQuery> = {},
): Promise<readonly RetainedDeletedSessionUsage[]> {
  return (await service.listDeletedSessions(listQuery(overrides))).items;
}

describe('RetainedUsageService', () => {
  let homeDir: string;
  let stores: DisposableStore[];

  beforeEach(async () => {
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'retained-usage-'));
    stores = [];
  });

  afterEach(async () => {
    for (const store of stores.toReversed()) store.dispose();
    await fsp.rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  function build(
    storage: IFileSystemStorageService = new FileStorageService(homeDir),
  ): {
    readonly service: IRetainedUsageService;
    readonly appendLog: IAppendLogStore;
  } {
    const disposables = new DisposableStore();
    stores.push(disposables);
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(IBootstrapService, stubBootstrap(homeDir));
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IRetainedUsageService, new SyncDescriptor(RetainedUsageService));
    return {
      service: ix.get(IRetainedUsageService),
      appendLog: ix.get(IAppendLogStore),
    };
  }

  async function writeLedger(entries: readonly unknown[]): Promise<void> {
    await fsp.mkdir(join(homeDir, 'store'), { recursive: true });
    await fsp.writeFile(
      join(homeDir, 'store/deleted-sessions-v2.jsonl'),
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
  }

  it('retains deleted session aggregates and attributed records across restart', async () => {
    const first = build();
    const sessionScope = 'sessions/workspace-1/session-1';
    first.appendLog.append(`${sessionScope}/agents/main`, AGENT_WIRE_RECORD_KEY, {
      type: 'usage.record',
      time: 150,
      model: 'model-a',
      usage,
      usageScope: 'turn',
      turnId: 3,
      agentId: 'main',
      provider: 'provider-a',
      modelAlias: 'model-a',
      profileName: 'coder',
      executorId: 'native',
    });
    await first.appendLog.flush();

    await first.service.retainDeletedSession(summary);
    await fsp.rm(join(homeDir, sessionScope), { recursive: true, force: true });

    const restarted = build();
    await expect(listItems(restarted.service)).resolves.toEqual([
      {
        version: RETAINED_USAGE_VERSION,
        ...summary,
        deleted: true,
        deletedAt: expect.any(Number),
        records: [
          {
            time: 150,
            model: 'model-a',
            usage,
            usageScope: 'turn',
            turnId: 3,
            agentId: 'main',
            provider: 'provider-a',
            modelAlias: 'model-a',
            profileName: 'coder',
            executorId: 'native',
          },
        ],
        complete: true,
      },
    ]);
  });

  it('preserves known, unknown, and absent usage provenance across retention restart', async () => {
    const first = build();
    const sessionScope = 'sessions/workspace-1/session-1';
    const zeroUsage = {
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    };
    for (const record of [
      {
        type: 'usage.record',
        time: 150,
        model: 'missing-usage',
        usage: zeroUsage,
        usageKnown: false,
      },
      {
        type: 'usage.record',
        time: 160,
        model: 'provider-zero',
        usage: zeroUsage,
        usageKnown: true,
      },
      {
        type: 'usage.record',
        time: 170,
        model: 'legacy-zero',
        usage: zeroUsage,
      },
    ]) {
      first.appendLog.append(`${sessionScope}/agents/main`, AGENT_WIRE_RECORD_KEY, record);
    }
    await first.appendLog.flush();

    const retained = await first.service.retainDeletedSession(summary);
    expect(retained.records).toEqual([
      { time: 150, model: 'missing-usage', usage: zeroUsage, usageKnown: false },
      { time: 160, model: 'provider-zero', usage: zeroUsage, usageKnown: true },
      { time: 170, model: 'legacy-zero', usage: zeroUsage },
    ]);
    expect(retained.records[2]).not.toHaveProperty('usageKnown');

    await fsp.rm(join(homeDir, sessionScope), { recursive: true, force: true });
    const restarted = build();
    const items = await listItems(restarted.service);
    expect(items[0]?.records).toEqual(retained.records);
    expect(items[0]?.records[2]).not.toHaveProperty('usageKnown');
  });

  it('does not fail when no retained ledger exists', async () => {
    const { service } = build();

    await expect(listItems(service)).resolves.toEqual([]);
  });

  it('ignores a v1 ledger without blocking v2 reads and writes', async () => {
    const storeDir = join(homeDir, 'store');
    const v1Path = join(storeDir, 'deleted-sessions-v1.jsonl');
    const v2Path = join(storeDir, 'deleted-sessions-v2.jsonl');
    const v1Ledger = `${JSON.stringify({
      version: RETAINED_USAGE_VERSION,
      ...summary,
      deleted: true,
      deletedAt: 250,
      records: [],
      complete: true,
    })}\n`;
    await fsp.mkdir(storeDir, { recursive: true });
    await fsp.writeFile(v1Path, v1Ledger);
    const { service, appendLog } = build();

    await expect(service.listDeletedSessions(listQuery())).resolves.toEqual({
      items: [],
      complete: true,
      incompleteReason: undefined,
      scannedRecords: 0,
    });
    await expect(fsp.stat(v2Path)).rejects.toMatchObject({ code: 'ENOENT' });

    const sessionScope = 'sessions/workspace-1/session-1';
    appendLog.append(`${sessionScope}/agents/main`, AGENT_WIRE_RECORD_KEY, {
      type: 'metadata',
      protocol_version: '1',
      created_at: 100,
    });
    await appendLog.flush();
    await service.retainDeletedSession(summary);

    await expect(listItems(service)).resolves.toEqual([
      expect.objectContaining({ id: 'session-1', workspaceId: 'workspace-1' }),
    ]);
    await expect(fsp.readFile(v1Path, 'utf8')).resolves.toBe(v1Ledger);
    await expect(fsp.stat(v2Path)).resolves.toMatchObject({ isFile: expect.any(Function) });
  });

  it('preserves archive state only when an archived session is later deleted', async () => {
    const { service, appendLog } = build();
    const archived = { ...summary, archived: true, archivedAt: 250 };
    const sessionScope = 'sessions/workspace-1/session-1';
    appendLog.append(`${sessionScope}/agents/main`, AGENT_WIRE_RECORD_KEY, {
      type: 'metadata',
      protocol_version: '1',
      created_at: 100,
    });
    await appendLog.flush();

    await expect(listItems(service)).resolves.toEqual([]);
    await service.retainDeletedSession(archived);

    await expect(listItems(service)).resolves.toEqual([
      expect.objectContaining({ archived: true, archivedAt: 250, deleted: true }),
    ]);
  });

  it('uses the latest immutable snapshot when a failed delete is retried', async () => {
    const { service, appendLog } = build();
    const sessionScope = 'sessions/workspace-1/session-1';
    appendLog.append(`${sessionScope}/agents/main`, AGENT_WIRE_RECORD_KEY, {
      type: 'metadata',
      protocol_version: '1',
      created_at: 100,
    });
    await appendLog.flush();

    await service.retainDeletedSession(summary);
    await service.retainDeletedSession({ ...summary, updatedAt: 300 });

    await expect(listItems(service)).resolves.toEqual([
      expect.objectContaining({ id: 'session-1', updatedAt: 300, deleted: true }),
    ]);
  });

  it('returns an incomplete prefix when the usage-record budget is exhausted', async () => {
    const { service, appendLog } = build();
    const sessionScope = 'sessions/workspace-1/session-1';
    appendLog.append(`${sessionScope}/agents/main`, AGENT_WIRE_RECORD_KEY, {
      type: 'usage.record',
      time: 150,
      model: 'model-a',
      usage,
      agentId: 'main',
    });
    await appendLog.flush();
    await service.retainDeletedSession(summary);

    await expect(
      service.listDeletedSessions(listQuery({ recordLimit: 0 })),
    ).resolves.toEqual({
      items: [],
      complete: false,
      incompleteReason: 'record_budget',
      scannedRecords: 0,
    });
  });

  it('maps an expired deadline and an aborted signal to deadline incompleteness', async () => {
    const { service } = build();
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.listDeletedSessions(listQuery({ deadlineAt: 0 })),
    ).resolves.toEqual({
      items: [],
      complete: false,
      incompleteReason: 'deadline',
      scannedRecords: 0,
    });
    await expect(
      service.listDeletedSessions(listQuery({ signal: controller.signal })),
    ).resolves.toEqual({
      items: [],
      complete: false,
      incompleteReason: 'deadline',
      scannedRecords: 0,
    });
  });

  it('returns when the deadline expires after the storage read blocks', async () => {
    const storage = new BlockingFileStorageService(homeDir);
    const { service } = build(storage);
    const startedAt = Date.now();
    const pending = service.listDeletedSessions(listQuery({ deadlineAt: startedAt + 10 }));
    await storage.started;

    await expect(pending).resolves.toEqual({
      items: [],
      complete: false,
      incompleteReason: 'deadline',
      scannedRecords: 0,
    });
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it('returns when the signal aborts after the storage read blocks', async () => {
    const storage = new BlockingFileStorageService(homeDir);
    const { service } = build(storage);
    const controller = new AbortController();
    const pending = service.listDeletedSessions(listQuery({ signal: controller.signal }));
    await storage.started;
    const abortedAt = Date.now();

    controller.abort();

    await expect(pending).resolves.toEqual({
      items: [],
      complete: false,
      incompleteReason: 'deadline',
      scannedRecords: 0,
    });
    expect(Date.now() - abortedAt).toBeLessThan(250);
  });

  it('does not materialize an oversized snapshot when the record budget is zero', async () => {
    const storage = new MeasuringFileStorageService(homeDir);
    const ledgerPath = join(homeDir, 'store/deleted-sessions-v2.jsonl');
    const usageLine = JSON.stringify({
      kind: 'record',
      record: { time: 150, model: 'model-a', usage, agentId: 'main' },
    });
    const ledger = [
      JSON.stringify({
        kind: 'session',
        version: RETAINED_USAGE_VERSION,
        id: summary.id,
        workspaceId: summary.workspaceId,
        recordCount: 20_000,
      }),
      JSON.stringify({
        kind: 'meta',
        cwd: summary.cwd,
        title: summary.title,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        archived: summary.archived,
        usage: summary.usage,
        deleted: true,
        deletedAt: 300,
        complete: true,
      }),
      ...Array.from({ length: 20_000 }, () => usageLine),
      JSON.stringify({ kind: 'commit' }),
      '',
    ].join('\n');
    await fsp.mkdir(join(homeDir, 'store'), { recursive: true });
    await fsp.writeFile(ledgerPath, ledger);
    const { service } = build(storage);

    await expect(
      service.listDeletedSessions(listQuery({ recordLimit: 0 })),
    ).resolves.toEqual({
      items: [],
      complete: false,
      incompleteReason: 'record_budget',
      scannedRecords: 0,
    });
    expect(storage.chunksRead).toBe(1);
    expect(storage.bytesRead).toBeLessThan(new TextEncoder().encode(ledger).byteLength);
  });

  it('does not read or parse an oversized record beyond the record budget', async () => {
    const storage = new MeasuringFileStorageService(homeDir);
    const ledgerPath = join(homeDir, 'store/deleted-sessions-v2.jsonl');
    const ledger = [
      JSON.stringify({
        kind: 'session',
        version: RETAINED_USAGE_VERSION,
        id: summary.id,
        workspaceId: summary.workspaceId,
        recordCount: 1,
      }),
      JSON.stringify({
        kind: 'meta',
        cwd: summary.cwd,
        title: summary.title,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
        archived: summary.archived,
        usage: summary.usage,
        deleted: true,
        deletedAt: 300,
        complete: true,
      }),
      JSON.stringify({
        kind: 'record',
        record: { time: 150, model: 'm'.repeat(5_000_000), usage, agentId: 'main' },
      }),
      JSON.stringify({ kind: 'commit' }),
      '',
    ].join('\n');
    const fileBytes = new TextEncoder().encode(ledger).byteLength;
    await fsp.mkdir(join(homeDir, 'store'), { recursive: true });
    await fsp.writeFile(ledgerPath, ledger);
    const { service } = build(storage);
    const originalParse = JSON.parse;
    let parsedOversizedEntry = false;
    const parse = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (text.length > 1_000_000) parsedOversizedEntry = true;
      return originalParse(text, reviver);
    });

    try {
      await expect(
        service.listDeletedSessions(listQuery({ recordLimit: 1 })),
      ).resolves.toEqual({
        items: [],
        complete: false,
        incompleteReason: 'record_budget',
        scannedRecords: 1,
      });
    } finally {
      parse.mockRestore();
    }
    expect(storage.chunksRead).toBe(1);
    expect(storage.bytesRead).toBeLessThan(fileBytes / 10);
    expect(parsedOversizedEntry).toBe(false);
  });

  it('applies the workspace header filter before spending the record budget', async () => {
    const { service, appendLog } = build();
    const sessionScope = 'sessions/workspace-1/session-1';
    appendLog.append(`${sessionScope}/agents/main`, AGENT_WIRE_RECORD_KEY, {
      type: 'usage.record',
      time: 150,
      model: 'model-a',
      usage,
      agentId: 'main',
    });
    await appendLog.flush();
    await service.retainDeletedSession(summary);

    await expect(
      service.listDeletedSessions(
        listQuery({ workspaceIds: ['workspace-2'], recordLimit: 0 }),
      ),
    ).resolves.toEqual({
      items: [],
      complete: true,
      incompleteReason: undefined,
      scannedRecords: 0,
    });
  });

  it('marks a truncated retained ledger prefix incomplete', async () => {
    const { service, appendLog } = build();
    const sessionScope = 'sessions/workspace-1/session-1';
    appendLog.append(`${sessionScope}/agents/main`, AGENT_WIRE_RECORD_KEY, {
      type: 'metadata',
      protocol_version: '1',
      created_at: 100,
    });
    await appendLog.flush();
    await service.retainDeletedSession(summary);
    await fsp.appendFile(join(homeDir, 'store/deleted-sessions-v2.jsonl'), '{"version":1');

    const result = await service.listDeletedSessions(listQuery());

    expect(result.items).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBeUndefined();
  });

  it.each([
    ['fewer than declared', 2],
    ['more than declared', 0],
  ] as const)(
    'marks a committed snapshot with %s records incomplete',
    async (_kind, recordCount) => {
      await writeLedger([
        {
          kind: 'session',
          version: RETAINED_USAGE_VERSION,
          id: summary.id,
          workspaceId: summary.workspaceId,
          recordCount,
        },
        {
          kind: 'meta',
          cwd: summary.cwd,
          title: summary.title,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          archived: summary.archived,
          usage: summary.usage,
          deleted: true,
          deletedAt: 300,
          complete: true,
        },
        {
          kind: 'record',
          record: { time: 150, model: 'model-a', usage, agentId: 'main' },
        },
        { kind: 'commit' },
      ]);
      const { service } = build();

      await expect(service.listDeletedSessions(listQuery())).resolves.toEqual({
        items: [],
        complete: false,
        incompleteReason: undefined,
        scannedRecords: 2,
      });
    },
  );

  it('marks an uncommitted transaction before a valid transaction incomplete', async () => {
    const meta = {
      kind: 'meta',
      cwd: summary.cwd,
      title: summary.title,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      archived: summary.archived,
      usage: summary.usage,
      deleted: true,
      deletedAt: 300,
      complete: true,
    };
    await writeLedger([
      {
        kind: 'session',
        version: RETAINED_USAGE_VERSION,
        id: 'incomplete-session',
        workspaceId: summary.workspaceId,
        recordCount: 1,
      },
      meta,
      {
        kind: 'record',
        record: { time: 150, model: 'model-a', usage, agentId: 'main' },
      },
      {
        kind: 'session',
        version: RETAINED_USAGE_VERSION,
        id: 'valid-session',
        workspaceId: summary.workspaceId,
        recordCount: 0,
      },
      meta,
      { kind: 'commit' },
    ]);
    const { service } = build();

    await expect(service.listDeletedSessions(listQuery())).resolves.toEqual({
      items: [expect.objectContaining({ id: 'valid-session' })],
      complete: false,
      incompleteReason: undefined,
      scannedRecords: 3,
    });
  });

  it('retains usage from the main agent and a forked subagent', async () => {
    const { service, appendLog } = build();
    const sessionScope = 'sessions/workspace-1/session-1';
    appendLog.append(`${sessionScope}/agents/main`, AGENT_WIRE_RECORD_KEY, {
      type: 'usage.record',
      time: 150,
      model: 'model-a',
      usage,
      agentId: 'main',
    });
    appendLog.append(`${sessionScope}/agents/worker`, AGENT_WIRE_RECORD_KEY, {
      type: 'usage.record',
      time: 160,
      model: 'model-b',
      usage,
      agentId: 'worker',
      parentAgentId: 'main',
    });
    await appendLog.flush();

    const retained = await service.retainDeletedSession(summary);

    expect(retained.complete).toBe(true);
    expect(retained.records.map((record) => record.agentId).toSorted()).toEqual([
      'main',
      'worker',
    ]);
  });

  it.each(['missing', 'empty', 'truncated'] as const)(
    'marks a %s agent wire incomplete',
    async (kind) => {
      const { service } = build();
      const agentDir = join(homeDir, 'sessions/workspace-1/session-1/agents/main');
      await fsp.mkdir(agentDir, { recursive: true });
      if (kind === 'empty') {
        await fsp.writeFile(join(agentDir, AGENT_WIRE_RECORD_KEY), '');
      } else if (kind === 'truncated') {
        await fsp.writeFile(
          join(agentDir, AGENT_WIRE_RECORD_KEY),
          `${JSON.stringify({ type: 'metadata', protocol_version: '1', created_at: 100 })}\n{"type":"usage.record"`,
        );
      }

      await expect(service.retainDeletedSession(summary)).resolves.toMatchObject({
        complete: false,
      });
    },
  );

  it('filters deleted records by workspace without rewriting the ledger', async () => {
    const { service, appendLog } = build();
    for (const [workspaceId, id] of [
      ['workspace-1', 'session-1'],
      ['workspace-2', 'session-2'],
    ] as const) {
      const sessionScope = `sessions/${workspaceId}/${id}`;
      appendLog.append(`${sessionScope}/agents/main`, AGENT_WIRE_RECORD_KEY, {
        type: 'metadata',
        protocol_version: '1',
        created_at: 100,
      });
      await appendLog.flush();
      await service.retainDeletedSession({ ...summary, id, workspaceId });
    }

    await expect(
      listItems(service, { workspaceIds: ['workspace-2'] }),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'session-2', workspaceId: 'workspace-2', deleted: true }),
    ]);
  });
});
