/**
 * Synchronous optimistic open & cross-space read-state coordinator.
 *
 * Clicking or pressing Enter on a conversation row calls
 * `beginExplicitConversationOpen(ref, cursor)` *before* navigation begins so
 * the unread dot clears in the same frame. The destination view commits the
 * durable mark once mounted visibly (`commitPendingConversationOpen`), while
 * a dirty-guard cancellation or failed remote verification calls `cancel()` to
 * restore the unread state cleanly.
 */

import { useSyncExternalStore } from 'react';

import type { RoomListItem, Session } from '@kiki/protocol';
import {
  hasSemanticAttentionCursor,
  isConversationUnread,
  sessionAttentionCursor,
  type InboxSource,
} from '@kiki/session-core/sessions';
import {
  beginOpenConversation,
  conversationSeenSnapshot,
  encodeConversationRef,
  markConversationSeen,
  markRoomSeen,
  markSessionSeen,
  roomSeenKey,
  subscribeConversationSeen,
  type AttentionCursor,
  type ConversationRef,
  type ConversationSeenMap,
  type SeenRecord,
  type SessionSeenMap,
} from '@kiki/session-core/settings';

interface PendingOpenEntry {
  readonly ref: ConversationRef;
  readonly cursor: AttentionCursor;
  readonly at: number;
  readonly syncLegacy: boolean;
  readonly handle: { commit(): void; cancel(): void };
}

const pendingOpens = new Map<string, PendingOpenEntry>();
const PENDING_OPEN_TTL_MS = 15_000;

/** Subscribe to global v2 multi-space read marks (including optimistic open overlays). */
export function useConversationSeen(): ConversationSeenMap {
  return useSyncExternalStore(
    subscribeConversationSeen,
    conversationSeenSnapshot,
    conversationSeenSnapshot,
  );
}

/**
 * Start an optimistic read overlay before navigating to a conversation.
 * Call `commit()` if already on the target route, or let the mounted view
 * commit via `commitPendingConversationOpen`. Call `cancel()` if navigation
 * is aborted by a dirty guard or remote scope verification fails.
 */
export function beginExplicitConversationOpen(
  ref: ConversationRef,
  cursor: AttentionCursor,
  options?: { readonly syncLegacy?: boolean },
): { commit(): void; cancel(): void } {
  const key = encodeConversationRef(ref);
  const existing = pendingOpens.get(key);
  if (existing !== undefined) {
    pendingOpens.delete(key);
    existing.handle.cancel();
  }
  const syncLegacy = options?.syncLegacy === true;
  const handle = beginOpenConversation(ref, cursor);
  const entry: PendingOpenEntry = {
    ref,
    cursor,
    at: Date.now(),
    syncLegacy,
    handle,
  };
  pendingOpens.set(key, entry);

  let settled = false;
  return {
    commit: () => {
      if (settled) return;
      settled = true;
      if (pendingOpens.get(key) === entry) pendingOpens.delete(key);
      handle.commit();
      if (syncLegacy) mirrorLegacySeen(ref, cursor.seq);
    },
    cancel: () => {
      if (settled) return;
      settled = true;
      if (pendingOpens.get(key) === entry) pendingOpens.delete(key);
      handle.cancel();
    },
  };
}

/** True when the user explicitly clicked/activated this conversation moments ago. */
export function hasPendingConversationOpen(ref: ConversationRef, nowMs = Date.now()): boolean {
  const key = encodeConversationRef(ref);
  const entry = pendingOpens.get(key);
  if (entry === undefined) return false;
  if (nowMs - entry.at > PENDING_OPEN_TTL_MS) {
    pendingOpens.delete(key);
    entry.handle.cancel();
    return false;
  }
  return true;
}

/**
 * Commit any pending optimistic open for `ref` and persist the confirmed cursor.
 * Returns true if an explicit pending open was active and committed.
 */
export function commitPendingConversationOpen(
  ref: ConversationRef,
  confirmedCursor?: AttentionCursor,
  syncLegacy = false,
): boolean {
  const key = encodeConversationRef(ref);
  const entry = pendingOpens.get(key);
  if (entry !== undefined) {
    pendingOpens.delete(key);
    entry.handle.commit();
  }
  if (confirmedCursor !== undefined) {
    markConversationSeen(ref, confirmedCursor);
    if (syncLegacy || entry?.syncLegacy === true) {
      mirrorLegacySeen(ref, confirmedCursor.seq);
    }
  } else if (entry !== undefined && (syncLegacy || entry.syncLegacy)) {
    mirrorLegacySeen(ref, entry.cursor.seq);
  }
  return entry !== undefined;
}

/** Cancel any pending optimistic open overlay for `ref` without committing. */
export function cancelPendingConversationOpen(ref: ConversationRef): void {
  const key = encodeConversationRef(ref);
  const entry = pendingOpens.get(key);
  if (entry !== undefined) {
    pendingOpens.delete(key);
    entry.handle.cancel();
  }
}

/** Mirror a confirmed read mark into the current space's v1 store for backward compatibility. */
export function mirrorLegacySeen(ref: ConversationRef, seq: number): void {
  if (!Number.isFinite(seq) || seq < 0) return;
  if (ref.kind === 'room') {
    markRoomSeen(ref.id, seq);
  } else {
    markSessionSeen(ref.id, seq);
  }
}

/** Effective seen record for one conversation, merging v2 marks with current-space v1 fallback. */
export function effectiveSeenRecord(
  ref: ConversationRef,
  seenV2: ConversationSeenMap,
  currentSpaceKey: string | undefined,
  seenV1: SessionSeenMap | undefined,
): SeenRecord | undefined {
  const key = encodeConversationRef(ref);
  const v2 = seenV2[key];
  if (v2 !== undefined) return v2;
  if (seenV1 === undefined || currentSpaceKey === undefined || ref.spaceKey !== currentSpaceKey) {
    return undefined;
  }
  const legacyId = ref.kind === 'room' ? roomSeenKey(ref.id) : ref.id;
  const legacySeq = seenV1[legacyId];
  return legacySeq === undefined ? undefined : { seq: legacySeq, updatedAt: 0 };
}

/** Merge current-space v1 marks into a v2 map without overriding existing v2 marks. */
export function withLegacySeenFallback(
  seenV2: ConversationSeenMap,
  currentSpaceKey: string,
  seenV1: SessionSeenMap,
): ConversationSeenMap {
  const entries = Object.entries(seenV1);
  if (entries.length === 0) return seenV2;
  let merged: Record<string, SeenRecord> | undefined;
  for (const [id, seq] of entries) {
    if (!Number.isFinite(seq)) continue;
    const ref: ConversationRef = id.startsWith('room:')
      ? { spaceKey: currentSpaceKey, kind: 'room', id: id.slice('room:'.length) }
      : { spaceKey: currentSpaceKey, kind: 'session', id };
    if (ref.id === '') continue;
    const key = encodeConversationRef(ref);
    if (seenV2[key] !== undefined) continue;
    merged ??= { ...seenV2 };
    merged[key] = { seq: Math.max(0, Math.trunc(seq)), updatedAt: 0 };
  }
  return merged ?? seenV2;
}

/** True when a session is unread in `spaceKey` under merged v2 + current-space v1 marks. */
export function isSessionUnreadUnified(
  spaceKey: string,
  session: Pick<InboxSource, 'id' | 'last_seq' | 'attention_cursor'>,
  seenV2: ConversationSeenMap,
  currentSpaceKey?: string,
  seenV1?: SessionSeenMap,
): boolean {
  const ref: ConversationRef = { spaceKey, kind: 'session', id: session.id };
  const record = effectiveSeenRecord(ref, seenV2, currentSpaceKey, seenV1);
  return isConversationUnread(
    sessionAttentionCursor(session),
    record,
    hasSemanticAttentionCursor(session),
  );
}

/** True when a room is unread in `spaceKey` under merged v2 + current-space v1 marks. */
export function isRoomUnreadUnified(
  spaceKey: string,
  room: Pick<RoomListItem, 'id' | 'lastSeq'>,
  seenV2: ConversationSeenMap,
  currentSpaceKey?: string,
  seenV1?: SessionSeenMap,
): boolean {
  const ref: ConversationRef = { spaceKey, kind: 'room', id: room.id };
  const record = effectiveSeenRecord(ref, seenV2, currentSpaceKey, seenV1);
  return isConversationUnread({ seq: Math.max(0, Math.trunc(room.lastSeq)) }, record, false);
}

/** Build the effective cursor for opening a session row. */
export function sessionOpenCursor(session: Pick<Session, 'last_seq' | 'attention_cursor'>): AttentionCursor {
  return sessionAttentionCursor(session);
}

/** Test seam: cancel and clear any pending explicit opens. */
export function resetPendingConversationOpens(): void {
  for (const entry of pendingOpens.values()) {
    entry.handle.cancel();
  }
  pendingOpens.clear();
}
