// @vitest-environment jsdom

/**
 * System notification permission is asked only from the person's click:
 * something missed while they are away never raises the browser prompt by
 * itself; it leaves one question for their return. "No thanks" is final for
 * the device and switches nothing off; Settings can still ask from its own
 * click.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttentionEvent, AwayNotificationPrefs } from '@kiki/session-core/sessions';

const ALL_ON: AwayNotificationPrefs = {
  enabled: true,
  kinds: { completed: true, failed: true, question: true, approval: true },
};

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static readonly requestPermission = vi.fn(async (): Promise<NotificationPermission> => {
    FakeNotification.permission = 'granted';
    return 'granted';
  });
  static shown = 0;
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor() { FakeNotification.shown += 1; }
}

const roots: Root[] = [];
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

beforeEach(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  FakeNotification.permission = 'default';
  FakeNotification.requestPermission.mockClear();
  FakeNotification.shown = 0;
  vi.stubGlobal('Notification', FakeNotification);
  localStorage.clear();
  localStorage.setItem('kiki.locale', 'en');
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.resetModules();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
});

/** The browser host, the shared notifier and the banner, from one module graph. */
async function setup() {
  const { browserHost } = await import('../../host/browser');
  const awayNotify = await import('../../lib/awayNotify');
  const { AwayNotifier } = awayNotify;
  const { NotifyAskBanner } = await import('./NotifyAskBanner');
  const { I18nProvider } = await import('../../i18n');
  const { readSettings } = await import('@kiki/session-core/settings');
  let away = true;
  let now = 1_000_000;
  const notifier = new AwayNotifier();
  notifier.configure({
    isAway: async () => away,
    notify: browserHost.notify!,
    format: (plan) => ({ title: plan.type }),
    prefs: () => ALL_ON,
    now: () => now,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(<I18nProvider><NotifyAskBanner /></I18nProvider>); });
  const report = async (event: AttentionEvent) => {
    // Far enough apart that the shared rate limit lets each one through.
    now += 10 * 60_000;
    await act(async () => { await notifier.report([event]); });
  };
  const finish = (sessionId: string) => report({ sessionId, kind: 'completed', title: 'Write the release notes' });
  return {
    container,
    report,
    finish,
    setAway: (value: boolean) => { away = value; },
    readSettings,
    awayNotify,
    browserHost,
  };
}

describe('the one question about system notifications', () => {
  it('never prompts on a finish; asks on return and requests permission only from the click', async () => {
    const { container, finish, setAway } = await setup();
    setAway(false);
    await finish('session-a');
    // Present but on another page: nothing to ask "while you were away".
    expect(container.querySelector('[data-notify-ask]')).toBeNull();

    setAway(true);
    await finish('session-b');
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(FakeNotification.shown).toBe(0);
    const banner = container.querySelector('[data-notify-ask]');
    expect(banner?.textContent).toContain('“Write the release notes” finished while you were away.');

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-notify-ask-yes]')!.click(); });
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-notify-ask]')).toBeNull();
  });

  it('asks in general terms when what was missed is not one finished task', async () => {
    const { container, report } = await setup();
    await report({ sessionId: 'session-a', kind: 'approval', title: 'Write the release notes' });
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(FakeNotification.shown).toBe(0);
    expect(container.querySelector('[data-notify-ask]')?.textContent)
      .toContain('Kiki needed you while you were away. Send a system notification next time?');

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-notify-ask-yes]')!.click(); });
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('records "No thanks" for this device without switching any notification off', async () => {
    const { container, finish, readSettings, awayNotify, browserHost } = await setup();
    await finish('session-a');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-notify-ask-no]')!.click(); });
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(container.querySelector('[data-notify-ask]')).toBeNull();
    expect(readSettings().awayNotifications).toEqual({ completed: true, failed: true, question: true, approval: true });
    await expect(awayNotify.systemNotificationState(browserHost)).resolves.toBe('declined');

    // Another missed finish reaching the host does not ask again.
    await finish('session-b');
    expect(container.querySelector('[data-notify-ask]')).toBeNull();
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

    // Settings can still ask, from its own click.
    await expect(awayNotify.requestSystemNotifications(browserHost)).resolves.toBe(true);
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    await expect(awayNotify.systemNotificationState(browserHost)).resolves.toBe('granted');
  });

  it('reads where system notifications stand', async () => {
    const { browserHost, awayNotify } = await setup();
    await expect(awayNotify.systemNotificationState(browserHost)).resolves.toBe('notAsked');
    FakeNotification.permission = 'denied';
    await expect(awayNotify.systemNotificationState(browserHost)).resolves.toBe('blocked');
    await expect(awayNotify.systemNotificationState({ ...browserHost, notify: undefined })).resolves.toBe('unsupported');
  });
});
