// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('browser notification navigation', () => {
  it('focuses the producing tab and carries its captured remote identity and child/turn route', async () => {
    let notification!: { onclick: (() => void) | null; close: ReturnType<typeof vi.fn> };
    class FakeNotification {
      static permission = 'granted';
      onclick: (() => void) | null = null;
      close = vi.fn();
      constructor(_title: string, _options: NotificationOptions) { notification = this; }
    }
    vi.stubGlobal('Notification', FakeNotification);
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const { browserHost } = await import('./browser');
    const click = vi.fn();
    const unsubscribe = browserHost.onNotificationClick!(click);
    const scope = { homeId: 'remote:example', scopeId: 'remote:example', serverHomeId: 'remote-home', connectionRef: 'example' };
    await browserHost.notify!({ title: 'Needs input', route: '/s/shared/agent/child?interaction=approval-1', scope });
    notification.onclick!();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(notification.close).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledWith('/s/shared/agent/child?interaction=approval-1', scope.homeId, scope);
    unsubscribe();
    notification.onclick!();
    expect(click).toHaveBeenCalledTimes(1);
    focus.mockRestore();
  });
});
