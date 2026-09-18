import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOwnWorkBoardService, type BoardWorkspaceAccess, type OwnWorkTaskApi, type OwnWorkTaskRecord } from '#/app/taskBoard/ownWorkAdapter';
import { BoardWriteSchema, type BoardStorageRef } from '#/app/taskBoard/taskBoard';

const root = path.resolve('/example-workspace');
const storage: BoardStorageRef = { root, kind: 'workspace', storageId: `workspace:${root}` };
const item = { workspaceId: 'workspace-a', category: '', sessionIds: ['session-a', 'session-b'], executionIds: ['run-a'], updatedAt: '2026-01-02' };
function record(revision = 3): OwnWorkTaskRecord {
  return { archived: false, revision, task: { id: 'task-example', title: 'Example', description: 'Details', priority: 'P2', status: 'active', createdAt: '2026-01-01', completedAt: null, meta: { own_work_item: item } }, prd: '# Authored document' };
}
function fixture() {
  const api = {
    inspectTaskStorage: vi.fn<OwnWorkTaskApi['inspectTaskStorage']>().mockImplementation(async (selected) => ({ root: selected, kind: 'workspace', storageId: `workspace:${selected}`, tasksDirectory: path.join(selected, 'tasks') })),
    initializeEmbeddedTaskStorage: vi.fn<OwnWorkTaskApi['initializeEmbeddedTaskStorage']>(),
    createTask: vi.fn<OwnWorkTaskApi['createTask']>().mockResolvedValue(record()),
    peekTask: vi.fn<OwnWorkTaskApi['peekTask']>().mockResolvedValue(record()),
    listTasks: vi.fn<OwnWorkTaskApi['listTasks']>().mockResolvedValue({ tasks: [{ ...record().task, archived: false, revision: 3, workItem: item }], issues: [] }),
    updateWorkItem: vi.fn<OwnWorkTaskApi['updateWorkItem']>().mockResolvedValue(record(4)),
  } satisfies OwnWorkTaskApi;
  const authorizeStorage = vi.fn().mockResolvedValue(undefined);
  const visits: string[] = [];
  const workspaces: BoardWorkspaceAccess = {
    currentWorkspaceId: () => 'workspace-a', storageConfig: () => ({ mode: 'auto' }),
    async withWorkspace(id, _operation, use) {
      visits.push(id);
      if (id === 'denied') throw Object.assign(new Error('Not authorized'), { code: 'BOARD_ACCESS_DENIED' });
      return use({ workspaceId: id, workspaceRoot: root, homeDir: path.resolve('/example-home'), sessionsDir: path.resolve('/example-home/sessions'), authorizeStorage });
    },
  };
  return { api, visits, workspaces, authorizeStorage, service: createOwnWorkBoardService(api, workspaces) };
}

describe('Own Work adapter (explicit native API mocks, not a persistence test)', () => {
  it('creates without a session or CLI, forwarding a durable creation key and selected location', async () => {
    const { service, api } = fixture();
    expect(await service.write({ action: 'create', title: ' Example ', requestKey: 'intent-a' })).toMatchObject({ ok: true, value: { storage, workspaceId: 'workspace-a', revision: 3 } });
    expect(api.createTask).toHaveBeenCalledExactlyOnceWith({ root, title: 'Example', description: undefined, priority: undefined, workItem: { workspaceId: 'workspace-a', requestKey: 'intent-a', category: undefined, sessionIds: undefined, executionIds: undefined } });
    expect(api.initializeEmbeddedTaskStorage).not.toHaveBeenCalled();
    expect(api.updateWorkItem).not.toHaveBeenCalled();
  });

  it('lists summaries only, retaining native pagination and association filters', async () => {
    const { service, api } = fixture();
    const result = await service.read({ action: 'list', sessionId: 'session-b', cursor: 'prior', limit: 5 });
    expect(result).toMatchObject({ ok: true, value: { cards: [{ title: 'Example', storage, sessionIds: ['session-a', 'session-b'] }] } });
    expect(api.peekTask).not.toHaveBeenCalled();
    expect(api.listTasks).toHaveBeenCalledExactlyOnceWith({ root, workspaceId: 'workspace-a', sessionId: 'session-b', cursor: 'prior', limit: 5, archived: undefined, status: undefined });
    if (result.ok && 'cards' in result.value) expect(result.value.cards[0]).not.toHaveProperty('description');
  });

  it('passes the original revision and links to one native mutation, without completing a run', async () => {
    const { service, api } = fixture();
    const patch = { title: 'Edited', sessionIds: ['session-a', 'session-b'], executionIds: ['run-a', 'run-b'] };
    expect(await service.write({ action: 'update', workspaceId: 'workspace-a', storage, id: 'task-example', expectedRevision: 3, patch })).toMatchObject({ ok: true, value: { revision: 4, status: 'active' } });
    expect(api.updateWorkItem).toHaveBeenCalledExactlyOnceWith({ root, workspaceId: 'workspace-a', id: 'task-example', expectedRevision: 3, patch });
  });

  it.each(['TASK_REVISION_CONFLICT', 'TASK_TERMINAL', 'WORKSPACE_CUTOVER_REQUIRED'])('propagates %s without retries or replacement cards', async (code) => {
    const { service, api } = fixture();
    api.updateWorkItem.mockRejectedValue(Object.assign(new Error(code), { code }));
    expect(await service.write({ action: 'update', workspaceId: 'workspace-a', storage, id: 'task-example', expectedRevision: 3, patch: { status: 'active' } })).toMatchObject({ ok: false, error: { code } });
    expect(api.updateWorkItem).toHaveBeenCalledTimes(1);
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it('forwards in_progress as an explicit milestone update', async () => {
    const { service, api } = fixture();
    const next = record(4);
    api.updateWorkItem.mockResolvedValue({ ...next, task: { ...next.task, status: 'in_progress' } });
    const patch = { status: 'in_progress' as const };
    expect(await service.write({ action: 'update', workspaceId: 'workspace-a', storage, id: 'task-example', expectedRevision: 3, patch })).toMatchObject({ ok: true, value: { revision: 4, status: 'in_progress' } });
    expect(api.updateWorkItem).toHaveBeenCalledExactlyOnceWith({ root, workspaceId: 'workspace-a', id: 'task-example', expectedRevision: 3, patch });
  });

  it('keeps existing card addresses stable after the default storage setting changes', async () => {
    const { service, api, workspaces } = fixture();
    workspaces.storageConfig = () => ({ mode: 'fixed', path: path.resolve('/different-store') });
    expect(await service.read({ action: 'show', workspaceId: 'workspace-a', storage, id: 'task-example' })).toMatchObject({ ok: true, value: { storage, description: 'Details' } });
    expect(api.peekTask).toHaveBeenCalledExactlyOnceWith({ root, id: 'task-example' });
    expect(api.initializeEmbeddedTaskStorage).not.toHaveBeenCalled();
  });

  it('rejects replaced storage identity and cross-workspace card addressing', async () => {
    const { service, api } = fixture();
    expect(await service.read({ action: 'show', workspaceId: 'workspace-b', storage, id: 'task-example' })).toMatchObject({ ok: false, error: { code: 'BOARD_WORKSPACE_MISMATCH' } });
    api.peekTask.mockClear();
    expect(await service.read({ action: 'show', workspaceId: 'workspace-a', storage: { ...storage, storageId: 'replacement' }, id: 'task-example' })).toMatchObject({ ok: false, error: { code: 'BOARD_STORAGE_CHANGED' } });
    expect(api.peekTask).not.toHaveBeenCalled();
  });

  it('only visits explicit overview workspaces and never forks on damaged native storage', async () => {
    const { service, api, visits } = fixture();
    await service.read({ action: 'overview', workspaceIds: ['workspace-a', 'denied', 'workspace-a'] });
    expect(visits).toEqual(['workspace-a', 'denied']);
    api.inspectTaskStorage.mockRejectedValue(new Error('damaged manifest'));
    expect(await service.read({ action: 'list' })).toMatchObject({ ok: false, error: { code: 'BOARD_UNAVAILABLE' } });
    expect(api.initializeEmbeddedTaskStorage).not.toHaveBeenCalled();
  });

  it('rejects forged actor fields and requires revisions and creation keys', () => {
    expect(BoardWriteSchema.safeParse({ action: 'create', title: 'Example', requestKey: 'a', agentId: 'main' }).success).toBe(false);
    expect(BoardWriteSchema.safeParse({ action: 'create', title: 'Example' }).success).toBe(false);
    expect(BoardWriteSchema.safeParse({ action: 'update', workspaceId: 'workspace-a', storage, id: 'x', patch: { title: 'New' } }).success).toBe(false);
  });
});
