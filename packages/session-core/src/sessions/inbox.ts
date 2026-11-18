/**
 * Activity inbox & live-pulse model — assembled from the session records the
 * app already polls plus local seen-marks (`settings/sessionReadState`).
 * Zero network requests: every field is projected from `Session` and `RoomListItem`.
 *
 * Three buckets:
 *   1. `needsYou` — an approval, question, or room budget gate is blocking the
 *      run. Sorted oldest-first: the longest-stuck run costs the most to leave.
 *   2. `unread`   — the run finished, failed, or stopped and the user has not
 *      opened or dismissed it since `last_seq`. Sorted newest-first.
 *   3. `running`  — active runs currently executing in the background without
 *      blocking on the user. Sorted most-recently-updated first.
 *
 * `total` remains `needsYou.length + unread.length` so navigation and dock
 * badges count only actionable / unread items, never active background work.
 */

import type { Session } from '@kiki/protocol';

import type { SessionSeenMap } from '../settings/sessionReadState';

import { pendingKindOf } from './activity';
import { sessionIsExecuting } from './sessionList';

export type InboxSource = Pick<
  Session,
  | 'id'
  | 'title'
  | 'workspace_id'
  | 'updated_at'
  | 'busy'
  | 'executing'
  | 'cleanup_pending'
  | 'main_turn_active'
  | 'last_seq'
  | 'archived'
  | 'private'
  | 'pending_interaction'
  | 'last_turn_reason'
  | 'last_prompt'
> &
  Partial<Pick<Session, 'agent_config' | 'metadata' | 'usage'>> & {
    readonly roomId?: string;
    readonly needsYouReason?: 'budget';
  };

/** Why a session or room appears on the Activity triage desk. */
export type InboxReason =
  | 'approval'
  | 'question'
  | 'budget'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'running';

/** Sub-filter slice on the Activity inbox desk. */
export type InboxTriageFilter = 'all' | 'needs-you' | 'unread' | 'running';

export interface InboxItem {
  readonly sessionId: string;
  readonly roomId?: string;
  readonly title: string;
  readonly workspaceId: string;
  readonly reason: InboxReason;
  /** ISO timestamp used for ordering and relative-time display. */
  readonly at: string;
  /** Still holding a turn (a blocked session can also have work in flight). */
  readonly busy: boolean;
  /** The session's event high-water mark; "mark as read" records it. */
  readonly lastSeq: number;
  /** Normalized single-line preview of the latest user prompt. */
  readonly preview?: string;
  /** Bound or compatibility persona identifier, when present. */
  readonly personaId?: string;
  /** Bound persona display name, when carried on `agent_config.persona`. */
  readonly personaName?: string;
  /** Configured model identifier for quick context on active/failed runs. */
  readonly model?: string;
  /** Recorded turn count when > 0. */
  readonly turnCount?: number;
}

export interface InboxModel {
  /** Blocked on the user, longest-waiting first. */
  readonly needsYou: readonly InboxItem[];
  /** Finished since the user last looked, newest first. */
  readonly unread: readonly InboxItem[];
  /** Actively executing in the background without blocking on the user, newest activity first. */
  readonly running: readonly InboxItem[];
  /** `needsYou.length + unread.length` — the actionable / unread badge count. */
  readonly total: number;
}

export interface FilteredInboxModel extends InboxModel {
  /** Flat top-to-bottom visible item list matching the rendered group order for keyboard navigation. */
  readonly visibleItems: readonly InboxItem[];
}

export const EMPTY_INBOX: InboxModel = { needsYou: [], unread: [], running: [], total: 0 };

/** True when the session has events the user has not opened yet. */
export function isSessionUnread(session: InboxSource, seen: SessionSeenMap): boolean {
  if (session.last_seq <= 0) return false;
  const mark = seen[session.id];
  return mark === undefined || mark < session.last_seq;
}

function finishedReason(session: InboxSource): InboxReason | undefined {
  switch (session.last_turn_reason) {
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'completed':
      return 'completed';
    default:
      return 'completed';
  }
}

function extractPersonaIdentity(session: InboxSource): {
  readonly personaId?: string;
  readonly personaName?: string;
} {
  const persona = session.agent_config?.persona;
  if (persona?.id) {
    const name = typeof persona.name === 'string' && persona.name.trim() !== '' ? persona.name.trim() : undefined;
    return { personaId: persona.id, personaName: name };
  }
  const metadata = session.metadata;
  if (metadata === undefined) return {};
  for (const key of ['bot_persona_id', 'room_persona_id', 'persona_id'] as const) {
    const raw = metadata[key];
    if (typeof raw === 'string' && raw.trim() !== '') {
      return { personaId: raw.trim() };
    }
  }
  return {};
}

function isActivelyRunning(session: InboxSource): boolean {
  if (session.cleanup_pending === true) return false;
  const executing = sessionIsExecuting(session);
  if (executing !== undefined) return executing;
  return session.busy === true;
}

function ascending(left: InboxItem, right: InboxItem): number {
  return Date.parse(left.at) - Date.parse(right.at);
}

/**
 * Assemble the inbox and live-pulse model. `sessions` is the already-fetched
 * list (any order); `seen` is the local read-state snapshot.
 */
export function buildInboxModel(
  sessions: readonly InboxSource[],
  seen: SessionSeenMap,
): InboxModel {
  const needsYou: InboxItem[] = [];
  const unread: InboxItem[] = [];
  const running: InboxItem[] = [];

  for (const session of sessions) {
    if (session.archived === true || session.private === true) continue;
    const { personaId, personaName } = extractPersonaIdentity(session);
    const rawModel = session.agent_config?.model;
    const model = typeof rawModel === 'string' && rawModel.trim() !== '' ? rawModel.trim() : undefined;
    const rawTurns = session.usage?.turn_count;
    const turnCount = typeof rawTurns === 'number' && rawTurns > 0 ? rawTurns : undefined;
    const preview = session.last_prompt !== undefined && session.last_prompt.trim() !== ''
      ? session.last_prompt.replace(/\s+/gu, ' ').trim()
      : undefined;

    const base = {
      sessionId: session.id,
      roomId: session.roomId,
      title: session.title,
      workspaceId: session.workspace_id,
      at: session.updated_at,
      busy: session.busy,
      lastSeq: session.last_seq,
      preview,
      personaId,
      personaName,
      model,
      turnCount,
    };

    const pending = pendingKindOf(session);
    if (pending !== 'none') {
      needsYou.push({ ...base, reason: pending });
      continue;
    }
    if (session.needsYouReason !== undefined) {
      needsYou.push({ ...base, reason: session.needsYouReason });
      continue;
    }
    if (isActivelyRunning(session)) {
      running.push({ ...base, reason: 'running' });
      continue;
    }
    if (session.busy) continue;
    if (!isSessionUnread(session, seen)) continue;
    const reason = finishedReason(session);
    if (reason === undefined) continue;
    unread.push({ ...base, reason });
  }

  needsYou.sort(ascending);
  unread.sort((left, right) => ascending(right, left));
  running.sort((left, right) => ascending(right, left));

  return {
    needsYou,
    unread,
    running,
    total: needsYou.length + unread.length,
  };
}

/**
 * Scope an `InboxModel` by optional `workspaceId` and compute the ordered flat
 * `visibleItems` list matching the active triage filter (`all` | `needs-you` |
 * `unread` | `running`).
 */
export function filterInboxModel(
  model: InboxModel,
  options: {
    readonly workspaceId?: string;
    readonly filter?: InboxTriageFilter;
  } = {},
): FilteredInboxModel {
  const { workspaceId, filter = 'all' } = options;
  const inScope = (items: readonly InboxItem[]): readonly InboxItem[] =>
    workspaceId === undefined ? items : items.filter((item) => item.workspaceId === workspaceId);

  const needsYou = inScope(model.needsYou);
  const unread = inScope(model.unread);
  const running = inScope(model.running);

  const visibleItems: readonly InboxItem[] =
    filter === 'needs-you'
      ? needsYou
      : filter === 'unread'
        ? unread
        : filter === 'running'
          ? running
          : [...needsYou, ...unread, ...running];

  return {
    needsYou,
    unread,
    running,
    total: needsYou.length + unread.length,
    visibleItems,
  };
}

/** Move keyboard triage focus up (`-1`) or down (`1`) within `items`, clamping at boundaries. */
export function stepInboxCursor(
  items: readonly InboxItem[],
  currentSessionId: string | undefined,
  delta: 1 | -1,
): string | undefined {
  if (items.length === 0) return undefined;
  if (currentSessionId === undefined) {
    return delta > 0 ? items[0]?.sessionId : items[items.length - 1]?.sessionId;
  }
  const index = items.findIndex((item) => item.sessionId === currentSessionId);
  if (index === -1) {
    return delta > 0 ? items[0]?.sessionId : items[items.length - 1]?.sessionId;
  }
  const nextIndex = Math.max(0, Math.min(items.length - 1, index + delta));
  return items[nextIndex]?.sessionId;
}

/** Pick the surviving cursor sessionId immediately after `dismissedSessionId` leaves `items`. */
export function nextCursorAfterDismiss(
  items: readonly InboxItem[],
  dismissedSessionId: string,
): string | undefined {
  const index = items.findIndex((item) => item.sessionId === dismissedSessionId);
  if (index === -1) return items[0]?.sessionId;
  return items[index + 1]?.sessionId ?? items[index - 1]?.sessionId;
}

/** Sidebar row state, in precedence order. */
export type SessionRowState = 'needs-me' | 'cleanup-pending' | 'running' | 'unread' | 'read';

/**
 * The visual state of one sidebar row. Blocking beats unconfirmed process
 * cleanup, cleanup beats running, running beats unread, and
 * a session with nothing outstanding is plain `read`.
 */
export function sessionRowState(session: InboxSource, seen: SessionSeenMap): SessionRowState {
  if (pendingKindOf(session) !== 'none') return 'needs-me';
  if (session.cleanup_pending === true) return 'cleanup-pending';
  if (sessionIsExecuting(session) === true) return 'running';
  return isSessionUnread(session, seen) ? 'unread' : 'read';
}
