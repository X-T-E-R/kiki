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

  it('notifies B while A is foreground without changing approval/question/failure foreground rules', async () => {
    away = false;
    const configure = (scopeKey: string) => notifier.configure({
      isAway, isViewingSession: (id) => id === 'a', scopeKey, notify,
      format: (plan) => ({ title: plan.type, route: notificationRoute(plan) }), prefs: () => prefs, now: () => now,
    });
    configure('home-a/local');
    await notifier.report([event('a', 'completed'), event('b', 'completed'), event('c', 'approval'), event('d', 'failed')]);
    expect(notify).toHaveBeenCalledExactlyOnceWith({ title: 'single', route: '/s/b' });
    configure('home-b/local');
    await notifier.report([event('b', 'completed')]);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('preserves completion during a same-scope list refresh, but drops an old-scope probe', async () => {
    let resolve: ((value: boolean) => void) | undefined;
    const configure = (scopeKey: string, title: string) => notifier.configure({
      isAway: () => new Promise<boolean>((done) => { resolve = done; }),
      isViewingSession: () => false, scopeKey, notify,
      format: (plan) => ({ title, route: notificationRoute(plan) }), prefs: () => prefs, now: () => now,
    });
    configure('home-a/local', 'before');
    const pending = notifier.report([event('b', 'completed')]);
    configure('home-a/local', 'after');
    resolve?.(false);
    await pending;
    expect(notify).toHaveBeenCalledExactlyOnceWith({ title: 'after', route: '/s/b' });
    const previous = notifier.report([event('c', 'completed')]);
    configure('home-b/local', 'other');
    resolve?.(false);
    await previous;
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('survives a host that rejects the notification', async () => {
    notify.mockRejectedValueOnce(new Error('denied'));
    await expect(notifier.report([event('a', 'failed')])).resolves.toMatchObject({ type: 'single' });
  });
});
