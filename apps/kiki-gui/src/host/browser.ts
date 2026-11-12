import type { BrowserHostAdapter, HostNotification } from './host';
import { NotificationPermissionNotAsked, type SystemNotificationPermission } from './notificationPermission';
import { browserSaveSink } from './saveSink';

type ClickListener = Parameters<NonNullable<BrowserHostAdapter['onNotificationClick']>>[0];
const clickListeners = new Set<ClickListener>();

function notificationsAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.Notification === 'function';
}

/** The browser's own answer so far, or undefined where it has no notifications. */
export function browserNotificationPermission(): SystemNotificationPermission | undefined {
  return notificationsAvailable() ? window.Notification.permission : undefined;
}

/**
 * The browser's permission prompt. It starts synchronously so that, called
 * from a click handler, it still runs inside that user gesture. Older engines
 * answer through a callback and return nothing, hence the `Promise.resolve`.
 */
export function requestBrowserPermission(): Promise<boolean> {
  const answer = window.Notification.requestPermission();
  return Promise.resolve(answer).then((value) => value === 'granted' || window.Notification.permission === 'granted');
}

/**
 * Web Notifications for `kiki web`. A browser that has not been asked yet
 * shows nothing and rejects with `NotificationPermissionNotAsked`; the app asks
 * the person first and requests permission from their click. A denied or
 * unsupported browser simply shows nothing (the activity inbox still holds the
 * item). A click focuses the tab and routes the page.
 */
async function browserNotify(options: HostNotification): Promise<void> {
  if (!notificationsAvailable()) return;
  const permission = window.Notification.permission;
  if (permission === 'default') throw new NotificationPermissionNotAsked(requestBrowserPermission);
  if (permission !== 'granted') return;
  const notification = new window.Notification(options.title, {
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.tag === undefined ? {} : { tag: options.tag }),
  });
  const route = options.route;
  const scope = options.scope;
  notification.onclick = () => {
    window.focus();
    notification.close();
    if (route !== undefined) for (const listener of clickListeners) listener(route, scope?.homeId, scope);
  };
}

interface ViteLocalServerPayload {
  readonly url?: string;
  readonly token?: string;
  readonly error?: string;
}

export const browserHost: BrowserHostAdapter = {
  kind: 'browser',
  openSaveSink: browserSaveSink,
  ...(notificationsAvailable()
    ? {
      notify: browserNotify,
      onNotificationClick: (callback: ClickListener) => {
        clickListeners.add(callback);
        return () => { clickListeners.delete(callback); };
      },
    }
    : {}),
  connection: {
    async discover() {
      const response = await fetch('/__kiki/local-server');
      if (!response.ok) throw new Error(`Local server detection failed (${response.status})`);
      const payload = (await response.json()) as ViteLocalServerPayload;
      if (payload.error !== undefined) throw new Error(payload.error);
      if (payload.url === undefined) return null;
      return {
        config: { url: payload.url, token: payload.token ?? '' },
        persist: false,
      };
    },
  },
};
