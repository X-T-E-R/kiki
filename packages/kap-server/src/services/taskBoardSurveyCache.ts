import path from 'node:path';
import type { surveyTasks } from 'own-work/tasks';
import type { OwnWorkTaskApi } from '@kiki/agent-core-v2/app/taskBoard/ownWorkAdapter';

type Survey = Awaited<ReturnType<typeof surveyTasks>>;
export type SurveyTaskApi = OwnWorkTaskApi & { surveyTasks: typeof surveyTasks };
const TTL_MS = 30_000;
const MAX_STORES = 32;

/**
 * Host-only pagination snapshots: first-page requests resurvey (concurrent scans
 * coalesce), continuation pages reuse at most 30 seconds and 32 stores. Writes
 * invalidate before and after execution, including failures; each page checks
 * storage identity. Workspace/path authorization remains in taskBoardHost.
 * External writers become visible on refresh or snapshot expiry. Native survey
 * validation/budgets are retained; this wrapper only filters its summaries.
 */
export function withTaskBoardSurveyCache(api: SurveyTaskApi): OwnWorkTaskApi {
  const snapshots = new Map<string, { identity: string; pending: boolean; expiresAt: number; value: Promise<Survey> }>();
  const keyFor = (root: string) => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
  const invalidate = (root: string) => { snapshots.delete(keyFor(root)); };
  return {
    ...api,
    async listTasks(options) {
      const limit = options.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw Object.assign(new Error('Task list limit must be between 1 and 100.'), { code: 'TASK_INVALID' });
      }
      const key = keyFor(options.root);
      const inspection = await api.inspectTaskStorage(options.root);
      if (inspection.kind === 'absent' || !inspection.storageId) {
        invalidate(options.root);
        throw Object.assign(new Error('Task storage no longer exists.'), { code: 'BOARD_STORAGE_INVALID' });
      }
      const identity = `${key}\0${inspection.storageId}\0${inspection.kind}`;
      for (const [entryKey, entry] of snapshots) {
        if (!entry.pending && entry.expiresAt <= Date.now()) snapshots.delete(entryKey);
      }
      let snapshot = snapshots.get(key);
      if (snapshot?.identity !== identity) snapshot = undefined;
      if (!snapshot || (!snapshot.pending && options.cursor === undefined)) {
        const value = api.surveyTasks({ root: options.root, includeArchived: true, depth: 'envelope' });
        snapshot = { identity, pending: true, expiresAt: Number.POSITIVE_INFINITY, value };
        const current = snapshot;
        snapshots.delete(key);
        snapshots.set(key, current);
        while (snapshots.size > MAX_STORES) snapshots.delete(snapshots.keys().next().value!);
        void value.then(() => {
          current.pending = false;
          current.expiresAt = Date.now() + TTL_MS;
        }, () => {
          if (snapshots.get(key) === current) snapshots.delete(key);
        });
      }
      const survey = await snapshot.value;
      const matching = survey.tasks.filter((entry) => entry.valid
        && (options.archived === true || !entry.archived)
        && (options.cursor === undefined || entry.id > options.cursor)
        && (options.workspaceId === undefined || entry.workItem?.workspaceId === options.workspaceId || (entry.workItem === undefined && inspection.kind === 'workspace'))
        && (options.sessionId === undefined || entry.workItem?.sessionIds.includes(options.sessionId) === true)
        && (options.status === undefined || entry.status === options.status));
      const tasks = matching.slice(0, limit);
      return { tasks, issues: survey.tasks.filter((entry) => !entry.valid), next_cursor: matching.length > tasks.length ? tasks.at(-1)?.id : undefined };
    },
    async createTask(options) {
      invalidate(options.root);
      try { return await api.createTask(options); }
      finally { invalidate(options.root); }
    },
    async updateWorkItem(options) {
      invalidate(options.root);
      try { return await api.updateWorkItem(options); }
      finally { invalidate(options.root); }
    },
  };
}
