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
  deriveSessionGroupToken,
  preserveReservedSessionGroupKeys,
  resolveSessionGroupProjection,
} from '#/app/sessionIndex/sessionGroup';
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
    const expectedCycleGroup = deriveSessionGroupToken(origin, 'cyc_a', 0);
    expect(projected.get('cyc_a')?.groupId).toBe(expectedCycleGroup);
    expect(projected.get('cyc_b')?.groupId).toBe(expectedCycleGroup);
    expect(projected.get('orphan_1')?.groupId).toBeUndefined();
    expect(projected.get('remote_child')?.groupId).toBeUndefined();
    expect(projected.get('exp_p')?.groupId).toBe('grp_explicit_p');
    expect(projected.get('exp_c')?.groupId).toBe('grp_explicit_p');
    expect(projected.get('exp_other')?.groupId).toBe('grp_explicit_other');
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

  it('handles equality ties, private opener exclusion, 51 & 201 member groups, query plans, and flag-off parity', async () => {
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

    for (let i = 0; i < 51; i += 1) {
      await writeSessionState(homeDir, workspaceId, `g51_${String(i).padStart(3, '0')}`, {
        title: `Group51 Member ${i}`,
        createdAt: 1000 + i,
        updatedAt: 70_000 + i,
        custom: { [SESSION_GROUP_ID_KEY]: 'grp_51' },
      });
    }

    for (let i = 0; i < 201; i += 1) {
      await writeSessionState(homeDir, workspaceId, `g201_${String(i).padStart(3, '0')}`, {
        title: `Group201 Member ${i}`,
        createdAt: 2000 + i,
        updatedAt: 60_000 + i,
        custom: { [SESSION_GROUP_ID_KEY]: 'grp_201' },
      });
    }

    const { index } = mountHost(true);
    const status = await index.prepare();
    expect(status, JSON.stringify(status)).toMatchObject({ state: 'ready' });

    const seenUnitIds: string[] = [];
    let cursor: { readonly sortAt: number; readonly sortText?: string; readonly typedUnitId: string } | undefined;
    let firstPlan: readonly string[] | undefined;
    let continuationPlan: readonly string[] | undefined;
    for (let pageNo = 0; pageNo < 10; pageNo += 1) {
      const page = await index.listSidebarUnits!({
        filter: { archived: 'hide', privacy: 'hide' },
        sort: 'updated_desc',
        limit: 3,
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
        expect(page.stats.unitsVisited).toBeLessThanOrEqual(5);
      }
      for (const unit of page.units) {
        seenUnitIds.push(unit.typedUnitId);
      }
      if (!page.hasMore) break;
      const last = page.units.at(-1)!;
      cursor = { sortAt: last.sortAt, sortText: last.sortText, typedUnitId: last.typedUnitId };
    }

    expect(new Set(seenUnitIds).size).toBe(seenUnitIds.length);
    expect(seenUnitIds).toHaveLength(9);
    expect(seenUnitIds.slice(0, 6)).toEqual([
      's:tie_05',
      's:tie_04',
      's:tie_03',
      's:tie_02',
      's:tie_01',
      's:tie_00',
    ]);
    expect(seenUnitIds.slice(6)).toEqual(['g:grp_priv_mix', 'g:grp_51', 'g:grp_201']);
    expect(firstPlan?.some((line) => line.includes('query_order_') || line.includes('SEARCH'))).toBe(true);
    expect(continuationPlan?.some((line) => line.includes('SEARCH') && line.includes('value') && line.includes('key'))).toBe(true);

    const resolvedPriv = await index.resolveSidebarUnits!({
      sessionIds: [],
      groupIds: ['grp_priv_mix', 'grp_51', 'grp_201'],
      filter: { archived: 'hide', privacy: 'hide' },
      memberLimit: 50,
    });
    const privGroup = resolvedPriv.units.find((u) => u.id === 'grp_priv_mix')!;
    expect(privGroup.memberCount).toBe(2);
    expect(privGroup.title).toBe('Public Child 1');
    expect(privGroup.sortAt).toBe(85_000);
    expect(privGroup.members.map((m) => m.id)).not.toContain('priv_opener');

    const group51 = resolvedPriv.units.find((u) => u.id === 'grp_51')!;
    expect(group51.memberCount).toBe(51);
    expect(group51.members).toHaveLength(50);
    expect(group51.hasMoreMembers).toBe(true);

    const last51 = group51.members.at(-1)!;
    const tail51 = await index.listSidebarGroupMembers!({
      groupId: 'grp_51',
      filter: { archived: 'hide', privacy: 'hide' },
      limit: 50,
      cursor: { ownUpdatedAt: last51.ownUpdatedAt ?? last51.updatedAt, id: last51.id },
    });
    expect(tail51.memberCount).toBe(51);
    expect(tail51.members).toHaveLength(1);
    expect(tail51.hasMore).toBe(false);

    const group201 = resolvedPriv.units.find((u) => u.id === 'grp_201')!;
    expect(group201.memberCount).toBe(201);
    expect(group201.members).toHaveLength(50);
    expect(group201.hasMoreMembers).toBe(true);
    const drained201: string[] = group201.members.map((m) => m.id);
    let mCursor: { readonly ownUpdatedAt: number; readonly id: string } | undefined = {
      ownUpdatedAt: group201.members.at(-1)!.ownUpdatedAt ?? group201.members.at(-1)!.updatedAt,
      id: group201.members.at(-1)!.id,
    };
    while (mCursor !== undefined) {
      const next = await index.listSidebarGroupMembers!({
        groupId: 'grp_201',
        filter: { archived: 'hide', privacy: 'hide' },
        limit: 50,
        cursor: mCursor,
      });
      drained201.push(...next.members.map((m) => m.id));
      if (!next.hasMore) break;
      const last = next.members.at(-1)!;
      mCursor = { ownUpdatedAt: last.ownUpdatedAt ?? last.updatedAt, id: last.id };
    }
    expect(new Set(drained201).size).toBe(201);

    await disposeHost?.();
    disposeHost = undefined;
    await queryStore?.close();
    queryStore = undefined;
    await drainQueryStoreDisposals();

    const fallback = mountHost(false);
    const fallbackPage = await fallback.index.listSidebarUnits!({
      filter: { archived: 'hide', privacy: 'hide' },
      sort: 'updated_desc',
      limit: 20,
      memberLimit: 50,
      maxRows: 500,
    });
    expect(fallbackPage.units.map((u) => u.typedUnitId)).toEqual(seenUnitIds);
    expect(fallbackPage.units.find((u) => u.id === 'grp_priv_mix')?.title).toBe('Public Child 1');
    expect(fallbackPage.units.find((u) => u.id === 'grp_201')?.memberCount).toBe(201);
  });

  it('keeps unstamped legacy children out of a detached-and-respawned opener generation across incremental, flag-off, and rebuild reads', async () => {
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
    expect(initialChild?.groupId).toBeDefined();
    const oldGroupId = initialChild!.groupId!;

    await detachSessionGroupUnguarded(host.accessor, 'leg_opener');
    const respawned = await ensureSessionGroupUnguarded(host.accessor, 'leg_opener');
    expect(respawned.groupId).not.toBe(oldGroupId);
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
    const newGroupInc = incrementalPage.units.find((u) => u.id === respawned.groupId);
    expect(newGroupInc?.members.map((m) => m.id).sort()).toEqual(['leg_new_child', 'leg_opener']);
    expect(newGroupInc?.members.map((m) => m.id)).not.toContain('leg_old_child');

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
    const newGroupOff = flagOffPage.units.find((u) => u.id === respawned.groupId);
    expect(newGroupOff?.members.map((m) => m.id).sort()).toEqual(['leg_new_child', 'leg_opener']);
    expect(newGroupOff?.members.map((m) => m.id)).not.toContain('leg_old_child');
    const oldGroupOff = flagOffPage.units.find((u) => u.id === oldGroupId);
    expect(oldGroupOff?.members.map((m) => m.id)).toEqual(['leg_old_child']);
  });
});
