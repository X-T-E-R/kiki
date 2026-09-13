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
}
export interface TaskBoardSnapshot {
  readonly cards: readonly (BoardSummary | BoardCard)[];
  readonly loading: boolean;
  readonly creating: boolean;
  readonly pendingKeys: readonly string[];
  readonly error: string | null;
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
}
function unwrap<T>(result: BoardResult<T>): T {
  if (!result.ok) throw Object.assign(new Error(`${result.error.code}: ${result.error.message}`), { code: result.error.code });
  return result.value;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'The board operation failed.'; }
function errorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return 'BOARD_REQUEST_FAILED';
}
function workspaceFailure(workspaceId: string, error: unknown): WorkspaceRefresh {
  return { cards: [], cardIssues: [], issue: { workspaceId, code: errorCode(error), message: errorMessage(error) } };
}
function isOverviewMethodUnavailable(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 40001) return false;
  const message = errorMessage(error).trim().toLowerCase();
  return message === 'method not found: taskboardservice.overview'
    || message === 'unknown klient procedure: taskboardservice.overview'
    || message === 'service not available in app scope: taskboardservice';
}

const REFRESH_CONCURRENCY = 8;

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

export class TaskBoardController {
  private state: TaskBoardSnapshot = { cards: [], loading: false, creating: false, pendingKeys: [], error: null, issues: [], cardIssues: [], refreshFailed: false };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private intent?: { key: string; workspaceId: string; target: BoardCreateTarget };
  private sources = new Map<string, BoardStorageRef>();
  private creating?: Promise<void>;
  private pending = new Map<string, Promise<void>>();
  private overviewUnavailable = false;

  constructor(private readonly client: TaskBoardClient) {}
  readonly getSnapshot = (): TaskBoardSnapshot => this.state;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(patch: Partial<TaskBoardSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private accept(card: BoardCard): void {
    const key = boardCardKey(card);
    const previous = this.state.cards.find((entry) => boardCardKey(entry) === key);
    if (previous && previous.revision > card.revision) return;
    this.epoch += 1;
    this.publish({ loading: false, cards: previous ? this.state.cards.map((entry) => boardCardKey(entry) === key ? card : entry) : [...this.state.cards, card], error: null });
  }
  private pageRefresh(workspaceId: string, page: BoardPage): WorkspaceRefresh {
    if (page.storage) this.sources.set(workspaceId, page.storage);
    return {
      cards: page.cards,
      cardIssues: page.issues.map((issue) => ({ workspaceId, code: issue.code, message: issue.message })),
      issue: undefined,
    };
  }
  private async readWorkspace(workspaceId: string, sessionId?: string): Promise<WorkspaceRefresh> {
    try {
      const cards: BoardSummary[] = [];
      const cardIssues: BoardWorkspaceIssue[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const value = unwrap(await this.client.read({ action: 'list', workspaceId, storage: this.sources.get(workspaceId), sessionId, cursor, limit: 100 }));
        if (!('cards' in value)) throw new Error('Invalid board list response.');
        const page: BoardPage = value;
        if (page.storage) this.sources.set(workspaceId, page.storage);
        cards.push(...page.cards);
        cardIssues.push(...page.issues.map((issue) => ({ workspaceId, code: issue.code, message: issue.message })));
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Board pagination did not advance.');
        if (cursor) seen.add(cursor);
      } while (cursor);
      return { cards, cardIssues, issue: undefined };
    } catch (error) {
      return workspaceFailure(workspaceId, error);
    }
  }
  private async readOverview(workspaceIds: readonly string[]): Promise<WorkspaceRefresh[]> {
    const entries = unwrap(await this.client.overview!());
    const byWorkspace = new Map(entries.map((entry) => [entry.workspaceId, entry]));
    return workspaceIds.map((workspaceId) => {
      const entry = byWorkspace.get(workspaceId);
      if (entry === undefined) {
        return workspaceFailure(workspaceId, Object.assign(new Error('The board overview omitted this workspace.'), { code: 'BOARD_OVERVIEW_INCOMPLETE' }));
      }
      try {
        const page = unwrap(entry.result);
        if (page.workspaceId !== workspaceId || page.nextCursor !== undefined) {
          throw Object.assign(new Error('The board overview returned an incomplete workspace page.'), { code: 'BOARD_OVERVIEW_INCOMPLETE' });
        }
        return this.pageRefresh(workspaceId, page);
      } catch (error) {
        return workspaceFailure(workspaceId, error);
      }
    });
  }

  async refresh(workspaceIds: readonly string[], sessionId?: string): Promise<void> {
    const epoch = ++this.epoch;
    this.publish({ loading: true, error: null, issues: [], cardIssues: [], refreshFailed: false });
    const unique = [...new Set(workspaceIds)];
    // One workspace's broken store must not take the whole board down: each
    // workspace is listed independently and its failure lands in `issues`,
    // while per-card parse failures land separately in `cardIssues`. Fan-out
    // is bounded; results merge in `unique` order so the published snapshot is
    // deterministic regardless of completion order.
    let pages: WorkspaceRefresh[];
    if (unique.length > 0 && sessionId === undefined && !this.overviewUnavailable && this.client.overview !== undefined) {
      try {
        pages = await this.readOverview(unique);
      } catch (error) {
        if (isOverviewMethodUnavailable(error)) {
          this.overviewUnavailable = true;
          pages = await mapBounded(unique, REFRESH_CONCURRENCY, (workspaceId) => this.readWorkspace(workspaceId, sessionId));
        } else {
          pages = unique.map((workspaceId) => workspaceFailure(workspaceId, error));
        }
      }
    } else {
      pages = await mapBounded(unique, REFRESH_CONCURRENCY, (workspaceId) => this.readWorkspace(workspaceId, sessionId));
    }
    const cards = pages.flatMap((page) => page.cards);
    const cardIssues = pages.flatMap((page) => page.cardIssues);
    const issues = pages.flatMap((page) => (page.issue === undefined ? [] : [page.issue]));
    if (epoch === this.epoch) this.publish({ cards, loading: false, issues, cardIssues, refreshFailed: unique.length > 0 && issues.length === unique.length });
  }

  async open(key: string): Promise<void> {
    const card = this.state.cards.find((entry) => boardCardKey(entry) === key);
    if (!card) throw new Error('The card is no longer in this view.');
    try {
      const detail = unwrap(await this.client.read({ action: 'show', workspaceId: card.workspaceId, storage: card.storage, id: card.id }));
      if (!('description' in detail)) throw new Error('Invalid board detail response.');
      this.accept(detail);
    } catch (error) {
      this.publish({ error: errorMessage(error) });
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
          if (!('selectionOnly' in preview)) throw new Error('Invalid board storage preview response.');
          this.intent = { key: input.requestKey, workspaceId: input.workspaceId, target: { root: preview.root, storageId: preview.storageId, kind: preview.kind } };
        }
        if (this.intent.workspaceId !== input.workspaceId) throw new Error('The pending create belongs to another workspace. Resolve it before changing the workspace.');
        const card = unwrap(await this.client.write({ action: 'create', ...input, target: this.intent.target }));
        this.sources.set(card.workspaceId, card.storage);
        this.accept(card);
        this.intent = undefined;
      } catch (error) {
        this.publish({ error: errorMessage(error) });
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
    if (!card) return Promise.reject(new Error('The card is no longer in this view.'));
    this.publish({ pendingKeys: [...this.state.pendingKeys, key], error: null });
    const operation = Promise.resolve().then(async () => {
      try {
        this.accept(unwrap(await this.client.write({ action: 'update', workspaceId: card.workspaceId, storage: card.storage, id: card.id, expectedRevision, patch })));
      } catch (error) {
        this.publish({ error: errorMessage(error) });
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
