/**
 * Away notifications and the unread badge, mounted once in the App shell.
 *
 * - Watches the session list the app already polls and turns transitions
 *   (turn failed, approval or question waiting) into system
 *   notifications through `awayNotifier` while hidden or unfocused.
 * - Observes stable work receipts and notifies unless the same conversation
 *   is visible and focused; completed episodes deduplicate by their identity.
 * - The app's own list poll stops while the document is hidden (a window
 *   closed to the tray), so this hook keeps a slower poll of its own running
 *   only in that state; otherwise it would never see the run finish.
 * - Mirrors the activity inbox count onto the taskbar / dock badge.
 * - Routes notification clicks back to the session (or the inbox for a
 *   merged notification).
 */

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
} from '@kiki/session-core/sessions';
import { markSessionSeen, sessionSeenSnapshot, subscribeSessionSeen } from '@kiki/session-core/settings';
import { spaceStorage, spaceStorageKey } from '@kiki/session-core/storage';

import type { HostAdapter, HostNotification } from '../host';
import { useI18n } from '../i18n';
import { useConnection } from '../state/connection';
import { awayNotifier, notificationRoute } from './awayNotify';
import { useThreadTitleResolver } from './threadTitles';

/** Poll cadence while the document is hidden (the visible app polls on its own). */
export const HIDDEN_POLL_INTERVAL_MS = 20_000;

export interface AwayNotificationsOptions {
  readonly host: HostAdapter;
  readonly sessions: readonly Session[];
  /** Fetches the newest sessions while hidden; the app's list query is paused then. */
  readonly listSessions: () => Promise<readonly Session[]>;
  readonly navigate: (route: string) => void;
}

function useFormatter(sessions: readonly Session[]): (notification: AttentionNotification) => HostNotification {
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
        route,
        tag: 'kiki-activity',
      };
    }
    const { event } = notification;
    const title = resolveTitle(event.title.trim() === '' ? t('sidebar.untitled') : event.title);
    return {
      title: t(`away.${event.kind}.title`, { title }),
      body: t(`away.${event.kind}.body`),
      route,
      tag: `kiki-session-${event.sessionId}`,
    };
  }, [t, tp, resolveTitle]);
}

export function useAwayNotifications({ host, sessions, listSessions, navigate }: AwayNotificationsOptions): void {
  const format = useFormatter(sessions);
  const sinceRef = useRef(Date.now());
  const baselineRef = useRef<AttentionBaseline | undefined>(undefined);
  const { client, scopeId, spaceKey, meta } = useConnection();
  const scopeKey = JSON.stringify([spaceKey, scopeId, meta.server_home_id]);
  const location = useLocation();
  const routeRef = useRef(location.pathname);
  routeRef.current = location.pathname;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  useEffect(() => {
    if (host.notify === undefined) return;
    const storage = spaceStorage.capture();
    const key = `kiki.completionObserved.v1:${scopeKey}`;
    let checkpoint: readonly StableCompletion[] | undefined;
    try { checkpoint = readCompletionCheckpoint(storage.getItem(key)); } catch { checkpoint = undefined; }
    const observer = new CompletionObserver(checkpoint);
    let stopped = false;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const completions = await client.notifications.listCompletions();
        if (stopped) return;
        await awayNotifier.report(observer.observe(completions, sessionsRef.current));
        if (!stopped) storage.setItem(key, JSON.stringify(observer.checkpoint()));
      } catch {
        // Retain the episode cursor across a temporary transport failure.
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, 5_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [client, scopeKey, host]);

  // Wire the shared notifier to this host and locale.
  useEffect(() => {
    const notify = host.notify;
    if (notify === undefined) {
      awayNotifier.configure(undefined);
      return;
    }
    awayNotifier.configure({
      isAway: async () => !(await isConversationWindowFocused(host)),
      isViewingSession: (sessionId) => routeRef.current === `/s/${encodeURIComponent(sessionId)}`,
      scopeKey,
      notify,
      format: (notification) => ({ ...format(notification), homeId: spaceKey, scopeId }),
    });
    return () => { awayNotifier.configure(undefined); };
  }, [host, format, scopeKey, spaceKey, scopeId]);

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
    if (host.notify === undefined || typeof document === 'undefined') return;
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
  }, [host, scopeKey]);

  // Taskbar / dock badge: the same count as the activity entry.
  const seen = useSyncExternalStore(subscribeSessionSeen, sessionSeenSnapshot, sessionSeenSnapshot);
  const inbox = useMemo(() => buildInboxModel(sessions, seen), [sessions, seen]);
  useEffect(() => {
    void host.setUnreadBadge?.(inbox.total, spaceKey, scopeId, inbox.unread.map((item) => item.sessionId));
  }, [host, inbox, spaceKey, scopeId]);

  // Clicks come back with the route the notification carried.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    if (host.onNotificationClick === undefined) return;
    return host.onNotificationClick((route, homeId) => {
      if (homeId === undefined && route.startsWith('/')) navigateRef.current(route);
    });
  }, [host]);
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

export function useViewedSession(host: HostAdapter, sessionId: string, lastSeq: number | undefined): void {
  const { scopeId, spaceKey } = useConnection();
  const location = useLocation();
  useEffect(() => {
    if (lastSeq === undefined || location.pathname !== `/s/${encodeURIComponent(sessionId)}`) return;
    let stopped = false;
    const storageKey = spaceStorageKey('kiki.sessionSeen.v1');
    const confirm = async () => {
      if (await isConversationWindowFocused(host) && !stopped && storageKey === spaceStorageKey('kiki.sessionSeen.v1')) {
        markSessionSeen(sessionId, lastSeq);
      }
    };
    void confirm();
    window.addEventListener('focus', confirm);
    document.addEventListener('visibilitychange', confirm);
    return () => {
      stopped = true;
      window.removeEventListener('focus', confirm);
      document.removeEventListener('visibilitychange', confirm);
    };
  }, [host, sessionId, lastSeq, location.pathname, scopeId, spaceKey]);
}
