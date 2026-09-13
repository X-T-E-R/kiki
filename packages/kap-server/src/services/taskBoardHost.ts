import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import * as ownWork from 'own-work/tasks';
import { IBootstrapService, IConfigService, IWorkspaceService, IAtomicDocumentStore, type Scope } from '@kiki/agent-core-v2';
import { createOwnWorkBoardService, type OwnWorkTaskApi } from '@kiki/agent-core-v2/app/taskBoard/ownWorkAdapter';
import { TaskBoardConfigSchema } from '@kiki/agent-core-v2/app/taskBoard/configSection';
import type { BoardOverviewEntry, BoardPage, BoardReadInput, BoardResult, BoardWriteInput, ITaskBoardService } from '@kiki/agent-core-v2/app/taskBoard/taskBoard';

const bindingsSchema = z.array(z.object({ root: z.string(), canonical: z.string(), workspaceRoot: z.string() }));
const normalize = (root: string): string => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
const OVERVIEW_CONCURRENCY = 8;
const OVERVIEW_PAGE_LIMIT = 100;
const OVERVIEW_MAX_PAGES = 100;
type RegisteredWorkspace = { readonly id: string; readonly root: string };
export interface TaskBoardHost extends ITaskBoardService {
  overview(): Promise<BoardResult<readonly BoardOverviewEntry[]>>;
}
function denied(message: string): never { throw Object.assign(new Error(message), { code: 'BOARD_ACCESS_DENIED' }); }
function failed<T>(error: unknown): BoardResult<T> {
  const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'BOARD_UNAVAILABLE';
  return { ok: false, error: { code, message: error instanceof Error ? error.message : 'The task board is unavailable.' } };
}
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length) as R[];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
async function canonical(root: string): Promise<string> {
  try { return normalize(await realpath(root)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(root);
    if (parent === root) throw error;
    return normalize(path.join(await canonical(parent), path.basename(root)));
  }
}

export function createTaskBoardHost(getCore: () => Scope, api: OwnWorkTaskApi = ownWork): TaskBoardHost {
  const run = async (input: BoardReadInput | BoardWriteInput, write: boolean, knownWorkspace?: RegisteredWorkspace) => {
    const core = getCore();
    const config = TaskBoardConfigSchema.parse(core.accessor.get(IConfigService).get('taskBoard') ?? {}).storage;
    const selected = input.action === 'preview' && input.configuration !== undefined ? input.configuration : config;
    const previewOnly = input.action === 'preview';
    const docs = core.accessor.get(IAtomicDocumentStore);
    const host = core.accessor.get(IBootstrapService);
    const touched: Array<{ workspaceId: string; root: string; canonical: string; workspaceRoot: string }> = [];
    const adapter = createOwnWorkBoardService(api, {
      currentWorkspaceId: () => undefined,
      storageConfig: () => config,
      async withWorkspace(workspaceId, operation, use) {
        const registered = knownWorkspace?.id === workspaceId
          ? knownWorkspace
          : await core.accessor.get(IWorkspaceService).get(workspaceId);
        if (registered === undefined) throw Object.assign(new Error('Workspace is not registered.'), { code: 'WORKSPACE_NOT_FOUND' });
        const workspaceRoot = await canonical(registered.root);
        const bindings = bindingsSchema.parse(await docs.get('task-board-authorizations', workspaceId) ?? []);
        const candidates = [
          { root: registered.root, canonical: workspaceRoot },
          { root: path.join(host.homeDir, 'boards'), canonical: normalize(path.join(await canonical(host.homeDir), 'boards')) },
          { root: path.join(host.sessionsDir, workspaceId, '.board'), canonical: normalize(path.join(await canonical(host.sessionsDir), workspaceId, '.board')) },
        ];
        if (selected.mode === 'fixed' && selected.path) {
          const root = path.resolve(registered.root, selected.path);
          candidates.push({ root, canonical: await canonical(root) });
        }
        return await use({
          workspaceId, workspaceRoot: registered.root, homeDir: host.homeDir, sessionsDir: host.sessionsDir,
          async authorizeStorage(root, access) {
            if (!path.isAbsolute(root)) denied('A storage root must be absolute.');
            if (access === 'write' && operation !== 'write') denied('This operation does not authorize storage writes.');
            const resolved = normalize(root);
            const physical = await canonical(resolved);
            const old = bindings.find((binding) => normalize(binding.root) === resolved && binding.workspaceRoot === workspaceRoot);
            if (old && old.canonical !== physical) denied('The authorized storage path now points to a different directory.');
            if (!old && !candidates.some((candidate) => normalize(candidate.root) === resolved && candidate.canonical === physical)) denied('This storage location has not been authorized for the workspace.');
            if (!previewOnly) touched.push({ workspaceId, root: resolved, canonical: physical, workspaceRoot });
          },
        });
      },
    });
    const result = write ? await adapter.write(input as BoardWriteInput) : await adapter.read(input as BoardReadInput);
    if (result.ok && !previewOnly) {
      for (const binding of touched) {
        await docs.update('task-board-authorizations', binding.workspaceId, (raw: unknown) => {
          const previous = bindingsSchema.parse(raw ?? []);
          if (previous.some((entry) => entry.root === binding.root && entry.workspaceRoot === binding.workspaceRoot)) return previous;
          return [...previous, { root: binding.root, canonical: binding.canonical, workspaceRoot: binding.workspaceRoot }];
        });
      }
    }
    return result;
  };
  const read = (input: BoardReadInput, knownWorkspace?: RegisteredWorkspace) => run(input, false, knownWorkspace) as ReturnType<ITaskBoardService['read']>;
  const overviewEntry = async (workspace: RegisteredWorkspace): Promise<BoardOverviewEntry> => {
    try {
      const cards: BoardPage['cards'][number][] = [];
      const issues: BoardPage['issues'][number][] = [];
      let storage: BoardPage['storage'];
      let cursor: string | undefined;
      let pageCount = 0;
      const seen = new Set<string>();
      do {
        if (pageCount >= OVERVIEW_MAX_PAGES) {
          return { workspaceId: workspace.id, result: failed(Object.assign(new Error(`Board pagination exceeded ${OVERVIEW_MAX_PAGES} pages.`), { code: 'BOARD_PAGINATION_LIMIT' })) };
        }
        pageCount += 1;
        const result = await read({ action: 'list', workspaceId: workspace.id, storage, cursor, limit: OVERVIEW_PAGE_LIMIT }, workspace);
        if (!result.ok) return { workspaceId: workspace.id, result };
        const value = result.value;
        if (!('cards' in value) || !('issues' in value)) {
          return { workspaceId: workspace.id, result: failed(Object.assign(new Error('The board list returned an invalid response.'), { code: 'BOARD_RESPONSE_INVALID' })) };
        }
        storage ??= value.storage;
        cards.push(...value.cards);
        issues.push(...value.issues);
        cursor = value.nextCursor;
        if (cursor !== undefined) {
          if (seen.has(cursor)) {
            return { workspaceId: workspace.id, result: failed(Object.assign(new Error('Board pagination did not advance.'), { code: 'BOARD_PAGINATION_INVALID' })) };
          }
          seen.add(cursor);
        }
      } while (cursor !== undefined);
      return { workspaceId: workspace.id, result: { ok: true, value: { workspaceId: workspace.id, storage, cards, issues } } };
    } catch (error) {
      return { workspaceId: workspace.id, result: failed(error) };
    }
  };
  return {
    _serviceBrand: undefined,
    read: (input) => read(input),
    write: (input) => run(input, true) as ReturnType<ITaskBoardService['write']>,
    async overview() {
      try {
        const workspaces = await getCore().accessor.get(IWorkspaceService).list();
        return { ok: true, value: await mapBounded(workspaces, OVERVIEW_CONCURRENCY, overviewEntry) };
      } catch (error) {
        return failed(error);
      }
    },
  };
}
