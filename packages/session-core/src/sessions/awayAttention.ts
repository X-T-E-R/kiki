/**
 * Away attention — which session changes deserve a system notification while
 * the user is not looking at the window, and how a burst of them is folded so
 * the desktop is never flooded.
 *
 * Two pure steps, both driven by the session records the list already
 * carries (`busy`, `pending_interaction`, `last_turn_reason`,
 * `message_count`):
 *
 *   1. `detectAttentionEvents` diffs the previous observation against the
 *      new list and reports transitions: a turn that finished or failed, and
 *      a session that started waiting on an approval or a question.
 *   2. `planAttentionNotifications` filters those by the user's switches,
 *      rate-limits per session, and merges a multi-session burst into one
 *      notification that points at the activity inbox.
 *
 * Nothing here knows about windows or hosts; the GUI decides when the user
 * is away and delivers the plan.
 */

import type { Session } from '@kiki/protocol';

import { pendingKindOf } from './activity';

export type AttentionKind = 'completed' | 'failed' | 'question' | 'approval';

export const ATTENTION_KINDS: readonly AttentionKind[] = ['completed', 'failed', 'question', 'approval'];

/** The facts one observation keeps per session. */
export interface AttentionSnapshot {
  readonly busy: boolean;
  readonly pending: 'approval' | 'question' | 'none';
  readonly reason: Session['last_turn_reason'];
  readonly messageCount: number;
}

export type AttentionBaseline = ReadonlyMap<string, AttentionSnapshot>;

export interface AttentionEvent {
  readonly sessionId: string;
  readonly kind: AttentionKind;
  readonly title: string;
}

export function attentionSnapshotOf(session: Session): AttentionSnapshot {
  return {
    busy: session.busy,
    pending: pendingKindOf(session),
    reason: session.last_turn_reason,
    messageCount: session.message_count,
  };
}

function finishedKind(session: Session): AttentionKind | undefined {
  // A stop is the user's own action (or a restart), not news to deliver.
  if (session.last_turn_reason === 'cancelled') return undefined;
  return session.last_turn_reason === 'failed' ? 'failed' : 'completed';
}

/**
 * Transitions between two observations. `sinceMs` is when the watcher
 * started: a session it has never seen only counts when it was created after
 * that (a scheduled run that appeared while the user was away); an older one
 * merely scrolled into the list and is baseline. Sessions missing from `next`
 * keep their previous snapshot, because two list sources (filtered and
 * unfiltered) feed the same baseline.
 */
export function detectAttentionEvents(
  previous: AttentionBaseline,
  sessions: readonly Session[],
  sinceMs: number,
): { readonly events: readonly AttentionEvent[]; readonly baseline: AttentionBaseline } {
  const baseline = new Map(previous);
  const events: AttentionEvent[] = [];
  for (const session of sessions) {
    const next = attentionSnapshotOf(session);
    const before = previous.get(session.id);
    baseline.set(session.id, next);
    if (session.archived === true) continue;
    const fresh = before === undefined && Date.parse(session.created_at) >= sinceMs;
    if (before === undefined && !fresh) continue;
    const event = (kind: AttentionKind) => {
      events.push({ sessionId: session.id, kind, title: session.title });
    };
    if (next.pending !== 'none') {
      if (before?.pending !== next.pending) event(next.pending);
      continue;
    }
    if (next.busy) continue;
    // A finished turn: the session was seen working, or it gained messages
    // between two looks (a turn shorter than the poll interval). A title or
    // metadata write moves neither.
    const ran = before === undefined
      ? session.last_turn_reason !== undefined
      : before.busy || next.messageCount > before.messageCount;
    if (!ran) continue;
    const kind = finishedKind(session);
    if (kind !== undefined) event(kind);
  }
  return { events, baseline };
}

// ---- delivery plan ----

export interface AwayNotificationPrefs {
  /** Master switch (the desktop notifications preference). */
  readonly enabled: boolean;
  readonly kinds: Readonly<Record<AttentionKind, boolean>>;
}

export interface AttentionRateState {
  /** sessionId → last delivery. */
  readonly last: ReadonlyMap<string, { readonly at: number; readonly kind: AttentionKind }>;
}

export const EMPTY_ATTENTION_RATE: AttentionRateState = { last: new Map() };

/** One session may notify again after this long, or sooner for a more urgent kind. */
export const ATTENTION_COOLDOWN_MS = 60_000;

const PRIORITY: Record<AttentionKind, number> = {
  completed: 1,
  failed: 2,
  question: 3,
  approval: 3,
};

export function isNeedsYouKind(kind: AttentionKind): boolean {
  return kind === 'approval' || kind === 'question';
}

export type AttentionNotification =
  | { readonly type: 'single'; readonly event: AttentionEvent }
  | {
    readonly type: 'merged';
    readonly events: readonly AttentionEvent[];
    readonly needsYou: number;
    readonly finished: number;
  };

/**
 * Decide what to show for a batch of events. Per session only the most
 * urgent event of the batch survives; a session that notified less than
 * `ATTENTION_COOLDOWN_MS` ago stays quiet unless the new event is more urgent
 * (a question after a completion). Two or more surviving sessions fold into
 * one merged notification.
 */
export function planAttentionNotifications(
  events: readonly AttentionEvent[],
  prefs: AwayNotificationPrefs,
  state: AttentionRateState,
  nowMs: number,
  cooldownMs: number = ATTENTION_COOLDOWN_MS,
): { readonly notification: AttentionNotification | undefined; readonly state: AttentionRateState } {
  if (!prefs.enabled) return { notification: undefined, state };
  const bySession = new Map<string, AttentionEvent>();
  for (const event of events) {
    if (!prefs.kinds[event.kind]) continue;
    const current = bySession.get(event.sessionId);
    if (current === undefined || PRIORITY[event.kind] > PRIORITY[current.kind]) bySession.set(event.sessionId, event);
  }
  const survivors = [...bySession.values()].filter((event) => {
    const last = state.last.get(event.sessionId);
    if (last === undefined || nowMs - last.at >= cooldownMs) return true;
    return PRIORITY[event.kind] > PRIORITY[last.kind];
  });
  if (survivors.length === 0) return { notification: undefined, state };
  const last = new Map(state.last);
  for (const event of survivors) last.set(event.sessionId, { at: nowMs, kind: event.kind });
  // Forget sessions whose cooldown has long passed so the map stays small.
  for (const [sessionId, entry] of last) if (nowMs - entry.at > cooldownMs * 10) last.delete(sessionId);
  const notification: AttentionNotification = survivors.length === 1
    ? { type: 'single', event: survivors[0]! }
    : {
      type: 'merged',
      events: survivors,
      needsYou: survivors.filter((event) => isNeedsYouKind(event.kind)).length,
      finished: survivors.filter((event) => !isNeedsYouKind(event.kind)).length,
    };
  return { notification, state: { last } };
}
