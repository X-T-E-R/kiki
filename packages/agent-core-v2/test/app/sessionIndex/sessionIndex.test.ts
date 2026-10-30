import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  overrideScopedService,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { TimeoutTimer } from '#/_base/utils/timer';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { IHostFsWatchService, type HostFsChange, type HostFsWatchOptions } from '#/os/interface/hostFsWatch';
import { SessionIndexBuildingError } from '#/app/sessionIndex/errors';
import {
  ISessionIndex,
  ISessionIndexMirror,
  type SessionIndexStatus,
  type SessionSummary,
} from '#/app/sessionIndex/sessionIndex';
import {
  LEGACY_SESSION_INDEX_MANIFEST,
  SESSION_INDEX_MANIFEST,
  legacySessionCollection,
  legacySessionCountersCollection,
  recencyColumn,
  sessionCollection,
} from '#/app/sessionIndex/sessionIndexModel';
import { FileSessionIndex } from '#/app/sessionIndex/sessionIndexService';
import { SessionIndexProjector } from '#/app/sessionIndex/sessionIndexProjector';
import { scanSessionsMaxMtime } from '#/app/sessionIndex/sessionIndexSource';
import {
  drainSessionIndexMirror,
  SessionIndexMirror,
} from '#/app/sessionIndex/sessionIndexMirrorService';
import {
  drainQueryStoreDisposals,
  MINIDB_QUERY_STORE_SUBDIR,
  MiniDbQueryStore,
} from '#/persistence/backends/minidb/miniDbQueryStore';
import { SqliteQueryStore } from '#/persistence/backends/sqlite/sqliteQueryStore';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  IQueryStore,
  QueryStoreBusyError,
  type Checkpoint,
  type ColumnPageQuery,
  type IQuery,
  type Page,
  type WriteOp,
} from '#/persistence/interface/queryStore';
import { IFileSystemStorageService, StorageError, StorageErrors } from '#/persistence/interface/storage';

import { stubSessionIndexMirror } from './stubs';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubFlag } from '../flag/stubs';
import { stubLog } from '../../_base/log/stubs';
import { stubQueryStore } from '../../persistence/interface/stubs';
import { deferred } from '../../deferred';

const WORK_DIR = '/home/user/repo';
const sourceChanges = new Emitter<HostFsChange>();
let indexWatchOptions: HostFsWatchOptions | undefined;

class TestSessionIndexWatch implements IHostFsWatchService {
  declare readonly _serviceBrand: undefined;

  watch(_path: string, options?: HostFsWatchOptions) {
    indexWatchOptions = options;
    return { ready: Promise.resolve(), onDidChange: sourceChanges.event, dispose: () => {} };
  }
}

function registerIndexWatch(): void {
  registerScopedService(
    LifecycleScope.App,
    IHostFsWatchService,
    TestSessionIndexWatch,
    ScopeActivation.OnDemand,
    'test',
  );
}

function canonicalIds(summaries: readonly SessionSummary[]): string[] {
  return [...summaries]
    .sort((a, b) => (a.updatedAt !== b.updatedAt ? b.updatedAt - a.updatedAt : a.id < b.id ? 1 : -1))
    .map((s) => s.id);
}

describe('FileSessionIndex (legacy)', () => {
  let homeDir: string;
  let sessionsDir: string;
  let workspaceId: string;
  let disposeHost: (() => void | Promise<void>) | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerIndexWatch();
    registerScopedService(
      LifecycleScope.App,
      ISessionIndex,
      FileSessionIndex,
      ScopeActivation.OnDemand,
      'sessionIndex',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'ws-sessions-'));
    sessionsDir = join(homeDir, 'sessions');
    workspaceId = encodeWorkDirKey(WORK_DIR);
  });

  afterEach(async () => {
    await disposeHost?.();
    disposeHost = undefined;
    await fsp.rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  function build(fileStorage: FileStorageService = new FileStorageService(homeDir)): ISessionIndex {
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IAppendLogStore, new AppendLogStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(IQueryStore, stubQueryStore()),
      stubPair(ISessionIndexMirror, stubSessionIndexMirror()),
      stubPair(IFlagService, stubFlag(false)),
      stubPair(ILogService, stubLog()),
    ]);
    disposeHost = () => {
      return host.dispose();
    };
    return host.app.accessor.get(ISessionIndex);
  }

  async function seedSession(
    sessionId: string,
    meta: Record<string, unknown>,
    wsId: string = workspaceId,
  ): Promise<void> {
    const dir = join(sessionsDir, wsId, sessionId, 'session-meta');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, 'state.json'), JSON.stringify(meta));
  }

  async function seedEmpty(sessionId: string, wsId: string = workspaceId): Promise<void> {
    await fsp.mkdir(join(sessionsDir, wsId, sessionId), { recursive: true });
  }

  it('listRecent returns non-archived sessions by default', async () => {
    await seedSession('active', { createdAt: 1, updatedAt: 2 });
    await seedSession('archived', { archived: true });
    await seedEmpty('no-state');

    const store = build();
    const page = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(page.items.map((s) => s.id)).toEqual(['active']);
    expect(page.items[0]?.workspaceId).toBe(workspaceId);
    expect(page.items[0]?.archived).toBe(false);
  });

  it('orders a cold parent by persisted child activity with the same point-read timestamp', async () => {
    await seedSession('parent', { createdAt: 1, updatedAt: 10, activityUpdatedAt: 100 });
    await seedSession('other', { createdAt: 1, updatedAt: 50 });
    const store = build();
    const page = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(page.items.map((entry) => entry.id)).toEqual(['parent', 'other']);
    expect(page.items[0]?.updatedAt).toBe((await store.get('parent'))?.updatedAt);
    expect(page.items[0]?.updatedAt).toBe(100);
    expect(page.items[0]?.ownUpdatedAt).toBe(10);
    expect((await store.get('parent'))?.ownUpdatedAt).toBe(10);
  });

  it('listRecent includes archived when requested', async () => {
    await seedSession('active', {});
    await seedSession('archived', { archived: true });

    const store = build();
    const page = await store.listRecent({ workspaceIds: [workspaceId], includeArchived: true });
    expect(page.items.map((s) => s.id).toSorted()).toEqual(['active', 'archived']);
  });

  it('get fetches a session by id across workspaces', async () => {
    await seedSession('active', { title: 'hello' });

    const store = build();
    const summary = await store.get('active');
    expect(summary?.id).toBe('active');
    expect(summary?.title).toBe('hello');
    expect(await store.get('missing')).toBeUndefined();
  });

  it('probes a new session id across workspaces with bounded concurrency and no session inventories', async () => {
    const firstBatch = deferred<void>();
    const release = deferred<void>();
    const workspaces = Array.from({ length: 40 }, (_, index) => `workspace-${index}`);
    let active = 0;
    let maximum = 0;
    let probes = 0;
    class PointStorage extends FileStorageService {
      override async list(scope: string): Promise<readonly string[]> {
        if (scope === 'sessions') return workspaces;
        if (scope.startsWith('sessions/')) throw new Error('point reads must not enumerate session inventories');
        return super.list(scope);
      }
      override async mtime(scope: string, key: string): Promise<number | undefined> {
        if (scope.startsWith('sessions/') && key === 'new-session-id') {
          probes++;
          maximum = Math.max(maximum, ++active);
          if (probes === 16) firstBatch.resolve();
          try {
            await release.promise;
            return undefined;
          } finally { active--; }
        }
        return super.mtime(scope, key);
      }
    }
    const store = build(new PointStorage(homeDir));
    const reading = store.get('new-session-id');
    try {
      await firstBatch.promise;
      expect(probes).toBe(16);
      expect(maximum).toBe(16);
    } finally { release.resolve(); }
    await expect(reading).resolves.toBeUndefined();
    expect(probes).toBe(40);
    expect(maximum).toBe(16);
  });

  it('keeps global point probe errors distinct from absence and skips stray workspace files', async () => {
    const failure = new StorageError(StorageErrors.codes.STORAGE_PERMISSION_DENIED, 'point stat denied');
    class PointStorage extends FileStorageService {
      override async list(scope: string): Promise<readonly string[]> {
        if (scope.startsWith('sessions/')) throw new Error('point reads must not enumerate session inventories');
        return super.list(scope);
      }
      override async mtime(scope: string, key: string): Promise<number | undefined> {
        if (key === 'denied' && scope === `sessions/${workspaceId}`) throw failure;
        return super.mtime(scope, key);
      }
    }
    await seedSession('found', { title: 'kept' });
    await fsp.writeFile(join(sessionsDir, 'stray.json'), '{}');
    await fsp.mkdir(join(sessionsDir, workspaceId, 'bad'), { recursive: true });
    await fsp.writeFile(join(sessionsDir, workspaceId, 'bad', 'state.json'), '');
    const store = build(new PointStorage(homeDir));
    await expect(store.get('found')).resolves.toMatchObject({ id: 'found', title: 'kept' });
    await expect(store.get('missing')).resolves.toBeUndefined();
    await expect(store.get('denied')).rejects.toBe(failure);
    await expect(store.get('bad')).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_DECODE_FAILED });
  });

  it.each(['', '.', '..', '../outside', 'nested/session', 'invalid\0name', ...(sep === '\\' ? ['..\\outside', 'nested\\session', 'C:outside', 'existing:stream', 'existing.', 'existing '] : [])])('does not probe a point id that is not one directory entry: %j', async (id) => {
    await seedSession('existing', { title: 'unchanged' });
    const storage = new FileStorageService(homeDir);
    const stat = vi.spyOn(storage, 'mtime');
    const read = vi.spyOn(storage, 'read');
    const store = build(storage);
    await expect(store.get(id)).resolves.toBeUndefined();
    await expect(store.get(id, workspaceId)).resolves.toBeUndefined();
    expect(stat).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['custom-session_001', ...(sep === '/' ? ['legacy\\name', 'legacy:name'] : [])])('preserves valid custom single-entry ids: %j', async (id) => {
    await seedSession(id, { title: 'custom identifier' });
    const store = build();
    await expect(store.get(id)).resolves.toMatchObject({ id, title: 'custom identifier' });
    await expect(store.get(id, workspaceId)).resolves.toMatchObject({ id, title: 'custom identifier' });
  });

  it('projects persisted aggregate usage from the authoritative metadata document', async () => {
    await seedSession('with-usage', {
      usage: {
        total: {
          inputOther: 11,
          output: 7,
          inputCacheRead: 5,
          inputCacheCreation: 3,
        },
        byModel: {
          'example-model': {
            inputOther: 11,
            output: 7,
            inputCacheRead: 5,
            inputCacheCreation: 3,
          },
        },
      },
    });

    const store = build();
    expect((await store.get('with-usage'))?.usage).toEqual({
      total: {
        inputOther: 11,
        output: 7,
        inputCacheRead: 5,
        inputCacheCreation: 3,
      },
      byModel: {
        'example-model': {
          inputOther: 11,
          output: 7,
          inputCacheRead: 5,
          inputCacheCreation: 3,
        },
      },
    });
  });

  it('authoritative point reads use persisted usage without replaying agent wires', async () => {
    await seedSession('wire-usage', {
      agents: {
        main: { type: 'main' },
        worker: { type: 'sub' },
      },
      usage: {
        total: { inputOther: 11, output: 7, inputCacheRead: 5, inputCacheCreation: 3 },
        byModel: {
          'example-model': {
            inputOther: 11,
            output: 7,
            inputCacheRead: 5,
            inputCacheCreation: 3,
          },
        },
      },
    });
    const records = new Map([
      [
        'main',
        {
          type: 'usage.record',
          model: 'example-model',
          usage: { inputOther: 11, output: 7, inputCacheRead: 5, inputCacheCreation: 3 },
        },
      ],
      [
        'worker',
        {
          type: 'usage.record',
          model: 'grok-4.6',
          usage: { inputOther: 4, output: 6, inputCacheRead: 8, inputCacheCreation: 10 },
        },
      ],
    ]);
    for (const [agentId, record] of records) {
      const dir = join(sessionsDir, workspaceId, 'wire-usage', 'agents', agentId);
      await fsp.mkdir(dir, { recursive: true });
      const metadata =
        agentId === 'main'
          ? `${JSON.stringify({ type: 'metadata', protocol_version: '1', created_at: 1 })}\n`
          : '';
      await fsp.writeFile(join(dir, 'wire.jsonl'), `${metadata}${JSON.stringify(record)}\n`);
    }

    const store = build();
    expect((await store.get('wire-usage'))?.usage).toEqual({
      total: { inputOther: 11, output: 7, inputCacheRead: 5, inputCacheCreation: 3 },
      byModel: {
        'example-model': {
          inputOther: 11,
          output: 7,
          inputCacheRead: 5,
          inputCacheCreation: 3,
        },
      },
    });
  });

  it('keeps persisted usage when one agent wire is corrupted during recovery', async () => {
    const persistedUsage = {
      total: { inputOther: 20, output: 10, inputCacheRead: 4, inputCacheCreation: 2 },
      byModel: {
        'example-model': {
          inputOther: 3,
          output: 2,
          inputCacheRead: 1,
          inputCacheCreation: 0,
        },
        'worker-model': {
          inputOther: 17,
          output: 8,
          inputCacheRead: 3,
          inputCacheCreation: 2,
        },
      },
    };
    await seedSession('corrupt-wire-usage', {
      agents: { main: { type: 'main' }, worker: { type: 'sub' } },
      usage: persistedUsage,
    });
    const mainDir = join(sessionsDir, workspaceId, 'corrupt-wire-usage', 'agents', 'main');
    const workerDir = join(sessionsDir, workspaceId, 'corrupt-wire-usage', 'agents', 'worker');
    await fsp.mkdir(mainDir, { recursive: true });
    await fsp.mkdir(workerDir, { recursive: true });
    await fsp.writeFile(
      join(mainDir, 'wire.jsonl'),
      `${JSON.stringify({
        type: 'usage.record',
        model: 'example-model',
        usage: { inputOther: 3, output: 2, inputCacheRead: 1, inputCacheCreation: 0 },
      })}\n`,
    );
    await fsp.writeFile(join(workerDir, 'wire.jsonl'), '{broken\n');

    const store = build();
    const usage = (await store.get('corrupt-wire-usage'))?.usage;
    expect(usage).toMatchObject(persistedUsage);
    expect(usage?.wireComplete).toBeUndefined();
  });

  it('keeps persisted usage when a usage record is structurally invalid during recovery', async () => {
    const persistedUsage = {
      total: { inputOther: 20, output: 10, inputCacheRead: 4, inputCacheCreation: 2 },
      byModel: {
        'example-model': {
          inputOther: 20,
          output: 10,
          inputCacheRead: 4,
          inputCacheCreation: 2,
        },
      },
    };
    await seedSession('invalid-wire-usage', {
      agents: { main: { type: 'main' } },
      usage: persistedUsage,
    });
    const dir = join(sessionsDir, workspaceId, 'invalid-wire-usage', 'agents', 'main');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      join(dir, 'wire.jsonl'),
      `${JSON.stringify({
        type: 'usage.record',
        model: 'example-model',
        usage: { inputOther: 3, output: 2, inputCacheRead: 1, inputCacheCreation: 0 },
      })}\n${JSON.stringify({
        type: 'usage.record',
        model: 'example-model',
        usage: { inputOther: 17, output: 8, inputCacheRead: 3 },
      })}\n`,
    );

    const store = build();
    const usage = (await store.get('invalid-wire-usage'))?.usage;
    expect(usage).toMatchObject(persistedUsage);
    expect(usage?.wireComplete).toBeUndefined();
  });

  it('keeps persisted usage when an enumerated agent wire is missing', async () => {
    const persistedUsage = {
      total: { inputOther: 8, output: 4, inputCacheRead: 2, inputCacheCreation: 1 },
      byModel: {
        'example-model': {
          inputOther: 8,
          output: 4,
          inputCacheRead: 2,
          inputCacheCreation: 1,
        },
      },
    };
    await seedSession('missing-wire-usage', {
      agents: { main: { type: 'main' }, worker: { type: 'sub' } },
      usage: persistedUsage,
    });
    const mainDir = join(sessionsDir, workspaceId, 'missing-wire-usage', 'agents', 'main');
    await fsp.mkdir(mainDir, { recursive: true });
    await fsp.writeFile(
      join(mainDir, 'wire.jsonl'),
      `${JSON.stringify({
        type: 'usage.record',
        model: 'example-model',
        usage: { inputOther: 3, output: 2, inputCacheRead: 1, inputCacheCreation: 0 },
      })}\n`,
    );

    const store = build();
    const usage = (await store.get('missing-wire-usage'))?.usage;
    expect(usage).toMatchObject(persistedUsage);
    expect(usage?.wireComplete).toBeUndefined();
  });

  it('does not replay main-agent usage for old metadata on a point read', async () => {
    await seedSession('legacy-wire-usage', { lastPrompt: 'hello' });
    const dir = join(sessionsDir, workspaceId, 'legacy-wire-usage', 'agents', 'main');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      join(dir, 'wire.jsonl'),
      `${JSON.stringify({
        type: 'usage.record',
        model: 'example-model',
        usage: { inputOther: 3, output: 2, inputCacheRead: 1, inputCacheCreation: 4 },
      })}\n`,
    );

    const store = build();
    expect((await store.get('legacy-wire-usage'))?.usage).toBeUndefined();
  });

  it('recovers cwd from the metadata document (v2 cwd, v1 workDir, custom.cwd)', async () => {
    await seedSession('v2', { cwd: '/repo/v2' });
    await seedSession('v1', { workDir: '/repo/v1' });
    await seedSession('old', { custom: { cwd: '/repo/old' } });
    await seedSession('none', { title: 'no cwd' });

    const store = build();
    expect((await store.get('v2'))?.cwd).toBe('/repo/v2');
    expect((await store.get('v1'))?.cwd).toBe('/repo/v1');
    expect((await store.get('old'))?.cwd).toBe('/repo/old');
    expect((await store.get('none'))?.cwd).toBeUndefined();
  });

  it('listRecent filters by sessionId without enumerating all sessions', async () => {
    await seedSession('active', { title: 'hello' });
    await seedSession('archived', { archived: true });

    const store = build();
    const active = await store.listRecent({ sessionId: 'active' });
    expect(active.items.map((s) => s.id)).toEqual(['active']);

    const archived = await store.listRecent({ sessionId: 'archived' });
    expect(archived.items).toEqual([]);

    const archivedIncluded = await store.listRecent({
      sessionId: 'archived',
      includeArchived: true,
    });
    expect(archivedIncluded.items.map((s) => s.id)).toEqual(['archived']);
  });

  it('listRecent filters by childOf using the parent_session_id + child_session_kind markers', async () => {
    await seedSession('parent', { createdAt: 1, updatedAt: 10 });
    await seedSession('child-a', {
      createdAt: 2,
      updatedAt: 9,
      custom: { parent_session_id: 'parent', child_session_kind: 'child' },
    });
    await seedSession('child-b', {
      createdAt: 3,
      updatedAt: 8,
      custom: { parent_session_id: 'parent', child_session_kind: 'child' },
    });
    await seedSession('fork', {
      createdAt: 4,
      updatedAt: 7,
      custom: { parent_session_id: 'parent' },
    });
    await seedSession('grandchild', {
      createdAt: 5,
      updatedAt: 6,
      custom: { parent_session_id: 'child-a', child_session_kind: 'child' },
    });

    const store = build();
    const page = await store.listRecent({ childOf: 'parent' });
    expect(page.items.map((s) => s.id).toSorted()).toEqual(['child-a', 'child-b']);
  });

  it('count counts non-archived sessions by default and everything with includeArchived', async () => {
    await seedSession('a', {});
    await seedSession('b', {});
    await seedSession('archived', { archived: true });
    await seedEmpty('no-state');

    const store = build();
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);
    expect(await store.count({ workspaceIds: [workspaceId], includeArchived: true })).toBe(3);
    expect(await store.count({ workspaceIds: ['wd_unknown'] })).toBe(0);
  });

  it('listRecent merges a workspace-id set into one recency-ordered page', async () => {
    const otherId = encodeWorkDirKey('/home/user/other');
    await seedSession('a1', { createdAt: 1, updatedAt: 1 });
    await seedSession('a3', { createdAt: 3, updatedAt: 3 });
    await seedSession('b2', { createdAt: 2, updatedAt: 2 }, otherId);
    await seedSession('b4', { createdAt: 4, updatedAt: 4 }, otherId);

    const store = build();
    const page = await store.listRecent({ workspaceIds: [workspaceId, otherId] });
    expect(page.items.map((s) => s.id)).toEqual(['b4', 'a3', 'b2', 'a1']);
    expect(page.items[0]?.workspaceId).toBe(otherId);
  });

  it('listRecent applies limit after the cross-bucket merge', async () => {
    const otherId = encodeWorkDirKey('/home/user/other');
    await seedSession('a1', { createdAt: 1, updatedAt: 1 });
    await seedSession('a3', { createdAt: 3, updatedAt: 3 });
    await seedSession('b2', { createdAt: 2, updatedAt: 2 }, otherId);

    const store = build();
    const page = await store.listRecent({ workspaceIds: [workspaceId, otherId], limit: 2 });
    expect(page.items.map((s) => s.id)).toEqual(['a3', 'b2']);
    expect(page.nextCursor).toBe('b2');
  });

  it('listRecent filters archived across every bucket of the id set', async () => {
    const otherId = encodeWorkDirKey('/home/user/other');
    await seedSession('active', {});
    await seedSession('archived', { archived: true }, otherId);

    const store = build();
    const visible = await store.listRecent({ workspaceIds: [workspaceId, otherId] });
    expect(visible.items.map((s) => s.id)).toEqual(['active']);

    const all = await store.listRecent({ workspaceIds: [workspaceId, otherId], includeArchived: true });
    expect(all.items.map((s) => s.id).toSorted()).toEqual(['active', 'archived']);
  });

  it('count sums over the workspace-id set', async () => {
    const otherId = encodeWorkDirKey('/home/user/other');
    await seedSession('a', {});
    await seedSession('b', {}, otherId);
    await seedSession('archived', { archived: true }, otherId);

    const store = build();
    expect(await store.count({ workspaceIds: [workspaceId, otherId] })).toBe(2);
    expect(await store.count({ workspaceIds: [otherId] })).toBe(1);
  });

  it('scans session mtimes past stray non-directory entries', async () => {
    await seedSession('a', { createdAt: 1, updatedAt: 2 });
    await fsp.mkdir(join(sessionsDir, workspaceId, 'no-state'), { recursive: true });
    await fsp.writeFile(join(sessionsDir, 'workspace.json'), '{}');
    await fsp.writeFile(join(sessionsDir, workspaceId, 'stray.json'), 'junk');

    const warnings: string[] = [];
    const log: ILogService = {
      ...stubLog(),
      warn: (message) => {
        warnings.push(message);
      },
    };
    const max = await scanSessionsMaxMtime(new FileStorageService(homeDir), 'sessions', log);

    expect(max).toBeGreaterThan(0);
    expect(warnings).toContain('session index skips a non-directory entry');
  });

  it('skips a file whose stat is denied while scanning mtimes', async () => {
    await seedSession('readable', { createdAt: 1, updatedAt: 2 });
    await seedSession('denied', { createdAt: 3, updatedAt: 4 });
    class DeniedStatStorage extends FileStorageService {
      override async mtime(scope: string, key: string): Promise<number | undefined> {
        if (scope === `sessions/${workspaceId}/denied` && key === 'state.json') {
          throw new StorageError(StorageErrors.codes.STORAGE_PERMISSION_DENIED, 'stat denied');
        }
        return super.mtime(scope, key);
      }
    }
    const warnings: string[] = [];
    const log: ILogService = { ...stubLog(), warn: (message) => { warnings.push(message); } };
    await expect(scanSessionsMaxMtime(new DeniedStatStorage(homeDir), 'sessions', log))
      .resolves.toBeGreaterThan(0);
    expect(warnings).toContain('session index skips unreadable metadata stat');
  });

  it('flag-off listings skip corrupted files without hiding healthy sessions', async () => {
    await seedSession('readable', { title: 'healthy', createdAt: 1, updatedAt: 2 });
    await fsp.mkdir(join(sessionsDir, workspaceId, 'bad'), { recursive: true });
    await fsp.writeFile(join(sessionsDir, workspaceId, 'bad', 'state.json'), '');
    const store = build();
    expect((await store.listRecent({ workspaceIds: [workspaceId] })).items.map((s) => s.id))
      .toEqual(['readable']);
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(1);
    await expect(store.get('bad', workspaceId)).rejects.toMatchObject({ code: StorageErrors.codes.STORAGE_DECODE_FAILED });
    await expect(store.get('absent', workspaceId)).resolves.toBeUndefined();
  });

  it('pages with the before/after keyset cursors', async () => {
    for (let i = 0; i < 5; i++) {
      await seedSession(`s${i}`, { createdAt: i, updatedAt: i });
    }
    const store = build();

    const page1 = await store.listRecent({ workspaceIds: [workspaceId], limit: 2 });
    expect(page1.items.map((s) => s.id)).toEqual(['s4', 's3']);
    expect(page1.nextCursor).toBe('s3');

    const page2 = await store.listRecent({
      workspaceIds: [workspaceId],
      limit: 2,
      before: page1.nextCursor,
    });
    expect(page2.items.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(page2.nextCursor).toBe('s1');

    const page3 = await store.listRecent({
      workspaceIds: [workspaceId],
      limit: 2,
      before: page2.nextCursor,
    });
    expect(page3.items.map((s) => s.id)).toEqual(['s0']);
    expect(page3.nextCursor).toBeUndefined();

    const newer = await store.listRecent({ workspaceIds: [workspaceId], after: 's2' });
    expect(newer.items.map((s) => s.id)).toEqual(['s4', 's3']);

    const unknown = await store.listRecent({ workspaceIds: [workspaceId], before: 'missing' });
    expect(unknown.items).toEqual([]);
    expect(unknown.nextCursor).toBeUndefined();
  });
});

describe('FileSessionIndex (read model)', () => {
  let homeDir: string;
  let sessionsDir: string;
  let workspaceId: string;
  let disposeHost: (() => void | Promise<void>) | undefined;
  let queryStore: IQueryStore;
  let mirror: ISessionIndexMirror;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerIndexWatch();
    registerScopedService(
      LifecycleScope.App,
      ISessionIndex,
      FileSessionIndex,
      ScopeActivation.OnDemand,
      'sessionIndex',
    );
    registerScopedService(
      LifecycleScope.App,
      ISessionIndexMirror,
      SessionIndexMirror,
      ScopeActivation.OnDemand,
      'sessionIndex',
    );
    registerScopedService(
      LifecycleScope.App,
      IQueryStore,
      MiniDbQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'ws-sessions-rm-'));
    sessionsDir = join(homeDir, 'sessions');
    workspaceId = encodeWorkDirKey(WORK_DIR);
  });

  afterEach(async () => {
    await disposeHost?.();
    disposeHost = undefined;
    await drainSessionIndexMirror();
    await drainQueryStoreDisposals();
    await fsp.rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  function build(
    fileStorage: FileStorageService = new FileStorageService(homeDir),
    flagEnabled: boolean | ((id: string) => boolean) = true,
    appendLog: IAppendLogStore = new AppendLogStore(fileStorage),
    documents: IAtomicDocumentStore = new JsonAtomicDocumentStore(fileStorage),
  ): FileSessionIndex {
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, documents),
      stubPair(IAppendLogStore, appendLog),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(flagEnabled)),
    ]);
    disposeHost = () => {
      return host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    return host.app.accessor.get(ISessionIndex) as FileSessionIndex;
  }

  async function seedSession(
    sessionId: string,
    meta: Record<string, unknown>,
    wsId: string = workspaceId,
  ): Promise<void> {
    const dir = join(sessionsDir, wsId, sessionId, 'session-meta');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, 'state.json'), JSON.stringify(meta));
  }

  function summary(id: string, overrides: Partial<SessionSummary> = {}) {
    return {
      id,
      workspaceId,
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      ...overrides,
    };
  }

  async function walkPages(
    store: FileSessionIndex,
    query: { workspaceIds?: readonly string[]; includeArchived?: boolean },
    pageSize: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listRecent({ ...query, limit: pageSize, before: cursor });
      ids.push(...page.items.map((s) => s.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return ids;
  }

  async function withinDeadline<T>(operation: Promise<T>, timeoutMs = 5_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('session index operation exceeded test deadline')), timeoutMs);
    });
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  class CountingStorage extends FileStorageService {
    listCalls = 0;
    override async list(scope: string, prefix?: string): Promise<readonly string[]> {
      this.listCalls += 1;
      return super.list(scope, prefix);
    }
  }

  class CountingAppendLogStore extends AppendLogStore {
    readCalls = 0;
    override async *read<R>(scope: string, key: string): AsyncIterable<R> {
      this.readCalls += 1;
      yield* super.read<R>(scope, key);
    }
  }

  interface OpCounts {
    calls: number;
    rows: number;
  }

  class CountingQueryStore extends MiniDbQueryStore {
    private readonly counts = new Map<string, OpCounts>();

    resetCounts(): void {
      this.counts.clear();
    }

    snapshotCounts(): Record<string, OpCounts> {
      return Object.fromEntries([...this.counts.entries()].toSorted(([a], [b]) => (a < b ? -1 : 1)));
    }

    private record(method: string, collection: string, rows: number): void {
      const key = `${method}:${collection}`;
      const entry = this.counts.get(key) ?? { calls: 0, rows: 0 };
      entry.calls += 1;
      entry.rows += rows;
      this.counts.set(key, entry);
    }

    override async get<T>(collection: string, key: string): Promise<T | undefined> {
      const value = await super.get<T>(collection, key);
      this.record('get', collection, value === undefined ? 0 : 1);
      return value;
    }

    override async getMany<T>(
      collection: string,
      keys: readonly string[],
    ): Promise<Map<string, T>> {
      const values = await super.getMany<T>(collection, keys);
      this.record('getMany', collection, values.size);
      return values;
    }

    override async pageByColumn<T>(
      collection: string,
      query: ColumnPageQuery,
    ): Promise<Page<T>> {
      const page = await super.pageByColumn<T>(collection, query);
      this.record('pageByColumn', collection, page.items.length);
      return page;
    }

    override query<T>(collection: string): IQuery<T> {
      const inner = super.query<T>(collection);
      const wrapper: IQuery<T> = {
        where: (filter) => {
          inner.where(filter);
          return wrapper;
        },
        whereColumn: (column, bounds) => {
          inner.whereColumn(column, bounds);
          return wrapper;
        },
        orderBy: (field, dir) => {
          inner.orderBy(field, dir);
          return wrapper;
        },
        limit: (n) => {
          inner.limit(n);
          return wrapper;
        },
        cursor: (cursor) => {
          inner.cursor(cursor);
          return wrapper;
        },
        execute: async () => {
          const page = await inner.execute();
          this.record('query', collection, page.items.length);
          return page;
        },
      };
      return wrapper;
    }

    override async listKeys(collection: string): Promise<readonly string[]> {
      const keys = await super.listKeys(collection);
      this.record('listKeys', collection, keys.length);
      return keys;
    }
  }

  it('rebuilds SQLite from metadata with tie order, parent filters, mirror and recovery', async () => {
    overrideScopedService(LifecycleScope.App, IQueryStore, SqliteQueryStore, ScopeActivation.OnDemand, 'storage');
    await seedSession('a', { title: 'first', createdAt: 1, updatedAt: 10 });
    await seedSession('b', { title: 'second', createdAt: 1, updatedAt: 10, custom: { parent_session_id: 'parent', child_session_kind: 'child' } });
    await seedSession('c', { title: 'third', createdAt: 1, updatedAt: 20, custom: { parent_session_id: 'parent', child_session_kind: 'child' } });
    await seedSession('archived', { archived: true, createdAt: 1, updatedAt: 30 });
    const store = build();
    expect((await store.prepare()).state).toBe('ready');
    expect(await walkPages(store, { workspaceIds: [workspaceId] }, 1)).toEqual(['c', 'b', 'a']);
    expect((await store.listRecent({ childOf: 'parent' })).items.map((item) => item.id)).toEqual(['c', 'b']);
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(3);
    expect(await store.count({ workspaceIds: [workspaceId], includeArchived: true })).toBe(4);
    mirror.record(summary('new', { updatedAt: 40, title: 'pending' }));
    expect(await store.get('new')).toMatchObject({ title: 'pending' });
    expect((await store.listRecent({ limit: 1 })).items[0]?.id).toBe('new');
    await queryStore.recover!();
    expect((await store.listRecent({ childOf: 'parent' })).items.map((item) => item.id)).toEqual(['c', 'b']);
    const manifest = await queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
    await queryStore.dropCollection(sessionCollection(manifest!.seq));
    await store.reprojectNow();
    expect(await walkPages(store, { workspaceIds: [workspaceId] }, 1)).toEqual(['c', 'b', 'a']);
  });

  it('prepare projects the persisted sessions and publishes a generation', async () => {
    await seedSession('active', { title: 'hello', createdAt: 1, updatedAt: 2 });
    await seedSession('archived', { archived: true });

    const store = build();
    expect(store.status()).toEqual({ source: 'read-model', state: 'uninitialized', degradedCount: 0 });

    const status = await store.prepare();
    expect(status).toEqual({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 });

    const page = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(page.items.map((s) => s.id)).toEqual(['active']);
    expect(page.items[0]?.title).toBe('hello');
    expect(await store.get('active')).toMatchObject({ id: 'active', title: 'hello' });
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(1);
    expect(await store.count({ workspaceIds: [workspaceId], includeArchived: true })).toBe(2);
  });

  it('projects and advances the generation through withExclusive after a zero-filled lock', async () => {
    await seedSession('before-restart', { title: 'before', createdAt: 1, updatedAt: 2 });
    const lockDir = join(homeDir, 'cache', MINIDB_QUERY_STORE_SUBDIR);
    const lockPath = join(lockDir, 'session-index.lock');
    await fsp.mkdir(lockDir, { recursive: true });
    await fsp.writeFile(lockPath, Buffer.alloc(188));
    expect((await fsp.stat(lockPath)).size).toBe(188);

    const store = build();
    const exclusive = vi.spyOn(queryStore, 'withExclusive');
    try {
      expect(await store.prepare()).toMatchObject({ state: 'ready', generation: 1 });
      expect(exclusive).toHaveBeenCalled();
      expect(await queryStore.listKeys(sessionCollection(1))).toEqual(['before-restart']);
      await expect(fsp.readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });

      await seedSession('after-restart', { title: 'after', createdAt: 3, updatedAt: 4 });
      await fsp.writeFile(lockPath, Buffer.alloc(188));
      await store.reprojectNow();
      expect(store.status()).toMatchObject({ state: 'ready', generation: 2 });
      expect((await queryStore.listKeys(sessionCollection(2))).toSorted())
        .toEqual(['after-restart', 'before-restart']);
      const page = await store.listRecent({ workspaceIds: [workspaceId] });
      expect(page.items.map((s) => s.id)).toEqual(['after-restart', 'before-restart']);
      await expect(fsp.readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      exclusive.mockRestore();
    }
  }, 10_000);

  it('prepare skips stray files and state-less directories instead of failing the projection', async () => {
    await seedSession('active', { title: 'hello', createdAt: 1, updatedAt: 2 });
    await fsp.writeFile(join(sessionsDir, 'workspace.json'), '{}');
    await fsp.writeFile(join(sessionsDir, workspaceId, 'workspace.json'), '{}');
    await fsp.writeFile(join(sessionsDir, workspaceId, '.DS_Store'), 'junk');
    await fsp.mkdir(join(sessionsDir, workspaceId, 'no-state'), { recursive: true });

    const store = build();
    const status = await store.prepare();
    expect(status).toEqual({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 });

    const page = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(page.items.map((s) => s.id)).toEqual(['active']);
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(1);
  });

  it('publishes past zero-byte and malformed session metadata, then retries repaired files', async () => {
    await seedSession('first', { title: 'first', createdAt: 1, updatedAt: 2 });
    const zeroPath = join(sessionsDir, workspaceId, 'zero', 'state.json');
    await fsp.mkdir(join(sessionsDir, workspaceId, 'zero'), { recursive: true });
    await fsp.writeFile(zeroPath, '');
    const malformedPath = join(sessionsDir, workspaceId, 'malformed', 'session-meta', 'state.json');
    await fsp.mkdir(join(sessionsDir, workspaceId, 'malformed', 'session-meta'), { recursive: true });
    await fsp.writeFile(malformedPath, '{broken');
    const warnings: { message: string; path?: unknown }[] = [];
    const log: ILogService = {
      ...stubLog(),
      warn: (message, details) => warnings.push({
        message,
        path: details !== null && typeof details === 'object' && 'path' in details
          ? details.path
          : undefined,
      }),
    };
    const fileStorage = new FileStorageService(homeDir);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IAppendLogStore, new AppendLogStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, log),
      stubPair(IFlagService, stubFlag(true)),
    ]);
    disposeHost = () => {
      return host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    const store = host.app.accessor.get(ISessionIndex) as FileSessionIndex;

    expect(await store.prepare()).toMatchObject({ state: 'ready', generation: 1, degradedCount: 0 });
    expect((await store.listRecent({ workspaceIds: [workspaceId] })).items.map((s) => s.id)).toEqual(['first']);
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(1);
    expect(warnings).toEqual(expect.arrayContaining([
      { message: 'session index skips unreadable metadata', path: `sessions/${workspaceId}/zero/state.json` },
      { message: 'session index skips unreadable metadata', path: `sessions/${workspaceId}/malformed/session-meta/state.json` },
    ]));

    await seedSession('second', { title: 'second', createdAt: 3, updatedAt: 4 });
    await store.reprojectNow();
    expect(store.status()).toMatchObject({ state: 'ready', generation: 2, degradedCount: 0 });
    expect((await store.listRecent({ workspaceIds: [workspaceId] })).items.map((s) => s.id)).toEqual(['second', 'first']);
    await fsp.writeFile(zeroPath, JSON.stringify({ title: 'repaired', createdAt: 5, updatedAt: 6 }));
    await store.reconcileNow();
    expect((await store.listRecent({ workspaceIds: [workspaceId] })).items.map((s) => s.id)).toEqual(['zero', 'second', 'first']);
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(3);
  });

  it.each([StorageErrors.codes.STORAGE_PERMISSION_DENIED, StorageErrors.codes.STORAGE_DECODE_FAILED])('keeps a healthy read model through repeated authoritative metadata errors: %s', async (code) => {
    const failure = new StorageError(code, 'read denied');
    class DeniedDocumentStore extends JsonAtomicDocumentStore {
      override async get<T>(scope: string, key: string): Promise<T | undefined> {
        if (scope === `sessions/${workspaceId}/denied/session-meta` && key === 'state.json') {
          throw failure;
        }
        return super.get<T>(scope, key);
      }
    }
    await seedSession('healthy', { title: 'visible', createdAt: 1, updatedAt: 2 });
    await seedSession('denied', { title: 'hidden', createdAt: 3, updatedAt: 4 });
    const fileStorage = new FileStorageService(homeDir);
    const store = build(fileStorage, true, new AppendLogStore(fileStorage), new DeniedDocumentStore(fileStorage));
    expect(await store.prepare()).toMatchObject({ state: 'ready', generation: 1, degradedCount: 0 });
    expect((await store.listRecent({ workspaceIds: [workspaceId] })).items.map((s) => s.id))
      .toEqual(['healthy']);
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(1);
    const recover = vi.spyOn(queryStore, 'recover');
    const project = vi.spyOn(SessionIndexProjector.prototype, 'project');
    try {
      for (let retry = 0; retry < 4; retry++) {
        await expect(store.get('denied', workspaceId)).rejects.toBe(failure);
        await expect(store.listRecent({ sessionId: 'denied', workspaceIds: [workspaceId] })).rejects.toBe(failure);
        expect(store.status()).toMatchObject({ state: 'ready', generation: 1, degradedCount: 0 });
        expect((await store.listRecent({ workspaceIds: [workspaceId] })).items.map((s) => s.id)).toEqual(['healthy']);
        expect(await store.count({ workspaceIds: [workspaceId] })).toBe(1);
      }
      await expect(store.get('absent', workspaceId)).resolves.toBeUndefined();
      expect(recover).not.toHaveBeenCalled();
      expect(project).not.toHaveBeenCalled();
    } finally {
      recover.mockRestore();
      project.mockRestore();
    }
  });

  it.each([
    ['initial', 'listRecent'],
    ['initial', 'count'],
    ['background', 'listRecent'],
    ['background', 'count'],
  ] as const)('recovers a manifest read failure during %s prepare projection through %s', async (window, method) => {
    await seedSession('existing', { createdAt: 1, updatedAt: 2 });
    const consumer: ISessionIndex = build();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const originalScan = SessionIndexProjector.prototype.scan;
    const scan = vi.spyOn(SessionIndexProjector.prototype, 'scan').mockImplementationOnce(async function (this: SessionIndexProjector, options) {
      entered.resolve();
      await gate.promise;
      return originalScan.call(this, options);
    });
    const originalCheckpoint = queryStore.getCheckpoint.bind(queryStore);
    let failManifest = false;
    const checkpoint = vi.spyOn(queryStore, 'getCheckpoint').mockImplementation(async (source) => {
      if (failManifest && source === SESSION_INDEX_MANIFEST) {
        failManifest = false;
        throw new Error('injected transient manifest read failure');
      }
      return originalCheckpoint(source);
    });
    const recover = vi.spyOn(queryStore, 'recover');
    const pending = consumer as unknown as { prepareFlight?: Promise<unknown>; projectFlight?: Promise<unknown> };
    const readyGenerations: (number | undefined)[] = [];
    const subscription = consumer.onDidChangeStatus((status) => {
      if (status.state === 'ready') readyGenerations.push(status.generation);
    });
    const preparing = consumer.prepare(window === 'background' ? { deadlineMs: 0 } : undefined);
    const read = () => method === 'count' ? consumer.count({ workspaceIds: [workspaceId] })
      : consumer.listRecent({ workspaceIds: [workspaceId] });
    try {
      await entered.promise;
      if (window === 'background') {
        expect(await preparing).toMatchObject({ state: 'preparing' });
      }
      failManifest = true;
      await expect(read()).rejects.toBeInstanceOf(SessionIndexBuildingError);
      expect(consumer.status().state).not.toBe('ready');
      expect(consumer.status().degradedCount).toBe(1);
      expect(recover).not.toHaveBeenCalled();
      const projected = pending.projectFlight;
      gate.resolve();
      await projected;
      await preparing;
      if (window === 'initial') {
        expect(consumer.status()).toMatchObject({ state: 'degraded', generation: 1, degradedCount: 1 });
        expect(readyGenerations).toEqual([]);
        await expect(read()).rejects.toBeInstanceOf(SessionIndexBuildingError);
      }
      await pending.prepareFlight;
      expect(recover).toHaveBeenCalledTimes(1);
      expect(consumer.status()).toMatchObject({ state: 'ready', generation: 2, degradedCount: 1 });
      expect(readyGenerations).toEqual([2]);
      expect((await consumer.listRecent({ workspaceIds: [workspaceId] })).items.map((item) => item.id)).toEqual(['existing']);
      expect(await consumer.count({ workspaceIds: [workspaceId] })).toBe(1);
      expect(await consumer.get('existing', workspaceId)).toMatchObject({ id: 'existing' });
    } finally {
      gate.resolve();
      await preparing;
      await pending.projectFlight;
      await pending.prepareFlight;
      subscription.dispose();
      scan.mockRestore();
      checkpoint.mockRestore();
      recover.mockRestore();
    }
  });

  it.each(['initial', 'background'] as const)('bounds failed recovery after a manifest read error during %s prepare projection', async (window) => {
    await seedSession('existing', { createdAt: 1, updatedAt: 2 });
    const consumer: ISessionIndex = build();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const originalScan = SessionIndexProjector.prototype.scan;
    const scan = vi.spyOn(SessionIndexProjector.prototype, 'scan').mockImplementationOnce(async function (this: SessionIndexProjector, options) {
      entered.resolve();
      await gate.promise;
      return originalScan.call(this, options);
    });
    const checkpoint = vi.spyOn(queryStore, 'getCheckpoint');
    const recoverEntered = deferred<void>();
    const failRecovery = deferred<void>();
    const recover = vi.spyOn(queryStore, 'recover').mockImplementation(async () => {
      recoverEntered.resolve();
      await failRecovery.promise;
      throw new Error('injected recovery failure');
    });
    const pending = consumer as unknown as { prepareFlight?: Promise<unknown>; projectFlight?: Promise<unknown> };
    const preparing = consumer.prepare(window === 'background' ? { deadlineMs: 0 } : undefined);
    try {
      await entered.promise;
      if (window === 'background') await preparing;
      checkpoint.mockRejectedValueOnce(new Error('injected transient manifest read failure'));
      await expect(consumer.count({ workspaceIds: [workspaceId] })).rejects.toBeInstanceOf(SessionIndexBuildingError);
      expect(recover).not.toHaveBeenCalled();
      const projected = pending.projectFlight;
      gate.resolve();
      await projected;
      await preparing;
      if (window === 'initial') {
        expect(consumer.status().state).toBe('degraded');
        await expect(consumer.count({ workspaceIds: [workspaceId] })).rejects.toBeInstanceOf(SessionIndexBuildingError);
      }
      await recoverEntered.promise;
      vi.useFakeTimers();
      failRecovery.resolve();
      await pending.prepareFlight;
      expect(recover).toHaveBeenCalledTimes(1);
      for (let attempt = 2; attempt <= 3; attempt++) {
        await vi.advanceTimersByTimeAsync(5_000);
        await pending.prepareFlight;
        expect(recover).toHaveBeenCalledTimes(attempt);
      }
      expect(consumer.status()).toMatchObject({ state: 'degraded', reason: expect.stringContaining('automatic recovery exhausted') });
      await vi.advanceTimersByTimeAsync(55_000);
      await expect(consumer.listRecent({ workspaceIds: [workspaceId] })).rejects.toBeInstanceOf(SessionIndexBuildingError);
      await expect(consumer.count({ workspaceIds: [workspaceId] })).rejects.toBeInstanceOf(SessionIndexBuildingError);
      expect(recover).toHaveBeenCalledTimes(3);
      expect(await consumer.get('existing', workspaceId)).toMatchObject({ id: 'existing' });
    } finally {
      gate.resolve();
      failRecovery.resolve();
      vi.useRealTimers();
      await preparing;
      await pending.projectFlight;
      await pending.prepareFlight;
      scan.mockRestore();
      checkpoint.mockRestore();
      recover.mockRestore();
    }
  });

  it('keeps a ready read model when its query queue is momentarily full', async () => {
    await seedSession('existing', { createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();
    const recover = vi.spyOn(queryStore, 'recover');
    const originalGet = queryStore.get.bind(queryStore);
    let busy = 2;
    vi.spyOn(queryStore, 'get').mockImplementation(async (collection, key) => {
      if (busy > 0) {
        busy -= 1;
        throw new QueryStoreBusyError();
      }
      return originalGet(collection, key);
    });
    try {
      expect(await store.get('existing', workspaceId)).toMatchObject({ id: 'existing' });
      await expect(store.listRecent({ workspaceIds: [workspaceId] })).rejects.toBeInstanceOf(SessionIndexBuildingError);
      expect(store.status()).toMatchObject({ state: 'ready', generation: 1, degradedCount: 0 });
      expect((await store.listRecent({ workspaceIds: [workspaceId] })).items.map((item) => item.id)).toEqual(['existing']);
      expect(recover).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('automatically retires failed readers and publishes a fresh generation without user cleanup', async () => {
    await seedSession('existing', { createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();
    const states: string[] = [];
    const subscription = store.onDidChangeStatus((status) => states.push(status.state));
    const recover = vi.spyOn(queryStore, 'recover');
    const originalGet = queryStore.get.bind(queryStore);
    let failed = false;
    vi.spyOn(queryStore, 'get').mockImplementation(async (collection, key) => {
      if (!failed && collection === sessionCollection(1)) {
        failed = true;
        throw new Error('value reader: snapshot file is not open');
      }
      return originalGet(collection, key);
    });
    try {
      expect(await store.get('existing', workspaceId)).toMatchObject({ id: 'existing' });
      await vi.waitFor(() => {
        expect(store.status()).toMatchObject({ state: 'ready', generation: 2, degradedCount: 1 });
      });
      expect(recover).toHaveBeenCalledTimes(1);
      expect(states).toContain('degraded');
      expect(states).toContain('preparing');
      for (let visit = 0; visit < 4; visit++) {
        expect(await store.get('existing', workspaceId)).toMatchObject({ id: 'existing' });
        expect((await store.listRecent({ workspaceIds: [workspaceId] })).items.map((item) => item.id)).toEqual(['existing']);
      }
    } finally {
      subscription.dispose();
      vi.restoreAllMocks();
    }
  });

  it('stops automatic reader recovery after three failures and permits an explicit retry', async () => {
    await seedSession('existing', { createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();
    const originalGet = queryStore.get.bind(queryStore);
    const get = vi.spyOn(queryStore, 'get').mockImplementation(async (collection, key) => {
      if (collection === sessionCollection(1)) throw new Error('value reader: snapshot file is not open');
      return originalGet(collection, key);
    });
    const recover = vi.spyOn(queryStore, 'recover').mockRejectedValue(new Error('injected recovery failure'));
    vi.useFakeTimers();
    try {
      expect(await store.get('existing', workspaceId)).toMatchObject({ id: 'existing' });
      await vi.waitFor(() => expect(store.status()).toMatchObject({ state: 'degraded', degradedCount: 2 }));
      expect(recover).toHaveBeenCalledTimes(1);
      const pending = store as unknown as { prepareFlight?: Promise<unknown> };
      await pending.prepareFlight;
      for (let attempt = 2; attempt <= 3; attempt++) {
        await vi.advanceTimersByTimeAsync(5_000);
        await pending.prepareFlight;
        expect(recover).toHaveBeenCalledTimes(attempt);
      }
      expect(recover).toHaveBeenCalledTimes(3);
      expect(store.status()).toMatchObject({ state: 'degraded', degradedCount: 4 });
      await expect(store.listRecent({ workspaceIds: [workspaceId] })).rejects.toBeInstanceOf(SessionIndexBuildingError);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(recover).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
      get.mockRestore();
      recover.mockRestore();
      expect(await store.prepare()).toMatchObject({ state: 'degraded', reason: expect.stringContaining('automatic recovery exhausted') });
      await store.reprojectNow();
      expect(store.status()).toMatchObject({ state: 'ready', generation: 2 });
      expect(await store.get('existing', workspaceId)).toMatchObject({ id: 'existing' });
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it.each(['get', 'listRecent', 'count'] as const)('resumes exhausted recovery through the production %s consumer after cooldown', async (method) => {
    await seedSession('existing', { createdAt: 1, updatedAt: 2 });
    const store = build();
    const consumer: ISessionIndex = store;
    await consumer.prepare();
    const originalGet = queryStore.get.bind(queryStore);
    const originalRecover = queryStore.recover!.bind(queryStore);
    let failing = true;
    const get = vi.spyOn(queryStore, 'get').mockImplementation(async (collection, key) => {
      if (failing && collection === sessionCollection(1)) throw new Error('value reader: snapshot file is not open');
      return originalGet(collection, key);
    });
    const recover = vi.spyOn(queryStore, 'recover').mockImplementation(async () => {
      if (failing) throw new Error('injected recovery failure');
      await originalRecover();
    });
    const pending = store as unknown as { prepareFlight?: Promise<unknown> };
    vi.useFakeTimers();
    try {
      expect(await consumer.get('existing', workspaceId)).toMatchObject({ id: 'existing' });
      await pending.prepareFlight;
      for (let attempt = 2; attempt <= 3; attempt++) {
        await vi.advanceTimersByTimeAsync(5_000);
        await pending.prepareFlight;
      }
      expect(recover).toHaveBeenCalledTimes(3);
      for (let retry = 0; retry < 11; retry++) {
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(consumer.listRecent({ workspaceIds: [workspaceId] })).rejects.toBeInstanceOf(SessionIndexBuildingError);
        await expect(consumer.count({ workspaceIds: [workspaceId] })).rejects.toBeInstanceOf(SessionIndexBuildingError);
        expect(recover).toHaveBeenCalledTimes(3);
      }
      failing = false;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(recover).toHaveBeenCalledTimes(3);
      const cooledAt = Date.now();
      vi.useRealTimers();
      vi.spyOn(Date, 'now').mockReturnValue(cooledAt);
      const read = () => method === 'get' ? consumer.get('existing', workspaceId)
        : method === 'count' ? consumer.count({ workspaceIds: [workspaceId] })
          : consumer.listRecent({ workspaceIds: [workspaceId] });
      const requests = Array.from({ length: 10 }, () => read().catch((error: unknown) => error));
      await Promise.all(requests);
      await pending.prepareFlight;
      expect(recover).toHaveBeenCalledTimes(4);
      expect(consumer.status()).toMatchObject({ state: 'ready', generation: 2 });
      expect(await consumer.count({ workspaceIds: [workspaceId] })).toBe(1);
      expect(await consumer.get('existing', workspaceId)).toMatchObject({ id: 'existing' });
    } finally {
      vi.useRealTimers();
      get.mockRestore();
      recover.mockRestore();
      vi.restoreAllMocks();
    }
  });

  it.each(['listRecent', 'count'] as const)('does not reset exhausted recovery while the third attempt is in flight for %s', async (method) => {
    await seedSession('existing', { createdAt: 1, updatedAt: 2 });
    const store = build();
    const consumer: ISessionIndex = store;
    await consumer.prepare();
    const originalGet = queryStore.get.bind(queryStore);
    const originalRecover = queryStore.recover!.bind(queryStore);
    const third = deferred<void>();
    const entered = deferred<void>();
    let failing = true;
    const get = vi.spyOn(queryStore, 'get').mockImplementation(async (collection, key) => {
      if (failing && collection === sessionCollection(1)) throw new Error('value reader: snapshot file is not open');
      return originalGet(collection, key);
    });
    let attempts = 0;
    const recover = vi.spyOn(queryStore, 'recover').mockImplementation(async () => {
      if (!failing) return originalRecover();
      if (++attempts === 3) { entered.resolve(); await third.promise; }
      throw new Error('injected recovery failure');
    });
    const pending = store as unknown as { prepareFlight?: Promise<unknown>; log: ILogService };
    const info = vi.spyOn(pending.log, 'info');
    const read = () => method === 'count' ? consumer.count({ workspaceIds: [workspaceId] })
      : consumer.listRecent({ workspaceIds: [workspaceId] });
    vi.useFakeTimers();
    try {
      expect(await consumer.get('existing', workspaceId)).toMatchObject({ id: 'existing' });
      await pending.prepareFlight;
      await vi.advanceTimersByTimeAsync(5_000);
      await pending.prepareFlight;
      await vi.advanceTimersByTimeAsync(5_000);
      await entered.promise;
      const thirdFlight = pending.prepareFlight;
      expect(recover).toHaveBeenCalledTimes(3);
      expect(consumer.status().state).toBe('preparing');
      for (let request = 0; request < 10; request++) {
        await expect(read()).rejects.toBeInstanceOf(SessionIndexBuildingError);
      }
      expect(info).not.toHaveBeenCalledWith('session index recovery resumed by read after cooldown');
      third.reject(new Error('held third attempt failed'));
      await thirdFlight;
      const afterThird = consumer.status();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(recover).toHaveBeenCalledTimes(3);
      expect(afterThird).toMatchObject({ state: 'degraded', reason: expect.stringContaining('automatic recovery exhausted') });
      for (let retry = 0; retry < 10; retry++) {
        await vi.advanceTimersByTimeAsync(5_000);
        await expect(read()).rejects.toBeInstanceOf(SessionIndexBuildingError);
        expect(recover).toHaveBeenCalledTimes(3);
      }
      expect(info).not.toHaveBeenCalledWith('session index recovery resumed by read after cooldown');
      failing = false;
      await vi.advanceTimersByTimeAsync(5_000);
      const cooledAt = Date.now();
      vi.useRealTimers();
      vi.spyOn(Date, 'now').mockReturnValue(cooledAt);
      await Promise.all(Array.from({ length: 10 }, () => read().catch((error: unknown) => error)));
      await pending.prepareFlight;
      expect(recover).toHaveBeenCalledTimes(4);
      expect(info.mock.calls.filter(([message]) => message === 'session index recovery resumed by read after cooldown')).toHaveLength(1);
      expect(consumer.status()).toMatchObject({ state: 'ready', generation: 2 });
      expect(await consumer.count({ workspaceIds: [workspaceId] })).toBe(1);
    } finally {
      third.resolve();
      await pending.prepareFlight;
      vi.useRealTimers();
      get.mockRestore();
      recover.mockRestore();
      vi.restoreAllMocks();
    }
  });

  it('fails closed when the sessions root cannot be enumerated', async () => {
    class UnreadableRootStorage extends FileStorageService {
      override async list(scope: string, prefix?: string): Promise<readonly string[]> {
        if (scope === 'sessions') throw new Error('sessions root is unreadable');
        return super.list(scope, prefix);
      }
    }
    await seedSession('healthy', { createdAt: 1, updatedAt: 2 });
    const store = build(new UnreadableRootStorage(homeDir));
    expect(await store.prepare()).toMatchObject({ state: 'degraded', reason: 'projection failed' });
    await expect(store.listRecent({ workspaceIds: [workspaceId] })).rejects.toBeInstanceOf(
      SessionIndexBuildingError,
    );
  });

  it('emits status changes once across prepare and repeated ready calls', async () => {
    await seedSession('active', { createdAt: 1, updatedAt: 2 });
    const store = build();
    const statuses: SessionIndexStatus[] = [];
    const subscription = store.onDidChangeStatus((status) => statuses.push(status));

    await store.prepare();
    await store.prepare();
    subscription.dispose();

    expect(statuses).toEqual([
      { source: 'read-model', state: 'preparing', degradedCount: 0 },
      { source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 },
    ]);
  });

  it('projects and reconciles metadata without reading incomplete usage wires', async () => {
    await seedSession('usage-repair', {
      title: 'usage',
      createdAt: 1,
      updatedAt: 2,
      agents: { main: { type: 'main' }, worker: { type: 'sub' } },
      usage: {
        total: { inputOther: 1, output: 1, inputCacheRead: 1, inputCacheCreation: 1 },
      },
    });
    const records = [
      ['main', 'example-model', { inputOther: 3, output: 2, inputCacheRead: 1, inputCacheCreation: 0 }],
      ['worker', 'worker-model', { inputOther: 4, output: 5, inputCacheRead: 6, inputCacheCreation: 7 }],
    ] as const;
    for (const [agentId, model, usage] of records) {
      const dir = join(sessionsDir, workspaceId, 'usage-repair', 'agents', agentId);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        join(dir, 'wire.jsonl'),
        `${JSON.stringify({ type: 'usage.record', model, usage })}\n`,
      );
    }
    const fileStorage = new FileStorageService(homeDir);
    const appendLog = new CountingAppendLogStore(fileStorage);
    const store = build(fileStorage, true, appendLog);

    await store.prepare();
    expect(appendLog.readCalls).toBe(0);
    expect((await store.get('usage-repair'))?.usage?.wireComplete).toBeUndefined();

    await store.reconcileNow();
    expect(appendLog.readCalls).toBe(0);
    expect((await store.get('usage-repair'))?.usage).toEqual({
      total: { inputOther: 1, output: 1, inputCacheRead: 1, inputCacheCreation: 1 },
    });

    await seedSession('usage-repair', {
      title: 'updated',
      createdAt: 1,
      updatedAt: 3,
      usage: {
        total: { inputOther: 2, output: 2, inputCacheRead: 2, inputCacheCreation: 2 },
      },
    });
    await store.reconcileNow();
    expect(appendLog.readCalls).toBe(0);
    expect(await store.get('usage-repair')).toMatchObject({
      title: 'updated',
      usage: { total: { inputOther: 2, output: 2, inputCacheRead: 2, inputCacheCreation: 2 } },
    });
  });

  it('serves warm reads with a pending window without touching session directories', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 3 });

    const fileStorage = new CountingStorage(homeDir);
    const store = build(fileStorage);
    await store.prepare();
    await seedSession('a', { title: 'updated', createdAt: 1, updatedAt: 4 });
    await seedSession('c', { title: 'c', createdAt: 3, updatedAt: 5 });
    mirror.record(summary('a', { title: 'updated', createdAt: 1, updatedAt: 4 }));
    mirror.record(summary('c', { title: 'c', createdAt: 3, updatedAt: 5 }));

    fileStorage.listCalls = 0;
    const page = await store.listRecent({ workspaceIds: [workspaceId], limit: 20 });
    expect(page.items.map((item) => item.id)).toEqual(['c', 'a', 'b']);
    expect(await store.get('a')).toMatchObject({ id: 'a', title: 'updated' });
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(3);
    expect(fileStorage.listCalls).toBe(0);
  });

  it('hydrates own recency from unchanged historical metadata without rebuilding the published index', async () => {
    await seedSession('parent', { createdAt: 1, updatedAt: 10, activityUpdatedAt: 100 });
    await seedSession('other', { createdAt: 1, updatedAt: 50 });
    const store = build();
    await store.prepare();
    const manifest = await queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
    const collection = sessionCollection(manifest!.seq);
    for (const id of ['parent', 'other']) {
      const cached = await queryStore.get<SessionSummary>(collection, id);
      const { ownUpdatedAt: _own, ...old } = cached!;
      await queryStore.put(collection, id, old, { columns: { [recencyColumn(manifest!.seq)]: old.updatedAt } });
    }
    const page = await store.listRecent({ limit: 1 });
    expect(page.items).toMatchObject([{ id: 'parent', updatedAt: 100, ownUpdatedAt: 10 }]);
    expect(page.nextCursor).toBe('parent');
    expect(await store.get('other')).toMatchObject({ updatedAt: 50, ownUpdatedAt: 50 });
    await (mirror as SessionIndexMirror).drain();
    expect((await queryStore.getCheckpoint(SESSION_INDEX_MANIFEST))?.seq).toBe(manifest!.seq);
    expect(await queryStore.get(collection, 'parent')).toMatchObject({ updatedAt: 100, ownUpdatedAt: 10 });
    const raw = JSON.parse(await fsp.readFile(join(sessionsDir, workspaceId, 'parent', 'session-meta', 'state.json'), 'utf8'));
    expect(raw).toEqual({ createdAt: 1, updatedAt: 10, activityUpdatedAt: 100 });
  });

  it('paginates exactly through same-millisecond ties', async () => {
    const specs: [string, number][] = [
      ['a', 100],
      ['b', 100],
      ['c', 100],
      ['d', 100],
      ['e', 90],
      ['f', 90],
      ['g', 90],
      ['h', 80],
      ['i', 80],
      ['j', 70],
    ];
    const summaries = specs.map(([id, updatedAt]) => summary(id, { updatedAt }));
    for (const [id, updatedAt] of specs) {
      await seedSession(id, { createdAt: updatedAt - 1, updatedAt });
    }
    const store = build();
    await store.prepare();

    const walked = await walkPages(store, { workspaceIds: [workspaceId] }, 3);
    expect(walked).toEqual(canonicalIds(summaries));
    expect(new Set(walked).size).toBe(specs.length);
  });

  it('drains more than one thousand ties across sixteen real shards in canonical order', async () => {
    const store = build();
    const summaries = [
      summary('newer', { updatedAt: 110, ownUpdatedAt: 110 }),
      ...Array.from({ length: 1201 }, (_, i) => summary(`tie-${String(i).padStart(4, '0')}`, { updatedAt: 100, ownUpdatedAt: 100 })),
      summary('older-z', { updatedAt: 90, ownUpdatedAt: 90 }),
      summary('older-a', { updatedAt: 90, ownUpdatedAt: 90 }),
    ];
    await queryStore.batch(summaries.map((value) => ({
      kind: 'put' as const,
      collection: sessionCollection(1),
      key: value.id,
      value: { ...value, [recencyColumn(1)]: value.updatedAt },
      columns: { [recencyColumn(1)]: value.updatedAt },
    })));
    await queryStore.setCheckpoint(SESSION_INDEX_MANIFEST, { seq: 1, sourceMaxMtimeMs: 110 });

    const metadataReads = vi.spyOn(JsonAtomicDocumentStore.prototype, 'get');
    try {
      const walked = await walkPages(store, { workspaceIds: [workspaceId] }, 50);
      expect(walked).toEqual(canonicalIds(summaries));
      expect(new Set(walked).size).toBe(summaries.length);
      expect((await store.listRecent({ after: 'tie-0600', limit: 50 })).items.map((item) => item.id))
        .toEqual(canonicalIds(summaries.filter((item) => item.updatedAt > 100 || item.updatedAt === 100 && item.id > 'tie-0600')).slice(0, 50));
      expect(metadataReads).not.toHaveBeenCalled();
    } finally {
      metadataReads.mockRestore();
    }
  });

  it('listRecent treats a cache entry missing required fields as a cold miss', async () => {
    await seedSession('s1', { title: 'on-disk', createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();
    const collection = sessionCollection(1);
    await queryStore.put(collection, 's1', {
      id: 's1',
      workspaceId,
      title: 'stale',
      createdAt: 1,
      updatedAt: 2,
    });

    const page = await store.listRecent({ sessionId: 's1' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.title).toBe('on-disk');
    expect(page.items[0]?.archived).toBe(false);

    await (mirror as SessionIndexMirror).drain();
    const cached = await queryStore.get<SessionSummary>(collection, 's1');
    expect(cached?.archived).toBe(false);
  });

  it('get falls back to disk when the cached entry fails the shape check', async () => {
    await seedSession('s1', { title: 'on-disk', createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();
    await queryStore.put(sessionCollection(1), 's1', { id: 's1' });

    const got = await store.get('s1');
    expect(got?.title).toBe('on-disk');
    expect(got?.archived).toBe(false);
  });

  it('walks all pages of a large listing without duplicates', async () => {
    const specs: SessionSummary[] = [];
    for (let i = 0; i < 25; i++) {
      specs.push(summary(`s${String(i).padStart(2, '0')}`, { createdAt: i, updatedAt: i }));
      await seedSession(`s${String(i).padStart(2, '0')}`, { createdAt: i, updatedAt: i });
    }
    const store = build();
    await store.prepare();

    const walked = await walkPages(store, { workspaceIds: [workspaceId] }, 10);
    expect(walked).toEqual(canonicalIds(specs));

    const newer = await store.listRecent({ workspaceIds: [workspaceId], after: 's20' });
    expect(newer.items.map((s) => s.id)).toEqual(['s24', 's23', 's22', 's21']);
  });

  it('listRecent filters by childOf from the read model', async () => {
    await seedSession('child-a', {
      createdAt: 2,
      updatedAt: 9,
      custom: { parent_session_id: 'parent', child_session_kind: 'child' },
    });
    await seedSession('child-b', {
      createdAt: 3,
      updatedAt: 8,
      custom: { parent_session_id: 'parent', child_session_kind: 'child' },
    });
    await seedSession('fork', {
      createdAt: 4,
      updatedAt: 7,
      custom: { parent_session_id: 'parent' },
    });
    await seedSession('grandchild', {
      createdAt: 5,
      updatedAt: 6,
      custom: { parent_session_id: 'child-a', child_session_kind: 'child' },
    });

    const store = build();
    await store.prepare();
    const page = await store.listRecent({ childOf: 'parent' });
    expect(page.items.map((s) => s.id)).toEqual(['child-a', 'child-b']);
  });

  it('listRecent merges a workspace-id set into one recency-ordered page', async () => {
    const otherId = encodeWorkDirKey('/home/user/other');
    await seedSession('a1', { createdAt: 1, updatedAt: 1 });
    await seedSession('a3', { createdAt: 3, updatedAt: 3 });
    await seedSession('b2', { createdAt: 2, updatedAt: 2 }, otherId);
    await seedSession('b4', { createdAt: 4, updatedAt: 4 }, otherId);

    const store = build();
    await store.prepare();
    const page = await store.listRecent({ workspaceIds: [workspaceId, otherId] });
    expect(page.items.map((s) => s.id)).toEqual(['b4', 'a3', 'b2', 'a1']);
    expect(await store.count({ workspaceIds: [workspaceId, otherId] })).toBe(4);
    expect(await store.count({ workspaceIds: [otherId] })).toBe(2);
  });

  it('get falls back to the authoritative document for an un-mirrored session', async () => {
    await seedSession('old', { title: 'projected', createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();

    await seedSession('fresh', { title: 'from disk', createdAt: 3, updatedAt: 4 });
    const found = await store.get('fresh');
    expect(found?.title).toBe('from disk');
    expect(mirror.pending().map((s) => s.id)).toContain('fresh');
  });

  it.each(['unready', 'dirty', 'cache-miss'] as const)('serves authoritative point reads while %s inventory work is stalled', async (mode) => {
    const release = deferred<void>();
    let blockInventories = false;
    let enabled = true;
    class GatedStorage extends FileStorageService {
      override async list(scope: string, prefix?: string): Promise<readonly string[]> {
        if (blockInventories && scope.startsWith('sessions/')) await release.promise;
        return super.list(scope, prefix);
      }
    }
    await seedSession('existing', { title: 'recover this prompt target', createdAt: 1, updatedAt: 2 });
    const store = build(new GatedStorage(homeDir), () => enabled);
    if (mode !== 'unready') await store.prepare();
    if (mode === 'cache-miss') {
      await seedSession('late', { title: 'unmirrored', createdAt: 3, updatedAt: 4 });
    } else if (mode === 'dirty') {
      enabled = false;
      mirror.record(summary('existing'));
      enabled = true;
    }
    blockInventories = true;
    let found: SessionSummary | undefined;
    let settled = false;
    const reading = store.get(mode === 'cache-miss' ? 'late' : 'existing').then((value) => {
      found = value;
      settled = true;
    });
    try {
      await vi.waitFor(() => { expect(settled).toBe(true); });
      expect(found).toMatchObject({ id: mode === 'cache-miss' ? 'late' : 'existing' });
      await expect(store.get('absent')).resolves.toBeUndefined();
    } finally {
      blockInventories = false;
      release.resolve();
      await reading;
    }
  });

  it('get prefers a queued summary over the published record', async () => {
    await seedSession('a', { title: 'published', createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();

    mirror.record(summary('a', { title: 'queued', updatedAt: 3 }));
    expect(await store.get('a')).toMatchObject({ title: 'queued', updatedAt: 3 });
  });

  it('does not return cached or queued sessions from the wrong workspace', async () => {
    const otherId = encodeWorkDirKey('/home/user/other');
    await seedSession('a', { title: 'published', createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();

    expect(await store.get('a', otherId)).toBeUndefined();

    await seedSession('a', { title: 'moved', createdAt: 1, updatedAt: 3 }, otherId);
    await fsp.rm(join(sessionsDir, workspaceId, 'a'), { recursive: true, force: true });
    mirror.record(summary('a', { workspaceId: otherId, title: 'moved', updatedAt: 3 }));

    expect(await store.get('a', workspaceId)).toBeUndefined();
    expect(await store.get('a', otherId)).toMatchObject({ workspaceId: otherId, title: 'moved' });
  });

  it('serves flag-off reads only from authoritative metadata', async () => {
    await seedSession('a', { title: 'published', createdAt: 1, updatedAt: 2 });
    const store = build(new FileStorageService(homeDir), false);
    mirror.record(summary('a', { title: 'queued-only', updatedAt: 3 }));

    expect(await store.prepare()).toEqual({
      source: 'authoritative',
      state: 'uninitialized',
      degradedCount: 0,
    });
    expect(await store.get('a')).toMatchObject({ id: 'a', title: 'published', updatedAt: 2 });
    expect((await store.listRecent({ workspaceIds: [workspaceId] })).items).toMatchObject([
      { id: 'a', title: 'published', updatedAt: 2 },
    ]);
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(1);
    expect(mirror.pending()).toEqual([]);

    await fsp.rm(join(sessionsDir, workspaceId, 'a', 'session-meta', 'state.json'));
    expect(await store.get('a')).toBeUndefined();
    expect((await store.listRecent({ workspaceIds: [workspaceId] })).items).toEqual([]);

    await seedSession('a', { title: 'observed', createdAt: 1, updatedAt: 4 });
    mirror.record(summary('a', { title: 'observed', createdAt: 1, updatedAt: 4 }));
    expect((await store.listRecent({ workspaceIds: [workspaceId] })).items).toMatchObject([
      { id: 'a', title: 'observed', updatedAt: 4 },
    ]);
    expect(mirror.pending()).toEqual([]);

    await fsp.rm(join(sessionsDir, workspaceId, 'a'), { recursive: true });
    await store.remove('a');
    expect((await store.listRecent({ workspaceIds: [workspaceId] })).items).toEqual([]);
    expect(await store.get('a')).toBeUndefined();
  });

  it('shares one authoritative inventory across concurrent fallback list and count reads', async () => {
    let release: () => void = () => {};
    let notify: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { notify = resolve; });
    class GatedStorage extends FileStorageService {
      sessionListReads = 0;
      override async list(scope: string, prefix?: string): Promise<readonly string[]> {
        const entries = await super.list(scope, prefix);
        if (scope === `sessions/${workspaceId}`) {
          this.sessionListReads += 1;
          notify();
          await gate;
        }
        return entries;
      }
    }
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    const storage = new GatedStorage(homeDir);
    const store = build(storage, false);
    const reads = Promise.all([
      store.listRecent({ workspaceIds: [workspaceId], limit: 1 }),
      store.count({ workspaceIds: [workspaceId] }),
      store.listRecent({ workspaceIds: [workspaceId], includeArchived: true }),
    ]);
    await entered;
    release();
    const [page, count, all] = await reads;
    expect(page.items.map((item) => item.id)).toEqual(['a']);
    expect(count).toBe(1);
    expect(all.items).toEqual(page.items);
    expect(storage.sessionListReads).toBe(1);
    await seedSession('b', { createdAt: 3, updatedAt: 4 });
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);
    expect(storage.sessionListReads).toBe(2);
  });

  it('repairs only changed sessions when authoritative scans cross create, update, and delete', async () => {
    let listGate: Promise<void> | undefined;
    let releaseList: () => void = () => {};
    let notifyList: (() => void) | undefined;
    let readGate: Promise<void> | undefined;
    let releaseRead: () => void = () => {};
    let notifyRead: (() => void) | undefined;
    let gatedReadId: string | undefined;
    class GatedStorage extends FileStorageService {
      sessionListReads = 0;
      stateReads = 0;

      override async list(scope: string, prefix?: string): Promise<readonly string[]> {
        const entries = await super.list(scope, prefix);
        if (scope === `sessions/${workspaceId}`) {
          this.sessionListReads += 1;
          const gate = listGate;
          listGate = undefined;
          if (gate !== undefined) {
            notifyList?.();
            await gate;
          }
        }
        return entries;
      }

      override async read(scope: string, key: string): Promise<Uint8Array | undefined> {
        const bytes = await super.read(scope, key);
        if (key === 'state.json' && scope.endsWith('/session-meta')) {
          this.stateReads += 1;
          if (gatedReadId !== undefined && scope.endsWith(`/${gatedReadId}/session-meta`)) {
            gatedReadId = undefined;
            const gate = readGate;
            readGate = undefined;
            notifyRead?.();
            if (gate !== undefined) await gate;
          }
        }
        return bytes;
      }
    }
    const fileStorage = new GatedStorage(homeDir);
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    const store = build(fileStorage, false);

    const listEntered = new Promise<void>((resolve) => {
      notifyList = resolve;
    });
    listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const beforeCreateReads = fileStorage.sessionListReads;
    const creatingScan = store.listRecent({ workspaceIds: [workspaceId] });
    await listEntered;
    await seedSession('b', { title: 'b', createdAt: 3, updatedAt: 4 });
    mirror.record(summary('b', { title: 'b', createdAt: 3, updatedAt: 4 }));
    releaseList();
    await expect(creatingScan).resolves.toMatchObject({ items: [{ id: 'b' }, { id: 'a' }] });
    expect(fileStorage.sessionListReads - beforeCreateReads).toBe(1);
    expect(mirror.pending()).toEqual([]);

    const updateReadEntered = new Promise<void>((resolve) => {
      notifyRead = resolve;
    });
    readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    gatedReadId = 'a';
    const beforeUpdateReads = fileStorage.stateReads;
    const updatingScan = store.get('a');
    await updateReadEntered;
    await seedSession('a', { title: 'updated', createdAt: 1, updatedAt: 5 });
    mirror.record(summary('a', { title: 'updated', createdAt: 1, updatedAt: 5 }));
    releaseRead();
    await expect(updatingScan).resolves.toMatchObject({ id: 'a', title: 'updated', updatedAt: 5 });
    expect(fileStorage.stateReads - beforeUpdateReads).toBeGreaterThanOrEqual(2);
    expect(mirror.pending()).toEqual([]);

    const deleteReadEntered = new Promise<void>((resolve) => {
      notifyRead = resolve;
    });
    readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    gatedReadId = 'a';
    const beforeDeleteLists = fileStorage.sessionListReads;
    const deletingScan = store.get('a');
    await deleteReadEntered;
    await fsp.rm(join(sessionsDir, workspaceId, 'a'), { recursive: true, force: true });
    await store.remove('a');
    releaseRead();
    await expect(deletingScan).resolves.toBeUndefined();
    expect(fileStorage.sessionListReads - beforeDeleteLists).toBe(0);
    expect((await store.listRecent({ workspaceIds: [workspaceId] })).items).toMatchObject([
      { id: 'b' },
    ]);
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(1);
    expect(mirror.pending()).toEqual([]);
  });

  it('does not repeat the full authoritative inventory under mutation churn', async () => {
    let mutationsRemaining = 3;
    class ChurningStorage extends FileStorageService {
      sessionListReads = 0;
      override async list(scope: string, prefix?: string): Promise<readonly string[]> {
        const entries = await super.list(scope, prefix);
        if (scope === `sessions/${workspaceId}`) {
          this.sessionListReads += 1;
          if (mutationsRemaining > 0) {
            mutationsRemaining -= 1;
            mirror.record(summary('a', { updatedAt: 2 }));
          }
        }
        return entries;
      }
    }
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    const fileStorage = new ChurningStorage(homeDir);
    const store = build(fileStorage, false);

    await expect(store.listRecent({ workspaceIds: [workspaceId] })).resolves.toMatchObject({
      items: [{ id: 'a' }],
    });
    expect(fileStorage.sessionListReads).toBe(1);
    expect(mutationsRemaining).toBe(2);
  });

  it('replaces pending rows before archive filtering and limited-page refill', async () => {
    for (let i = 1; i <= 5; i++) {
      await seedSession(`s${i}`, { createdAt: i, updatedAt: i });
    }
    const store = build();
    await store.prepare();

    mirror.record(summary('s5', { createdAt: 5, updatedAt: 6, archived: true }));
    const active = await store.listRecent({ workspaceIds: [workspaceId], limit: 2 });
    expect(active.items.map((item) => item.id)).toEqual(['s4', 's3']);
    expect(active.nextCursor).toBe('s3');

    const all = await store.listRecent({
      workspaceIds: [workspaceId],
      includeArchived: true,
      limit: 2,
    });
    expect(all.items.map((item) => item.id)).toEqual(['s5', 's4']);
    expect(all.nextCursor).toBe('s4');
  });

  it('replaces pending rows before child filters', async () => {
    await seedSession('child', {
      createdAt: 1,
      updatedAt: 2,
      custom: { parent_session_id: 'parent-a', child_session_kind: 'child' },
    });
    const store = build();
    await store.prepare();

    mirror.record(
      summary('child', {
        updatedAt: 3,
        custom: { parent_session_id: 'parent-b', child_session_kind: 'child' },
      }),
    );
    expect((await store.listRecent({ childOf: 'parent-a' })).items).toEqual([]);
    expect((await store.listRecent({ childOf: 'parent-b' })).items).toMatchObject([
      { id: 'child', custom: { parent_session_id: 'parent-b' } },
    ]);
  });

  it('replaces pending rows across workspace filters and restricted counts', async () => {
    const otherId = encodeWorkDirKey('/home/user/other');
    await seedSession('moved', { title: 'old', createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();

    mirror.record(
      summary('moved', {
        workspaceId: otherId,
        title: 'latest',
        updatedAt: 3,
      }),
    );

    expect((await store.listRecent({ workspaceIds: [workspaceId] })).items).toEqual([]);
    expect((await store.listRecent({ workspaceIds: [otherId] })).items).toMatchObject([
      { id: 'moved', workspaceId: otherId, title: 'latest' },
    ]);
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(0);
    expect(await store.count({ workspaceIds: [otherId] })).toBe(1);
    expect(await store.count({})).toBe(1);
  });

  it('replaces pending rows before cursor-range filtering and refill', async () => {
    for (let i = 1; i <= 4; i++) {
      await seedSession(`s${i}`, { createdAt: i, updatedAt: i });
    }
    const store = build();
    await store.prepare();

    mirror.record(summary('s3', { createdAt: 3, updatedAt: 5 }));
    const older = await store.listRecent({
      workspaceIds: [workspaceId],
      before: 's4',
      limit: 2,
    });
    expect(older.items.map((item) => item.id)).toEqual(['s2', 's1']);
    expect(older.nextCursor).toBeUndefined();
    const newer = await store.listRecent({ workspaceIds: [workspaceId], after: 's4' });
    expect(newer.items.map((item) => item.id)).toEqual(['s3']);
  });

  it('keeps an explicit keyset position after its cursor row changes or disappears', async () => {
    for (const id of ['a', 'b', 'c']) await seedSession(id, { createdAt: 1, updatedAt: 10 });
    const store = build();
    await store.prepare();
    const query = { workspaceIds: [workspaceId], beforePosition: { updatedAt: 10, id: 'b' }, limit: 2 };
    expect((await store.listRecent(query)).items.map((item) => item.id)).toEqual(['a']);
    mirror.record(summary('b', { createdAt: 1, updatedAt: 20 }));
    expect((await store.listRecent(query)).items.map((item) => item.id)).toEqual(['a']);
    await fsp.rm(join(sessionsDir, workspaceId, 'b'), { recursive: true });
    await store.remove('b');
    expect((await store.listRecent(query)).items.map((item) => item.id)).toEqual(['a']);
  });

  it('removes summaries and workspace counters atomically and idempotently', async () => {
    const otherId = encodeWorkDirKey('/home/user/other');
    await seedSession('active', { createdAt: 1, updatedAt: 3 });
    await seedSession('archived', { createdAt: 2, updatedAt: 2, archived: true });
    await seedSession('other', { createdAt: 3, updatedAt: 1 }, otherId);
    const store = build();
    await store.prepare();

    await fsp.rm(join(sessionsDir, workspaceId, 'active'), { recursive: true });
    await store.remove('active');
    await store.remove('active');
    await fsp.rm(join(sessionsDir, workspaceId, 'archived'), { recursive: true });
    await store.remove('archived');
    await store.remove('archived');

    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(0);
    expect(await store.count({ workspaceIds: [workspaceId], includeArchived: true })).toBe(0);
    expect(await store.count({ workspaceIds: [otherId] })).toBe(1);
    expect(await store.count({})).toBe(1);
    expect(await store.count({ includeArchived: true })).toBe(1);
    expect((await store.listRecent({ includeArchived: true })).items.map((item) => item.id)).toEqual([
      'other',
    ]);
  });

  it('does not revive a rolled-back session after explicit invalidation', async () => {
    await seedSession('base', { createdAt: 1, updatedAt: 1 });
    const store = build();
    await store.prepare();
    await seedSession('ghost', { createdAt: 2, updatedAt: 2 });
    mirror.record(summary('ghost', { createdAt: 2, updatedAt: 2 }));
    await fsp.rm(join(sessionsDir, workspaceId, 'ghost'), { recursive: true });
    await store.remove('ghost');

    const before = {
      got: await store.get('ghost'),
      ids: (await store.listRecent({ workspaceIds: [workspaceId] })).items.map((item) => item.id),
      count: await store.count({ workspaceIds: [workspaceId] }),
    };
    await mirror.drain();
    const after = {
      got: await store.get('ghost'),
      ids: (await store.listRecent({ workspaceIds: [workspaceId] })).items.map((item) => item.id),
      count: await store.count({ workspaceIds: [workspaceId] }),
    };

    expect(before).toEqual({ got: undefined, ids: ['base'], count: 1 });
    expect(after).toEqual(before);
  });

  it('reports building for dirty mirror state until authoritative catch-up publishes', async () => {
    let enabled = true;
    const store = build(new FileStorageService(homeDir), () => enabled);
    await store.prepare();
    expect(store.status().generation).toBe(1);

    enabled = false;
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 3 });
    await seedSession('c', { title: 'initial', createdAt: 3, updatedAt: 4 });
    mirror.record(summary('a', { title: 'a', createdAt: 1, updatedAt: 2 }));
    mirror.record(summary('b', { title: 'b', createdAt: 2, updatedAt: 3 }));
    mirror.record(summary('c', { title: 'initial', createdAt: 3, updatedAt: 4 }));
    await seedSession('c', { title: 'latest', createdAt: 3, updatedAt: 5 });
    mirror.record(summary('c', { title: 'latest', createdAt: 3, updatedAt: 5 }));
    expect(mirror.pending()).toEqual([]);

    enabled = true;
    await expect(
      store.listRecent({ workspaceIds: [workspaceId], limit: 1 }),
    ).rejects.toBeInstanceOf(SessionIndexBuildingError);
    expect(await store.get('c')).toMatchObject({ id: 'c', title: 'latest' });
    await store.prepare();
    expect((await store.listRecent({ workspaceIds: [workspaceId], limit: 1 })).items).toMatchObject([
      { id: 'c', title: 'latest' },
    ]);
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(3);
    expect(store.status().generation).toBe(2);
    expect(mirror.pending()).toEqual([]);

    await store.get('a');
    expect(store.status().generation).toBe(2);
  });

  it('cursor-less pages merge the mirror queue for read-your-writes', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();

    await seedSession('pending-one', { title: 'pending', createdAt: 3, updatedAt: 10 });
    mirror.record(summary('pending-one', { title: 'pending', createdAt: 3, updatedAt: 10 }));
    const page = await store.listRecent({ workspaceIds: [workspaceId], limit: 20 });
    expect(page.items.map((s) => s.id)).toEqual(['pending-one', 'a']);

    await mirror.drain();
    expect(mirror.pending()).toEqual([]);
    const after = await store.listRecent({ workspaceIds: [workspaceId], limit: 20 });
    expect(after.items.map((s) => s.id)).toEqual(['pending-one', 'a']);
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);
  });

  it('drains a pending initial projection before disposing its query store', async () => {
    const scanning = deferred<void>();
    const resumeScan = deferred<void>();
    class GatedStorage extends FileStorageService {
      override async list(scope: string, prefix?: string): Promise<readonly string[]> {
        const entries = await super.list(scope, prefix);
        if (scope === `sessions/${workspaceId}`) {
          scanning.resolve();
          await resumeScan.promise;
        }
        return entries;
      }
    }
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    const watch = vi.spyOn(TestSessionIndexWatch.prototype, 'watch');
    const store = build(new GatedStorage(homeDir));
    const closeQueryStore = vi.spyOn(queryStore, 'close');
    const exclusive = vi.spyOn(queryStore, 'withExclusive');
    const preparing = store.prepare();
    await scanning.promise;
    const disposeIndex = vi.spyOn(store, 'dispose');
    let disposed = false;
    const closing = Promise.resolve(disposeHost?.()).then(() => { disposed = true; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(disposeIndex).toHaveBeenCalledOnce();
      expect(disposed).toBe(false);
      expect(closeQueryStore).not.toHaveBeenCalled();
      resumeScan.resolve();
      await preparing;
      await closing;
      disposeHost = undefined;
      expect(watch).not.toHaveBeenCalled();
      await drainSessionIndexMirror();
      await drainQueryStoreDisposals();
      expect(closeQueryStore).toHaveBeenCalledOnce();
      expect(exclusive).toHaveBeenCalled();
      exclusive.mockClear();
      await fsp.rm(homeDir, { recursive: true, force: true });
      await store.prepare();
      await store.reprojectNow();
      expect(exclusive).not.toHaveBeenCalled();
      await expect(fsp.stat(homeDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      resumeScan.resolve();
      await preparing;
      await closing;
      store.stopReconcileLoop();
      disposeIndex.mockRestore();
      watch.mockRestore();
      closeQueryStore.mockRestore();
      exclusive.mockRestore();
    }
  });

  it('keeps a queued summary visible to a page that races its flush', async () => {
    let pageGate: Promise<void> | undefined;
    let releasePage: () => void = () => {};
    let notifyPageRead: (() => void) | undefined;
    class GatedQueryStore extends MiniDbQueryStore {
      override async pageByColumn<T>(
        collection: string,
        query: ColumnPageQuery,
      ): Promise<Page<T>> {
        const page = await super.pageByColumn<T>(collection, query);
        const gate = pageGate;
        pageGate = undefined;
        if (gate !== undefined) {
          notifyPageRead?.();
          await gate;
        }
        return page;
      }
    }
    overrideScopedService(
      LifecycleScope.App,
      IQueryStore,
      GatedQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();

    await seedSession('fresh', { title: 'fresh', createdAt: 3, updatedAt: 10 });
    mirror.record(summary('fresh', { title: 'fresh', createdAt: 3, updatedAt: 10 }));
    const pageRead = new Promise<void>((resolve) => {
      notifyPageRead = resolve;
    });
    pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const listing = store.listRecent({ workspaceIds: [workspaceId], limit: 20 });
    await pageRead;
    await mirror.drain();
    releasePage();

    const page = await listing;
    expect(page.items.map((item) => item.id)).toEqual(['fresh', 'a']);
  });

  it('serializes a mirror flush behind a replacement projection', async () => {
    let scanGate: Promise<void> | undefined;
    let releaseScan: () => void = () => {};
    let notifyScanRead: (() => void) | undefined;
    class GatedStorage extends FileStorageService {
      holdWorkspaceScan = false;
      override async list(scope: string, prefix?: string): Promise<readonly string[]> {
        const entries = await super.list(scope, prefix);
        if (this.holdWorkspaceScan && scope === `sessions/${workspaceId}`) {
          this.holdWorkspaceScan = false;
          notifyScanRead?.();
          await scanGate;
        }
        return entries;
      }
    }
    class TrackingQueryStore extends MiniDbQueryStore {
      trackManifestReads = false;
      trackedManifestReads = 0;
      override async getCheckpoint(source: string): Promise<Checkpoint | undefined> {
        if (this.trackManifestReads && source === SESSION_INDEX_MANIFEST) {
          this.trackedManifestReads += 1;
        }
        return super.getCheckpoint(source);
      }
    }
    overrideScopedService(
      LifecycleScope.App,
      IQueryStore,
      TrackingQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    const fileStorage = new GatedStorage(homeDir);
    const store = build(fileStorage);
    await store.prepare();

    const scanRead = new Promise<void>((resolve) => {
      notifyScanRead = resolve;
    });
    scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    fileStorage.holdWorkspaceScan = true;
    const reprojecting = store.reprojectNow();
    await scanRead;

    await seedSession('fresh', { title: 'fresh', createdAt: 3, updatedAt: 10 });
    mirror.record(summary('fresh', { title: 'fresh', createdAt: 3, updatedAt: 10 }));
    const trackingStore = queryStore as TrackingQueryStore;
    trackingStore.trackManifestReads = true;
    const draining = mirror.drain();
    const crossedProjection = trackingStore.trackedManifestReads;
    trackingStore.trackManifestReads = false;
    releaseScan();
    await Promise.all([reprojecting, draining]);

    expect(crossedProjection).toBe(0);
    const page = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(page.items.map((item) => item.id)).toEqual(['fresh', 'a']);
  }, 30_000);

  it('resolves a keyset cursor that is still queued in the mirror', async () => {
    await seedSession('a', { createdAt: 1, updatedAt: 2 });
    await seedSession('b', { createdAt: 2, updatedAt: 3 });
    const store = build();
    await store.prepare();

    await seedSession('cursor-new', { createdAt: 3, updatedAt: 10 });
    mirror.record(summary('cursor-new', { createdAt: 3, updatedAt: 10 }));
    const first = await store.listRecent({ workspaceIds: [workspaceId], limit: 1 });
    expect(first.items.map((s) => s.id)).toEqual(['cursor-new']);
    expect(first.nextCursor).toBe('cursor-new');

    const rest = await store.listRecent({
      workspaceIds: [workspaceId],
      limit: 5,
      before: first.nextCursor,
    });
    expect(rest.items.map((s) => s.id)).toEqual(['b', 'a']);
    expect(rest.nextCursor).toBeUndefined();

    const unknown = await store.listRecent({ workspaceIds: [workspaceId], before: 'missing' });
    expect(unknown.items).toEqual([]);
  }, 30_000);

  it('remove evicts a queued mirror entry so a deleted session stays unlisted', async () => {
    await seedSession('a', { createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();

    await seedSession('fresh', { createdAt: 3, updatedAt: 10 });
    mirror.record(summary('fresh', { createdAt: 3, updatedAt: 10 }));
    const before = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(before.items.map((s) => s.id)).toEqual(['fresh', 'a']);

    await fsp.rm(join(sessionsDir, workspaceId, 'fresh'), { recursive: true, force: true });
    await store.remove('fresh');
    expect(mirror.pending()).toEqual([]);
    const after = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(after.items.map((s) => s.id)).toEqual(['a']);

    await mirror.drain();
    const settled = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(settled.items.map((s) => s.id)).toEqual(['a']);
  });

  it('remove waits out an in-flight mirror flush before deleting from the store', async () => {
    await seedSession('a', { createdAt: 1, updatedAt: 2 });

    let batchGate: Promise<void> | undefined;
    let releaseBatch: () => void = () => {};
    let notifyBatchEntered: (() => void) | undefined;
    class GatedQueryStore extends MiniDbQueryStore {
      override async batch(ops: readonly WriteOp[]): Promise<void> {
        notifyBatchEntered?.();
        const gate = batchGate;
        batchGate = undefined;
        if (gate !== undefined) await gate;
        return super.batch(ops);
      }
    }
    overrideScopedService(
      LifecycleScope.App,
      IQueryStore,
      GatedQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    const fileStorage = new FileStorageService(homeDir);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IAppendLogStore, new AppendLogStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(true)),
    ]);
    disposeHost = () => {
      return host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    const store = host.app.accessor.get(ISessionIndex) as FileSessionIndex;
    await store.prepare();

    const entered = new Promise<void>((resolve) => {
      notifyBatchEntered = resolve;
    });
    batchGate = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });
    await seedSession('fresh', { createdAt: 3, updatedAt: 10 });
    mirror.record(summary('fresh', { createdAt: 3, updatedAt: 10 }));
    const draining = mirror.drain();
    await entered;

    await fsp.rm(join(sessionsDir, workspaceId, 'fresh'), { recursive: true, force: true });
    const removing = store.remove('fresh');
    releaseBatch();
    await Promise.all([removing, draining]);

    const page = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(page.items.map((s) => s.id)).toEqual(['a']);
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(1);
  });

  it('removes from a concurrently published generation and decrements its counter once', async () => {
    await seedSession('a', { createdAt: 1, updatedAt: 2 });

    let checkpointGate: Promise<void> | undefined;
    let releaseCheckpoint: () => void = () => {};
    let notifyCheckpointEntered: (() => void) | undefined;
    class GatedQueryStore extends MiniDbQueryStore {
      holdNextPublish = false;
      override async setCheckpoint(source: string, checkpoint: Checkpoint): Promise<void> {
        if (
          this.holdNextPublish &&
          source === SESSION_INDEX_MANIFEST &&
          checkpoint.seq === 2
        ) {
          this.holdNextPublish = false;
          notifyCheckpointEntered?.();
          await checkpointGate;
        }
        return super.setCheckpoint(source, checkpoint);
      }
    }
    overrideScopedService(
      LifecycleScope.App,
      IQueryStore,
      GatedQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    const store = build();
    await store.prepare();

    const entered = new Promise<void>((resolve) => {
      notifyCheckpointEntered = resolve;
    });
    checkpointGate = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    (queryStore as GatedQueryStore).holdNextPublish = true;
    const reprojecting = store.reprojectNow();
    await entered;

    await fsp.rm(join(sessionsDir, workspaceId, 'a'), { recursive: true, force: true });
    const removing = store.remove('a');
    releaseCheckpoint();
    await Promise.all([reprojecting, removing]);
    await store.remove('a');

    expect((await store.listRecent({ workspaceIds: [workspaceId] })).items).toEqual([]);
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(0);
    expect(await store.count({ workspaceIds: [workspaceId], includeArchived: true })).toBe(0);
  });

  it('count folds the mirror queue in before the flush lands', async () => {
    await seedSession('a', { createdAt: 1, updatedAt: 2 });
    await seedSession('b', { createdAt: 2, updatedAt: 3 });
    const store = build();
    await store.prepare();
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);

    await seedSession('new', { createdAt: 3, updatedAt: 4 });
    mirror.record(summary('new', { createdAt: 3, updatedAt: 4 }));
    mirror.record(summary('a', { archived: true, updatedAt: 5 }));
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);
    expect(await store.count({ workspaceIds: [workspaceId], includeArchived: true })).toBe(3);

    await mirror.drain();
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);
    expect(await store.count({ workspaceIds: [workspaceId], includeArchived: true })).toBe(3);
  });

  it('keeps legacy published collections when the isolated publish fails', async () => {
    class PublishFailingQueryStore extends MiniDbQueryStore {
      failPublish = false;
      override async setCheckpoint(source: string, checkpoint: Checkpoint): Promise<void> {
        if (this.failPublish && source === SESSION_INDEX_MANIFEST) {
          throw new Error('injected isolated publish crash');
        }
        await super.setCheckpoint(source, checkpoint);
      }
    }
    overrideScopedService(
      LifecycleScope.App,
      IQueryStore,
      PublishFailingQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    const fileStorage = new FileStorageService(homeDir);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IAppendLogStore, new AppendLogStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(true)),
    ]);
    disposeHost = () => {
      return host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    const store = host.app.accessor.get(ISessionIndex) as FileSessionIndex;
    const legacySummary = summary('legacy', { createdAt: 1, updatedAt: 2 });
    await queryStore.put('session:g1', 'legacy', legacySummary, {
      columns: { 'g1:updatedAt': legacySummary.updatedAt },
    });
    await queryStore.setCheckpoint('sessionIndex', { seq: 1 });
    await queryStore.setCheckpoint('sessionIndex:v2', { seq: 1 });

    (queryStore as PublishFailingQueryStore).failPublish = true;
    const status = await store.prepare();

    expect(status).toMatchObject({ state: 'degraded', reason: 'projection failed' });
    expect(await queryStore.getCheckpoint(SESSION_INDEX_MANIFEST)).toBeUndefined();
    expect(await queryStore.getCheckpoint('sessionIndex')).toEqual({ seq: 1 });
    expect(await queryStore.getCheckpoint('sessionIndex:v2')).toEqual({ seq: 1 });
    expect(await queryStore.get<SessionSummary>('session:g1', 'legacy')).toEqual(legacySummary);
  });

  it('publishes v4 before cleaning a real v3 collection layout', async () => {
    class UpgradeTrackingQueryStore extends MiniDbQueryStore {
      legacyPresentAtPublish = false;
      override async setCheckpoint(source: string, checkpoint: Checkpoint): Promise<void> {
        if (source === SESSION_INDEX_MANIFEST) {
          this.legacyPresentAtPublish =
            (await this.get<SessionSummary>(legacySessionCollection(1), 'legacy')) !== undefined;
        }
        await super.setCheckpoint(source, checkpoint);
      }
    }
    overrideScopedService(
      LifecycleScope.App,
      IQueryStore,
      UpgradeTrackingQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    await seedSession('fresh', { createdAt: 1, updatedAt: 3 });
    const store = build();
    const legacySummary = summary('legacy', { createdAt: 1, updatedAt: 2 });
    await queryStore.put(legacySessionCollection(1), 'legacy', legacySummary);
    await queryStore.put(legacySessionCountersCollection(1), workspaceId, {
      active: 1,
      archived: 0,
    });
    await queryStore.setCheckpoint(LEGACY_SESSION_INDEX_MANIFEST, { seq: 1 });

    await expect(store.prepare()).resolves.toMatchObject({
      source: 'read-model',
      state: 'ready',
      generation: 1,
    });

    const tracking = queryStore as UpgradeTrackingQueryStore;
    expect(tracking.legacyPresentAtPublish).toBe(true);
    expect(await queryStore.get<SessionSummary>(sessionCollection(1), 'fresh')).toMatchObject({
      id: 'fresh',
    });
    expect(await queryStore.get<SessionSummary>(legacySessionCollection(1), 'legacy')).toBeUndefined();
    expect(await queryStore.get(legacySessionCountersCollection(1), workspaceId)).toBeUndefined();
  });

  it('a crashed initial projection reports building and recovers on retry', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 3 });

    class FlakyQueryStore extends MiniDbQueryStore {
      failNextBatch = false;
      override async batch(ops: readonly WriteOp[]): Promise<void> {
        if (this.failNextBatch) {
          this.failNextBatch = false;
          throw new Error('injected projection crash');
        }
        return super.batch(ops);
      }
    }
    overrideScopedService(
      LifecycleScope.App,
      IQueryStore,
      FlakyQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    const fileStorage = new CountingStorage(homeDir);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IAppendLogStore, new AppendLogStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(true)),
    ]);
    disposeHost = () => {
      return host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    const store = host.app.accessor.get(ISessionIndex) as FileSessionIndex;

    (queryStore as FlakyQueryStore).failNextBatch = true;
    const status = await store.prepare();
    expect(status.state).toBe('degraded');
    expect(status.degradedCount).toBe(1);
    expect(status.reason).toBe('projection failed');
    fileStorage.listCalls = 0;
    expect(await store.get('b', workspaceId)).toMatchObject({ id: 'b', title: 'b' });
    expect(fileStorage.listCalls).toBe(0);
    await expect(store.listRecent({ workspaceIds: [workspaceId] })).rejects.toBeInstanceOf(
      SessionIndexBuildingError,
    );
    expect(store.status()).toEqual({
      source: 'read-model',
      state: 'preparing',
      generation: undefined,
      reason: 'projection failed',
      degradedCount: 1,
    });

    const recovered = await store.prepare();
    expect(recovered).toEqual({
      source: 'read-model',
      state: 'ready',
      generation: 1,
      degradedCount: 1,
    });
    const warm = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(warm.items.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('a crashed re-projection keeps readers on the previous generation', async () => {
    await seedSession('a', { createdAt: 1, updatedAt: 3 });
    await seedSession('b', { createdAt: 2, updatedAt: 2 });
    await seedSession('c', { createdAt: 3, updatedAt: 1 });

    class FlakyQueryStore extends MiniDbQueryStore {
      failNextBatch = false;
      override async batch(ops: readonly WriteOp[]): Promise<void> {
        if (this.failNextBatch) {
          this.failNextBatch = false;
          throw new Error('injected projection crash');
        }
        return super.batch(ops);
      }
    }
    overrideScopedService(
      LifecycleScope.App,
      IQueryStore,
      FlakyQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    const fileStorage = new FileStorageService(homeDir);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IAppendLogStore, new AppendLogStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(true)),
    ]);
    disposeHost = () => {
      return host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    const store = host.app.accessor.get(ISessionIndex) as FileSessionIndex;
    await store.prepare();
    expect(store.status().state).toBe('ready');

    await fsp.rm(join(sessionsDir, workspaceId, 'b'), { recursive: true, force: true });
    (queryStore as FlakyQueryStore).failNextBatch = true;
    await store.reprojectNow();

    expect(store.status()).toEqual({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 });
    const page = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(page.items.map((s) => s.id)).toEqual(['a', 'b', 'c']);

    await store.reprojectNow();
    expect(store.status()).toEqual({
      source: 'read-model',
      state: 'ready',
      generation: 2,
      degradedCount: 0,
    });
    const rebuilt = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(rebuilt.items.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('reprojects automatically after the store is wiped, without per-request backfill', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 3 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 2 });

    const first = build();
    await first.prepare();
    expect(first.status().state).toBe('ready');

    await disposeHost?.();
    disposeHost = undefined;
    await drainSessionIndexMirror();
    await drainQueryStoreDisposals();
    await fsp.rm(join(homeDir, 'cache', MINIDB_QUERY_STORE_SUBDIR), { recursive: true, force: true });

    const second = build();
    await expect(second.listRecent({ workspaceIds: [workspaceId] })).rejects.toBeInstanceOf(
      SessionIndexBuildingError,
    );
    const status = await second.prepare();
    expect(status.state).toBe('ready');
    const warm = await second.listRecent({ workspaceIds: [workspaceId] });
    expect(warm.items.map((s) => s.id)).toEqual(['a', 'b']);
    expect(await second.count({ workspaceIds: [workspaceId] })).toBe(2);
  });

  it('serves published list and count while reconciliation scans the authoritative tree', async () => {
    await seedSession('existing', { createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();
    const entered = deferred<void>();
    const gate = deferred<void>();
    const original = SessionIndexProjector.prototype.planReconcile;
    const scan = vi.spyOn(SessionIndexProjector.prototype, 'planReconcile').mockImplementation(async function (this: SessionIndexProjector, ...args) {
      entered.resolve();
      await gate.promise;
      return original.apply(this, args);
    });
    const reconciliation = store.reconcileNow();
    let reads: Promise<unknown> | undefined;
    try {
      await entered.promise;
      reads = Promise.all([
        store.listRecent({ workspaceIds: [workspaceId], limit: 10 }),
        store.count({ workspaceIds: [workspaceId] }),
      ]);
      const result = await Promise.race([
        reads,
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked by reconciliation'), 300)),
      ]);
      expect(result).toEqual([expect.objectContaining({ items: [expect.objectContaining({ id: 'existing' })] }), 1]);
    } finally {
      gate.resolve();
      await reconciliation;
      await reads;
      scan.mockRestore();
    }
  });

  it.each(['writer', 'requests'] as const)('bounds repeated reconciliation invalidation from continuous %s and retains a scheduled repair', async (activity) => {
    await Promise.all(Array.from({ length: 452 }, (_, i) => seedSession(`s${i}`, { createdAt: 1, updatedAt: i + 1 })));
    const store = build();
    await store.prepare();
    await seedSession('s0', { title: 'external drift', createdAt: 1, updatedAt: 1 });
    let scheduled: (() => void) | undefined;
    let delay = 0;
    const schedule = vi.spyOn(TimeoutTimer.prototype, 'cancelAndSet').mockImplementation((runner, timeout) => {
      scheduled = runner;
      delay = timeout;
    });
    const original = SessionIndexProjector.prototype.planReconcile;
    let continuous = true;
    let scans = 0;
    const waiters: Promise<unknown>[] = [];
    const batchWrites = vi.spyOn(queryStore, 'batch');
    const scan = vi.spyOn(SessionIndexProjector.prototype, 'planReconcile').mockImplementation(async function (this: SessionIndexProjector, ...args) {
      if (++scans > 2 && continuous) throw new Error('reconciliation exceeded the scan budget');
      const commit = await original.apply(this, args);
      if (continuous) {
        const read = Promise.all([
          store.listRecent({ workspaceIds: [workspaceId], limit: 10 }),
          store.count({ workspaceIds: [workspaceId] }),
        ]);
        expect(await Promise.race([
          read,
          new Promise<string>((resolve) => setTimeout(() => resolve('read blocked'), 1_000)),
        ])).toEqual([expect.objectContaining({ items: expect.any(Array) }), 452]);
        if (activity === 'writer') {
          const value = { title: `managed ${scans}`, createdAt: 1, updatedAt: 500 + scans };
          await seedSession('s451', value);
          mirror.record(summary('s451', value));
          await mirror.drain();
        } else {
          waiters.push(store.reconcileNow().catch((error: unknown) => error));
        }
      }
      return commit;
    });
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const outcome = await store.reconcileNow().catch((error: unknown) => error);
      expect(outcome).toMatchObject({ code: 'session.index_building', details: { operation: 'reconcile', reason: 'concurrent_changes', attempts: 2 } });
      expect(scans).toBe(2);
      if (activity === 'requests') expect(batchWrites).not.toHaveBeenCalled();
      expect(scheduled).toBeTypeOf('function');
      expect(delay).toBeGreaterThanOrEqual(5_000);
      await expect(store.reconcileNow()).rejects.toMatchObject({ code: 'session.index_building' });
      expect(scans).toBe(2);
      await Promise.all(waiters);
      continuous = false;
      clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + delay);
      const retry = vi.spyOn(store, 'reconcileNow');
      try {
        scheduled!();
        await retry.mock.results[0]!.value;
      } finally {
        retry.mockRestore();
      }
      expect(scans).toBe(3);
      expect(await store.get('s0', workspaceId)).toMatchObject({ title: 'external drift' });
      expect(await store.count({ workspaceIds: [workspaceId] })).toBe(452);
    } finally {
      continuous = false;
      await Promise.all(waiters);
      clock?.mockRestore();
      scan.mockRestore();
      batchWrites.mockRestore();
      schedule.mockRestore();
    }
  }, 30_000);

  it.each(['initial', 'ordinary reproject', 'dirty catchup'] as const)('D7 bounds %s invalidated projections and preserves authoritative changes', async (mode) => {
    await seedSession('keep', { title: 'keep', createdAt: 1, updatedAt: 1 });
    await seedSession('changed', { title: 'before', createdAt: 2, updatedAt: 2 });
    await seedSession('deleted', { title: 'remove', createdAt: 3, updatedAt: 3 });
    await seedSession('churn', { title: 'from disk', createdAt: 4, updatedAt: 4 });

    let enabled = true;
    const store = build(new FileStorageService(homeDir), () => enabled);
    if (mode !== 'initial') await store.prepare();

    await seedSession('changed', { title: 'after', createdAt: 2, updatedAt: 10 });
    await fsp.rm(join(sessionsDir, workspaceId, 'deleted'), { recursive: true, force: true });
    await seedSession('late', { title: 'authoritative', createdAt: 5, updatedAt: 11 });
    if (mode === 'dirty catchup') {
      enabled = false;
      mirror.record(summary('dirty-marker', { title: 'dirty', createdAt: 6, updatedAt: 6 }));
      enabled = true;
    }

    let scans = 0;
    let injecting = true;
    const originalScan = SessionIndexProjector.prototype.scan;
    const scan = vi.spyOn(SessionIndexProjector.prototype, 'scan').mockImplementation(function (this: SessionIndexProjector, options) {
      const result = originalScan.call(this, options);
      scans += 1;
      if (injecting) mirror.record(summary('churn', { title: `mirror-${scans}`, updatedAt: 100 + scans }));
      return result;
    });
    try {
      const invalidated = mode === 'initial' || mode === 'dirty catchup'
        ? store.prepare()
        : store.reprojectNow();
      await withinDeadline(invalidated.then(() => undefined));
      expect(scans).toBe(2);
      if (mode === 'initial') {
        expect(store.status()).toMatchObject({ state: 'degraded', generation: undefined });
      } else {
        expect(store.status()).toMatchObject({ state: 'ready', generation: 1 });
      }
      if (mode === 'dirty catchup') expect(mirror.dirtyEpoch()).toBeTypeOf('number');
      expect(await store.get('late', workspaceId)).toMatchObject({ title: 'authoritative' });

      injecting = false;
      const beforeRetry = scans;
      await withinDeadline(store.reprojectNow());
      expect(scans - beforeRetry).toBeLessThanOrEqual(2);
      if (mode === 'dirty catchup') {
        const beforeCatchup = scans;
        await withinDeadline(store.prepare());
        expect(scans - beforeCatchup).toBeLessThanOrEqual(2);
      }
      const page = await store.listRecent({ workspaceIds: [workspaceId], includeArchived: true, limit: 20 });
      expect(page.items.map((item) => item.id).toSorted()).toEqual(['changed', 'churn', 'keep', 'late']);
      expect(page.items.find((item) => item.id === 'changed')).toMatchObject({ title: 'after' });
      expect(await store.get('deleted', workspaceId)).toBeUndefined();
      expect(await store.count({ workspaceIds: [workspaceId] })).toBe(4);
      await withinDeadline(mirror.drain());
      expect(mirror.pending()).toEqual([]);
    } finally {
      injecting = false;
      scan.mockRestore();
    }
  }, 10_000);

  it.each(['local', 'peer'] as const)('coalesces reconciliation and discards a plan superseded by a %s mirror write', async (writer) => {
    await seedSession('existing', { title: 'initial', createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();
    const peer = writer === 'peer' ? createScopedTestHost([
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(true)),
    ]) : undefined;
    const writingMirror = peer?.app.accessor.get(ISessionIndexMirror) ?? mirror;
    await seedSession('existing', { title: 'external', createdAt: 1, updatedAt: 3 });
    const entered = deferred<void>();
    const gate = deferred<void>();
    const original = SessionIndexProjector.prototype.planReconcile;
    let plans = 0;
    const obsoleteCommit = vi.fn<() => void>();
    const scan = vi.spyOn(SessionIndexProjector.prototype, 'planReconcile').mockImplementation(async function (this: SessionIndexProjector, ...args) {
      const commit = await original.apply(this, args);
      if (++plans === 1) {
        entered.resolve();
        await gate.promise;
        return async () => {
          obsoleteCommit();
          return commit();
        };
      }
      return commit;
    });
    const reconciliation = store.reconcileNow();
    let queued: Promise<void>[] = [];
    try {
      await entered.promise;
      queued = Array.from({ length: 10 }, () => store.reconcileNow({ reuseFingerprints: true }));
      await seedSession('existing', { title: 'managed', createdAt: 1, updatedAt: 4 });
      writingMirror.record(summary('existing', { title: 'managed', updatedAt: 4 }));
      await writingMirror.drain();
      gate.resolve();
      await Promise.all([reconciliation, ...queued]);
      expect(obsoleteCommit).not.toHaveBeenCalled();
      expect(plans).toBe(2);
      expect(await store.get('existing', workspaceId)).toMatchObject({ title: 'managed', updatedAt: 4 });
      expect(await store.count({ workspaceIds: [workspaceId] })).toBe(1);
    } finally {
      gate.resolve();
      await Promise.all([reconciliation, ...queued]);
      scan.mockRestore();
      await peer?.dispose();
    }
  }, 30_000);

  it.each(['dispose', 'disable'] as const)('abandons an unpublished reconciliation plan after %s', async (stop) => {
    await seedSession('existing', { title: 'published', createdAt: 1, updatedAt: 2 });
    let enabled = true;
    const store = build(undefined, () => enabled);
    await store.prepare();
    await seedSession('existing', { title: 'unpublished', createdAt: 1, updatedAt: 3 });
    const entered = deferred<void>();
    const gate = deferred<void>();
    const original = SessionIndexProjector.prototype.planReconcile;
    const commitCalls = vi.fn<() => void>();
    const scan = vi.spyOn(SessionIndexProjector.prototype, 'planReconcile').mockImplementation(async function (this: SessionIndexProjector, ...args) {
      const commit = await original.apply(this, args);
      entered.resolve();
      await gate.promise;
      return async () => {
        commitCalls();
        return commit();
      };
    });
    const reconciliation = store.reconcileNow().catch((error: unknown) => error);
    try {
      await entered.promise;
      const disposing = stop === 'dispose' ? store.dispose() : undefined;
      if (stop === 'disable') enabled = false;
      gate.resolve();
      await disposing;
      expect(await reconciliation).toMatchObject({
        code: 'session.index_building',
        details: { operation: 'reconcile', reason: stop === 'dispose' ? 'disposed' : 'disabled' },
      });
      expect(commitCalls).not.toHaveBeenCalled();
      expect(await queryStore.get(sessionCollection(1), 'existing')).toMatchObject({ title: 'published' });
    } finally {
      gate.resolve();
      await reconciliation;
      scan.mockRestore();
    }
  });

  it('reconciliation repairs external edits and deletions of state.json', async () => {
    await seedSession('keep', { title: 'before', createdAt: 1, updatedAt: 3 });
    await seedSession('archived', { createdAt: 2, updatedAt: 2 });
    await seedSession('gone', { createdAt: 3, updatedAt: 1 });

    const store = build();
    await store.prepare();
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(3);

    await seedSession('keep', { title: 'after', createdAt: 1, updatedAt: 4 });
    await fsp.rm(join(sessionsDir, workspaceId, 'gone'), { recursive: true, force: true });
    await store.reconcileNow();

    const page = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(page.items.map((s) => s.id)).toEqual(['keep', 'archived']);
    expect(page.items[0]?.title).toBe('after');
    expect(await store.get('gone')).toBeUndefined();
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);
  });

  it('updates both workspace counters across a two-phase session move', async () => {
    const otherId = encodeWorkDirKey('/home/user/other');
    await seedSession('moved', { title: 'old', createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();

    await seedSession('moved', { title: 'new', createdAt: 1, updatedAt: 3 }, otherId);
    await store.reconcileNow();
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(1);
    expect(await store.count({ workspaceIds: [otherId] })).toBe(1);

    await fsp.rm(join(sessionsDir, workspaceId, 'moved'), { recursive: true, force: true });
    await store.reconcileNow();

    expect(await store.get('moved')).toMatchObject({ workspaceId: otherId, title: 'new' });
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(0);
    expect(await store.count({ workspaceIds: [otherId] })).toBe(1);
  });

  it('removes a session whose metadata file is deleted while its directory remains', async () => {
    await seedSession('gone', { title: 'gone', createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();

    await fsp.rm(join(sessionsDir, workspaceId, 'gone', 'session-meta', 'state.json'));
    await store.reconcileNow();

    expect(await store.get('gone')).toBeUndefined();
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(0);
  });

  it('retries metadata read failures without freezing their fingerprint', async () => {
    class FlakyDocs extends JsonAtomicDocumentStore {
      failScope: string | undefined;
      override async get<T>(scope: string, key: string): Promise<T | undefined> {
        if (scope === this.failScope && key === 'state.json') {
          this.failScope = undefined;
          throw new Error('injected metadata read failure');
        }
        return super.get<T>(scope, key);
      }
    }
    await seedSession('retry', { title: 'before', createdAt: 1, updatedAt: 2 });
    const fileStorage = new FileStorageService(homeDir);
    const docs = new FlakyDocs(fileStorage);
    const store = build(fileStorage, true, new AppendLogStore(fileStorage), docs);
    await store.prepare();
    await seedSession('retry', { title: 'after', createdAt: 1, updatedAt: 3 });
    docs.failScope = `sessions/${workspaceId}/retry`;

    await store.reconcileNow();
    expect(await store.get('retry')).toMatchObject({ title: 'before' });

    await store.reconcileNow();
    expect(await store.get('retry')).toMatchObject({ title: 'after' });
  });

  it('aborts reconciliation on enumeration failure without removing published sessions', async () => {
    class FlakyStorage extends FileStorageService {
      failNextWorkspaceList = false;
      override async list(scope: string, prefix?: string): Promise<readonly string[]> {
        if (this.failNextWorkspaceList && scope === `sessions/${workspaceId}`) {
          this.failNextWorkspaceList = false;
          throw new Error('injected enumeration failure');
        }
        return super.list(scope, prefix);
      }
    }
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 3 });
    const fileStorage = new FlakyStorage(homeDir);
    const store = build(fileStorage);
    await store.prepare();
    fileStorage.failNextWorkspaceList = true;

    await expect(store.reconcileNow()).rejects.toThrow('injected enumeration failure');

    expect((await store.listRecent({ workspaceIds: [workspaceId] })).items.map((item) => item.id)).toEqual([
      'b',
      'a',
    ]);
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);
  });

  it('reconciles an unchanged tree without reading metadata or enumerating index keys', async () => {
    class CountingDocs extends JsonAtomicDocumentStore {
      gets = 0;
      override async get<T>(scope: string, key: string): Promise<T | undefined> {
        this.gets += 1;
        return super.get<T>(scope, key);
      }
    }
    overrideScopedService(
      LifecycleScope.App,
      IQueryStore,
      CountingQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 3 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 2 });
    const fileStorage = new FileStorageService(homeDir);
    const docs = new CountingDocs(fileStorage);
    const store = build(fileStorage, true, new AppendLogStore(fileStorage), docs);
    await store.prepare();
    const countingStore = queryStore as CountingQueryStore;
    countingStore.resetCounts();
    docs.gets = 0;

    await store.reconcileNow();

    const counts = countingStore.snapshotCounts();
    expect(docs.gets).toBe(0);
    expect(Object.keys(counts).some((key) => key.startsWith('listKeys:'))).toBe(false);
    expect(counts[`getMany:${sessionCollection(1)}`]).toBeUndefined();
  });

  it('reuses periodic fingerprints but forced reconciliation still repairs external drift', async () => {
    class CountingStorage extends FileStorageService {
      stats = 0;
      override async mtime(scope: string, key: string): Promise<number | undefined> {
        this.stats += 1;
        return super.mtime(scope, key);
      }
      override async size(scope: string, key: string): Promise<number | undefined> {
        this.stats += 1;
        return super.size(scope, key);
      }
    }
    await seedSession('a', { title: 'before', createdAt: 1, updatedAt: 2 });
    const storage = new CountingStorage(homeDir);
    const store = build(storage);
    await store.prepare();
    await store.reconcileNow({ reuseFingerprints: true });
    storage.stats = 0;
    await store.reconcileNow({ reuseFingerprints: true });
    expect(storage.stats).toBe(1);

    await seedSession('a', { title: 'after', createdAt: 1, updatedAt: 3 });
    await store.reconcileNow();
    expect((await store.get('a'))?.title).toBe('after');
    storage.stats = 0;
    await store.reconcileNow({ reuseFingerprints: true });
    expect(storage.stats).toBe(1);

    await seedSession('a', { title: 'later', createdAt: 1, updatedAt: 4 });
    const future = Date.now() + 31 * 60_000;
    const date = vi.spyOn(Date, 'now').mockReturnValue(future);
    try {
      storage.stats = 0;
      await store.reconcileNow({ reuseFingerprints: true });
      expect(storage.stats).toBe(5);
      expect((await store.get('a'))?.title).toBe('later');
    } finally {
      date.mockRestore();
    }
  });

  it('drains more than one watched-session batch without re-enumerating the inventory', async () => {
    await Promise.all(Array.from({ length: 36 }, (_, index) => seedSession(`s${index}`, { createdAt: 1, updatedAt: 1, title: 'initial' })));
    const storage = new CountingStorage(homeDir);
    const store = build(storage);
    await store.prepare();
    storage.listCalls = 0;
    const plans = vi.spyOn(SessionIndexProjector.prototype, 'planReconcile');
    try {
      for (let index = 0; index < 37; index++) {
        await seedSession(`s${index}`, { createdAt: 1, updatedAt: 2, title: 'changed' });
        sourceChanges.fire({ path: join(sessionsDir, workspaceId, `s${index}`, 'session-meta', 'state.json'), action: 'modified', kind: 'file' });
      }
      await vi.waitFor(async () => { expect((await queryStore.get<SessionSummary>(sessionCollection(1), 's36'))?.title).toBe('changed'); }, { timeout: 6000 });
      expect(plans.mock.calls.map(([, options]) => options?.changedSessions?.length)).toEqual([16, 16, 5]);
      expect(storage.listCalls).toBe(0);
      expect(await store.count({ workspaceIds: [workspaceId] })).toBe(37);
    } finally {
      plans.mockRestore();
    }
  }, 15_000);

  it.each([1, 463])('bounds watched metadata for %s agents, survives unrelated mirror writes and suspends reads while disabled', async (agentCount) => {
    const agents = Object.fromEntries(Array.from({ length: agentCount }, (_, index) => [`agent-${index}`, { status: 'completed', resultSummary: 'x'.repeat(2048) }]));
    await seedSession('active', { createdAt: 1, updatedAt: 1, agents });
    await seedSession('other', { createdAt: 1, updatedAt: 1 });
    let enabled = true;
    const storage = new CountingStorage(homeDir);
    const docs = new JsonAtomicDocumentStore(storage);
    const store = build(storage, () => enabled, new AppendLogStore(storage), docs);
    await store.prepare();
    await store.reconcileNow();
    storage.listCalls = 0;
    const reads = vi.spyOn(docs, 'get');
    const writes = vi.spyOn(queryStore, 'batch');
    const original = SessionIndexProjector.prototype.planReconcile;
    const plans = vi.spyOn(SessionIndexProjector.prototype, 'planReconcile').mockImplementation(async function (this: SessionIndexProjector, ...args) {
      const commit = await original.apply(this, args);
      if (args[1]?.changedSessions !== undefined) mirror.record(summary('other', { title: 'managed update', updatedAt: 9 }));
      return commit;
    });
    const emit = () => { sourceChanges.fire({ path: join(sessionsDir, workspaceId, 'active', 'session-meta', 'state.json'), action: 'modified', kind: 'file' }); };
    const cpu = process.cpuUsage();
    const heaps: number[] = [];
    try {
      for (let round = 0; round < 3; round++) {
        await seedSession('active', { createdAt: 1, updatedAt: round + 2, title: `updated-${round}`, agents });
        for (let event = 0; event < 100; event++) emit();
        await vi.waitFor(async () => { expect((await store.get('active'))?.title).toBe(`updated-${round}`); }, { timeout: 5000 });
        heaps.push(process.memoryUsage().heapUsed);
      }
      await mirror.drain();
      expect(await queryStore.listKeys(sessionCollection(1))).toHaveLength(2);
      const row = await queryStore.get<SessionSummary>(sessionCollection(1), 'active');
      expect(row).not.toHaveProperty('agents');
      expect(storage.listCalls).toBe(0);
      const serializedWrites = writes.mock.calls.reduce((bytes, [ops]) => bytes + Buffer.byteLength(JSON.stringify(ops)), 0);
      console.log(JSON.stringify({ scenario: 'agent-metadata-scale', agentCount, metadataBytes: Buffer.byteLength(JSON.stringify(agents)), metadataReads: reads.mock.calls.length, plans: plans.mock.calls.length, writeBytes: serializedWrites, rowBytes: Buffer.byteLength(JSON.stringify(row)), cpu: process.cpuUsage(cpu), heapUsed: heaps }));
      enabled = false;
      reads.mockClear();
      plans.mockClear();
      writes.mockClear();
      await seedSession('active', { createdAt: 1, updatedAt: 10, title: 'disabled update', agents });
      for (let event = 0; event < 100; event++) emit();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(reads).not.toHaveBeenCalled();
      expect(plans).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      enabled = true;
      await store.listRecent({ limit: 2 });
      await vi.waitFor(async () => { expect((await store.get('active'))?.title).toBe('disabled update'); }, { timeout: 5000 });
    } finally {
      enabled = true;
      reads.mockRestore();
      writes.mockRestore();
      plans.mockRestore();
    }
  }, 30_000);

  it('coalesces sustained metadata watches into bounded changed-session work without inventory scans', async () => {
    await Promise.all(Array.from({ length: 100 }, (_, index) => seedSession(`s${index}`, { createdAt: 1, updatedAt: 1, title: 'initial' })));
    const storage = new CountingStorage(homeDir);
    const docs = new JsonAtomicDocumentStore(storage);
    const store = build(storage, true, new AppendLogStore(storage), docs);
    await store.prepare();
    await store.reconcileNow({ reuseFingerprints: true });
    storage.listCalls = 0;
    const reads = vi.spyOn(docs, 'get');
    const plans = vi.spyOn(SessionIndexProjector.prototype, 'planReconcile');
    const heaps: number[] = [];
    try {
      for (let round = 0; round < 4; round++) {
        for (let index = 0; index < 3; index++) {
          await seedSession(`s${index}`, { createdAt: 1, updatedAt: round + 2, title: `round-${round}` });
          sourceChanges.fire({ path: join(sessionsDir, workspaceId, `s${index}`, 'session-meta', 'state.json'), action: 'modified', kind: 'file' });
        }
        await vi.waitFor(async () => {
          expect((await store.get('s0'))?.title).toBe(`round-${round}`);
        }, { timeout: 5000 });
        heaps.push(process.memoryUsage().heapUsed);
      }
      expect(storage.listCalls).toBe(0);
      expect(plans.mock.calls.filter(([, options]) => options?.changedSessions === undefined)).toHaveLength(0);
      expect(plans.mock.calls.length).toBeLessThanOrEqual(4);
      expect(reads.mock.calls.length).toBeLessThanOrEqual(24);
      expect((await store.get('s2'))?.title).toBe('round-3');
      console.log(JSON.stringify({ scenario: 'metadata-watch-storm', plans: plans.mock.calls.length, inventoryReads: storage.listCalls, metadataReads: reads.mock.calls.length, heapUsed: heaps }));
      reads.mockClear();
      const writes = vi.spyOn(queryStore, 'batch');
      try {
        for (let index = 0; index < 100; index++) sourceChanges.fire({ path: join(sessionsDir, workspaceId, 's0', 'session-meta', 'state.json'), action: 'modified', kind: 'file' });
        await vi.waitFor(() => { expect(plans).toHaveBeenCalledTimes(5); }, { timeout: 5000 });
        await store.count({ workspaceIds: [workspaceId] });
        expect(reads).not.toHaveBeenCalled();
        expect(writes).not.toHaveBeenCalled();
      } finally {
        writes.mockRestore();
      }
    } finally {
      reads.mockRestore();
      plans.mockRestore();
    }
  }, 30_000);

  it('does not starve watched metadata under events arriving faster than the debounce', async () => {
    await seedSession('active', { createdAt: 1, updatedAt: 1, title: 'before' });
    const store = build();
    await store.prepare();
    await seedSession('active', { createdAt: 1, updatedAt: 2, title: 'during-storm' });
    const emit = () => { sourceChanges.fire({ path: join(sessionsDir, workspaceId, 'active', 'session-meta', 'state.json'), action: 'modified', kind: 'file' }); };
    sourceChanges.fire({ path: sessionsDir, action: 'modified', kind: 'directory' });
    const events = setInterval(emit, 25);
    emit();
    try {
      await vi.waitFor(async () => {
        expect((await store.get('active'))?.title).toBe('during-storm');
      }, { timeout: 2500 });
    } finally {
      clearInterval(events);
    }
  });

  it('reconciles a watched metadata edit and session deletion without statting unchanged sessions', async () => {
    class CountingStorage extends FileStorageService {
      stats = 0;
      override async mtime(scope: string, key: string): Promise<number | undefined> {
        this.stats += 1;
        return super.mtime(scope, key);
      }
      override async size(scope: string, key: string): Promise<number | undefined> {
        this.stats += 1;
        return super.size(scope, key);
      }
    }
    await seedSession('a', { title: 'before', createdAt: 1, updatedAt: 2 });
    await seedSession('b', { title: 'unchanged', createdAt: 1, updatedAt: 1 });
    const storage = new CountingStorage(homeDir);
    const store = build(storage);
    await store.prepare();
    expect(indexWatchOptions?.ignored?.(join(sessionsDir, workspaceId, 'a', 'agents'))).toBe(true);
    expect(indexWatchOptions?.ignored?.(join(sessionsDir, workspaceId, 'a', 'session-meta'))).toBe(false);
    await store.reconcileNow({ reuseFingerprints: true });
    storage.stats = 0;
    await seedSession('a', { title: 'after', createdAt: 1, updatedAt: 3 });
    sourceChanges.fire({
      path: join(sessionsDir, workspaceId, 'a', 'session-meta', 'state.json'),
      action: 'modified', kind: 'file',
    });
    await vi.waitFor(async () => {
      expect((await store.get('a'))?.title).toBe('after');
    }, { timeout: 5000 });
    expect(storage.stats).toBe(5);

    await fsp.rm(join(sessionsDir, workspaceId, 'b'), { recursive: true, force: true });
    sourceChanges.fire({
      path: join(sessionsDir, workspaceId, 'b'), action: 'deleted', kind: 'directory',
    });
    await vi.waitFor(async () => {
      expect(await store.count({ workspaceIds: [workspaceId] })).toBe(1);
    }, { timeout: 5000 });
  });

  it('returns building before a gated first projection without request-path source reads', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 3 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 2 });
    await seedSession('c', { title: 'c', createdAt: 3, updatedAt: 1 });

    class GatedQueryStore extends MiniDbQueryStore {
      checkpointReads = 0;
      private releaseGate: (() => void) | undefined;
      private markPrepareEntered: (() => void) | undefined;
      readonly prepareEntered = new Promise<void>((resolve) => {
        this.markPrepareEntered = resolve;
      });
      private readonly gate = new Promise<void>((resolve) => {
        this.releaseGate = resolve;
      });
      release(): void {
        this.releaseGate?.();
      }
      override async getCheckpoint(source: string): Promise<Checkpoint | undefined> {
        if (source === SESSION_INDEX_MANIFEST) {
          this.checkpointReads += 1;
          if (this.checkpointReads === 2) {
            this.markPrepareEntered?.();
            await this.gate;
          }
        }
        return super.getCheckpoint(source);
      }
    }
    overrideScopedService(
      LifecycleScope.App,
      IQueryStore,
      GatedQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    const fileStorage = new CountingStorage(homeDir);
    const appendLog = new CountingAppendLogStore(fileStorage);
    const store = build(fileStorage, true, appendLog);
    const gated = queryStore as GatedQueryStore;

    await expect(
      store.listRecent({ workspaceIds: [workspaceId], limit: 100 }),
    ).rejects.toBeInstanceOf(SessionIndexBuildingError);
    await gated.prepareEntered;
    expect(fileStorage.listCalls).toBe(0);
    expect(appendLog.readCalls).toBe(0);

    gated.release();
    const status = await store.prepare();
    expect(status).toEqual({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 });
    expect((await store.listRecent({ workspaceIds: [workspaceId] })).items.map((s) => s.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('keeps workspace-bounded point reads available while list and count report building', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 3 });

    class GatedQueryStore extends MiniDbQueryStore {
      private gate: Promise<void> | undefined;
      private openGate: (() => void) | undefined;
      private notifyEntered: (() => void) | undefined;
      entered: Promise<void> = Promise.resolve();
      hold(): void {
        this.entered = new Promise((resolve) => {
          this.notifyEntered = resolve;
        });
        this.gate = new Promise((resolve) => {
          this.openGate = resolve;
        });
      }
      release(): void {
        this.openGate?.();
        this.gate = undefined;
      }
      override async batch(ops: readonly WriteOp[]): Promise<void> {
        this.notifyEntered?.();
        await this.gate;
        return super.batch(ops);
      }
    }
    overrideScopedService(
      LifecycleScope.App,
      IQueryStore,
      GatedQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    const fileStorage = new CountingStorage(homeDir);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IAppendLogStore, new AppendLogStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(true)),
    ]);
    disposeHost = () => {
      return host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    const store = host.app.accessor.get(ISessionIndex) as FileSessionIndex;

    (queryStore as GatedQueryStore).hold();
    const preparing = store.prepare();
    expect(store.status().state).toBe('preparing');

    await expect(store.listRecent({ workspaceIds: [workspaceId] })).rejects.toBeInstanceOf(
      SessionIndexBuildingError,
    );
    await expect(store.count({ workspaceIds: [workspaceId] })).rejects.toBeInstanceOf(
      SessionIndexBuildingError,
    );
    await (queryStore as GatedQueryStore).entered;
    fileStorage.listCalls = 0;
    expect((await store.get('b', workspaceId))?.title).toBe('b');
    expect(fileStorage.listCalls).toBe(0);
    expect(store.status().state).toBe('preparing');

    (queryStore as GatedQueryStore).release();
    const status = await preparing;
    expect(status).toEqual({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 });
    const warm = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(warm.items.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('reports building during projection and folds queued mirror writes after publish', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 3 });

    class GatedDocs extends JsonAtomicDocumentStore {
      private gate: Promise<void> | undefined;
      private openGate: (() => void) | undefined;
      private markFirstGet: (() => void) | undefined;
      readonly firstGet = new Promise<void>((resolve) => {
        this.markFirstGet = resolve;
      });
      hold(): void {
        this.gate = new Promise((resolve) => {
          this.openGate = resolve;
        });
      }
      release(): void {
        this.openGate?.();
      }
      override async get<T>(scope: string, key: string): Promise<T | undefined> {
        this.markFirstGet?.();
        await this.gate;
        return super.get<T>(scope, key);
      }
    }
    const fileStorage = new FileStorageService(homeDir);
    const docs = new GatedDocs(fileStorage);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, docs),
      stubPair(IAppendLogStore, new AppendLogStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(true)),
    ]);
    disposeHost = () => {
      return host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    const store = host.app.accessor.get(ISessionIndex) as FileSessionIndex;

    docs.hold();
    await expect(store.listRecent({ workspaceIds: [workspaceId] })).rejects.toBeInstanceOf(
      SessionIndexBuildingError,
    );
    await docs.firstGet;

    await seedSession('c', { title: 'c', createdAt: 3, updatedAt: 4 });
    mirror.record(summary('c', { title: 'c', createdAt: 3, updatedAt: 4 }));
    mirror.record(summary('a', { archived: true, updatedAt: 5 }));

    await expect(store.listRecent({ workspaceIds: [workspaceId] })).rejects.toBeInstanceOf(
      SessionIndexBuildingError,
    );
    docs.release();

    const status = await store.prepare();
    expect(status.state).toBe('ready');
    await mirror.drain();
    const warm = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(warm.items.map((s) => s.id)).toEqual(['c', 'b']);
    const all = await store.listRecent({ workspaceIds: [workspaceId], includeArchived: true });
    expect(all.items.map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });

  it('counts the published generation and bounded pending entries during a gated scan', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });

    class GatedDocs extends JsonAtomicDocumentStore {
      private gate: Promise<void> | undefined;
      private releaseGate: (() => void) | undefined;
      private notifyEntered: (() => void) | undefined;
      entered: Promise<void> = Promise.resolve();

      holdNextGet(): void {
        this.entered = new Promise<void>((resolve) => {
          this.notifyEntered = resolve;
        });
        this.gate = new Promise<void>((resolve) => {
          this.releaseGate = resolve;
        });
      }

      release(): void {
        this.releaseGate?.();
      }

      override async get<T>(scope: string, key: string): Promise<T | undefined> {
        const gate = this.gate;
        if (gate !== undefined) {
          this.gate = undefined;
          this.notifyEntered?.();
          await gate;
        }
        return super.get<T>(scope, key);
      }
    }

    const fileStorage = new FileStorageService(homeDir);
    const docs = new GatedDocs(fileStorage);
    const store = build(
      fileStorage,
      true,
      new AppendLogStore(fileStorage),
      docs,
    );
    await store.prepare();
    docs.holdNextGet();
    const reprojecting = store.reprojectNow();
    await docs.entered;

    await seedSession('c', { title: 'latest', createdAt: 3, updatedAt: 5 });
    mirror.record(summary('c', { title: 'first', createdAt: 3, updatedAt: 4 }));
    mirror.record(summary('c', { title: 'latest', createdAt: 3, updatedAt: 5 }));
    let settled = false;
    let counted: number | undefined;
    const counting = store.count({ workspaceIds: [workspaceId] }).then((value) => {
      counted = value;
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(counted).toBe(2);
      await mirror.drain();
      expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);
    } finally {
      docs.release();
      await Promise.all([counting, reprojecting]);
    }

    await mirror.drain();
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);
    expect((await store.listRecent({ workspaceIds: [workspaceId] })).items).toMatchObject([
      { id: 'c', title: 'latest' },
      { id: 'a', title: 'a' },
    ]);
  });

  it.each(['reprojectNow', 'reconcileNow'] as const)('discards an old scan after a peer %s publishes deletion and addition with unchanged max mtime', async (publish) => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 3 });
    const time = new Date('2025-01-01T00:00:00Z');
    for (const id of ['a', 'b']) await fsp.utimes(join(sessionsDir, workspaceId, id, 'session-meta', 'state.json'), time, time);
    const first = build();
    await first.prepare();
    const peerQuery = new MiniDbQueryStore(stubBootstrap(homeDir), stubLog());
    const peerMirror = new SessionIndexMirror(peerQuery, stubFlag(true), stubLog());
    const storage = new FileStorageService(homeDir);
    const peer = new FileSessionIndex(stubBootstrap(homeDir), storage, new JsonAtomicDocumentStore(storage), peerQuery, stubFlag(true), peerMirror, stubLog(), new TestSessionIndexWatch());
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const captured = new Promise<void>((resolve) => { entered = resolve; });
    const exclusive = mirror.runExclusive.bind(mirror);
    let sections = 0;
    const hold = vi.spyOn(mirror, 'runExclusive').mockImplementation(async (operation) => {
      sections += 1;
      if (sections === 2) {
        entered();
        await gate;
      }
      return exclusive(operation);
    });
    const stale = first.reprojectNow();
    await captured;
    try {
      await fsp.rm(join(sessionsDir, workspaceId, 'a'), { recursive: true });
      await seedSession('c', { title: 'c', createdAt: 3, updatedAt: 4 });
      await fsp.utimes(join(sessionsDir, workspaceId, 'c', 'session-meta', 'state.json'), time, time);
      await peer[publish]();
      release();
      await stale;
      expect((await first.listRecent({})).items.map((item) => item.id)).toEqual(['c', 'b']);
      expect(await first.count({})).toBe(2);
    } finally {
      release();
      await stale;
      hold.mockRestore();
      await peer.dispose();
      await peerMirror.dispose();
      await peerQuery.close();
    }
  }, 60_000);

  it('prepare serves a published generation without waiting for source stats', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    const first = build();
    await first.prepare();
    const storage = new FileStorageService(homeDir);
    const stats = vi.spyOn(storage, 'mtime');
    const second = new FileSessionIndex(stubBootstrap(homeDir), storage, new JsonAtomicDocumentStore(storage), queryStore, stubFlag(true), mirror, stubLog(), new TestSessionIndexWatch());
    try {
      expect((await second.prepare()).state).toBe('ready');
      expect(stats).not.toHaveBeenCalled();
    } finally {
      await second.dispose();
    }
  });

  it('serves an existing published generation immediately on restart', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 3 });
    const first = build();
    await first.prepare();

    await disposeHost?.();
    disposeHost = undefined;
    await drainSessionIndexMirror();
    await drainQueryStoreDisposals();

    class CountingDocs extends JsonAtomicDocumentStore {
      gets = 0;
      override async get<T>(scope: string, key: string): Promise<T | undefined> {
        this.gets += 1;
        return super.get<T>(scope, key);
      }
    }
    const fileStorage = new FileStorageService(homeDir);
    const docs = new CountingDocs(fileStorage);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, docs),
      stubPair(IAppendLogStore, new AppendLogStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(true)),
    ]);
    disposeHost = () => {
      return host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    const second = host.app.accessor.get(ISessionIndex) as FileSessionIndex;

    const page = await second.listRecent({ workspaceIds: [workspaceId] });
    expect(page.items.map((s) => s.id)).toEqual(['b', 'a']);
    expect(second.status()).toEqual({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 });
    expect(docs.gets).toBe(0);
  });

  it('status() walks the read-model lifecycle and stays diagnosable through degradation', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });

    class GatedFlakyQueryStore extends MiniDbQueryStore {
      private gate: Promise<void> | undefined;
      private openGate: (() => void) | undefined;
      failNextBatch = false;
      hold(): void {
        this.gate = new Promise((resolve) => {
          this.openGate = resolve;
        });
      }
      release(): void {
        this.openGate?.();
        this.gate = undefined;
      }
      override async getCheckpoint(source: string): Promise<Checkpoint | undefined> {
        await this.gate;
        return super.getCheckpoint(source);
      }
      override async batch(ops: readonly WriteOp[]): Promise<void> {
        if (this.failNextBatch) {
          this.failNextBatch = false;
          throw new Error('injected projection crash');
        }
        return super.batch(ops);
      }
    }
    overrideScopedService(
      LifecycleScope.App,
      IQueryStore,
      GatedFlakyQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    const fileStorage = new FileStorageService(homeDir);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IAppendLogStore, new AppendLogStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(true)),
    ]);
    disposeHost = () => {
      return host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    const store = host.app.accessor.get(ISessionIndex) as FileSessionIndex;
    const gated = queryStore as GatedFlakyQueryStore;

    expect(store.status()).toEqual({ source: 'read-model', state: 'uninitialized', degradedCount: 0 });
    gated.hold();
    const preparing = store.prepare();
    expect(store.status()).toEqual({ source: 'read-model', state: 'preparing', degradedCount: 0 });
    gated.release();
    expect(await preparing).toEqual({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 });

    gated.failNextBatch = true;
    await store.reprojectNow();
    expect(store.status()).toEqual({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 });

    await disposeHost?.();
    disposeHost = undefined;
    await drainSessionIndexMirror();
    await drainQueryStoreDisposals();
    await fsp.rm(join(homeDir, 'cache', MINIDB_QUERY_STORE_SUBDIR), { recursive: true, force: true });

    const second = build();
    (queryStore as GatedFlakyQueryStore).failNextBatch = true;
    const degraded = await second.prepare();
    expect(degraded.state).toBe('degraded');
    expect(degraded.reason).toBe('projection failed');
    expect(degraded.degradedCount).toBe(1);
    await expect(second.listRecent({ workspaceIds: [workspaceId] })).rejects.toBeInstanceOf(
      SessionIndexBuildingError,
    );
    expect(await second.prepare()).toEqual({
      source: 'read-model',
      state: 'ready',
      generation: 1,
      degradedCount: 1,
    });
  });

  it('a restart loads the published generation instead of re-scanning', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 3 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 2 });
    await seedSession('c', { title: 'c', createdAt: 3, updatedAt: 1 });

    const first = build();
    await first.prepare();
    expect(first.status()).toEqual({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 });
    const published = await queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
    expect(published).toMatchObject({ seq: 1, sourceMaxMtimeMs: expect.any(Number) });
    await disposeHost?.();
    disposeHost = undefined;
    await drainSessionIndexMirror();
    await drainQueryStoreDisposals();

    class CountingDocs extends JsonAtomicDocumentStore {
      gets = 0;
      override async get<T>(scope: string, key: string): Promise<T | undefined> {
        this.gets += 1;
        return super.get<T>(scope, key);
      }
    }
    const fileStorage = new FileStorageService(homeDir);
    const docs = new CountingDocs(fileStorage);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, docs),
      stubPair(IAppendLogStore, new AppendLogStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(true)),
    ]);
    disposeHost = () => {
      return host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    const second = host.app.accessor.get(ISessionIndex) as FileSessionIndex;

    const status = await second.prepare();
    expect(status).toEqual({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 });
    expect(docs.gets).toBe(0);
    const warm = await second.listRecent({ workspaceIds: [workspaceId] });
    expect(warm.items.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(docs.gets).toBe(0);
  });

  it('serves the published generation before background startup reconciliation repairs external changes', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 3 });

    const first = build();
    await first.prepare();
    expect(first.status()).toEqual({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 });
    await disposeHost?.();
    disposeHost = undefined;
    await drainSessionIndexMirror();
    await drainQueryStoreDisposals();

    await seedSession('c', { title: 'c', createdAt: 3, updatedAt: 4 });
    const future = new Date(Date.now() + 60_000);
    await fsp.utimes(
      join(sessionsDir, workspaceId, 'c', 'session-meta', 'state.json'),
      future,
      future,
    );

    const second = build();
    const status = await second.prepare();
    expect(status).toEqual({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 });
    await vi.waitFor(async () => {
      const page = await second.listRecent({ workspaceIds: [workspaceId] });
      expect(page.items.map((s) => s.id)).toEqual(['c', 'b', 'a']);
    });
  });

  it('serves an older published checkpoint and repairs its source watermark in the background', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });

    const first = build();
    await first.prepare();
    await queryStore.setCheckpoint(SESSION_INDEX_MANIFEST, { seq: 1 });
    await disposeHost?.();
    disposeHost = undefined;
    await drainSessionIndexMirror();
    await drainQueryStoreDisposals();

    const second = build();
    const status = await second.prepare();
    expect(status).toEqual({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 });
    const page = await second.listRecent({ workspaceIds: [workspaceId] });
    expect(page.items.map((s) => s.id)).toEqual(['a']);
    await vi.waitFor(async () => {
      expect((await queryStore.getCheckpoint(SESSION_INDEX_MANIFEST))?.sourceMaxMtimeMs).toBeGreaterThan(0);
    });
  });

  it('reconciliation refreshes the published source max mtime', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });

    const store = build();
    await store.prepare();
    const published = await queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
    expect(published).toMatchObject({ seq: 1, sourceMaxMtimeMs: expect.any(Number) });

    await seedSession('a', { title: 'a2', createdAt: 1, updatedAt: 5 });
    const future = new Date((published?.sourceMaxMtimeMs ?? 0) + 60_000);
    await fsp.utimes(
      join(sessionsDir, workspaceId, 'a', 'session-meta', 'state.json'),
      future,
      future,
    );

    await store.reconcileNow();
    const refreshed = await queryStore.getCheckpoint(SESSION_INDEX_MANIFEST);
    expect(refreshed?.seq).toBe(1);
    expect(refreshed?.sourceMaxMtimeMs).toBeGreaterThan(published?.sourceMaxMtimeMs ?? 0);
    expect((await store.get('a'))?.title).toBe('a2');
  });

  it('the resume-startup sequence pays one scan: point lookup, projection, then warm lists', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 3 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 2 });
    await seedSession('c', { title: 'c', createdAt: 3, updatedAt: 1 });

    class CountingDocs extends JsonAtomicDocumentStore {
      gets = 0;
      override async get<T>(scope: string, key: string): Promise<T | undefined> {
        this.gets += 1;
        return super.get<T>(scope, key);
      }
    }
    const fileStorage = new FileStorageService(homeDir);
    const docs = new CountingDocs(fileStorage);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, docs),
      stubPair(IAppendLogStore, new AppendLogStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(true)),
    ]);
    disposeHost = () => {
      return host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    const store = host.app.accessor.get(ISessionIndex) as FileSessionIndex;

    expect((await store.get('b'))?.title).toBe('b');
    expect(await store.prepare()).toEqual({ source: 'read-model', state: 'ready', generation: 1, degradedCount: 0 });
    expect(docs.gets).toBe(8);

    const page = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(page.items.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(docs.gets).toBe(8);
  });

  it('the session query-store carries no full-text index artifacts', async () => {
    await seedSession('a', { title: 'alpha', createdAt: 1, updatedAt: 2 });
    await seedSession('b', { title: 'beta', createdAt: 2, updatedAt: 3 });

    const store = build();
    await store.prepare();
    await seedSession('c', { title: 'gamma', createdAt: 3, updatedAt: 4 });
    mirror.record(summary('c', { title: 'gamma', createdAt: 3, updatedAt: 4 }));
    await mirror.drain();
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(3);

    const storeDir = join(homeDir, 'cache', MINIDB_QUERY_STORE_SUBDIR);
    const entries = await fsp.readdir(storeDir, { recursive: true, withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((name) => name === 'db.textindexes.json')).toEqual([]);
    expect(files.filter((name) => /^db\.text-.*\.postings$/.test(name))).toEqual([]);
    expect(files.filter((name) => /^text-.*\.(dictionary|postings|docs)$/.test(name))).toEqual([]);
  });

  it('materializes at most one write chunk at a time during a 50k-session initial projection', async () => {
    let materialized = 0;
    const summaries = Array.from({ length: 50_000 }, (_, id) => ({
      ...summary(`s${id}`),
      get title() { materialized += 1; return 'saved title'; },
    }));
    const baselineHeap = process.memoryUsage().heapUsed;
    let peakHeap = baselineHeap;
    let firstChunkMaterialized: number | undefined;
    let maxBatch = 0;
    let written = 0;
    const store = stubQueryStore();
    store.batch = async (ops) => {
      firstChunkMaterialized ??= materialized;
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      maxBatch = Math.max(maxBatch, ops.length);
      written += ops.length;
    };
    const storage = new FileStorageService(homeDir);
    const projector = new SessionIndexProjector({ storage, docs: new JsonAtomicDocumentStore(storage), queryStore: store, log: stubLog(), sessionsScope: 'sessions' });
    await projector.project(1, { summaries, counts: new Map(), fingerprints: new Map(), workspaceSources: new Map(), sourceMaxMtimeMs: 0 });
    console.log('[projection-memory]', JSON.stringify({ sessions: summaries.length, firstChunkMaterialized, maxBatch, heapGrowthMiB: (peakHeap - baselineHeap) / (1 << 20) }));
    expect(firstChunkMaterialized).toBe(500);
    expect(maxBatch).toBe(500);
    expect(written).toBe(50_001);
  });

  const baseline = { retry: 1, timeout: 120_000 };

  it('baseline: warm listRecent(limit=20) at 1k vs 10k vs 50k sessions', baseline, async () => {
    overrideScopedService(
      LifecycleScope.App,
      IQueryStore,
      CountingQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    const fileStorage = new CountingStorage(homeDir);
    const store = build(fileStorage);
    const countingStore = queryStore as CountingQueryStore;
    await seedSession('seed', { createdAt: 0, updatedAt: 0 });
    await store.prepare();
    store.stopReconcileLoop();
    const collection = sessionCollection(1);

    const seedRows = async (from: number, to: number): Promise<void> => {
      for (let start = from; start < to; start += 500) {
        const ops = [];
        for (let i = start; i < Math.min(start + 500, to); i++) {
          ops.push({
            kind: 'put' as const,
            collection,
            key: `s${i}`,
            value: {
              ...summary(`s${i}`, { title: `session ${i}`, createdAt: i, updatedAt: i + 1 }),
              [recencyColumn(1)]: i + 1,
            },
            columns: { [recencyColumn(1)]: i + 1 },
          });
        }
        await queryStore.batch(ops);
      }
    };
    const median = async (run: () => Promise<unknown>, repeats = 5): Promise<number> => {
      const runs: number[] = [];
      for (let r = 0; r < repeats; r++) {
        const t0 = performance.now();
        await run();
        runs.push(performance.now() - t0);
      }
      runs.sort((a, b) => a - b);
      return runs[(runs.length / 2) | 0]!;
    };

    const LIST_LIMIT = 20;
    const listPage = async () => {
      const page = await store.listRecent({ workspaceIds: [workspaceId], limit: LIST_LIMIT });
      expect(page.items).toHaveLength(LIST_LIMIT);
    };
    const getOne = () => store.get('s0');
    const countAll = () => store.count({ workspaceIds: [workspaceId] });

    const measure = async () => {
      const countOp = async (op: () => Promise<unknown>) => {
        countingStore.resetCounts();
        const listed = fileStorage.listCalls;
        await op();
        return { counts: countingStore.snapshotCounts(), fsLists: fileStorage.listCalls - listed };
      };
      const ops = {
        list: await countOp(listPage),
        get: await countOp(getOne),
        count: await countOp(countAll),
      };
      const list = await median(listPage);
      const get = await median(getOne);
      const count = await median(countAll);
      return { ops, list, get, count };
    };

    await seedRows(0, 1_000);
    const at1k = await measure();
    await seedRows(1_000, 10_000);
    const at10k = await measure();
    await seedRows(10_000, 50_000);
    const at50k = await measure();
    console.log(
      `[baseline] sessionIndex read-model ${JSON.stringify({ sessions: [1000, 10000, 50000], list: [at1k.list, at10k.list, at50k.list], get: [at1k.get, at10k.get, at50k.get], count: [at1k.count, at10k.count, at50k.count] })}`,
    );

    const sessionOps = (counts: Record<string, OpCounts>): string[] =>
      Object.keys(counts).filter((key) => key.endsWith(`:${collection}`));
    const sessionRows = (counts: Record<string, OpCounts>): number =>
      sessionOps(counts).reduce((total, key) => total + counts[key]!.rows, 0);

    for (const measured of [at1k, at10k, at50k]) {
      for (const op of Object.values(measured.ops)) expect(op.fsLists).toBe(0);
      expect(sessionOps(measured.ops.list.counts)).toEqual([`pageByColumn:${collection}`]);
      expect(sessionRows(measured.ops.list.counts)).toBeLessThanOrEqual(2 * (LIST_LIMIT + 1));
      expect(measured.ops.get.counts[`get:${collection}`]).toEqual({ calls: 1, rows: 1 });
      expect(sessionOps(measured.ops.get.counts)).toEqual([`get:${collection}`]);
      expect(sessionOps(measured.ops.count.counts)).toEqual([]);
    }
    expect(at10k.ops).toEqual(at1k.ops);
    expect(at50k.ops).toEqual(at1k.ops);
  });
});
