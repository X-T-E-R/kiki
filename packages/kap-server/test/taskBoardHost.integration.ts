import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createKlient } from '@kiki/klient/http';
import { IBootstrapService, IAtomicDocumentStore, IConfigService, IWorkspaceService, type Scope } from '@kiki/agent-core-v2';
import type { OwnWorkTaskApi } from '@kiki/agent-core-v2/app/taskBoard/ownWorkAdapter';
import type { BoardCard, BoardPage, BoardStoragePreview, BoardResult, BoardReadValue } from '@kiki/klient';
import { startServer } from '../src/start';
import { createTaskBoardHost } from '../src/services/taskBoardHost';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { fixedTokenAuth } from './helpers/fixedAuth';

function value<T>(result: BoardResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function pageValue(result: BoardResult<BoardReadValue>): BoardPage {
  const read = value(result);
  if (!('cards' in read) || !('issues' in read)) throw new Error('Expected a board page result.');
  return read;
}

it('uses the bundled Own Work package over real HTTP without requiring workspace trust, with persistent authorized addresses and CAS', async () => {
  const testRoot = resolve(process.cwd(), '../../.tmp');
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'kiki-native-board-'));
  const home = join(root, 'home');
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot);
  const options = { homeDir: home, host: '127.0.0.1', port: 0, hostIdentity: TEST_HOST_IDENTITY, authTokenService: fixedTokenAuth('board-test'), logLevel: 'silent' as const };
  let server = await startServer(options);
  let client = createKlient({ endpoint: `http://127.0.0.1:${server.port}`, token: 'board-test' });
  try {
    const workspace = await client.global.workspaces.createOrTouch({ root: workspaceRoot });
    const workspaceId = workspace.id;
    const preview = async (configuration: { mode: 'auto' | 'global' | 'fixed'; path?: string }) => value(await client.global.board.read({ action: 'preview', workspaceId, configuration })) as BoardStoragePreview;
    const trustState = async () => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/workspaces/${encodeURIComponent(workspaceId)}/trust`, { headers: { authorization: 'Bearer board-test' } });
      expect(response.status).toBe(200);
      const body = await response.json() as { code: number; data: { trusted: boolean } };
      expect(body.code).toBe(0);
      return body.data.trusted;
    };
    const auto = await preview({ mode: 'auto' });
    const global = await preview({ mode: 'global' });
    const fixed = await preview({ mode: 'fixed', path: 'requirements' });
    expect(auto.root).toBe(join(home, 'sessions', workspaceId, '.board'));
    expect(global.root).toBe(join(home, 'boards'));
    expect(fixed.root).toBe(join(workspaceRoot, 'requirements'));
    for (const location of [auto, global, fixed]) await expect(stat(location.root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await server.core.accessor.get(IAtomicDocumentStore).get('task-board-authorizations', workspaceId)).toBeUndefined();
    expect(await trustState()).toBe(false);
    const create = { action: 'create' as const, workspaceId, requestKey: 'stable-request', title: 'Requirement', description: 'Initial detail' };
    expect(await client.global.board.write({ ...create, workspaceId: 'missing-board-workspace' })).toMatchObject({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } });
    const created = value(await client.global.board.write(create));
    expect(created.status).toBe('active');
    expect(value(await client.global.board.write(create)).id).toBe(created.id);
    const show = (card: BoardCard) => client.global.board.read({ action: 'show', workspaceId, storage: card.storage, id: card.id });
    const updated = value(await client.global.board.write({ action: 'update', workspaceId, storage: created.storage, id: created.id, expectedRevision: created.revision, patch: { description: 'Edited detail', sessionIds: ['session-example'] } }));
    expect(updated.description).toBe('Edited detail');
    const inProgress = value(await client.global.board.write({ action: 'update', workspaceId, storage: updated.storage, id: updated.id, expectedRevision: updated.revision, patch: { status: 'in_progress' } }));
    expect(inProgress.status).toBe('in_progress');
    const inProgressList = pageValue(await client.global.board.read({ action: 'list', workspaceId, storage: inProgress.storage, status: 'in_progress' }));
    expect(inProgressList.cards.map((card) => card.id)).toContain(inProgress.id);
    expect(inProgressList.cards.every((card) => card.status === 'in_progress')).toBe(true);
    const done = value(await client.global.board.write({ action: 'update', workspaceId, storage: inProgress.storage, id: inProgress.id, expectedRevision: inProgress.revision, patch: { status: 'done' } }));
    expect(done.completedAt).not.toBeNull();
    const reopened = value(await client.global.board.write({ action: 'update', workspaceId, storage: done.storage, id: done.id, expectedRevision: done.revision, patch: { status: 'active' } }));
    expect(reopened).toMatchObject({ status: 'active', completedAt: null });
    const cancelledCard = value(await client.global.board.write({ ...create, requestKey: 'cancelled-reopen' }));
    const cancelled = value(await client.global.board.write({ action: 'update', workspaceId, storage: cancelledCard.storage, id: cancelledCard.id, expectedRevision: cancelledCard.revision, patch: { status: 'cancelled' } }));
    expect(value(await client.global.board.write({ action: 'update', workspaceId, storage: cancelled.storage, id: cancelled.id, expectedRevision: cancelled.revision, patch: { status: 'paused' } }))).toMatchObject({ status: 'paused', completedAt: null });
    const supersededCard = value(await client.global.board.write({ ...create, requestKey: 'superseded-reopen' }));
    const superseded = value(await client.global.board.write({ action: 'update', workspaceId, storage: supersededCard.storage, id: supersededCard.id, expectedRevision: supersededCard.revision, patch: { status: 'superseded' } }));
    expect(value(await client.global.board.write({ action: 'update', workspaceId, storage: superseded.storage, id: superseded.id, expectedRevision: superseded.revision, patch: { status: 'in_progress' } }))).toMatchObject({ status: 'in_progress', completedAt: null });
    const legacyTarget = value(await client.global.board.write({ ...create, requestKey: 'legacy-target' }));
    const legacySource = value(await client.global.board.write({ ...create, requestKey: 'legacy-source' }));
    const legacyTaskPath = join(legacySource.storage.root, 'tasks', legacySource.id, 'task.json');
    const legacyBefore = await readFile(legacyTaskPath);
    const legacyRecord = JSON.parse(legacyBefore.toString('utf8')) as { meta: { assay: { relations: unknown[] } } };
    legacyRecord.meta.assay.relations = [{ type: 'succeeds', target: legacyTarget.id }, { type: 'follows', target: created.id }];
    await writeFile(legacyTaskPath, `${JSON.stringify(legacyRecord, null, 2)}\n`);
    const legacyList = pageValue(await client.global.board.read({ action: 'list', workspaceId, storage: legacySource.storage }));
    expect(legacyList.issues).toEqual([]);
    expect(legacyList.cards.map((card) => card.id)).toEqual(expect.arrayContaining([legacyTarget.id, legacySource.id]));
    expect(value(await show(legacySource))).toMatchObject({ id: legacySource.id, title: 'Requirement' });
    const legacyHash = createHash('sha256').update(await readFile(legacyTaskPath)).digest('hex');
    const conflict = await client.global.board.write({ action: 'update', workspaceId, storage: created.storage, id: created.id, expectedRevision: created.revision, patch: { title: 'Stale edit' } });
    expect(conflict.ok).toBe(false);
    expect(value(await show(updated))).toMatchObject({ description: 'Edited detail' });
    await client.global.config.replace({ domain: 'taskBoard', value: { storage: { mode: 'fixed', path: 'requirements' } } });
    const fixedCard = value(await client.global.board.write({ ...create, requestKey: 'fixed-request' }));
    expect(fixedCard.storage.root).toBe(fixed.root);
    await client.global.config.replace({ domain: 'taskBoard', value: { storage: { mode: 'global' } } });
    const globalCard = value(await client.global.board.write({ ...create, requestKey: 'global-request' }));
    expect(globalCard.storage.root).toBe(global.root);
    const forged = await client.global.board.read({ action: 'show', workspaceId, id: fixedCard.id, storage: { ...fixedCard.storage, root: join(root, 'not-granted') } });
    expect(forged).toMatchObject({ ok: false, error: { code: 'BOARD_ACCESS_DENIED' } });
    const unsaved = await preview({ mode: 'fixed', path: join(root, 'unsaved-selection') });
    expect(await client.global.board.write({ ...create, requestKey: 'ungranted-create', target: { root: unsaved.root, kind: unsaved.kind } })).toMatchObject({ ok: false, error: { code: 'BOARD_ACCESS_DENIED' } });
    await expect(stat(unsaved.root)).rejects.toMatchObject({ code: 'ENOENT' });
    const otherRoot = join(root, 'other-workspace');
    await mkdir(otherRoot);
    const other = await client.global.workspaces.createOrTouch({ root: otherRoot });
    expect(await client.global.board.read({ action: 'show', workspaceId: other.id, storage: globalCard.storage, id: globalCard.id })).toMatchObject({ ok: false, error: { code: 'BOARD_WORKSPACE_MISMATCH' } });
    await client.close();
    await server.close();
    server = await startServer(options);
    client = createKlient({ endpoint: `http://127.0.0.1:${server.port}`, token: 'board-test' });
    for (const card of [reopened, fixedCard, globalCard]) expect(value<BoardReadValue>(await show(card))).toMatchObject({ id: card.id, revision: card.revision });
    expect(value(await show(reopened))).toMatchObject({ status: 'active', completedAt: null });
    const restartedActiveList = pageValue(await client.global.board.read({ action: 'list', workspaceId, storage: reopened.storage, status: 'active' }));
    expect(restartedActiveList.cards.map((card) => card.id)).toContain(reopened.id);
    const restartedLegacyList = pageValue(await client.global.board.read({ action: 'list', workspaceId, storage: legacySource.storage }));
    expect(restartedLegacyList.issues).toEqual([]);
    expect(restartedLegacyList.cards.map((card) => card.id)).toEqual(expect.arrayContaining([legacyTarget.id, legacySource.id]));
    expect(value(await show(legacySource))).toMatchObject({ id: legacySource.id });
    expect(createHash('sha256').update(await readFile(legacyTaskPath)).digest('hex')).toBe(legacyHash);
    const list = pageValue(await client.global.board.read({ action: 'list', workspaceId, storage: fixedCard.storage }));
    expect(list).toMatchObject({ cards: [expect.objectContaining({ id: fixedCard.id })] });
    expect(await trustState()).toBe(false);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 120_000);

it('returns one server-enumerated overview while isolating an incompatible workspace store', async () => {
  const testRoot = resolve(process.cwd(), '../../.tmp');
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'kiki-board-overview-'));
  const home = join(root, 'home');
  const healthyRoot = join(root, 'healthy-workspace');
  const incompatibleRoot = join(root, 'incompatible-workspace');
  await Promise.all([mkdir(healthyRoot), mkdir(incompatibleRoot)]);
  const server = await startServer({
    homeDir: home,
    host: '127.0.0.1',
    port: 0,
    hostIdentity: TEST_HOST_IDENTITY,
    authTokenService: fixedTokenAuth('board-overview-test'),
    logLevel: 'silent',
  });
  const client = createKlient({ endpoint: `http://127.0.0.1:${server.port}`, token: 'board-overview-test' });
  try {
    const healthy = await client.global.workspaces.createOrTouch({ root: healthyRoot });
    const incompatible = await client.global.workspaces.createOrTouch({ root: incompatibleRoot });
    const created = value(await client.global.board.write({
      action: 'create',
      workspaceId: healthy.id,
      requestKey: 'overview-card',
      title: 'Visible in overview',
    }));
    const incompatibleStore = join(home, 'sessions', incompatible.id, '.board');
    await mkdir(incompatibleStore, { recursive: true });
    await writeFile(join(incompatibleStore, '.own-work-storage.json'), `${JSON.stringify({
      format: 'own-work-items',
      version: 2,
      id: '11111111-1111-4111-8111-111111111111',
    }, null, 2)}\n`);

    const overview = value(await client.global.board.overview());
    expect(overview).toHaveLength(2);
    expect(overview.find((entry) => entry.workspaceId === healthy.id)).toMatchObject({
      result: { ok: true, value: { workspaceId: healthy.id, cards: [expect.objectContaining({ id: created.id })], issues: [] } },
    });
    expect(overview.find((entry) => entry.workspaceId === incompatible.id)).toMatchObject({
      result: { ok: false, error: { code: 'BOARD_UNAVAILABLE' } },
    });
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 120_000);

it('caps a runaway workspace cursor without failing healthy overview entries', async () => {
  const testRoot = resolve(process.cwd(), '../../.tmp');
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'kiki-board-overview-limit-'));
  const home = join(root, 'home');
  const sessionsDir = join(home, 'sessions');
  const healthyRoot = join(root, 'healthy-workspace');
  const runawayRoot = join(root, 'runaway-workspace');
  await Promise.all([
    mkdir(sessionsDir, { recursive: true }),
    mkdir(healthyRoot),
    mkdir(runawayRoot),
  ]);
  let runawayCursor = 0;
  const api = {
    inspectTaskStorage: vi.fn<OwnWorkTaskApi['inspectTaskStorage']>().mockImplementation(async (selected) => ({
      root: selected,
      kind: 'workspace',
      storageId: `workspace:${selected}`,
      tasksDirectory: join(selected, 'tasks'),
    })),
    initializeEmbeddedTaskStorage: vi.fn<OwnWorkTaskApi['initializeEmbeddedTaskStorage']>(),
    createTask: vi.fn<OwnWorkTaskApi['createTask']>(),
    peekTask: vi.fn<OwnWorkTaskApi['peekTask']>(),
    listTasks: vi.fn<OwnWorkTaskApi['listTasks']>().mockImplementation(async ({ workspaceId }) => {
      if (workspaceId !== 'workspace-runaway') return { tasks: [], issues: [] };
      runawayCursor += 1;
      return { tasks: [], issues: [], next_cursor: `cursor-${runawayCursor}` };
    }),
    updateWorkItem: vi.fn<OwnWorkTaskApi['updateWorkItem']>(),
  } satisfies OwnWorkTaskApi;
  const workspaces = [
    { id: 'workspace-healthy', root: healthyRoot },
    { id: 'workspace-runaway', root: runawayRoot },
  ];
  const services = new Map<unknown, unknown>([
    [IWorkspaceService, { list: vi.fn(async () => workspaces) }],
    [IConfigService, { get: vi.fn(() => undefined) }],
    [IAtomicDocumentStore, { get: vi.fn(async () => []), update: vi.fn(async () => undefined) }],
    [IBootstrapService, { homeDir: home, sessionsDir }],
  ]);
  const core = {
    accessor: {
      get<T>(token: unknown): T {
        const service = services.get(token);
        if (service === undefined) throw new Error('Unexpected service token.');
        return service as T;
      },
    },
  } as unknown as Scope;

  try {
    const result = await createTaskBoardHost(() => core, api).overview();
    expect(result).toMatchObject({
      ok: true,
      value: [
        { workspaceId: 'workspace-healthy', result: { ok: true, value: { cards: [], issues: [] } } },
        { workspaceId: 'workspace-runaway', result: { ok: false, error: { code: 'BOARD_PAGINATION_LIMIT' } } },
      ],
    });
    expect(api.listTasks.mock.calls.filter(([options]) => options.workspaceId === 'workspace-runaway')).toHaveLength(100);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}, 120_000);
