import { spaceStorage, type SpaceStorage } from '../storage/spaceStorage';

export const INTENT_OUTBOX_STORAGE_KEY = 'kiki.sessionTriageOutbox';
export const INTENT_OUTBOX_MIN_BACKOFF_MS = 1_000;
export const INTENT_OUTBOX_MAX_BACKOFF_MS = 30_000;

export type TriageIntent =
  | { readonly kind: 'archive'; readonly sessionId: string }
  | { readonly kind: 'unarchive'; readonly sessionId: string }
  | { readonly kind: 'markRead'; readonly sessionId: string; readonly readAt?: number }
  | { readonly kind: 'rename'; readonly sessionId: string; readonly title: string };

export type TriageIntentSlot = 'archive' | 'read' | 'rename';

export interface OutboxEntry {
  readonly slotKey: string;
  readonly intent: TriageIntent;
  readonly revision: number;
  readonly createdAt: number;
  readonly attempts: number;
}

export interface IntentOverlay {
  readonly archived: ReadonlyMap<string, boolean>;
  readonly read: ReadonlySet<string>;
  readonly titles: ReadonlyMap<string, string>;
}

export interface IntentOutboxOptions {
  readonly dispatch: (intent: TriageIntent) => Promise<void>;
  readonly storage?: SpaceStorage | null;
  readonly isPermanentError?: (error: unknown) => boolean;
  readonly now?: () => number;
  readonly scheduleTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export function triageIntentSlot(kind: TriageIntent['kind']): TriageIntentSlot {
  return kind === 'archive' || kind === 'unarchive' ? 'archive' : kind === 'markRead' ? 'read' : 'rename';
}

export function triageSlotKey(intent: Pick<TriageIntent, 'kind' | 'sessionId'>): string {
  return `${triageIntentSlot(intent.kind)}|${intent.sessionId}`;
}

export function triageBackoffMs(attempts: number): number {
  return Math.min(INTENT_OUTBOX_MIN_BACKOFF_MS * 2 ** Math.max(0, Math.min(attempts - 1, 5)), INTENT_OUTBOX_MAX_BACKOFF_MS);
}

export function projectIntentOverlay(entries: readonly OutboxEntry[]): IntentOverlay {
  const archived = new Map<string, boolean>();
  const read = new Set<string>();
  const titles = new Map<string, string>();
  for (const { intent } of entries) {
    if (intent.kind === 'archive') archived.set(intent.sessionId, true);
    else if (intent.kind === 'unarchive') archived.set(intent.sessionId, false);
    else if (intent.kind === 'markRead') read.add(intent.sessionId);
    else titles.set(intent.sessionId, intent.title);
  }
  return { archived, read, titles };
}

function defaultStorage(): SpaceStorage | null {
  try { return typeof localStorage === 'undefined' ? null : spaceStorage.capture(); }
  catch { return null; }
}

function parseEntry(raw: unknown): OutboxEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const i = r['intent'] as Record<string, unknown> | undefined;
  if (typeof i !== 'object' || i === null || typeof i['sessionId'] !== 'string' || i['sessionId'] === '') return null;
  const sessionId = i['sessionId'];
  let intent: TriageIntent | null = null;
  if (i['kind'] === 'archive' || i['kind'] === 'unarchive') intent = { kind: i['kind'], sessionId };
  else if (i['kind'] === 'markRead') intent = typeof i['readAt'] === 'number' ? { kind: 'markRead', sessionId, readAt: i['readAt'] } : { kind: 'markRead', sessionId };
  else if (i['kind'] === 'rename' && typeof i['title'] === 'string') intent = { kind: 'rename', sessionId, title: i['title'] };
  if (intent === null) return null;
  return {
    slotKey: triageSlotKey(intent),
    intent,
    revision: typeof r['revision'] === 'number' ? r['revision'] : 1,
    createdAt: typeof r['createdAt'] === 'number' ? r['createdAt'] : 0,
    attempts: typeof r['attempts'] === 'number' && r['attempts'] >= 0 ? r['attempts'] : 0,
  };
}

export class IntentOutbox {
  private readonly entries = new Map<string, OutboxEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly storage: SpaceStorage | null;
  private cachedOverlay: IntentOverlay = projectIntentOverlay([]);
  private nextRevision = 1;
  private flushing = false;
  private kickRequested = false;
  private disposed = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: IntentOutboxOptions) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.restore();
  }

  get overlay(): IntentOverlay { return this.cachedOverlay; }
  get size(): number { return this.entries.size; }
  snapshot(): readonly OutboxEntry[] { return [...this.entries.values()]; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  enqueue(intent: TriageIntent): void {
    if (this.disposed) return;
    const slotKey = triageSlotKey(intent);
    const createdAt = (this.options.now ?? Date.now)();
    this.entries.set(slotKey, { slotKey, intent, revision: this.nextRevision++, createdAt, attempts: 0 });
    this.commit();
    this.kick();
  }

  kick(): void {
    if (this.disposed || this.entries.size === 0) return;
    this.cancelRetry();
    if (this.flushing) { this.kickRequested = true; return; }
    void this.flushLoop();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelRetry();
    this.listeners.clear();
  }

  private cancelRetry(): void {
    if (this.retryTimer === undefined) return;
    (this.options.clearTimer ?? clearTimeout)(this.retryTimer);
    this.retryTimer = undefined;
  }

  private restore(): void {
    if (this.storage === null) return;
    try {
      const raw: unknown = JSON.parse(this.storage.getItem(INTENT_OUTBOX_STORAGE_KEY) ?? '[]');
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        const entry = parseEntry(item);
        if (entry === null) continue;
        this.entries.set(entry.slotKey, entry);
        this.nextRevision = Math.max(this.nextRevision, entry.revision + 1);
      }
      this.cachedOverlay = projectIntentOverlay([...this.entries.values()]);
    } catch { /* ignore corrupt storage */ }
  }

  private commit(): void {
    const list = [...this.entries.values()];
    this.cachedOverlay = projectIntentOverlay(list);
    if (this.storage !== null) {
      try {
        if (list.length === 0) this.storage.removeItem(INTENT_OUTBOX_STORAGE_KEY);
        else this.storage.setItem(INTENT_OUTBOX_STORAGE_KEY, JSON.stringify(list));
      } catch { /* ignore quota errors */ }
    }
    for (const listener of this.listeners) listener();
  }

  private async flushLoop(): Promise<void> {
    if (this.flushing || this.disposed) return;
    this.flushing = true;
    try {
      while (!this.disposed && this.entries.size > 0) {
        this.kickRequested = false;
        const entry = this.entries.values().next().value;
        if (entry === undefined) break;
        try {
          await this.options.dispatch(entry.intent);
          if (this.entries.get(entry.slotKey)?.revision === entry.revision) {
            this.entries.delete(entry.slotKey);
            this.commit();
          }
        } catch (error) {
          if (this.disposed) break;
          if (this.entries.get(entry.slotKey)?.revision !== entry.revision) continue;
          if (this.options.isPermanentError?.(error) === true) { this.entries.delete(entry.slotKey); this.commit(); continue; }
          const attempts = entry.attempts + 1;
          this.entries.set(entry.slotKey, { ...entry, attempts });
          this.commit();
          if (this.kickRequested) continue;
          const schedule = this.options.scheduleTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
          this.retryTimer = schedule(() => { this.retryTimer = undefined; void this.flushLoop(); }, triageBackoffMs(attempts));
          return;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
