import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as ownWork from 'own-work/tasks';
import { afterEach, expect, it, vi } from 'vitest';
import { withTaskBoardSurveyCache, type SurveyTaskApi } from '../src/services/taskBoardSurveyCache';

const item = (index: number): Awaited<ReturnType<SurveyTaskApi['surveyTasks']>>['tasks'][number] => ({
  id: `task-${String(index).padStart(4, '0')}-example`, path: `tasks/task-${index}`, archived: false, valid: true,
  title: 'Example', status: 'active', revision: 0, priority: 'P2', createdAt: '2026-01-01', completedAt: null, issues: [],
  workItem: { workspaceId: 'workspace-a', category: '', sessionIds: ['session-a'], executionIds: [], updatedAt: '2026-01-01' },
});
function fixture(count = 200) {
  const tasks = Array.from({ length: count }, (_, index) => item(index));
  const api = {
    ...ownWork,
    inspectTaskStorage: vi.fn<SurveyTaskApi['inspectTaskStorage']>().mockImplementation(async (root) => ({ root, kind: 'embedded', storageId: 'store-a', tasksDirectory: join(root, 'tasks') })),
    surveyTasks: vi.fn<SurveyTaskApi['surveyTasks']>().mockImplementation(async (options) => ({ root: options.root, ok: true, tasks, context_issues: [], context_path: 'contexts.json' })),
    createTask: vi.fn<SurveyTaskApi['createTask']>().mockRejectedValue(new Error('Write failed')),
    updateWorkItem: vi.fn<SurveyTaskApi['updateWorkItem']>().mockRejectedValue(new Error('Write failed')),
  } satisfies SurveyTaskApi;
  return { api, tasks, cached: withTaskBoardSurveyCache(api) };
}
const root = resolve(process.cwd(), '../../.tmp/board-cache-example');
afterEach(() => vi.restoreAllMocks());

it.each([100, 1000])('scans %i envelopes once across every page instead of N times page count', async (count) => {
  const { api, cached } = fixture(count);
  let cursor: string | undefined;
  let cards = 0;
  do {
    const page = await cached.listTasks({ root, workspaceId: 'workspace-a', cursor, limit: 100 });
    cards += page.tasks.length;
    cursor = page.next_cursor;
  } while (cursor);
  expect(cards).toBe(count);
  expect(api.surveyTasks).toHaveBeenCalledTimes(1);
  expect(api.surveyTasks.mock.calls.length * count).toBe(count);
  expect(api.inspectTaskStorage).toHaveBeenCalledTimes(Math.ceil(count / 100));
});

it('refreshes first-page reads, expires continuations, and invalidates writes and storage identities', async () => {
  const { api, cached } = fixture();
  const first = () => cached.listTasks({ root, limit: 100 });
  const next = () => cached.listTasks({ root, limit: 100, cursor: item(99).id });
  await first();
  await next();
  expect(api.surveyTasks).toHaveBeenCalledTimes(1);
  await first();
  expect(api.surveyTasks).toHaveBeenCalledTimes(2);
  const now = Date.now();
  const time = vi.spyOn(Date, 'now').mockReturnValue(now + 30_001);
  await next();
  expect(api.surveyTasks).toHaveBeenCalledTimes(3);
  time.mockRestore();
  await expect(cached.updateWorkItem({ root, workspaceId: 'workspace-a', id: item(0).id, expectedRevision: 0, patch: { title: 'Changed' } })).rejects.toThrow('Write failed');
  await next();
  expect(api.surveyTasks).toHaveBeenCalledTimes(4);
  await expect(cached.createTask({ root, title: 'New', workItem: { workspaceId: 'workspace-a', requestKey: 'request' } })).rejects.toThrow('Write failed');
  await next();
  expect(api.surveyTasks).toHaveBeenCalledTimes(5);
  api.inspectTaskStorage.mockResolvedValue({ root, kind: 'embedded', storageId: 'replacement', tasksDirectory: join(root, 'tasks') });
  await next();
  expect(api.surveyTasks).toHaveBeenCalledTimes(6);
});

it('coalesces concurrent surveys, does not retain failures, and bounds cached stores', async () => {
  const { api, cached } = fixture();
  let complete!: (value: Awaited<ReturnType<SurveyTaskApi['surveyTasks']>>) => void;
  api.surveyTasks.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
  const reads = [cached.listTasks({ root }), cached.listTasks({ root, workspaceId: 'workspace-b' })];
  await vi.waitFor(() => expect(api.surveyTasks).toHaveBeenCalledTimes(1));
  complete({ root, ok: true, tasks: [], context_issues: [], context_path: '' });
  await Promise.all(reads);
  api.surveyTasks.mockRejectedValueOnce(new Error('Unavailable'));
  await expect(cached.listTasks({ root })).rejects.toThrow('Unavailable');
  await cached.listTasks({ root, cursor: item(1).id });
  expect(api.surveyTasks).toHaveBeenCalledTimes(3);
  for (let index = 0; index < 32; index++) await cached.listTasks({ root: `${root}-${index}` });
  await cached.listTasks({ root, cursor: item(1).id });
  expect(api.surveyTasks).toHaveBeenCalledTimes(36);
});

it('matches bundled list filtering, issues and ordering against a real embedded store', async () => {
  const base = resolve(process.cwd(), '../../.tmp');
  await mkdir(base, { recursive: true });
  const store = await mkdtemp(join(base, 'board-cache-parity-'));
  try {
    await ownWork.initializeEmbeddedTaskStorage(store);
    for (const workspaceId of ['workspace-a', 'workspace-b']) {
      const created = await ownWork.createTask({ root: store, title: workspaceId, workItem: { workspaceId, requestKey: workspaceId, sessionIds: ['session-a'] } });
      if (workspaceId === 'workspace-b') {
        await ownWork.updateWorkItem({ root: store, workspaceId, id: created.task.id, expectedRevision: created.revision, patch: { status: 'done' } });
        await ownWork.archiveTask({ root: store, id: created.task.id });
      }
    }
    const cached = withTaskBoardSurveyCache(ownWork);
    const options = [
      {}, { workspaceId: 'workspace-a' }, { workspaceId: 'workspace-b' }, { archived: true },
      { archived: true, status: 'done' as const }, { sessionId: 'session-a' }, { sessionId: 'missing' }, { limit: 1, archived: true },
    ];
    for (const filter of options) {
      const native = await ownWork.listTasks({ root: store, ...filter });
      expect(await cached.listTasks({ root: store, ...filter })).toEqual({ tasks: native.tasks, issues: native.issues, next_cursor: native.next_cursor });
      if (native.next_cursor) {
        const next = await ownWork.listTasks({ root: store, ...filter, cursor: native.next_cursor });
        expect(await cached.listTasks({ root: store, ...filter, cursor: native.next_cursor })).toEqual({ tasks: next.tasks, issues: next.issues, next_cursor: next.next_cursor });
      }
    }
  } finally {
    await rm(store, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
