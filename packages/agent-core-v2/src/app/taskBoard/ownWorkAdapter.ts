import path from 'node:path';
import { z } from 'zod';
import { BoardReadSchema, BoardWriteSchema, type BoardCard, type BoardIssue, type BoardPage, type BoardPatch, type BoardReadInput, type BoardReadValue, type BoardResult, type BoardStatus, type BoardStorageRef, type BoardSummary, type BoardWriteInput, type ITaskBoardService } from './taskBoard';
import type { BoardStorageConfig } from './configSection';
import { openBoardStorage, prepareBoardStorage, previewBoardStorage, type BoardStorageApi, type BoardStorageContext, type BoardStoragePreview } from './storage';

export interface OwnWorkItemSummary {
  readonly workspaceId: string;
  readonly category: string;
  readonly sessionIds: readonly string[];
  readonly executionIds: readonly string[];
  readonly updatedAt: string;
}
export interface OwnWorkTaskRecord {
  readonly archived: boolean;
  readonly revision: number;
  readonly task: {
    readonly id: string; readonly title: string; readonly description: string; readonly priority: string;
    readonly status: BoardStatus; readonly createdAt: string; readonly completedAt: string | null;
    readonly meta: Record<string, unknown>;
  };
  readonly prd: string;
  readonly handoff?: string;
}
export interface OwnWorkListEntry {
  readonly id: string; readonly title?: string; readonly priority?: string; readonly status?: BoardStatus;
  readonly revision?: number; readonly createdAt?: string; readonly completedAt?: string | null;
  readonly archived: boolean; readonly workItem?: OwnWorkItemSummary;
}

/** Required native API surface; legacy 0.1.1 alone does not implement this embedded work-item contract. */
export interface OwnWorkTaskApi extends BoardStorageApi {
  createTask(options: {
    readonly root: string; readonly title: string; readonly description?: string; readonly priority?: string;
    readonly workItem: { readonly workspaceId: string; readonly requestKey: string; readonly category?: string; readonly sessionIds?: string[]; readonly executionIds?: string[] };
  }): Promise<OwnWorkTaskRecord>;
  peekTask(options: { readonly root: string; readonly id: string }): Promise<OwnWorkTaskRecord>;
  listTasks(options: { readonly root: string; readonly workspaceId?: string; readonly sessionId?: string; readonly status?: BoardStatus; readonly archived?: boolean; readonly limit?: number; readonly cursor?: string }): Promise<{
    readonly tasks: readonly OwnWorkListEntry[];
    readonly issues: readonly { readonly id: string; readonly path: string; readonly archived: boolean; readonly valid: boolean; readonly issues: readonly BoardIssue[] }[];
    readonly next_cursor?: string;
  }>;
  updateWorkItem(options: { readonly root: string; readonly workspaceId: string; readonly id: string; readonly expectedRevision: number; readonly patch: BoardPatch }): Promise<OwnWorkTaskRecord>;
}

/** Host-owned workspace lease and root authorization; no directory discovery or card state lives here. */
export interface BoardWorkspaceAccess {
  currentWorkspaceId(): string | undefined;
  storageConfig(): BoardStorageConfig;
  withWorkspace<T>(workspaceId: string, operation: 'read' | 'write', use: (context: BoardStorageContext) => Promise<T>): Promise<T>;
}

const itemSchema = z.object({ workspaceId: z.string(), category: z.string(), sessionIds: z.array(z.string()), executionIds: z.array(z.string()), updatedAt: z.string() });
function fail<T>(code: string, message: string): BoardResult<T> { return { ok: false, error: { code, message } }; }
function failure<T>(error: unknown): BoardResult<T> {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && (error.code.startsWith('TASK_') || error.code.startsWith('BOARD_') || error.code === 'WORKSPACE_NOT_FOUND')) {
    return fail(error.code, error instanceof Error ? error.message : 'Own Work rejected the operation.');
  }
  return fail('BOARD_UNAVAILABLE', 'Own Work storage is unavailable or incompatible. No fallback store was selected.');
}
function owns(context: BoardStorageContext, storage: BoardStorageRef, item: OwnWorkItemSummary | undefined): boolean {
  return item ? item.workspaceId === context.workspaceId : storage.kind === 'workspace' && path.resolve(storage.root) === path.resolve(context.workspaceRoot);
}
function summary(context: BoardStorageContext, storage: BoardStorageRef, entry: OwnWorkListEntry): BoardResult<BoardSummary> {
  if (!owns(context, storage, entry.workItem)) return fail('BOARD_WORKSPACE_MISMATCH', 'The record belongs to another workspace or has no ownership in a shared store.');
  if (entry.title === undefined || entry.status === undefined || entry.revision === undefined || entry.priority === undefined || entry.createdAt === undefined) {
    return fail('BOARD_API_INCOMPATIBLE', 'Own Work did not provide the required summary contract.');
  }
  return { ok: true, value: {
    id: entry.id, workspaceId: context.workspaceId, storage, title: entry.title, priority: entry.priority,
    status: entry.status, revision: entry.revision, createdAt: entry.createdAt, updatedAt: entry.workItem?.updatedAt ?? entry.createdAt,
    completedAt: entry.completedAt ?? null, archived: entry.archived, category: entry.workItem?.category ?? '',
    sessionIds: entry.workItem?.sessionIds ?? [], executionIds: entry.workItem?.executionIds ?? [],
  } };
}
function project(context: BoardStorageContext, storage: BoardStorageRef, record: OwnWorkTaskRecord): BoardResult<BoardCard> {
  const meta = record.task.meta['own_work_item'];
  const workItem = meta === undefined ? undefined : itemSchema.parse(meta);
  const result = summary(context, storage, { ...record.task, revision: record.revision, archived: record.archived, workItem });
  return result.ok ? { ok: true, value: { ...result.value, description: record.task.description, prd: record.prd, handoff: record.handoff } } : result;
}

export function createOwnWorkBoardService(api: OwnWorkTaskApi, workspaces: BoardWorkspaceAccess): ITaskBoardService {
  async function access<T>(selected: string | undefined, operation: 'read' | 'write', use: (context: BoardStorageContext) => Promise<BoardResult<T>>): Promise<BoardResult<T>> {
    const workspaceId = selected ?? workspaces.currentWorkspaceId();
    if (!workspaceId) return fail('BOARD_WORKSPACE_REQUIRED', 'Select an authorized workspace.');
    try { return await workspaces.withWorkspace(workspaceId, operation, use); }
    catch (error) { return failure(error); }
  }
  async function page(input: Extract<BoardReadInput, { action: 'list' }>): Promise<BoardResult<BoardPage>> {
    return access(input.workspaceId, 'read', async (context) => {
      let storage: BoardStorageRef;
      if (input.storage) {
        const opened = await openBoardStorage(api, context, input.storage, 'read');
        if (!opened.ok) return opened;
        storage = opened.value;
      } else {
        const preview = await previewBoardStorage(api, context, workspaces.storageConfig());
        if (!preview.ok) return preview;
        if (!preview.value.existing) return { ok: true, value: { workspaceId: context.workspaceId, cards: [], issues: [] } };
        if (!preview.value.storageId) return fail('BOARD_STORAGE_INVALID', 'The existing store has no identity.');
        storage = { root: preview.value.root, storageId: preview.value.storageId, kind: preview.value.kind };
      }
      const listing = await api.listTasks({ root: storage.root, workspaceId: context.workspaceId, sessionId: input.sessionId, status: input.status, archived: input.archived, limit: input.limit ?? 50, cursor: input.cursor });
      const cards: BoardSummary[] = [];
      const issues = listing.issues.flatMap((entry) => entry.issues.map(({ code, message }) => ({ code, message: `${entry.path} (${entry.id}): ${message}` })));
      for (const entry of listing.tasks) {
        const projected = summary(context, storage, entry);
        if (projected.ok) cards.push(projected.value);
        else issues.push(projected.error);
      }
      return { ok: true, value: { workspaceId: context.workspaceId, storage, cards, issues, nextCursor: listing.next_cursor } };
    });
  }
  return {
    _serviceBrand: undefined,
    async read(raw: BoardReadInput): Promise<BoardResult<BoardReadValue>> {
      const parsed = BoardReadSchema.safeParse(raw);
      if (!parsed.success) return fail('BOARD_INPUT_INVALID', 'Invalid board request.');
      const input = parsed.data;
      if (input.action === 'list') return page(input);
      if (input.action === 'preview') return access(input.workspaceId, 'read', (context) => previewBoardStorage(api, context, input.configuration ?? workspaces.storageConfig()));
      if (input.action === 'show') return access(input.workspaceId, 'read', async (context) => {
        const opened = await openBoardStorage(api, context, input.storage, 'read');
        if (!opened.ok) return opened;
        return project(context, opened.value, await api.peekTask({ root: opened.value.root, id: input.id }));
      });
      const entries = [];
      for (const workspaceId of new Set(input.workspaceIds)) entries.push({ workspaceId, result: await page({ action: 'list', workspaceId, status: input.status, limit: input.limit }) });
      return { ok: true, value: entries };
    },
    async write(raw: BoardWriteInput): Promise<BoardResult<BoardCard>> {
      const parsed = BoardWriteSchema.safeParse(raw);
      if (!parsed.success) return fail('BOARD_INPUT_INVALID', 'Invalid board request.');
      const input = parsed.data;
      return access(input.workspaceId, 'write', async (context) => {
        if (input.action === 'update') {
          const opened = await openBoardStorage(api, context, input.storage, 'write');
          if (!opened.ok) return opened;
          const prior = project(context, opened.value, await api.peekTask({ root: opened.value.root, id: input.id }));
          if (!prior.ok) return prior;
          return project(context, opened.value, await api.updateWorkItem({ root: opened.value.root, workspaceId: context.workspaceId, id: input.id, expectedRevision: input.expectedRevision, patch: input.patch }));
        }
        let preview: BoardResult<BoardStoragePreview>;
        if (input.target) {
          if (!path.isAbsolute(input.target.root)) return fail('BOARD_STORAGE_INVALID', 'A creation target must be an absolute previewed location.');
          preview = { ok: true, value: { mode: 'fixed', workspaceId: context.workspaceId, root: input.target.root, tasksDirectory: path.join(input.target.root, 'tasks'), kind: input.target.kind, existing: input.target.storageId !== undefined, storageId: input.target.storageId, selectionOnly: true } };
        } else {
          preview = await previewBoardStorage(api, context, workspaces.storageConfig());
        }
        if (!preview.ok) return preview;
        const prepared = await prepareBoardStorage(api, context, preview.value);
        if (!prepared.ok) return prepared;
        const record = await api.createTask({ root: prepared.value.root, title: input.title, description: input.description, priority: input.priority,
          workItem: { workspaceId: context.workspaceId, requestKey: input.requestKey, category: input.category, sessionIds: input.sessionIds, executionIds: input.executionIds } });
        return project(context, prepared.value, record);
      });
    },
  };
}
