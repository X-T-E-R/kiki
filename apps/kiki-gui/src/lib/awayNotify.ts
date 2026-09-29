/**
 * Away notifier — one delivery point for every system notification about a
 * session, so the list watcher (`useAwayNotifications`) and the open session's
 * live stream (SessionView) share one rate limit and never double-ping.
 *
 * The decision logic is pure (`@kiki/session-core/sessions` awayAttention);
 * this module owns the moving parts: the rate state, the "is the user away"
 * probe, reading the switches, and turning a plan into a host notification.
 */

import {
  EMPTY_ATTENTION_RATE,
  planAttentionNotifications,
  type AttentionEvent,
  type AttentionNotification,
  type AttentionRateState,
  type AwayNotificationPrefs,
} from '@kiki/session-core/sessions';
import { readDesktopPrefs, readSettings } from '@kiki/session-core/settings';

import type { HostNotification } from '../host';

export interface AwayNotifierDeps {
  /** True when the window is hidden, minimized or not focused. */
  readonly isAway: () => Promise<boolean>;
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
  return notification.type === 'single' ? sessionRoute(notification.event.sessionId) : ACTIVITY_ROUTE;
}

export class AwayNotifier {
  private rate: AttentionRateState = EMPTY_ATTENTION_RATE;
  private deps: AwayNotifierDeps | undefined;

  configure(deps: AwayNotifierDeps | undefined): void {
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
    let away: boolean;
    try {
      away = await deps.isAway();
    } catch {
      away = false;
    }
    // The user is looking at the window: the inbox and the row states carry
    // it, and nothing is spent from the rate limit.
    if (!away) return undefined;
    const now = (deps.now ?? Date.now)();
    const plan = planAttentionNotifications(wanted, prefs, this.rate, now);
    this.rate = plan.state;
    if (plan.notification === undefined) return undefined;
    try {
      await deps.notify(deps.format(plan.notification));
    } catch {
      // A denied permission or a closed host: the inbox still has the item.
    }
    return plan.notification;
  }

  /** Test seam. */
  reset(): void {
    this.rate = EMPTY_ATTENTION_RATE;
    this.deps = undefined;
  }
}

/** The app's one notifier; `useAwayNotifications` configures it. */
export const awayNotifier = new AwayNotifier();

export function reportAttention(events: readonly AttentionEvent[]): void {
  void awayNotifier.report(events);
}
