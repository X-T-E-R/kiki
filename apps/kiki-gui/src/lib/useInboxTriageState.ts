/**
 * Inbox triage controller hook — drives `buildUnifiedInbox`, zero-jank
 * `viewingSessionPin`, reversible 10-entry undo stack (`u`), minute-aligned
 * snooze wake timer, and cursor-advance triage cleanup.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
  buildUnifiedConversationEntries,
  buildUnifiedInbox,
  EMPTY_UNIFIED_INBOX,
  sessionAttentionCursor,
  type SpaceConversationSource,
  type UnifiedInboxItem,
  type UnifiedInboxModel,
} from '@kiki/session-core/sessions';
import {
  archiveConversationTriage,
  clearChangedTriageMarks,
  clearConversationTriage,
  computeSnoozeUntilMs,
  conversationTriageSnapshot,
  encodeConversationRef,
  markConversationSeen,
  markConversationUnread,
  markRoomSeen,
  markSessionSeen,
  markSessionUnread,
  nextSnoozeExpiryMs,
  sessionSeenSnapshot,
  settleConversation,
  snoozeConversation,
  subscribeConversationTriage,
  subscribeSessionSeen,
  type AttentionCursor,
  type ConversationRef,
  type SnoozePreset,
  type TriageRecord,
} from '@kiki/session-core/settings';

import { useI18n } from '../i18n';
import {
  cancelPendingConversationOpen,
  commitPendingConversationOpen,
  useConversationSeen,
  withLegacySeenFallback,
} from './conversationOpen';
import { pushToast, UNDO_TOAST_MS } from './toasts';
import { matchesSpaceScope } from './useMultiSpaceSessions';

const MAX_UNDO_STACK = 10;

interface UndoEntry {
  readonly ref: ConversationRef;
  readonly cursor: AttentionCursor;
  readonly prevRecord: TriageRecord | undefined;
  readonly restoreUnread: boolean;
  readonly currentSpaceKey: string;
}

export interface UseInboxTriageOptions {
  /** All multi-space conversation sources (unfiltered by spaceScope). */
  readonly sources: readonly SpaceConversationSource[];
  /** Currently active connection's `spaceKey` (for v1 mirror & active key). */
  readonly currentSpaceKey: string;
  /** Active sidebar space filter (`'all'`, `'local:...'`, or `'remote:...'`). */
  readonly spaceScope?: string;
  /** Encoded `ConversationRef` key of the currently open conversation route, if any. */
  readonly activeConversationKey?: string;
  /** Optional clock override for deterministic tests. */
  readonly nowMs?: number;
}

export interface InboxTriageController {
  /** Scoped unified inbox model for rendering the Inbox view & mode badge. */
  readonly inbox: UnifiedInboxModel;
  /** Unscoped unified inbox model across all spaces (for global badge consistency). */
  readonly allSpacesInbox: UnifiedInboxModel;
  /** Currently pinned viewing key (if an opened idle item is held under pointer). */
  readonly pinnedViewingKey: string | undefined;
  /** Pin a clicked unread/woken item in place so it never jumps away under the pointer. */
  readonly pinViewingItem: (item: UnifiedInboxItem) => void;
  /** Clear the viewing pin (e.g. when navigating away). */
  readonly clearViewingPin: () => void;
  /** Mark an idle/woken item done (`e` / `✓`). No-op on unresolved `needsYou`. */
  readonly settleItem: (item: UnifiedInboxItem) => void;
  /** Snooze an item until a preset (`30m` | `1h` | `3h` | `tomorrow`). */
  readonly snoozeItem: (item: UnifiedInboxItem, preset: SnoozePreset) => void;
  /** Reversible inbox archive (`a`). */
  readonly archiveItem: (item: UnifiedInboxItem) => void;
  /** Wake a snoozed item or restore an inbox-archived item back to active. */
  readonly restoreItem: (item: UnifiedInboxItem) => void;
  /** Pop and reverse the latest triage mutation (`u`). Returns true when undone. */
  readonly undoLast: () => boolean;
  /** Whether an undo entry is currently available. */
  readonly canUndo: boolean;
}

function formatSnoozeTime(untilMs: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(untilMs));
  } catch {
    return new Date(untilMs).toTimeString().slice(0, 5);
  }
}

export function useInboxTriageState({
  sources,
  currentSpaceKey,
  spaceScope = 'all',
  activeConversationKey,
  nowMs: fixedNowMs,
}: UseInboxTriageOptions): InboxTriageController {
  const { t, locale } = useI18n();
  const seenV2 = useConversationSeen();
  const seenV1 = useSyncExternalStore(subscribeSessionSeen, sessionSeenSnapshot, sessionSeenSnapshot);
  const triageMap = useSyncExternalStore(
    subscribeConversationTriage,
    conversationTriageSnapshot,
    conversationTriageSnapshot,
  );

  const [clockTick, setClockTick] = useState(() => Date.now());
  const nowMs = fixedNowMs ?? clockTick;
  const [pinnedViewingKey, setPinnedViewingKey] = useState<string | undefined>(undefined);
  const [dismissedActiveKey, setDismissedActiveKey] = useState<string | undefined>(undefined);
  const undoStackRef = useRef<UndoEntry[]>([]);
  const [undoDepth, setUndoDepth] = useState(0);

  // Schedule a single timer aligned to the earliest future snooze wake-up.
  const nextExpiry = useMemo(() => nextSnoozeExpiryMs(triageMap, nowMs), [triageMap, nowMs]);
  useEffect(() => {
    if (fixedNowMs !== undefined || nextExpiry === undefined) return undefined;
    const delay = Math.max(100, nextExpiry - Date.now() + 50);
    const timer = window.setTimeout(() => {
      setClockTick(Date.now());
    }, Math.min(delay, 2_147_483_647));
    return () => { window.clearTimeout(timer); };
  }, [nextExpiry, fixedNowMs]);

  const effectiveSeen = useMemo(
    () => withLegacySeenFallback(seenV2, currentSpaceKey, seenV1),
    [seenV2, currentSpaceKey, seenV1],
  );

  const allEntries = useMemo(
    () => buildUnifiedConversationEntries(sources),
    [sources],
  );

  const scopedEntries = useMemo(
    () => allEntries.filter((entry) => matchesSpaceScope(spaceScope, entry.spaceKey)),
    [allEntries, spaceScope],
  );

  // Prune stale triage marks whose live attention cursor has moved forward.
  useEffect(() => {
    if (Object.keys(triageMap).length === 0 || allEntries.length === 0) return;
    const liveCursors = new Map<string, AttentionCursor>();
    for (const entry of allEntries) {
      if (entry.kind === 'session') {
        liveCursors.set(
          encodeConversationRef({ spaceKey: entry.spaceKey, kind: 'session', id: entry.session.id }),
          sessionAttentionCursor(entry.session),
        );
      } else {
        liveCursors.set(
          encodeConversationRef({ spaceKey: entry.spaceKey, kind: 'room', id: entry.room.id }),
          { seq: Math.max(0, Math.trunc(entry.room.lastSeq)) },
        );
      }
    }
    clearChangedTriageMarks(liveCursors);
  }, [allEntries, triageMap]);

  // Clear the viewing pin as soon as the user navigates to another conversation,
  // or the pinned conversation resumes execution (`busy === true`).
  const pinnedEntryBusy = useMemo(() => {
    if (pinnedViewingKey === undefined) return false;
    for (const entry of allEntries) {
      const key = entry.kind === 'session'
        ? encodeConversationRef({ spaceKey: entry.spaceKey, kind: 'session', id: entry.session.id })
        : encodeConversationRef({ spaceKey: entry.spaceKey, kind: 'room', id: entry.room.id });
      if (key === pinnedViewingKey) {
        return entry.kind === 'session' ? entry.session.busy : entry.room.busy;
      }
    }
    return false;
  }, [allEntries, pinnedViewingKey]);

  const prevActiveKeyRef = useRef<string | undefined>(activeConversationKey);
  const pinnedObservedActiveRef = useRef(false);
  useEffect(() => {
    const prevActive = prevActiveKeyRef.current;
    prevActiveKeyRef.current = activeConversationKey;
    if (pinnedViewingKey === undefined) {
      pinnedObservedActiveRef.current = false;
      return;
    }
    if (pinnedEntryBusy) {
      pinnedObservedActiveRef.current = false;
      setPinnedViewingKey(undefined);
      return;
    }
    if (activeConversationKey === pinnedViewingKey) {
      pinnedObservedActiveRef.current = true;
      return;
    }
    // Clear the pin once the pinned conversation was observed active and the
    // user navigated away, or if navigation transitioned to a different
    // conversation while the pinned one was still in flight. Keep it pinned
    // while `activeConversationKey` remains unchanged on the prior conversation
    // during an async cross-space navigation flight.
    if (pinnedObservedActiveRef.current || activeConversationKey !== prevActive) {
      pinnedObservedActiveRef.current = false;
      setPinnedViewingKey(undefined);
    }
  }, [activeConversationKey, pinnedViewingKey, pinnedEntryBusy]);

  // Clear an explicit settle/snooze dismissal on the currently open conversation
  // when navigating to another conversation or when the open conversation starts
  // executing again.
  const activeEntryBusy = useMemo(() => {
    if (activeConversationKey === undefined) return false;
    for (const entry of allEntries) {
      const key = entry.kind === 'session'
        ? encodeConversationRef({ spaceKey: entry.spaceKey, kind: 'session', id: entry.session.id })
        : encodeConversationRef({ spaceKey: entry.spaceKey, kind: 'room', id: entry.room.id });
      if (key === activeConversationKey) {
        return entry.kind === 'session' ? entry.session.busy : entry.room.busy;
      }
    }
    return false;
  }, [allEntries, activeConversationKey]);

  useEffect(() => {
    if (dismissedActiveKey === undefined) return;
    if (dismissedActiveKey !== activeConversationKey || activeEntryBusy) {
      setDismissedActiveKey(undefined);
    }
  }, [activeConversationKey, activeEntryBusy, dismissedActiveKey]);

  const visibleActiveKey =
    activeConversationKey !== undefined && activeConversationKey !== dismissedActiveKey
      ? activeConversationKey
      : undefined;

  const inbox = useMemo<UnifiedInboxModel>(() => {
    if (scopedEntries.length === 0) return EMPTY_UNIFIED_INBOX;
    return buildUnifiedInbox(scopedEntries, effectiveSeen, triageMap, nowMs, {
      pinnedViewingKey,
      activeConversationKey: visibleActiveKey,
    });
  }, [scopedEntries, effectiveSeen, triageMap, nowMs, pinnedViewingKey, visibleActiveKey]);

  const allSpacesInbox = useMemo<UnifiedInboxModel>(() => {
    if (allEntries.length === 0) return EMPTY_UNIFIED_INBOX;
    if (scopedEntries.length === allEntries.length) return inbox;
    return buildUnifiedInbox(allEntries, effectiveSeen, triageMap, nowMs, {
      pinnedViewingKey,
      activeConversationKey: visibleActiveKey,
    });
  }, [allEntries, scopedEntries.length, inbox, effectiveSeen, triageMap, nowMs, pinnedViewingKey, visibleActiveKey]);

  const pushUndo = useCallback((entry: UndoEntry) => {
    const next = [...undoStackRef.current, entry];
    if (next.length > MAX_UNDO_STACK) next.splice(0, next.length - MAX_UNDO_STACK);
    undoStackRef.current = next;
    setUndoDepth(next.length);
  }, []);

  const undoLast = useCallback((): boolean => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return false;
    const top = stack[stack.length - 1]!;
    undoStackRef.current = stack.slice(0, -1);
    setUndoDepth(undoStackRef.current.length);

    if (top.prevRecord === undefined) {
      clearConversationTriage(top.ref);
    } else if (top.prevRecord.s === 'settled') {
      settleConversation(top.ref, { epoch: top.prevRecord.epoch, seq: top.prevRecord.seq }, top.prevRecord.reason, top.prevRecord.t);
    } else if (top.prevRecord.s === 'snoozed' && top.prevRecord.u !== undefined) {
      snoozeConversation(top.ref, { epoch: top.prevRecord.epoch, seq: top.prevRecord.seq }, top.prevRecord.u, top.prevRecord.reason, top.prevRecord.t);
    } else if (top.prevRecord.s === 'archived') {
      archiveConversationTriage(top.ref, { epoch: top.prevRecord.epoch, seq: top.prevRecord.seq }, top.prevRecord.reason, top.prevRecord.t);
    }

    const topKey = encodeConversationRef(top.ref);
    setDismissedActiveKey((current) => (current === topKey ? undefined : current));
    if (top.restoreUnread) {
      cancelPendingConversationOpen(top.ref);
      markConversationUnread(top.ref, top.cursor);
      if (top.ref.spaceKey === top.currentSpaceKey && top.ref.kind === 'session') {
        markSessionUnread(top.ref.id, top.cursor.seq);
      }
    }
    return true;
  }, []);

  const pinViewingItem = useCallback((item: UnifiedInboxItem) => {
    // Only pin non-needsYou, non-busy items that would otherwise vanish the moment
    // clicking clears their unread dot.
    pinnedObservedActiveRef.current = false;
    if (!item.needsYou && !item.busy) {
      setPinnedViewingKey(item.encodedKey);
    } else {
      setPinnedViewingKey(undefined);
    }
  }, []);

  const clearViewingPin = useCallback(() => {
    pinnedObservedActiveRef.current = false;
    setPinnedViewingKey(undefined);
  }, []);

  const settleItem = useCallback((item: UnifiedInboxItem) => {
    if (item.needsYou) return;
    const prevRecord = conversationTriageSnapshot()[item.encodedKey];
    if (pinnedViewingKey === item.encodedKey) {
      pinnedObservedActiveRef.current = false;
      setPinnedViewingKey(undefined);
    }
    if (activeConversationKey === item.encodedKey) {
      setDismissedActiveKey(item.encodedKey);
    }
    settleConversation(item.ref, item.attentionCursor, item.reason, fixedNowMs ?? Date.now());
    commitPendingConversationOpen(item.ref, item.attentionCursor, item.spaceKey === currentSpaceKey);
    markConversationSeen(item.ref, item.attentionCursor);
    if (item.spaceKey === currentSpaceKey) {
      if (item.ref.kind === 'room') markRoomSeen(item.ref.id, item.attentionCursor.seq);
      else markSessionSeen(item.ref.id, item.attentionCursor.seq);
    }
    pushUndo({
      ref: item.ref,
      cursor: item.attentionCursor,
      prevRecord,
      restoreUnread: true,
      currentSpaceKey,
    });
    pushToast({
      tone: 'info',
      text: t('sidebar.inbox.settledToast'),
      durationMs: UNDO_TOAST_MS,
      action: { label: t('sidebar.inbox.undo'), run: () => { undoLast(); } },
    });
  }, [activeConversationKey, currentSpaceKey, fixedNowMs, pinnedViewingKey, pushUndo, t, undoLast]);

  const snoozeItem = useCallback((item: UnifiedInboxItem, preset: SnoozePreset) => {
    const prevRecord = conversationTriageSnapshot()[item.encodedKey];
    const stamp = fixedNowMs ?? Date.now();
    const untilMs = computeSnoozeUntilMs(preset, new Date(stamp));
    if (pinnedViewingKey === item.encodedKey) setPinnedViewingKey(undefined);
    if (activeConversationKey === item.encodedKey) setDismissedActiveKey(item.encodedKey);
    snoozeConversation(item.ref, item.attentionCursor, untilMs, item.reason, stamp);
    pushUndo({
      ref: item.ref,
      cursor: item.attentionCursor,
      prevRecord,
      restoreUnread: false,
      currentSpaceKey,
    });
    pushToast({
      tone: 'info',
      text: t('sidebar.inbox.snoozedToast', { time: formatSnoozeTime(untilMs, locale) }),
      durationMs: UNDO_TOAST_MS,
      action: { label: t('sidebar.inbox.undo'), run: () => { undoLast(); } },
    });
  }, [activeConversationKey, currentSpaceKey, fixedNowMs, locale, pinnedViewingKey, pushUndo, t, undoLast]);

  const archiveItem = useCallback((item: UnifiedInboxItem) => {
    if (item.needsYou) return;
    const prevRecord = conversationTriageSnapshot()[item.encodedKey];
    if (pinnedViewingKey === item.encodedKey) setPinnedViewingKey(undefined);
    archiveConversationTriage(item.ref, item.attentionCursor, item.reason, fixedNowMs ?? Date.now());
    pushUndo({
      ref: item.ref,
      cursor: item.attentionCursor,
      prevRecord,
      restoreUnread: false,
      currentSpaceKey,
    });
    pushToast({
      tone: 'info',
      text: t('sidebar.inbox.archivedToast'),
      durationMs: UNDO_TOAST_MS,
      action: { label: t('sidebar.inbox.undo'), run: () => { undoLast(); } },
    });
  }, [currentSpaceKey, fixedNowMs, pinnedViewingKey, pushUndo, t, undoLast]);

  const restoreItem = useCallback((item: UnifiedInboxItem) => {
    clearConversationTriage(item.ref);
    if (!item.needsYou && !item.busy && !item.unread && item.attentionCursor.seq > 0) {
      markConversationUnread(item.ref, item.attentionCursor);
      if (item.spaceKey === currentSpaceKey && item.ref.kind === 'session') {
        markSessionUnread(item.ref.id, item.attentionCursor.seq);
      }
    }
    pushToast({
      tone: 'info',
      text: t('sidebar.inbox.restoredToast'),
    });
  }, [currentSpaceKey, t]);

  return {
    inbox,
    allSpacesInbox,
    pinnedViewingKey,
    pinViewingItem,
    clearViewingPin,
    settleItem,
    snoozeItem,
    archiveItem,
    restoreItem,
    undoLast,
    canUndo: undoDepth > 0,
  };
}
