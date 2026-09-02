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
    await expect(restarted.service.listDeletedSessions()).resolves.toEqual([
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

    await expect(service.listDeletedSessions()).resolves.toEqual([]);
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

    await expect(service.listDeletedSessions()).resolves.toEqual([]);
    await service.retainDeletedSession(archived);

    await expect(service.listDeletedSessions()).resolves.toEqual([
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

    await expect(service.listDeletedSessions()).resolves.toEqual([
      expect.objectContaining({ id: 'session-1', updatedAt: 300, deleted: true }),
    ]);
  });

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
      service.listDeletedSessions({ workspaceIds: ['workspace-2'] }),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'session-2', workspaceId: 'workspace-2', deleted: true }),
    ]);
  });
});
