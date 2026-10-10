import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttentionEvent, AwayNotificationPrefs } from '@kiki/session-core/sessions';

import { ACTIVITY_ROUTE, AwayNotifier, notificationRoute } from './awayNotify';

const ALL_ON: AwayNotificationPrefs = {
  enabled: true,
  kinds: { completed: true, failed: true, question: true, approval: true },
};

const event = (sessionId: string, kind: AttentionEvent['kind']): AttentionEvent => ({ sessionId, kind, title: `T ${sessionId}` });

describe('AwayNotifier', () => {
  let notifier: AwayNotifier;
  let away: boolean;
  let prefs: AwayNotificationPrefs;
  let now: number;
  const notify = vi.fn(async () => undefined);
  const isAway = vi.fn(async () => away);

  beforeEach(() => {
    notifier = new AwayNotifier();
    away = true;
    prefs = ALL_ON;
    now = 1_000_000;
    notify.mockClear();
    isAway.mockClear();
    notifier.configure({
      isAway,
      notify,
      format: (plan) => ({ title: plan.type, route: notificationRoute(plan) }),
      prefs: () => prefs,
      now: () => now,
    });
  });
  afterEach(() => { notifier.reset(); });

  it('notifies only while the window is away, and routes the click to the session', async () => {
    away = false;
    expect(await notifier.report([event('a', 'completed')])).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
    away = true;
    await notifier.report([event('a', 'completed')]);
    expect(notify).toHaveBeenCalledWith({ title: 'single', route: '/s/a' });
  });

  it('does not spend the rate limit while the user is looking', async () => {
    away = false;
    await notifier.report([event('a', 'completed')]);
    away = true;
    await notifier.report([event('a', 'completed')]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('honours the master switch and per-kind switches without probing the window', async () => {
    prefs = { ...ALL_ON, enabled: false };
    await notifier.report([event('a', 'approval')]);
    prefs = { enabled: true, kinds: { ...ALL_ON.kinds, completed: false } };
    await notifier.report([event('a', 'completed')]);
    expect(isAway).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('shares one rate limit between the live stream and the list watcher', async () => {
    await notifier.report([event('a', 'completed')]);
    now += 5_000;
    // The list poll sees the same finish a few seconds later.
    await notifier.report([event('a', 'completed')]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('sends a burst across sessions as one notification that opens the inbox', async () => {
    await notifier.report([event('a', 'completed'), event('b', 'question')]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ title: 'merged', route: ACTIVITY_ROUTE });
  });

  it('preserves a child and exact turn or interaction without falling back to main', () => {
    const child = { ...event('session / one', 'completed'), agentId: 'child / two', turnId: 't4' };
    expect(notificationRoute({ type: 'single', event: child })).toBe('/s/session%20%2F%20one/agent/child%20%2F%20two?turn=t4');
    expect(notificationRoute({ type: 'single', event: { ...child, kind: 'approval', interactionId: 'approval/3' } }))
      .toBe('/s/session%20%2F%20one/agent/child%20%2F%20two?interaction=approval%2F3');
  });

  it('drops a late away probe from the previous connection rather than delivering it under the new scope', async () => {
    let release!: (value: boolean) => void;
    isAway.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = notifier.report([event('same-session', 'question')]);
    notifier.reset();
    notifier.configure({ isAway: async () => true, notify, format: () => ({ title: 'new-scope' }), prefs: () => ALL_ON });
    release(true);
    expect(await pending).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
    await notifier.report([event('same-session', 'question')]);
    expect(notify).toHaveBeenCalledWith({ title: 'new-scope' });
  });

  it('survives a host that rejects the notification', async () => {
    notify.mockRejectedValueOnce(new Error('denied'));
    await expect(notifier.report([event('a', 'failed')])).resolves.toMatchObject({ type: 'single' });
  });
});
