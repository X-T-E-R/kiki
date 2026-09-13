import type { BoardCard, BoardClient, BoardCreateTarget, BoardPage, BoardPatch, BoardResult, BoardStorageRef, BoardSummary, BoardWriteInput } from '@kiki/klient/contract/board/types';

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
function unwrap<T>(result: BoardResult<T>): T {
  if (!result.ok) throw Object.assign(new Error(`${result.error.code}: ${result.error.message}`), { code: result.error.code });
  return result.value;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'The board operation failed.'; }
function errorCode(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return 'BOARD_REQUEST_FAILED';
}

export class TaskBoardController {
  private state: TaskBoardSnapshot = { cards: [], loading: false, creating: false, pendingKeys: [], error: null, issues: [], cardIssues: [], refreshFailed: false };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private intent?: { key: string; workspaceId: string; target: BoardCreateTarget };
  private sources = new Map<string, BoardStorageRef>();
  private creating?: Promise<void>;
  private pending = new Map<string, Promise<void>>();

  constructor(private readonly client: BoardClient) {}
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

  async refresh(workspaceIds: readonly string[], sessionId?: string): Promise<void> {
    const epoch = ++this.epoch;
    this.publish({ loading: true, error: null, issues: [], cardIssues: [], refreshFailed: false });
    const cards: BoardSummary[] = [];
    const issues: BoardWorkspaceIssue[] = [];
    const cardIssues: BoardWorkspaceIssue[] = [];
    let attempted = 0;
    let failed = 0;
    // One workspace's broken store must not take the whole board down: each
    // workspace is listed independently and its failure lands in `issues`,
    // while per-card parse failures land separately in `cardIssues`.
    for (const workspaceId of new Set(workspaceIds)) {
      attempted += 1;
      try {
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
      } catch (error) {
        failed += 1;
        issues.push({ workspaceId, code: errorCode(error), message: errorMessage(error) });
      }
    }
    if (epoch === this.epoch) this.publish({ cards, loading: false, issues, cardIssues, refreshFailed: attempted > 0 && failed === attempted });
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
