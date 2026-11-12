/**
 * Away notifier — one delivery point for every system notification about a
 * session, so the list watcher (`useAwayNotifications`) and the open session's
 * live stream (SessionView) share one rate limit and never double-ping.
 *
 * The decision logic is pure (`@kiki/session-core/sessions` awayAttention);
 * this module owns the moving parts: the rate state, the "is the user away"
 * probe, reading the switches, and turning a plan into a host notification.
 *
 * It also owns the one question about system notifications. The system is
 * never asked as a side effect of a notification: the first time anything —
 * a finished task, a failure, a question, an approval waiting — could not be
 * shown while the person was away because the system was never asked, nothing
 * is shown, and the app asks in words when they are back
 * (`components/firstRun/NotifyAskBanner`). Their click is what asks the
 * system. The question comes once per device; "No thanks" is remembered as
 * this device's answer and changes no notification setting. Settings can read
 * where things stand and ask the system from its own button
 * (`systemNotificationState`, `requestSystemNotifications`).
 */

import {
  EMPTY_ATTENTION_RATE,
  planAttentionNotifications,
  type AttentionEvent,
  type AttentionNotification,
  type AttentionRateState,
  type AwayNotificationPrefs,
} from '@kiki/session-core/sessions';
import {
  clearFirstRunHint,
  isFirstRunHintDone,
  markFirstRunHintDone,
  readDesktopPrefs,
  readSettings,
} from '@kiki/session-core/settings';

import type { HostAdapter, HostNotification } from '../host';
import { browserNotificationPermission, requestBrowserPermission } from '../host/browser';
import { NotificationPermissionNotAsked, type SystemNotificationPermission } from '../host/notificationPermission';
import { requestTauriPermission, tauriNotificationPermission } from '../host/tauri';
import { isVscodeWebview } from '../host/vscode';

export interface AwayNotifierDeps {
  /** True when the window is hidden, minimized or not focused. */
  readonly isAway: () => Promise<boolean>;
  readonly isViewingSession?: (sessionId: string) => boolean;
  readonly scopeKey?: string;
  readonly notify: (notification: HostNotification) => Promise<void>;
  /** Builds the text for a plan; locale-bound, so the App supplies it. */
  readonly format: (notification: AttentionNotification) => HostNotification;
  readonly prefs?: () => AwayNotificationPrefs;
  readonly now?: () => number;
}

/** The switches as stored: desktop master switch plus per-kind settings. */
export function readAwayNotificationPrefs(): AwayNotificationPrefs {
  return { enabled: readDesktopPrefs().notifications, kinds: readSettings().awayNotifications };
}

export function sessionRoute(sessionId: string): string {
  return `/s/${encodeURIComponent(sessionId)}`;
}

export const ACTIVITY_ROUTE = '/activity';

/** Where a click on this notification should land. */
export function notificationRoute(notification: AttentionNotification): string {
  if (notification.type !== 'single') return ACTIVITY_ROUTE;
  const event = notification.event;
  const base = sessionRoute(event.sessionId);
  const route = event.agentId && event.agentId !== 'main' ? `${base}/agent/${encodeURIComponent(event.agentId)}` : base;
  const params = new URLSearchParams();
  if (event.interactionId !== undefined) params.set('interaction', event.interactionId);
  else if (event.turnId !== undefined) params.set('turn', event.turnId);
  return params.size === 0 ? route : `${route}?${params}`;
}

export class AwayNotifier {
  private rate: AttentionRateState = EMPTY_ATTENTION_RATE;
  private deps: AwayNotifierDeps | undefined;
  private scopeKey: string | undefined;
  private scopeGeneration = 0;

  configure(deps: AwayNotifierDeps | undefined): void {
    if (deps === undefined) this.scopeGeneration += 1;
    if (deps !== undefined && deps.scopeKey !== this.scopeKey) {
      this.rate = EMPTY_ATTENTION_RATE;
      this.scopeKey = deps.scopeKey;
      this.scopeGeneration += 1;
    }
    this.deps = deps;
  }

  /**
   * Offer events; returns what was delivered (for tests). Events are checked
   * against the switches first so a disabled kind never costs a window probe.
   */
  async report(events: readonly AttentionEvent[]): Promise<AttentionNotification | undefined> {
    const deps = this.deps;
    if (deps === undefined || events.length === 0) return undefined;
    const prefs = (deps.prefs ?? readAwayNotificationPrefs)();
    const wanted = prefs.enabled ? events.filter((event) => prefs.kinds[event.kind]) : [];
    if (wanted.length === 0) return undefined;
    const generation = this.scopeGeneration;
    let away: boolean;
    try {
      away = await deps.isAway();
    } catch {
      away = false;
    }
    const current = this.deps;
    if (current === undefined || generation !== this.scopeGeneration) return undefined;
    const currentPrefs = (current.prefs ?? readAwayNotificationPrefs)();
    const deliverable = wanted.filter((event) => currentPrefs.enabled && currentPrefs.kinds[event.kind]).filter((event) => away ||
      (event.kind === 'completed' && current.isViewingSession !== undefined && !current.isViewingSession(event.sessionId)));
    if (deliverable.length === 0) return undefined;
    const now = (current.now ?? Date.now)();
    const plan = planAttentionNotifications(deliverable, currentPrefs, this.rate, now);
    this.rate = plan.state;
    if (plan.notification === undefined) return undefined;
    try {
      await current.notify(current.format(plan.notification));
    } catch (error) {
      // A denied permission or a closed host: the inbox still has the item.
      // A system that was never asked is asked about later, in words, for
      // whatever the person missed while away.
      if (error instanceof NotificationPermissionNotAsked && away) offerNotificationAsk(plan.notification, error.request);
    }
    return plan.notification;
  }

  /** Test seam. */
  reset(): void {
    this.rate = EMPTY_ATTENTION_RATE;
    this.deps = undefined;
    this.scopeKey = undefined;
    this.scopeGeneration += 1;
  }
}

/**
 * The pending question: the finished task it names (only when that alone was
 * missed), and the call that asks the system.
 */
export interface NotificationAsk {
  readonly title: string | undefined;
  readonly request: () => Promise<boolean>;
}

let pendingAsk: NotificationAsk | null = null;
const askListeners = new Set<() => void>();

function publishAsk(next: NotificationAsk | null): void {
  pendingAsk = next;
  for (const listener of askListeners) listener();
}

export function subscribeNotificationAsk(listener: () => void): () => void {
  askListeners.add(listener);
  return () => { askListeners.delete(listener); };
}

export function notificationAskSnapshot(): NotificationAsk | null {
  return pendingAsk;
}

/**
 * Hold the question for the person's return. One finished task with a title
 * is named; anything else, or several misses, is asked about in general terms.
 */
function offerNotificationAsk(notification: AttentionNotification, request: () => Promise<boolean>): void {
  if (isFirstRunHintDone('notifyAsk')) return;
  const event = notification.type === 'single' ? notification.event : undefined;
  const title = event !== undefined && event.kind === 'completed' && event.title.trim() !== '' ? event.title : undefined;
  publishAsk({ title: pendingAsk === null || pendingAsk.title === title ? title : undefined, request });
}

/**
 * The person's answer, given once. Yes asks the system: call this from the
 * click itself, so the prompt runs inside that gesture. No is remembered as
 * this device's answer; every notification switch stays as it is.
 */
export function answerNotificationAsk(accept: boolean): Promise<boolean> | undefined {
  const ask = pendingAsk;
  if (ask === null) return undefined;
  markFirstRunHintDone('notifyAsk');
  publishAsk(null);
  if (accept) return ask.request();
  markFirstRunHintDone('notifyDeclined');
  return undefined;
}

/**
 * Where system notifications stand on this device: allowed, never asked,
 * declined here ("No thanks" in Kiki; the system itself was never asked),
 * blocked by the browser or the system, or not available on this host.
 */
export type SystemNotificationState = 'granted' | 'notAsked' | 'declined' | 'blocked' | 'unsupported';

async function systemPermission(host: HostAdapter): Promise<SystemNotificationPermission | undefined> {
  if (host.notify === undefined) return undefined;
  if (host.kind === 'tauri') return tauriNotificationPermission();
  // The VS Code webview hands notifications to its extension: nothing to ask.
  if (isVscodeWebview()) return 'granted';
  return browserNotificationPermission();
}

export async function systemNotificationState(host: HostAdapter): Promise<SystemNotificationState> {
  const permission = await systemPermission(host);
  if (permission === undefined) return 'unsupported';
  if (permission === 'granted') return 'granted';
  if (permission === 'denied') return 'blocked';
  return isFirstRunHintDone('notifyDeclined') ? 'declined' : 'notAsked';
}

/**
 * Ask the system, from the person's own click (Settings' way back after "No
 * thanks"). Asking is their new answer, so the earlier "no" and any pending
 * question are cleared. Resolves to whether notifications are now allowed.
 */
export function requestSystemNotifications(host: HostAdapter): Promise<boolean> {
  clearFirstRunHint('notifyDeclined');
  markFirstRunHintDone('notifyAsk');
  publishAsk(null);
  if (host.notify === undefined) return Promise.resolve(false);
  if (host.kind === 'tauri') return requestTauriPermission();
  if (isVscodeWebview()) return Promise.resolve(true);
  return browserNotificationPermission() === undefined ? Promise.resolve(false) : requestBrowserPermission();
}

/** The app's one notifier; `useAwayNotifications` configures it. */
export const awayNotifier = new AwayNotifier();

export function reportAttention(events: readonly AttentionEvent[]): void {
  void awayNotifier.report(events);
}
