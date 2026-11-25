import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import {
  CHILD_SESSION_KIND,
  CHILD_SESSION_KIND_KEY,
  CREATED_BY_SESSION_ID_KEY,
  ISessionIndex,
  ISessionIndexMirror,
  PARENT_SESSION_ID_KEY,
  SESSION_GROUP_DETACHED_KEY,
  SESSION_GROUP_GENERATION_KEY,
  SESSION_GROUP_ID_KEY,
  SESSION_GROUP_ORIGIN_KEY,
  type SessionSummary,
} from '#/app/sessionIndex/sessionIndex';
import {
  preserveReservedSessionGroupKeys,
  resolveSessionGroupProjection,
} from '#/app/sessionIndex/sessionGroup';
import { FORKED_FROM_KEY, PROMOTED_FROM_KEY } from '#/session/sessionMetadata/sessionMetadata';
import { FileSessionIndex } from '#/app/sessionIndex/sessionIndexService';
import { SessionIndexMirror } from '#/app/sessionIndex/sessionIndexMirrorService';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IHostFsWatchService, type HostFsChange } from '#/os/interface/hostFsWatch';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { SqliteQueryStore } from '#/persistence/backends/sqlite/sqliteQueryStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IQueryStore } from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { drainQueryStoreDisposals } from '#/persistence/queryStoreDisposals';
import { detachSessionGroupUnguarded, ensureSessionGroupUnguarded } from '#/workspace/sessionLifecycle/sessionGroupAuthority';

import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubFlag } from '../flag/stubs';

const WORK_DIR = '/home/user/sidebar-groups-repo';

class NoopFsWatch implements IHostFsWatchService {
  declare readonly _serviceBrand: undefined;
  private readonly emitter = new Emitter<HostFsChange>();
  watch() {
    return { ready: Promise.resolve(), onDidChange: this.emitter.event, dispose: () => {} };
  }
}

async function writeSessionState(
  homeDir: string,
  workspaceId: string,
  sessionId: string,
  doc: Record<string, unknown>,
  nestedLegacy = false,
): Promise<void> {
  const dir = nestedLegacy
    ? join(homeDir, 'sessions', workspaceId, sessionId, 'session-meta')
    : join(homeDir, 'sessions', workspaceId, sessionId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    join(dir, 'state.json'),
    JSON.stringify({
      version: 1,
      id: sessionId,
      cwd: WORK_DIR,
      createdAt: 1_000,
      updatedAt: 2_000,
      archived: false,
      ...doc,
    }),
    'utf8',
  );
}

describe('sessionGroup projection and authority', () => {
  it('resolves legacy cycles deterministically, honors detach/explicit precedence, and never strips cross-host prefixes', () => {
    const origin = 'home:test-origin';
    const summaries: SessionSummary[] = [
      {
        id: 'cyc_b',
        workspaceId: 'ws_1',
        createdAt: 200,
        updatedAt: 200,
        ownUpdatedAt: 200,
        archived: false,
        custom: { [CREATED_BY_SESSION_ID_KEY]: 'cyc_a' },
      },
      {
        id: 'cyc_a',
        workspaceId: 'ws_1',
        createdAt: 100,
        updatedAt: 300,
        ownUpdatedAt: 300,
        archived: false,
        custom: { [CREATED_BY_SESSION_ID_KEY]: 'cyc_b' },
      },
      {
        id: 'orphan_1',
        workspaceId: 'ws_1',
        createdAt: 400,
        updatedAt: 400,
        ownUpdatedAt: 400,
        archived: false,
        custom: { [CREATED_BY_SESSION_ID_KEY]: 'missing_root' },
      },
      {
        id: 'remote_child',
        workspaceId: 'ws_1',
        createdAt: 500,
        updatedAt: 500,
        ownUpdatedAt: 500,
        archived: false,
        custom: { [CREATED_BY_SESSION_ID_KEY]: 'peer-host:cyc_a' },
      },
      {
        id: 'exp_p',
        workspaceId: 'ws_1',
        createdAt: 600,
        updatedAt: 600,
        ownUpdatedAt: 600,
        archived: false,
        custom: { [SESSION_GROUP_ID_KEY]: 'grp_explicit_p' },
      },
      {
        id: 'exp_c',
        workspaceId: 'ws_1',
        createdAt: 610,
        updatedAt: 610,
        ownUpdatedAt: 610,
        archived: false,
        custom: { [PARENT_SESSION_ID_KEY]: 'exp_p', [CHILD_SESSION_KIND_KEY]: CHILD_SESSION_KIND },
      },
      {
        id: 'exp_other',
        workspaceId: 'ws_1',
        createdAt: 620,
        updatedAt: 620,
        ownUpdatedAt: 620,
        archived: false,
        custom: { [PARENT_SESSION_ID_KEY]: 'exp_p', [CHILD_SESSION_KIND_KEY]: CHILD_SESSION_KIND, [SESSION_GROUP_ID_KEY]: 'grp_explicit_other' },
      },
      {
        id: 'det_c',
        workspaceId: 'ws_1',
        createdAt: 630,
        updatedAt: 630,
        ownUpdatedAt: 630,
        archived: false,
        custom: { [PARENT_SESSION_ID_KEY]: 'exp_p', [CHILD_SESSION_KIND_KEY]: CHILD_SESSION_KIND, [SESSION_GROUP_DETACHED_KEY]: true },
      },
    ];

    const projected = new Map(resolveSessionGroupProjection(summaries, origin).map((s) => [s.id, s]));
    expect(projected.get('cyc_a')?.groupId).toBeUndefined();
    expect(projected.get('cyc_b')?.groupId).toBeUndefined();
    expect(projected.get('orphan_1')?.groupId).toBeUndefined();
    expect(projected.get('remote_child')?.groupId).toBeUndefined();
    expect(projected.get('exp_p')?.groupId).toBeUndefined();
    expect(projected.get('exp_c')?.groupId).toBeUndefined();
    expect(projected.get('exp_other')?.groupId).toBeUndefined();
    expect(projected.get('det_c')?.groupId).toBeUndefined();
    expect(projected.get('det_c')?.groupDetached).toBe(true);
  });

  it('protects reserved group keys against stale generic PATCH overwrites', () => {
    const existing = {
      [SESSION_GROUP_ID_KEY]: 'grp_real',
      [SESSION_GROUP_GENERATION_KEY]: 2,
      [SESSION_GROUP_ORIGIN_KEY]: { homeId: 'h1', hostId: 'host1' },
      keep: 'old',
    };
    const merged = preserveReservedSessionGroupKeys(existing, {
      [SESSION_GROUP_ID_KEY]: 'grp_spoofed',
      [SESSION_GROUP_DETACHED_KEY]: true,
      keep: 'new',
      'kiki.pinned': true,
    });
    expect(merged[SESSION_GROUP_ID_KEY]).toBe('grp_real');
    expect(merged[SESSION_GROUP_GENERATION_KEY]).toBe(2);
    expect(merged[SESSION_GROUP_ORIGIN_KEY]).toEqual({ homeId: 'h1', hostId: 'host1' });
    expect(merged[SESSION_GROUP_DETACHED_KEY]).toBeUndefined();
    expect(merged['keep']).toBe('new');
    expect(merged['kiki.pinned']).toBe(true);
  });
});

describe('SQLite v7 sidebar unit pagination, query plan, and authority', () => {
  let homeDir: string;
  let workspaceId: string;
  let disposeHost: (() => void | Promise<void>) | undefined;
  let queryStore: SqliteQueryStore | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'kiki-sidebar-v7-'));
    workspaceId = encodeWorkDirKey(WORK_DIR);
  });

  afterEach(async () => {
    await disposeHost?.();
    disposeHost = undefined;
    await queryStore?.close();
    queryStore = undefined;
    await drainQueryStoreDisposals();
    await fsp.rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  function mountHost(useReadModel: boolean) {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.App, IHostFsWatchService, NoopFsWatch, ScopeActivation.OnDemand, 'test');
    registerScopedService(LifecycleScope.App, ISessionIndexMirror, SessionIndexMirror, ScopeActivation.OnDemand, 'test');
    registerScopedService(LifecycleScope.App, ISessionIndex, FileSessionIndex, ScopeActivation.OnDemand, 'test');
    const fileStorage = new FileStorageService(homeDir);
    const docs = new JsonAtomicDocumentStore(fileStorage);
    const logs = new AppendLogStore(fileStorage);
    const bootstrap = stubBootstrap(homeDir);
    const log = stubLog();
    queryStore = new SqliteQueryStore(bootstrap, log);
    const managerStub = {
      _serviceBrand: undefined,
      get: () => undefined,
      list: () => [],
    } as unknown as ISessionManager;
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, docs),
      stubPair(IAppendLogStore, logs),
      stubPair(IBootstrapService, bootstrap),
      stubPair(IQueryStore, queryStore),
      stubPair(IFlagService, stubFlag(useReadModel)),
      stubPair(ILogService, stubLog()),
      stubPair(ISessionManager, managerStub),
    ]);
    disposeHost = () => host.dispose();
    return {
      host: host.app,
      index: host.app.accessor.get(ISessionIndex),
      mirror: host.app.accessor.get(ISessionIndexMirror),
    };
  }

  it('stamps opener deterministically without touching updatedAt, and opens a fresh group generation after detach', async () => {
    await writeSessionState(homeDir, workspaceId, 's_opener', {
      title: 'Opener',
      createdAt: 1000,
      updatedAt: 5000,
    }, true);

    const { host, index } = mountHost(true);
    await index.prepare();

    const [first, second] = await Promise.all([
      ensureSessionGroupUnguarded(host.accessor, 's_opener'),
      ensureSessionGroupUnguarded(host.accessor, 's_opener'),
    ]);
    expect(first.groupId).toBe(second.groupId);
    expect(first.groupId.startsWith('grp_')).toBe(true);

    const canonical = JSON.parse(await fsp.readFile(join(homeDir, 'sessions', workspaceId, 's_opener', 'state.json'), 'utf8')) as {
      updatedAt: number;
      custom: Record<string, unknown>;
    };
    expect(canonical.updatedAt).toBe(5000);
    expect(canonical.custom[SESSION_GROUP_ID_KEY]).toBe(first.groupId);

    const detached = await detachSessionGroupUnguarded(host.accessor, 's_opener');
    expect(detached.detached).toBe(true);
    expect(detached.previousGroupId).toBe(first.groupId);

    const fresh = await ensureSessionGroupUnguarded(host.accessor, 's_opener');
    expect(fresh.groupId).not.toBe(first.groupId);
    const afterFresh = JSON.parse(await fsp.readFile(join(homeDir, 'sessions', workspaceId, 's_opener', 'state.json'), 'utf8')) as {
      updatedAt: number;
      custom: Record<string, unknown>;
    };
    expect(afterFresh.updatedAt).toBe(5000);
    expect(afterFresh.custom[SESSION_GROUP_GENERATION_KEY]).toBe(2);
  });

  it('projects 39 mixed creator/fork/promotion/stamped sessions as 39 flat independent units across SQLite v8 pagination, flag-off fallback, and non-destructive v7 upgrade', async () => {
    for (let i = 0; i < 6; i += 1) {
      await writeSessionState(homeDir, workspaceId, `tie_${String(i).padStart(2, '0')}`, {
        title: `Tie ${i}`,
        createdAt: 1000 + i,
        updatedAt: 90_000,
      });
    }

    await writeSessionState(homeDir, workspaceId, 'priv_opener', {
      title: 'Secret Opener Title',
      createdAt: 100,
      updatedAt: 100_000,
      private: true,
      custom: { [SESSION_GROUP_ID_KEY]: 'grp_priv_mix' },
    });
    await writeSessionState(homeDir, workspaceId, 'pub_child_1', {
      title: 'Public Child 1',
      createdAt: 200,
      updatedAt: 85_000,
      custom: { [SESSION_GROUP_ID_KEY]: 'grp_priv_mix', [CREATED_BY_SESSION_ID_KEY]: 'priv_opener' },
    });
    await writeSessionState(homeDir, workspaceId, 'pub_child_2', {
      title: 'Public Child 2',
      createdAt: 300,
      updatedAt: 84_000,
      custom: { [SESSION_GROUP_ID_KEY]: 'grp_priv_mix', [CREATED_BY_SESSION_ID_KEY]: 'priv_opener' },
    });

    await writeSessionState(homeDir, workspaceId, 'root_00', {
      title: 'Root 0',
      createdAt: 1000,
      updatedAt: 80_000,
      custom: { [SESSION_GROUP_ID_KEY]: 'grp_legacy_39' },
    });
    for (let i = 1; i < 31; i += 1) {
      const id = `chain_${String(i).padStart(2, '0')}`;
      const custom: Record<string, unknown> =
        i % 4 === 0
          ? { [CREATED_BY_SESSION_ID_KEY]: 'root_00', [SESSION_GROUP_ID_KEY]: 'grp_legacy_39' }
          : i % 4 === 1
            ? { [CREATED_BY_SESSION_ID_KEY]: `chain_${String(Math.max(1, i - 1)).padStart(2, '0')}` }
            : i % 4 === 2
              ? { [FORKED_FROM_KEY]: { sessionId: 'root_00', forkedAt: 1000 + i }, [SESSION_GROUP_ID_KEY]: 'grp_legacy_39' }
              : { [PROMOTED_FROM_KEY]: { sessionId: 'root_00', agentId: `agent-${i}`, promotedAt: 1000 + i } };
      await writeSessionState(homeDir, workspaceId, id, {
        title: `Session ${i}`,
        createdAt: 1000 + i,
        updatedAt: 70_000 + i,
        custom,
      });
    }

    const { index } = mountHost(true);
    const status = await index.prepare();
    expect(status, JSON.stringify(status)).toMatchObject({ state: 'ready' });

    const seenUnitIds: string[] = [];
    let cursor: { readonly sortAt: number; readonly sortText?: string; readonly typedUnitId: string } | undefined;
    let firstPlan: readonly string[] | undefined;
    let continuationPlan: readonly string[] | undefined;
    for (let pageNo = 0; pageNo < 20; pageNo += 1) {
      const page = await index.listSidebarUnits!({
        filter: { archived: 'hide', privacy: 'hide' },
        sort: 'updated_desc',
        limit: 5,
        memberLimit: 50,
        maxRows: 100,
        cursor,
        explain: pageNo <= 1,
      });
      if (pageNo === 0) {
        firstPlan = page.stats.indexPlan;
        expect(page.stats.unitsVisited).toBeLessThanOrEqual(10);
      } else if (pageNo === 1) {
        continuationPlan = page.stats.indexPlan;
        expect(page.stats.unitsVisited).toBeLessThanOrEqual(10);
      }
      for (const unit of page.units) {
        expect(unit.kind).toBe('session');
        seenUnitIds.push(unit.typedUnitId);
      }
      if (!page.hasMore) break;
      const last = page.units.at(-1)!;
      cursor = { sortAt: last.sortAt, sortText: last.sortText, typedUnitId: last.typedUnitId };
    }

    expect(new Set(seenUnitIds).size).toBe(39);
    expect(seenUnitIds).toHaveLength(39);
    expect(seenUnitIds.slice(0, 9)).toEqual([
      's:tie_05',
      's:tie_04',
      's:tie_03',
      's:tie_02',
      's:tie_01',
      's:tie_00',
      's:pub_child_1',
      's:pub_child_2',
      's:root_00',
    ]);
    expect(firstPlan?.some((line) => line.includes('query_order_') || line.includes('SEARCH'))).toBe(true);
    expect(continuationPlan?.some((line) => line.includes('SEARCH') && line.includes('value') && line.includes('key'))).toBe(true);

    const diskRoot = JSON.parse(await fsp.readFile(join(homeDir, 'sessions', workspaceId, 'root_00', 'state.json'), 'utf8')) as {
      custom?: Record<string, unknown>;
    };
    expect(diskRoot.custom?.[SESSION_GROUP_ID_KEY]).toBe('grp_legacy_39');

    await disposeHost?.();
    disposeHost = undefined;
    await queryStore?.close();
    queryStore = undefined;
    await drainQueryStoreDisposals();

    const fallback = mountHost(false);
    const fallbackPage = await fallback.index.listSidebarUnits!({
      filter: { archived: 'hide', privacy: 'hide' },
      sort: 'updated_desc',
      limit: 50,
      memberLimit: 50,
      maxRows: 500,
    });
    expect(fallbackPage.units.map((u) => u.typedUnitId)).toEqual(seenUnitIds);
  });

  it('keeps legacy children and respawned opener independent across incremental, flag-off, and rebuild reads', async () => {
    await writeSessionState(homeDir, workspaceId, 'leg_opener', {
      title: 'Legacy Opener',
      createdAt: 1000,
      updatedAt: 5000,
    });
    await writeSessionState(homeDir, workspaceId, 'leg_old_child', {
      title: 'Legacy Old Child',
      createdAt: 1100,
      updatedAt: 5100,
      custom: { [CREATED_BY_SESSION_ID_KEY]: 'leg_opener' },
    });

    const { host, index } = mountHost(true);
    await index.prepare();
    const initialChild = await index.get('leg_old_child');
    expect(initialChild?.groupId).toBeUndefined();

    await detachSessionGroupUnguarded(host.accessor, 'leg_opener');
    const respawned = await ensureSessionGroupUnguarded(host.accessor, 'leg_opener');
    await writeSessionState(homeDir, workspaceId, 'leg_new_child', {
      title: 'New Gen Child',
      createdAt: 1200,
      updatedAt: 5200,
      custom: { [CREATED_BY_SESSION_ID_KEY]: 'leg_opener', [SESSION_GROUP_ID_KEY]: respawned.groupId },
    });
    await (index as { reconcileNow?: () => Promise<void> }).reconcileNow?.();

    const incrementalPage = await index.listSidebarUnits!({
      filter: { archived: 'hide', privacy: 'hide' },
      sort: 'updated_desc',
      limit: 10,
      memberLimit: 50,
    });
    expect(incrementalPage.units.every((u) => u.kind === 'session')).toBe(true);
    expect(incrementalPage.units.map((u) => u.id)).toEqual(['leg_new_child', 'leg_old_child', 'leg_opener']);

    await disposeHost?.();
    disposeHost = undefined;
    await queryStore?.close();
    queryStore = undefined;
    await drainQueryStoreDisposals();

    const fallback = mountHost(false);
    const flagOffPage = await fallback.index.listSidebarUnits!({
      filter: { archived: 'hide', privacy: 'hide' },
      sort: 'updated_desc',
      limit: 10,
      memberLimit: 50,
    });
    expect(flagOffPage.units.every((u) => u.kind === 'session')).toBe(true);
    expect(flagOffPage.units.map((u) => u.id)).toEqual(['leg_new_child', 'leg_old_child', 'leg_opener']);
  });
});
