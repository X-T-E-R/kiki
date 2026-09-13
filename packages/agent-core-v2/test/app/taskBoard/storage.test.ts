import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { previewBoardStorage, prepareBoardStorage, openBoardStorage, type BoardStorageApi, type BoardStorageContext } from '#/app/taskBoard/storage';
import { TaskBoardConfigSchema } from '#/app/taskBoard/configSection';

const context: BoardStorageContext = {
  workspaceId: 'workspace-a', workspaceRoot: path.resolve('/project'), homeDir: path.resolve('/home'), sessionsDir: path.resolve('/home/sessions'),
  authorizeStorage: async () => undefined,
};
function fixture() {
  return {
    inspectTaskStorage: vi.fn<BoardStorageApi['inspectTaskStorage']>().mockImplementation(async (root) => ({ root, kind: 'absent', empty: true })),
    initializeEmbeddedTaskStorage: vi.fn<BoardStorageApi['initializeEmbeddedTaskStorage']>().mockResolvedValue({ id: 'store-a' }),
  } satisfies BoardStorageApi;
}

describe('task board location policy (mocked native inspection, no filesystem writes)', () => {
  it('defaults to auto and rejects fixed without a plain path', () => {
    expect(TaskBoardConfigSchema.parse({})).toEqual({ storage: { mode: 'auto' } });
    expect(TaskBoardConfigSchema.safeParse({ storage: { mode: 'fixed' } }).success).toBe(false);
    expect(TaskBoardConfigSchema.safeParse({ storage: { mode: 'fixed', path: 'bad\u0000path' } }).success).toBe(false);
  });

  it('auto reuses a compatible project layout rather than testing CLI installation', async () => {
    const api = fixture();
    api.inspectTaskStorage.mockResolvedValue({ root: context.workspaceRoot, kind: 'workspace', storageId: 'project', tasksDirectory: path.join(context.workspaceRoot, '.absorb', 'tasks') });
    expect(await previewBoardStorage(api, context, { mode: 'auto' })).toMatchObject({ ok: true, value: { root: context.workspaceRoot, tasksDirectory: path.join(context.workspaceRoot, '.absorb', 'tasks'), existing: true } });
    expect(api.inspectTaskStorage).toHaveBeenCalledTimes(1);
    expect(api.initializeEmbeddedTaskStorage).not.toHaveBeenCalled();
  });

  it.each([
    [{ mode: 'auto' } as const, path.join(context.sessionsDir, context.workspaceId, '.board')],
    [{ mode: 'global' } as const, path.join(context.homeDir, 'boards')],
    [{ mode: 'fixed', path: 'data/cards' } as const, path.join(context.workspaceRoot, 'data', 'cards')],
    [{ mode: 'fixed', path: path.resolve('/external/cards') } as const, path.resolve('/external/cards')],
  ])('resolves %o without initializing anything', async (config, expected) => {
    const api = fixture();
    expect(await previewBoardStorage(api, context, config)).toMatchObject({ ok: true, value: { root: expected, existing: false, selectionOnly: true } });
    expect(api.initializeEmbeddedTaskStorage).not.toHaveBeenCalled();
  });

  it('does not reinterpret a damaged existing envelope as absent', async () => {
    const api = fixture();
    api.inspectTaskStorage.mockRejectedValue(new Error('Damaged manifest'));
    await expect(previewBoardStorage(api, context, { mode: 'auto' })).rejects.toThrow('Damaged manifest');
    expect(api.inspectTaskStorage).toHaveBeenCalledTimes(1);
    expect(api.initializeEmbeddedTaskStorage).not.toHaveBeenCalled();
  });

  it('rejects foreign fixed content and checks authorization before probing paths', async () => {
    const api = fixture();
    api.inspectTaskStorage.mockResolvedValue({ root: path.resolve('/foreign'), kind: 'absent', empty: false });
    expect(await previewBoardStorage(api, context, { mode: 'fixed', path: '/foreign' })).toMatchObject({ ok: false, error: { code: 'BOARD_STORAGE_NOT_EMPTY' } });
    api.inspectTaskStorage.mockClear();
    await expect(previewBoardStorage(api, { ...context, authorizeStorage: async () => { throw new Error('Denied'); } }, { mode: 'global' })).rejects.toThrow('Denied');
    expect(api.inspectTaskStorage).not.toHaveBeenCalled();
  });

  it('initializes only on an explicit write and confirms a stable native storage identity', async () => {
    const api = fixture();
    const preview = await previewBoardStorage(api, context, { mode: 'global' });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const calls: string[] = [];
    const writing = { ...context, authorizeStorage: async (_root: string, op: 'read' | 'write') => { calls.push(op); } };
    api.inspectTaskStorage.mockResolvedValueOnce({ root: preview.value.root, kind: 'absent', empty: true }).mockResolvedValueOnce({ root: preview.value.root, kind: 'embedded', storageId: 'store-a' });
    expect(await prepareBoardStorage(api, writing, preview.value)).toMatchObject({ ok: true, value: { kind: 'embedded', storageId: 'store-a' } });
    expect(calls).toEqual(['write']);
    expect(api.initializeEmbeddedTaskStorage).toHaveBeenCalledExactlyOnceWith(preview.value.root);
  });

  it('does not reopen a replacement store under an old card address', async () => {
    const api = fixture();
    const root = path.resolve('/original');
    api.inspectTaskStorage.mockResolvedValue({ root, kind: 'embedded', storageId: 'different' });
    expect(await openBoardStorage(api, context, { root, kind: 'embedded', storageId: 'original' }, 'write')).toMatchObject({ ok: false, error: { code: 'BOARD_STORAGE_CHANGED' } });
    expect(api.initializeEmbeddedTaskStorage).not.toHaveBeenCalled();
  });
});
