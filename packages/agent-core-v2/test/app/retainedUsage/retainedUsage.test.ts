import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY } from '#/wire/record';

import { stubBootstrap } from '../bootstrap/stubs';

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

  function build(): {
    readonly service: IRetainedUsageService;
    readonly appendLog: IAppendLogStore;
  } {
    const disposables = new DisposableStore();
    stores.push(disposables);
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(IBootstrapService, stubBootstrap(homeDir));
    ix.stub(IFileSystemStorageService, new FileStorageService(homeDir));
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IRetainedUsageService, new SyncDescriptor(RetainedUsageService));
    return {
      service: ix.get(IRetainedUsageService),
      appendLog: ix.get(IAppendLogStore),
    };
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

  it('does not fail when no retained ledger exists', async () => {
    const { service } = build();

    await expect(listItems(service)).resolves.toEqual([]);
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
    await fsp.appendFile(join(homeDir, 'store/deleted-sessions-v1.jsonl'), '{"version":1');

    const result = await service.listDeletedSessions(listQuery());

    expect(result.items).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBeUndefined();
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
