/**
 * Away notifications and the unread badge, mounted once in the App shell.
 *
 * - Watches the session list the app already polls and turns transitions
 *   (turn failed, approval or question waiting) into system notifications
 *   through `awayNotifier` while hidden or unfocused.
 * - Observes stable work receipts and notifies unless the same conversation
 *   is visible and focused; completed episodes deduplicate by their identity.
 * - The app's own list poll stops while the document is hidden (a window
 *   closed to the tray), so this hook keeps a slower poll of its own running
 *   only in that state; otherwise it would never see the run finish.
 * - Mirrors the activity inbox count onto the taskbar / dock badge.
 * - NavScopeBoundary owns the scoped notification-click consumer; an embedded
 *   shell with no boundary can pass `navigate` for a plain one instead.
 */

import { randomUuid } from '@kiki/session-core/util';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';

import type { Session } from '@kiki/protocol';
import {
  buildInboxModel,
  CompletionObserver,
  detectAttentionEvents,
  type AttentionBaseline,
  type AttentionNotification,
  type StableCompletion,
  type UnifiedInboxModel,
} from '@kiki/session-core/sessions';
import {
  markConversationSeen,
  markRoomSeen,
  markSessionSeen,
  seedLegacySeenForSpace,
  sessionSeenSnapshot,
  subscribeSessionSeen,
  type AttentionCursor,
  type ConversationRef,
} from '@kiki/session-core/settings';
import { spaceStorage, spaceStorageKey } from '@kiki/session-core/storage';

import type { HostAdapter, HostNotification } from '../host';
import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import { awayNotifier, notificationRoute } from './awayNotify';
import { stripPlacePrefix } from './placeRoutes';
import {
  commitPendingConversationOpen,
  hasPendingConversationOpen,
} from './conversationOpen';
import { activeSpace } from './spaceStorage';
import { useDeferSecondaryBootQueries } from './bootHydrationGate';
import type { NavScopeIdentity } from './navHistory';
import { useThreadTitleResolver } from './threadTitles';

/** Matches `/s/:id`, `/s/:id/agent/:agentId`, and `/p/:conn/s/:id...`, never `/s/:id/tasks`. */
export function isViewingSessionPath(pathname: string, sessionId: string): boolean {
  if (sessionId === '') return false;
  const normalized = stripPlacePrefix(pathname);
  const route = `/s/${encodeURIComponent(sessionId)}`;
  if (normalized === route) return true;
  if (!normalized.startsWith(`${route}/`)) return false;
  const rest = normalized.slice(route.length + 1);
  return rest.startsWith('agent/');
}

/** Matches `/rooms/:id` and `/p/:conn/rooms/:id` (with optional trailing slash). */
export function isViewingRoomPath(pathname: string, roomId: string): boolean {
  if (roomId === '') return false;
  const normalized = stripPlacePrefix(pathname);
  const route = `/rooms/${encodeURIComponent(roomId)}`;
  return normalized === route || normalized === `${route}/`;
}

async function subscribeNativeWindowFocus(
  host: HostAdapter,
  onFocus: () => void,
): Promise<(() => void) | undefined> {
  if (host.kind !== 'tauri') return undefined;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return await getCurrentWindow().onFocusChanged(({ payload }) => {
      if (payload) onFocus();
    });
  } catch {
    return undefined;
  }
}

/** Poll cadence while the document is hidden (the visible app polls on its own). */
export const HIDDEN_POLL_INTERVAL_MS = 20_000;

const sendingNotifications = new Set<{
  readonly scopeKey: string;
  readonly sessionIds: readonly string[];
  readonly viewed: Set<string>;
}>();

export interface AwayNotificationsOptions {
  readonly host: HostAdapter;
  readonly enabled?: boolean;
  readonly sessions: readonly Session[];
  /** Fetches the newest sessions while hidden; the app's list query is paused then. */
  readonly listSessions: () => Promise<readonly Session[]>;
  /**
   * Optional unified multi-space inbox model. When provided, the taskbar / dock
   * badge mirrors these exact counts so sidebar, activity, mobile header, and
   * native badge stay in lockstep.
   */
  readonly unifiedInbox?: UnifiedInboxModel;
  /**
   * Plain click consumer for a shell that mounts no `NavScopeBoundary`. The app
   * shell leaves it out: scoped navigation needs the boundary's own consumer.
   */
  readonly navigate?: (route: string) => void;
}

function useFormatter(sessions: readonly Session[], scope: NavScopeIdentity): (notification: AttentionNotification) => HostNotification {
  const { t, tp } = useI18n();
  const resolveTitle = useThreadTitleResolver(sessions.map((session) => session.title), sessions);
  return useMemo(() => (notification: AttentionNotification): HostNotification => {
    const route = notificationRoute(notification);
    if (notification.type === 'merged') {
      const parts = [
        notification.needsYou > 0 ? tp('away.merged.needsYou', notification.needsYou) : undefined,
        notification.finished > 0 ? tp('away.merged.finished', notification.finished) : undefined,
      ].filter((part): part is string => part !== undefined);
      return {
        title: t('away.merged.title', { count: notification.events.length }),
        body: parts.join(' · '),
        route, scope,
        homeId: scope.homeId, scopeId: scope.scopeId,
        tag: `kiki-activity-${scope.homeId}-${scope.scopeId}`,
        sessionIds: notification.events.map((event) => event.sessionId),
      };
    }
    const { event } = notification;
    const title = resolveTitle(event.title.trim() === '' ? t('sidebar.untitled') : event.title);
    return {
      title: t(`away.${event.kind}.title`, { title }),
      body: t(`away.${event.kind}.body`),
      route, scope,
      homeId: scope.homeId, scopeId: scope.scopeId,
      tag: `kiki-session-${scope.homeId}-${scope.scopeId}-${event.sessionId}`,
      sessionIds: [event.sessionId],
    };
  }, [t, tp, resolveTitle, scope]);
}

export function useAwayNotifications({ host, sessions, listSessions, unifiedInbox, navigate, enabled = true }: AwayNotificationsOptions): void {
  const connection = useConnection();
  const { client, scopeId, meta, spaceKey } = connection;
  const effectiveSpaceKey = spaceKey || activeSpace()?.homeId || 'main';
  const scope = useMemo<NavScopeIdentity>(() => ({
    homeId: effectiveSpaceKey, scopeId,
    serverHomeId: meta.server_home_id, connectionRef: connection.connectionRef,
  }), [effectiveSpaceKey, scopeId, meta.server_home_id, connection.connectionRef]);
  const scopeKey = JSON.stringify(scope);
  // Seed legacy v1 seen marks into the v2 global store once per verified space
  // so existing users keep their read history across the v1 -> v2 upgrade.
  useEffect(() => {
    seedLegacySeenForSpace(effectiveSpaceKey, sessionSeenSnapshot());
  }, [effectiveSpaceKey]);
  const format = useFormatter(sessions, scope);
  const formatRef = useRef(format);
  formatRef.current = format;
  const sinceRef = useRef(Date.now());
  const baselineRef = useRef<AttentionBaseline | undefined>(undefined);
  const location = useLocation();
  const routeRef = useRef(location.pathname);
  routeRef.current = location.pathname;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Stable work receipts: the list poll cannot see an episode end while the
  // app's own query is paused, so this poll owns its checkpoint. When the live
  // event socket is open, work-change events trigger immediate coalesced reads
  // and the fallback timer backs off so an idle window stays quiet.
  const wsOpen = connection.wsStatus === 'open';
  const deferSecondaryBoot = useDeferSecondaryBootQueries();
  useEffect(() => {
    if (host.notify === undefined || deferSecondaryBoot) return;
    const storage = spaceStorage.capture();
    const key = `kiki.completionObserved.v1:${scopeKey}`;
    const savedRaw = storage.getItem(key);
    let checkpoint: readonly StableCompletion[] | undefined;
    try { checkpoint = readCompletionCheckpoint(savedRaw); } catch { checkpoint = undefined; }
    let lastSavedJson = savedRaw;
    const observer = new CompletionObserver(checkpoint);
    let stopped = false;
    let running = false;
    let queued = false;
    let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (running) {
        queued = true;
        return;
      }
      running = true;
      queued = false;
      try {
        const completions = await client.notifications.listCompletions();
        if (stopped) return;
        await awayNotifier.report(observer.observe(completions, sessionsRef.current));
        if (!stopped) {
          const nextJson = JSON.stringify(observer.checkpoint());
          if (nextJson !== lastSavedJson) {
            lastSavedJson = nextJson;
            storage.setItem(key, nextJson);
          }
        }
      } catch {
        // Retain the episode cursor across a temporary transport failure.
      } finally {
        running = false;
        if (!stopped && queued) {
          queued = false;
          void tick();
        }
      }
    };
    const scheduleEventTick = () => {
      if (stopped || coalesceTimer !== undefined) return;
      coalesceTimer = setTimeout(() => {
        coalesceTimer = undefined;
        void tick();
      }, 250);
    };
    void tick();
    const events = client.klient?.events;
    const subs = wsOpen && events !== undefined
      ? [
          events.on('session.workChanged', scheduleEventTick),
          events.on('session.metaUpdated', scheduleEventTick),
        ]
      : [];
    const timer = setInterval(() => { void tick(); }, wsOpen && subs.length > 0 ? 60_000 : 5_000);
    return () => {
      stopped = true;
      clearInterval(timer);
      if (coalesceTimer !== undefined) clearTimeout(coalesceTimer);
      for (const sub of subs) sub.dispose();
    };
  }, [client, scopeKey, host, wsOpen, deferSecondaryBoot]);

  // Wire the shared notifier to this host and locale.
  useEffect(() => {
    const notify = host.notify;
    if (notify === undefined) {
      awayNotifier.configure(undefined);
      return;
    }
    const isViewingSession = (sessionId: string) => isViewingSessionPath(routeRef.current, sessionId);
    awayNotifier.configure({
      isAway: async () => !(await isConversationWindowFocused(host)),
      isViewingSession,
      scopeKey,
      notify: async (notification) => {
        const deliveryId = randomUuid();
        const sending = { scopeKey, sessionIds: notification.sessionIds ?? [], viewed: new Set<string>() };
        sendingNotifications.add(sending);
        try {
          await notify({ ...notification, deliveryId });
          for (const id of sending.viewed) await host.acknowledgeNotifications?.(id, scope, deliveryId);
        } finally {
          sendingNotifications.delete(sending);
        }
      },
      format: (notification) => formatRef.current(notification),
    });
    return () => { awayNotifier.configure(undefined); };
  }, [host, scope, scopeKey]);

  // Diff every list the app (or the hidden poll) observes.
  const observe = useRef((list: readonly Session[]) => {
    const previous = baselineRef.current;
    const { events, baseline } = detectAttentionEvents(previous ?? new Map(), list, sinceRef.current);
    baselineRef.current = baseline;
    // The very first list is the baseline: what was already true at launch is not news.
    if (previous === undefined) return;
    void awayNotifier.report(events.filter((event) => event.kind !== 'completed'));
  });
  useEffect(() => {
    baselineRef.current = undefined;
    sinceRef.current = Date.now();
  }, [scopeKey]);
  useEffect(() => {
    if (sessions.length === 0 && baselineRef.current === undefined) return;
    observe.current(sessions);
  }, [sessions, scopeKey]);

  // Hidden-window poll: the app's own poll pauses while the document is hidden.
  const listRef = useRef(listSessions);
  listRef.current = listSessions;
  useEffect(() => {
    if (!enabled || host.notify === undefined || typeof document === 'undefined') return;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => {
      if (document.visibilityState !== 'hidden') return;
      void listRef.current().then((list) => { if (!stopped) observe.current(list); }, () => undefined);
    };
    const sync = () => {
      if (document.visibilityState === 'hidden') {
        timer ??= setInterval(tick, HIDDEN_POLL_INTERVAL_MS);
      } else if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', sync);
      if (timer !== undefined) clearInterval(timer);
    };
  }, [enabled, host, scopeKey]);

  // Taskbar / dock badge: mirrors the unified inbox when supplied, else the
  // local session inbox for standalone shells and unit tests.
  const seen = useSyncExternalStore(subscribeSessionSeen, sessionSeenSnapshot, sessionSeenSnapshot);
  const localInbox = useMemo(() => (unifiedInbox === undefined ? buildInboxModel(sessions, seen) : undefined), [unifiedInbox, sessions, seen]);
  const badgeTotal = unifiedInbox !== undefined ? unifiedInbox.total : (localInbox?.total ?? 0);
  const unreadSessionIds = useMemo(() => {
    if (unifiedInbox !== undefined) {
      return JSON.stringify(
        unifiedInbox.active
          .filter((item) => !item.needsYou && item.triageClass === 'active')
          .map((item) => item.sessionId)
          .toSorted(),
      );
    }
    return JSON.stringify((localInbox?.unread ?? []).map((item) => item.sessionId).toSorted());
  }, [unifiedInbox, localInbox]);
  useEffect(() => {
    void host.setUnreadBadge?.(badgeTotal, scope.homeId, scopeId, JSON.parse(unreadSessionIds) as string[]);
  }, [host, badgeTotal, unreadSessionIds, scope.homeId, scopeId]);

  // Clicks come back with the route the notification carried. The app shell
  // mounts NavScopeBoundary, which owns the scoped consumer (it verifies the
  // destination belongs to the live scope); a boundary-less shell passes
  // `navigate` and gets the plain one.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    const click = host.onNotificationClick;
    if (navigate === undefined || click === undefined) return;
    return click((route, homeId) => {
      if (homeId === undefined && route.startsWith('/')) navigateRef.current?.(route);
    });
  }, [host, navigate]);
}

export async function isConversationWindowFocused(host: HostAdapter): Promise<boolean> {
  if (document.visibilityState === 'hidden') return false;
  try {
    const focused = host.isWindowVisibleAndFocused !== undefined
      ? await host.isWindowVisibleAndFocused()
      : document.hasFocus();
    return focused && document.visibilityState === 'visible';
  } catch {
    return false;
  }
}

export function readCompletionCheckpoint(raw: string | null): readonly StableCompletion[] | undefined {
  if (raw === null) return undefined;
  try {
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) return undefined;
    return rows.filter((row): row is StableCompletion => typeof row?.session_id === 'string' &&
      typeof row?.episode_id === 'string' && typeof row?.completed_at === 'number' && Number.isFinite(row.completed_at));
  } catch {
    return undefined;
  }
}

function normalizeViewedCursor(cursorOrSeq: number | AttentionCursor | undefined): AttentionCursor | undefined {
  if (cursorOrSeq === undefined) return undefined;
  if (typeof cursorOrSeq === 'number') {
    return Number.isFinite(cursorOrSeq) ? { seq: Math.max(0, Math.trunc(cursorOrSeq)) } : undefined;
  }
  if (!Number.isFinite(cursorOrSeq.seq)) return undefined;
  return cursorOrSeq.epoch === undefined
    ? { seq: Math.max(0, Math.trunc(cursorOrSeq.seq)) }
    : { epoch: cursorOrSeq.epoch, seq: Math.max(0, Math.trunc(cursorOrSeq.seq)) };
}

export function useViewedSession(
  host: HostAdapter,
  sessionId: string,
  cursorOrSeq: number | AttentionCursor | undefined,
): void {
  const { scopeId, spaceKey, meta, connectionRef } = useConnection();
  const location = useLocation();
  const effectiveSpaceKey = spaceKey || activeSpace()?.homeId || 'main';
  const cursor = normalizeViewedCursor(cursorOrSeq);
  const cursorEpoch = cursor?.epoch;
  const cursorSeq = cursor?.seq;
  const viewing = cursorSeq !== undefined && isViewingSessionPath(location.pathname, sessionId);

  // Track confirmed visibility on this conversation so leaving for another
  // conversation flushes the latest semantic cursor without firing during
  // React StrictMode unmount/remount or main<->subagent navigation.
  const confirmedViewRef = useRef<{
    readonly ref: ConversationRef;
    cursor: AttentionCursor;
    confirmed: boolean;
    readonly storageKey: string;
  } | null>(null);

  useEffect(() => {
    const prev = confirmedViewRef.current;
    if (prev !== null && prev.confirmed) {
      const stillSameConversation =
        prev.ref.spaceKey === effectiveSpaceKey &&
        prev.ref.id === sessionId &&
        isViewingSessionPath(location.pathname, prev.ref.id);
      if (!stillSameConversation) {
        markConversationSeen(prev.ref, prev.cursor);
        if (prev.storageKey === spaceStorageKey('kiki.sessionSeen.v1')) {
          markSessionSeen(prev.ref.id, prev.cursor.seq);
        }
        confirmedViewRef.current = null;
      }
    }
  }, [effectiveSpaceKey, sessionId, location.pathname]);

  useEffect(() => {
    if (!viewing || cursorSeq === undefined) return;
    const activeCursor: AttentionCursor = cursorEpoch === undefined ? { seq: cursorSeq } : { epoch: cursorEpoch, seq: cursorSeq };
    const ref: ConversationRef = { spaceKey: effectiveSpaceKey, kind: 'session', id: sessionId };
    const scope: NavScopeIdentity = {
      homeId: effectiveSpaceKey,
      scopeId,
      serverHomeId: meta.server_home_id,
      connectionRef,
    };
    const storageKey = spaceStorageKey('kiki.sessionSeen.v1');
    if (
      confirmedViewRef.current !== null &&
      confirmedViewRef.current.ref.spaceKey === ref.spaceKey &&
      confirmedViewRef.current.ref.id === ref.id
    ) {
      confirmedViewRef.current.cursor = activeCursor;
    } else {
      confirmedViewRef.current = { ref, cursor: activeCursor, confirmed: false, storageKey };
    }

    let stopped = false;
    let recheckTimer: ReturnType<typeof setTimeout> | undefined;
    let unlistenNative: (() => void) | undefined;

    const recordConfirmed = async () => {
      if (stopped || storageKey !== spaceStorageKey('kiki.sessionSeen.v1')) return;
      if (confirmedViewRef.current !== null && confirmedViewRef.current.ref.id === sessionId) {
        confirmedViewRef.current.confirmed = true;
        confirmedViewRef.current.cursor = activeCursor;
      }
      commitPendingConversationOpen(ref, activeCursor, true);
      markConversationSeen(ref, activeCursor);
      markSessionSeen(sessionId, activeCursor.seq);
      const scopeKey = JSON.stringify(scope);
      for (const sending of sendingNotifications) {
        if (sending.scopeKey === scopeKey && sending.sessionIds.includes(sessionId)) sending.viewed.add(sessionId);
      }
      await host.acknowledgeNotifications?.(sessionId, scope);
    };

    const confirm = async (allowRecheck: boolean) => {
      const explicitOpen = hasPendingConversationOpen(ref) && document.visibilityState === 'visible';
      const focused = await isConversationWindowFocused(host);
      if (stopped || storageKey !== spaceStorageKey('kiki.sessionSeen.v1')) return;
      if (focused || (explicitOpen && document.visibilityState === 'visible')) {
        await recordConfirmed();
        return;
      }
      // Bounded activation recheck: WebView2/Tauri window.isFocused() can lag
      // briefly behind a click or visibility transition.
      if (allowRecheck && document.visibilityState === 'visible' && recheckTimer === undefined) {
        recheckTimer = setTimeout(() => {
          recheckTimer = undefined;
          if (!stopped) {
            void confirm(false).catch((error: unknown) => {
              console.warn('Cannot acknowledge viewed conversation notifications', error);
            });
          }
        }, 150);
      }
    };

    const confirmFromEvent = () => {
      void confirm(false).catch((error: unknown) => {
        console.warn('Cannot acknowledge viewed conversation notifications', error);
      });
    };

    void confirm(true).catch((error: unknown) => {
      console.warn('Cannot acknowledge viewed conversation notifications', error);
    });
    window.addEventListener('focus', confirmFromEvent);
    document.addEventListener('visibilitychange', confirmFromEvent);
    void subscribeNativeWindowFocus(host, confirmFromEvent).then((dispose) => {
      if (stopped) dispose?.();
      else unlistenNative = dispose;
    });
    return () => {
      stopped = true;
      if (recheckTimer !== undefined) clearTimeout(recheckTimer);
      unlistenNative?.();
      window.removeEventListener('focus', confirmFromEvent);
      document.removeEventListener('visibilitychange', confirmFromEvent);
    };
  }, [host, viewing, sessionId, cursorEpoch, cursorSeq, effectiveSpaceKey, scopeId, meta.server_home_id, connectionRef]);
}

/** Focus-aware viewed coordinator for `/rooms/:id` (replaces blind background-poll seen writes). */
export function useViewedRoom(host: HostAdapter, roomId: string, lastSeq: number | undefined): void {
  const { spaceKey } = useConnection();
  const location = useLocation();
  const effectiveSpaceKey = spaceKey || activeSpace()?.homeId || 'main';
  const viewing = lastSeq !== undefined && Number.isFinite(lastSeq) && isViewingRoomPath(location.pathname, roomId);

  useEffect(() => {
    if (!viewing || lastSeq === undefined) return;
    const seq = Math.max(0, Math.trunc(lastSeq));
    const cursor: AttentionCursor = { seq };
    const ref: ConversationRef = { spaceKey: effectiveSpaceKey, kind: 'room', id: roomId };
    const storageKey = spaceStorageKey('kiki.sessionSeen.v1');
    let stopped = false;
    let recheckTimer: ReturnType<typeof setTimeout> | undefined;
    let unlistenNative: (() => void) | undefined;

    const confirm = async (allowRecheck: boolean) => {
      const explicitOpen = hasPendingConversationOpen(ref) && document.visibilityState === 'visible';
      const focused = await isConversationWindowFocused(host);
      if (stopped || storageKey !== spaceStorageKey('kiki.sessionSeen.v1')) return;
      if (focused || (explicitOpen && document.visibilityState === 'visible')) {
        commitPendingConversationOpen(ref, cursor, true);
        markConversationSeen(ref, cursor);
        markRoomSeen(roomId, seq);
        return;
      }
      if (allowRecheck && document.visibilityState === 'visible' && recheckTimer === undefined) {
        recheckTimer = setTimeout(() => {
          recheckTimer = undefined;
          if (!stopped) void confirm(false);
        }, 150);
      }
    };

    const confirmFromEvent = () => { void confirm(false); };
    void confirm(true);
    window.addEventListener('focus', confirmFromEvent);
    document.addEventListener('visibilitychange', confirmFromEvent);
    void subscribeNativeWindowFocus(host, confirmFromEvent).then((dispose) => {
      if (stopped) dispose?.();
      else unlistenNative = dispose;
    });
    return () => {
      stopped = true;
      if (recheckTimer !== undefined) clearTimeout(recheckTimer);
      unlistenNative?.();
      window.removeEventListener('focus', confirmFromEvent);
      document.removeEventListener('visibilitychange', confirmFromEvent);
    };
  }, [host, viewing, roomId, lastSeq, effectiveSpaceKey]);
}
