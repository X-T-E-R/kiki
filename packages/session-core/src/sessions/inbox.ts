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

import type { RoomListItem, Session } from '@kiki/protocol';

import { roomSeenKey } from '../settings/roomReadState';
import {
  encodeConversationRef,
  type AttentionCursor,
  type ConversationRef,
  type ConversationSeenMap,
  type SeenRecord,
  type SessionSeenMap,
} from '../settings/sessionReadState';
import {
  classifyConversationTriage,
  isAttentionCursorSame,
  type ConversationTriageMap,
  type TriageClass,
} from '../settings/sessionTriage';

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
  Partial<Pick<Session, 'agent_config' | 'metadata' | 'usage' | 'attention_cursor'>> & {
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

/** Effective attention cursor for a session: semantic `attention_cursor` when available, else `last_seq`. */
export function sessionAttentionCursor(
  session: Pick<Session, 'last_seq' | 'attention_cursor'>,
): AttentionCursor {
  if (session.attention_cursor !== undefined) {
    return {
      epoch: session.attention_cursor.epoch,
      seq: Math.max(0, Math.trunc(session.attention_cursor.seq)),
    };
  }
  return { seq: Math.max(0, Math.trunc(session.last_seq)) };
}

/** True when the server provided a semantic `attention_cursor` for this session. */
export function hasSemanticAttentionCursor(
  session: Pick<Session, 'attention_cursor'>,
): boolean {
  return session.attention_cursor !== undefined;
}

/**
 * True when a conversation's attention cursor is ahead of its persisted seen mark.
 * A zero cursor is never unread (immune to non-attention metadata/heartbeat writes);
 * differing non-empty epochs always flag unread across journal resets.
 */
export function isConversationUnread(
  cursor: AttentionCursor,
  seenRecord: SeenRecord | undefined,
  _hasSemanticCursor?: boolean,
): boolean {
  if (!Number.isFinite(cursor.seq) || cursor.seq <= 0) return false;
  if (seenRecord === undefined) return true;
  if (cursor.epoch !== undefined && seenRecord.epoch !== undefined && cursor.epoch !== seenRecord.epoch) {
    return true;
  }
  return seenRecord.seq < Math.trunc(cursor.seq);
}

/** True when the session has attention-worthy events the user has not opened yet. */
export function isSessionUnread(session: InboxSource, seen: SessionSeenMap): boolean {
  const effectiveSeq = session.attention_cursor?.seq ?? session.last_seq;
  if (effectiveSeq <= 0) return false;
  const mark = seen[session.id];
  return mark === undefined || mark < effectiveSeq;
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

function parseTimestamp(at: string): number {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : 0;
}

function ascending(left: InboxItem, right: InboxItem): number {
  return parseTimestamp(left.at) - parseTimestamp(right.at);
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

// ---- unified multi-space inbox with triage ----

export interface UnifiedInboxEntryBase {
  readonly spaceKey: string;
  readonly spaceName: string;
  readonly isRemote: boolean;
  readonly workspaceName?: string;
}

export interface UnifiedInboxSessionEntry extends UnifiedInboxEntryBase {
  readonly kind: 'session';
  readonly session: InboxSource;
}

export interface UnifiedInboxRoomEntry extends UnifiedInboxEntryBase {
  readonly kind: 'room';
  readonly room: RoomListItem;
  /** Resolved workspace id when mapped against the space's workspace catalog. */
  readonly workspaceId?: string;
}

export type UnifiedInboxEntry = UnifiedInboxSessionEntry | UnifiedInboxRoomEntry;

export interface UnifiedInboxItem {
  readonly ref: ConversationRef;
  readonly encodedKey: string;
  readonly spaceKey: string;
  readonly spaceName: string;
  readonly isRemote: boolean;
  readonly workspaceId: string;
  readonly workspaceName?: string;
  readonly sessionId: string;
  readonly roomId?: string;
  readonly title: string;
  readonly reason: InboxReason;
  readonly at: string;
  readonly busy: boolean;
  readonly attentionCursor: AttentionCursor;
  readonly lastSeq: number;
  readonly snoozedUntil?: number;
  readonly triageClass: TriageClass;
  readonly unread: boolean;
  readonly needsYou: boolean;
  readonly preview?: string;
  readonly personaId?: string;
  readonly personaName?: string;
  readonly model?: string;
  readonly turnCount?: number;
}

export interface UnifiedInboxModel {
  /** Actionable items: `needsYou` oldest-first, then `failed`/`cancelled` newest-first, then `completed`/woken newest-first. */
  readonly active: readonly UnifiedInboxItem[];
  /** Actively running conversations without a blocking prompt, newest-updated first. */
  readonly working: readonly UnifiedInboxItem[];
  /** Snoozed conversations, soonest wake-up first. */
  readonly snoozed: readonly UnifiedInboxItem[];
  /** Reversible inbox-archived conversations, newest-updated first. */
  readonly archived: readonly UnifiedInboxItem[];
  /** Count of active `needsYou` items. */
  readonly needsYouCount: number;
  /** Count of active non-`needsYou` actionable items (unread or woken snooze; excludes read viewing-pinned rows). */
  readonly unreadCount: number;
  /** `needsYouCount + unreadCount`. */
  readonly total: number;
}

export interface UnifiedInboxOptions {
  /**
   * Encoded conversation key currently being viewed from the inbox. Keeps a
   * clicked-and-read row pinned in `active` until it is triaged (`settled` /
   * `snoozed` / `archived`), resumes work, or the user navigates away.
   */
  readonly pinnedViewingKey?: string;
}

export const EMPTY_UNIFIED_INBOX: UnifiedInboxModel = {
  active: [],
  working: [],
  snoozed: [],
  archived: [],
  needsYouCount: 0,
  unreadCount: 0,
  total: 0,
};

function activePriorityTier(item: UnifiedInboxItem): number {
  if (item.needsYou) return 0;
  if (item.reason === 'failed' || item.reason === 'cancelled') return 1;
  return 2;
}

function compareActiveItems(left: UnifiedInboxItem, right: UnifiedInboxItem): number {
  const leftTier = activePriorityTier(left);
  const rightTier = activePriorityTier(right);
  if (leftTier !== rightTier) return leftTier - rightTier;
  if (leftTier === 0) {
    return parseTimestamp(left.at) - parseTimestamp(right.at) || left.encodedKey.localeCompare(right.encodedKey);
  }
  return parseTimestamp(right.at) - parseTimestamp(left.at) || left.encodedKey.localeCompare(right.encodedKey);
}

function compareNewestFirst(left: UnifiedInboxItem, right: UnifiedInboxItem): number {
  return parseTimestamp(right.at) - parseTimestamp(left.at) || left.encodedKey.localeCompare(right.encodedKey);
}

function compareSnoozed(left: UnifiedInboxItem, right: UnifiedInboxItem): number {
  const leftUntil = left.snoozedUntil ?? Number.POSITIVE_INFINITY;
  const rightUntil = right.snoozedUntil ?? Number.POSITIVE_INFINITY;
  if (leftUntil !== rightUntil) return leftUntil - rightUntil;
  return compareNewestFirst(left, right);
}

function normalizePreview(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw.replace(/\s+/gu, ' ').trim();
}

function activeSnoozeUntil(
  cursor: AttentionCursor,
  record: ConversationTriageMap[string] | undefined,
  nowMs: number,
): number | undefined {
  if (record === undefined || record.s !== 'snoozed' || record.u === undefined) return undefined;
  if (nowMs >= record.u) return undefined;
  return isAttentionCursorSame(cursor, record) ? record.u : undefined;
}

/**
 * Assemble the unified multi-space inbox across local/remote sessions and rooms,
 * applying semantic `attention_cursor` unread checks and reversible triage rules.
 */
export function buildUnifiedInbox(
  entries: readonly UnifiedInboxEntry[],
  seenMap: ConversationSeenMap,
  triageMap: ConversationTriageMap,
  nowMs: number = Date.now(),
  options: UnifiedInboxOptions = {},
): UnifiedInboxModel {
  const active: UnifiedInboxItem[] = [];
  const working: UnifiedInboxItem[] = [];
  const snoozed: UnifiedInboxItem[] = [];
  const archived: UnifiedInboxItem[] = [];
  const seenKeys = new Set<string>();
  const pinnedViewingKey = options.pinnedViewingKey;

  const routeItem = (item: UnifiedInboxItem): void => {
    switch (item.triageClass) {
      case 'active':
        active.push(item);
        break;
      case 'working':
        working.push(item);
        break;
      case 'snoozed':
        snoozed.push(item);
        break;
      case 'archived':
        archived.push(item);
        break;
      case 'hidden':
        if (pinnedViewingKey !== undefined && item.encodedKey === pinnedViewingKey) {
          active.push(item);
        }
        break;
      case 'settled':
        break;
    }
  };

  for (const entry of entries) {
    if (entry.kind === 'session') {
      const { session } = entry;
      if (session.archived === true || session.private === true) continue;
      const ref: ConversationRef = {
        spaceKey: entry.spaceKey,
        kind: 'session',
        id: session.id,
      };
      const encodedKey = encodeConversationRef(ref);
      if (seenKeys.has(encodedKey)) continue;
      seenKeys.add(encodedKey);

      const attentionCursor = sessionAttentionCursor(session);
      const semantic = hasSemanticAttentionCursor(session);
      const pending = pendingKindOf(session);
      const needsYouReason: InboxReason | undefined = pending !== 'none' ? pending : session.needsYouReason;
      const needsYou = needsYouReason !== undefined;
      const activelyRunning = !needsYou && isActivelyRunning(session);
      const unread = !session.busy && isConversationUnread(attentionCursor, seenMap[encodedKey], semantic);
      const reason: InboxReason = needsYouReason ?? (activelyRunning ? 'running' : (finishedReason(session) ?? 'completed'));

      const record = triageMap[encodedKey];
      const triageClass = classifyConversationTriage(
        { needsYou, busy: activelyRunning, unread, cursor: attentionCursor, reason },
        record,
        nowMs,
      );
      const snoozedUntil = activeSnoozeUntil(attentionCursor, record, nowMs);

      const { personaId, personaName } = extractPersonaIdentity(session);
      const rawModel = session.agent_config?.model;
      const model = typeof rawModel === 'string' && rawModel.trim() !== '' ? rawModel.trim() : undefined;
      const rawTurns = session.usage?.turn_count;
      const turnCount = typeof rawTurns === 'number' && rawTurns > 0 ? rawTurns : undefined;

      routeItem({
        ref,
        encodedKey,
        spaceKey: entry.spaceKey,
        spaceName: entry.spaceName,
        isRemote: entry.isRemote,
        workspaceId: session.workspace_id,
        workspaceName: entry.workspaceName,
        sessionId: session.id,
        roomId: session.roomId,
        title: session.title,
        reason,
        at: session.updated_at,
        busy: session.busy,
        attentionCursor,
        lastSeq: session.last_seq,
        snoozedUntil,
        triageClass,
        unread,
        needsYou,
        preview: normalizePreview(session.last_prompt),
        personaId,
        personaName,
        model,
        turnCount,
      });
      continue;
    }

    const { room } = entry;
    if (room.archived === true) continue;
    const ref: ConversationRef = {
      spaceKey: entry.spaceKey,
      kind: 'room',
      id: room.id,
    };
    const encodedKey = encodeConversationRef(ref);
    if (seenKeys.has(encodedKey)) continue;
    seenKeys.add(encodedKey);

    const attentionCursor: AttentionCursor = { seq: Math.max(0, Math.trunc(room.lastSeq)) };
    const needsYouReason: InboxReason | undefined =
      room.pendingInteraction !== 'none'
        ? room.pendingInteraction
        : room.needsYou
          ? 'budget'
          : undefined;
    const needsYou = needsYouReason !== undefined;
    const activelyRunning = !needsYou && room.busy;
    const unread = !room.busy && isConversationUnread(attentionCursor, seenMap[encodedKey], false);
    const reason: InboxReason = needsYouReason ?? (activelyRunning ? 'running' : room.failed ? 'failed' : 'completed');

    const record = triageMap[encodedKey];
    const triageClass = classifyConversationTriage(
      { needsYou, busy: activelyRunning, unread, cursor: attentionCursor, reason },
      record,
      nowMs,
    );
    const snoozedUntil = activeSnoozeUntil(attentionCursor, record, nowMs);

    routeItem({
      ref,
      encodedKey,
      spaceKey: entry.spaceKey,
      spaceName: entry.spaceName,
      isRemote: entry.isRemote,
      workspaceId: entry.workspaceId ?? room.workspace,
      workspaceName: entry.workspaceName,
      sessionId: roomSeenKey(room.id),
      roomId: room.id,
      title: room.title,
      reason,
      at: room.updatedAt,
      busy: room.busy,
      attentionCursor,
      lastSeq: room.lastSeq,
      snoozedUntil,
      triageClass,
      unread,
      needsYou,
    });
  }

  active.sort(compareActiveItems);
  working.sort(compareNewestFirst);
  snoozed.sort(compareSnoozed);
  archived.sort(compareNewestFirst);

  let needsYouCount = 0;
  let unreadCount = 0;
  for (const item of active) {
    if (item.needsYou) needsYouCount += 1;
    else if (item.triageClass === 'active') unreadCount += 1;
  }

  return {
    active,
    working,
    snoozed,
    archived,
    needsYouCount,
    unreadCount,
    total: needsYouCount + unreadCount,
  };
}
