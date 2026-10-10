import type { BrowserHostAdapter, HostNotification } from './host';
import { browserSaveSink } from './saveSink';

type ClickListener = Parameters<NonNullable<BrowserHostAdapter['onNotificationClick']>>[0];
const clickListeners = new Set<ClickListener>();

function notificationsAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.Notification === 'function';
}

/**
 * Web Notifications for `kiki web`. Permission is asked on the first send; a
 * denied or unsupported browser simply shows nothing (the activity inbox
 * still holds the item). A click focuses the tab and routes the page.
 */
async function browserNotify(options: HostNotification): Promise<void> {
  if (!notificationsAvailable()) return;
  let permission = window.Notification.permission;
  if (permission === 'default') permission = await window.Notification.requestPermission();
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
