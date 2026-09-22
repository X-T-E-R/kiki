import { LocalizedError, issueText, type I18nKey, type ValidationIssue } from '@kiki/session-core/i18n';
import type { BoardCard, BoardClient, BoardCreateTarget, BoardOverviewClient, BoardPage, BoardPatch, BoardResult, BoardStorageRef, BoardSummary, BoardWriteInput } from '@kiki/klient/contract/board/types';

export interface TaskBoardClient extends BoardClient {
  readonly overview?: BoardOverviewClient['overview'];
}
export function boardCardKey(card: Pick<BoardSummary, 'id' | 'workspaceId' | 'storage'>): string {
  return JSON.stringify([card.workspaceId, card.storage.root, card.storage.storageId, card.id]);
}
export interface BoardWorkspaceIssue {
  readonly workspaceId?: string;
  readonly code: string;
  readonly message: string;
  readonly issue: ValidationIssue;
}
export interface TaskBoardSnapshot {
  readonly cards: readonly (BoardSummary | BoardCard)[];
  readonly loading: boolean;
  readonly creating: boolean;
  readonly pendingKeys: readonly string[];
  readonly error: ValidationIssue | null;
  /** Refresh-time degradation: per-workspace load failures. */
  readonly issues: readonly BoardWorkspaceIssue[];
  /** Card-level load issues reported by otherwise healthy workspaces. */
  readonly cardIssues: readonly BoardWorkspaceIssue[];
  /** The last refresh could not load ANY workspace — the host cannot serve the board. */
  readonly refreshFailed: boolean;
}
interface WorkspaceRefresh {
  readonly cards: readonly BoardSummary[];
  readonly cardIssues: readonly BoardWorkspaceIssue[];
  readonly issue?: BoardWorkspaceIssue;
  readonly nextCursor?: string;
}
function unwrap<T>(result: BoardResult<T>): T {
  if (!result.ok) {
    const issue: ValidationIssue = {
      key: 'taskBoard.error.requestFailed',
      params: { code: String(result.error.code), message: result.error.message },
    };
    throw Object.assign(new LocalizedError(issue), { code: result.error.code });
  }
  return result.value;
}
function issueFromError(error: unknown, fallbackKey: I18nKey = 'taskBoard.error.operationFailed'): ValidationIssue {
  if (error instanceof LocalizedError) return error.issue;
  return {
    key: fallbackKey,
    params: error instanceof Error ? { detail: error.message } : undefined,
  };
}
function errorMessage(error: unknown): string {
  if (error instanceof LocalizedError) return error.message;
  return error instanceof Error ? error.message : issueText('en', issueFromError(error));
}
function errorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number')) return String(error.code);
  return 'BOARD_REQUEST_FAILED';
}
function workspaceIssue(workspaceId: string | undefined, code: string, issue: ValidationIssue): BoardWorkspaceIssue {
  const result = { workspaceId, code, message: issueText('en', issue) } as BoardWorkspaceIssue;
  Object.defineProperty(result, 'issue', { value: issue, enumerable: false });
  return result;
}
function workspaceFailure(workspaceId: string, error: unknown): WorkspaceRefresh {
  const issue = issueFromError(error);
  return { cards: [], cardIssues: [], issue: workspaceIssue(workspaceId, errorCode(error), issue) };
}
function isOverviewMethodUnavailable(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 40001) return false;
  const message = errorMessage(error).trim().toLowerCase();
  return message === 'method not found: taskboardservice.overview'
    || message === 'unknown klient procedure: taskboardservice.overview'
    || message === 'service not available in app scope: taskboardservice';
}

const REFRESH_CONCURRENCY = 8;
const MAX_PAGES = 100;

async function mapBounded<T>(items: readonly T[], signal: AbortSignal, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, items.length) }, async () => {
    while (next < items.length && !signal.aborted) {
      const item = items[next++]!;
      await fn(item);
    }
  }));
}

function idle(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { signal.removeEventListener('abort', cancel); resolve(); };
    const useIdle = typeof requestIdleCallback === 'function';
    const handle = useIdle ? requestIdleCallback(done, { timeout: 200 }) : setTimeout(done, 16);
    const cancel = () => {
      if (useIdle) cancelIdleCallback(handle as number);
      else clearTimeout(handle);
      done();
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export class TaskBoardController {
  private state: TaskBoardSnapshot = { cards: [], loading: false, creating: false, pendingKeys: [], error: null, issues: [], cardIssues: [], refreshFailed: false };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private refreshAbort?: AbortController;
  private accepted = new Map<string, BoardCard>();
  private intent?: { key: string; workspaceId: string; target: BoardCreateTarget };
  private sources = new Map<string, BoardStorageRef>();
  private creating?: Promise<void>;
  private pending = new Map<string, Promise<void>>();
  private overviewUnavailable = false;

  constructor(private readonly client: TaskBoardClient) {}
  readonly getSnapshot = (): TaskBoardSnapshot => this.state;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  cancelRefresh(): void {
    this.epoch += 1;
    this.refreshAbort?.abort();
  }
  private publish(patch: Partial<TaskBoardSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private accept(card: BoardCard): void {
    const key = boardCardKey(card);
    const previous = this.state.cards.find((entry) => boardCardKey(entry) === key);
    if (previous && previous.revision > card.revision) return;
    // Keep successful edits and detail reads while later summary pages arrive.
    this.accepted.set(key, card);
    this.publish({ cards: previous ? this.state.cards.map((entry) => boardCardKey(entry) === key ? card : entry) : [...this.state.cards, card], error: null });
  }
  private pageRefresh(workspaceId: string, page: BoardPage): WorkspaceRefresh {
    if (page.storage) this.sources.set(workspaceId, page.storage);
    return {
      cards: page.cards,
      cardIssues: page.issues.map((issue) => workspaceIssue(workspaceId, issue.code, { key: 'taskBoard.error.cardIssue', params: { message: issue.message } })),
      nextCursor: page.nextCursor,
    };
  }
  private async readWorkspace(workspaceId: string, signal: AbortSignal, sessionId?: string, cursor?: string): Promise<WorkspaceRefresh> {
    try {
      signal.throwIfAborted();
      const value = unwrap(await this.client.read({ action: 'list', workspaceId, storage: this.sources.get(workspaceId), sessionId, cursor, limit: 100 }, { signal }));
      signal.throwIfAborted();
      if (!('cards' in value) || value.workspaceId !== workspaceId) throw new LocalizedError({ key: 'taskBoard.error.invalidListResponse' });
      return this.pageRefresh(workspaceId, value);
    } catch (error) {
      return workspaceFailure(workspaceId, error);
    }
  }
  private async readOverview(workspaceIds: readonly string[], signal: AbortSignal): Promise<WorkspaceRefresh[]> {
    const entries = unwrap(await this.client.overview!({ signal }));
    signal.throwIfAborted();
    const byWorkspace = new Map(entries.map((entry) => [entry.workspaceId, entry]));
    return workspaceIds.map((workspaceId) => {
      const entry = byWorkspace.get(workspaceId);
      if (entry === undefined) {
        return workspaceFailure(workspaceId, Object.assign(new LocalizedError({ key: 'taskBoard.error.overviewIncomplete' }), { code: 'BOARD_OVERVIEW_INCOMPLETE' }));
      }
      try {
        const page = unwrap(entry.result);
        if (page.workspaceId !== workspaceId) {
          throw Object.assign(new LocalizedError({ key: 'taskBoard.error.overviewPageIncomplete' }), { code: 'BOARD_OVERVIEW_INCOMPLETE' });
        }
        return this.pageRefresh(workspaceId, page);
      } catch (error) {
        return workspaceFailure(workspaceId, error);
      }
    });
  }

  async refresh(workspaceIds: readonly string[], sessionId?: string): Promise<void> {
    this.cancelRefresh();
    const epoch = this.epoch;
    const abort = new AbortController();
    this.refreshAbort = abort;
    const { signal } = abort;
    this.accepted.clear();
    this.publish({ loading: true, error: null, issues: [], cardIssues: [], refreshFailed: false });
    const unique = [...new Set(workspaceIds)];
    const pages = new Map<string, WorkspaceRefresh>();
    const publishPages = (loading: boolean) => {
      if (signal.aborted || epoch !== this.epoch) return;
      const ordered = unique.flatMap((id) => pages.has(id) ? [pages.get(id)!] : []);
      const cards = new Map(ordered.flatMap((page) => page.cards).map((card) => [boardCardKey(card), card]));
      for (const [key, card] of this.accepted) {
        if ((cards.get(key)?.revision ?? -1) <= card.revision) cards.set(key, card);
      }
      const issues = ordered.flatMap((page) => page.issue ? [page.issue] : []);
      const cardIssues = [...new Map(ordered.flatMap((page) => page.cardIssues).map((issue) => [JSON.stringify([issue.workspaceId, issue.code, issue.message]), issue])).values()];
      this.publish({ cards: [...cards.values()], loading, issues, cardIssues, refreshFailed: !loading && unique.length > 0 && issues.length === unique.length && cards.size === 0 });
    };
    const readFirstPages = () => mapBounded(unique, signal, async (workspaceId) => {
      pages.set(workspaceId, await this.readWorkspace(workspaceId, signal, sessionId));
      publishPages(true);
    });
    // Single-workspace reads never enumerate unrelated workspace stores.
    if (unique.length > 1 && sessionId === undefined && !this.overviewUnavailable && this.client.overview !== undefined) {
      try {
        const overview = await this.readOverview(unique, signal);
        overview.forEach((page, index) => pages.set(unique[index]!, page));
      } catch (error) {
        if (signal.aborted) return;
        if (isOverviewMethodUnavailable(error)) {
          this.overviewUnavailable = true;
          await readFirstPages();
        } else unique.forEach((id) => pages.set(id, workspaceFailure(id, error)));
      }
    } else await readFirstPages();
    if (signal.aborted) return;
    const remaining = unique.filter((id) => pages.get(id)?.nextCursor !== undefined);
    publishPages(remaining.length > 0);
    // Return the first-page snapshot; continuation yields between pages so the
    // browser can paint and input/scope changes can cancel queued work.
    void mapBounded(remaining, signal, async (workspaceId) => {
      const seen = new Set<string>();
      let page = pages.get(workspaceId)!;
      while (page.nextCursor !== undefined && !signal.aborted) {
        const cursor = page.nextCursor;
        if (seen.has(cursor) || seen.size >= MAX_PAGES - 1) {
          pages.set(workspaceId, { ...page, nextCursor: undefined, issue: workspaceFailure(workspaceId, new LocalizedError({ key: 'taskBoard.error.paginationDidNotAdvance' })).issue });
          break;
        }
        seen.add(cursor);
        await idle(signal);
        if (signal.aborted) return;
        const next = await this.readWorkspace(workspaceId, signal, sessionId, cursor);
        if (signal.aborted) return;
        page = { ...next, cards: [...page.cards, ...next.cards], cardIssues: [...page.cardIssues, ...next.cardIssues] };
        pages.set(workspaceId, page);
        publishPages(true);
      }
    }).then(() => { publishPages(false); });
  }

  async open(key: string): Promise<void> {
    const card = this.state.cards.find((entry) => boardCardKey(entry) === key);
    if (!card) throw new LocalizedError({ key: 'taskBoard.error.cardGone' });
    try {
      const detail = unwrap(await this.client.read({ action: 'show', workspaceId: card.workspaceId, storage: card.storage, id: card.id }));
      if (!('description' in detail)) throw new LocalizedError({ key: 'taskBoard.error.invalidDetailResponse' });
      this.accept(detail);
    } catch (error) {
      this.publish({ error: issueFromError(error) });
      throw error;
    }
  }

  create(input: Omit<Extract<BoardWriteInput, { action: 'create' }>, 'action' | 'target'> & { workspaceId: string }): Promise<void> {
    if (this.creating) return this.creating;
    this.publish({ creating: true, error: null });
    const operation = Promise.resolve().then(async () => {
      try {
        if (!this.intent || this.intent.key !== input.requestKey) {
          const preview = unwrap(await this.client.read({ action: 'preview', workspaceId: input.workspaceId }));
          if (!('selectionOnly' in preview)) throw new LocalizedError({ key: 'taskBoard.error.invalidPreviewResponse' });
          this.intent = { key: input.requestKey, workspaceId: input.workspaceId, target: { root: preview.root, storageId: preview.storageId, kind: preview.kind } };
        }
        if (this.intent.workspaceId !== input.workspaceId) throw new LocalizedError({ key: 'taskBoard.error.createWorkspaceMismatch' });
        const card = unwrap(await this.client.write({ action: 'create', ...input, target: this.intent.target }));
        this.sources.set(card.workspaceId, card.storage);
        this.accept(card);
        this.intent = undefined;
      } catch (error) {
        this.publish({ error: issueFromError(error) });
        throw error;
      } finally {
        this.creating = undefined;
        this.publish({ creating: false });
      }
    });
    this.creating = operation;
    return operation;
  }

  update(key: string, expectedRevision: number, patch: BoardPatch): Promise<void> {
    const pending = this.pending.get(key);
    if (pending) return pending;
    const card = this.state.cards.find((entry) => boardCardKey(entry) === key);
    if (!card) return Promise.reject(new LocalizedError({ key: 'taskBoard.error.cardGone' }));
    this.publish({ pendingKeys: [...this.state.pendingKeys, key], error: null });
    const operation = Promise.resolve().then(async () => {
      try {
        this.accept(unwrap(await this.client.write({ action: 'update', workspaceId: card.workspaceId, storage: card.storage, id: card.id, expectedRevision, patch })));
      } catch (error) {
        this.publish({ error: issueFromError(error) });
        throw error;
      } finally {
        this.pending.delete(key);
        this.publish({ pendingKeys: this.state.pendingKeys.filter((entry) => entry !== key) });
      }
    });
    this.pending.set(key, operation);
    return operation;
  }
}
