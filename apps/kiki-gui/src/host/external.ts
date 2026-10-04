import type { HostAdapter } from './host';

export interface ExternalBrowserTab {
  navigate(url: string): void;
  close(): void;
}

export function reserveExternalBrowserTab(popupBlockedMessage: string): ExternalBrowserTab {
  if (typeof window === 'undefined' || typeof window.open !== 'function') throw new Error(popupBlockedMessage);
  const tab = window.open('about:blank', '_blank');
  if (tab === null) throw new Error(popupBlockedMessage);
  try {
    tab.opener = null;
    const policy = tab.document.createElement('meta');
    policy.name = 'referrer'; policy.content = 'no-referrer';
    tab.document.head.append(policy);
  } catch (error) { tab.close(); throw error; }
  return {
    navigate: (url) => {
      if (tab.closed) throw new Error(popupBlockedMessage);
      const link = tab.document.createElement('a');
      link.href = url; link.target = '_self'; link.rel = 'noreferrer'; link.referrerPolicy = 'no-referrer';
      tab.document.body.append(link); link.click(); link.remove();
    },
    close: () => tab.close(),
  };
}

/** Open outside the GUI through the native host or an isolated browser tab. */
export function openExternalUrl(
  host: Pick<HostAdapter, 'openUrl'>,
  url: string,
  popupBlockedMessage: string,
): Promise<void> {
  if (host.openUrl !== undefined) return host.openUrl(url);
  let tab: ExternalBrowserTab | undefined;
  try {
    tab = reserveExternalBrowserTab(popupBlockedMessage);
    tab.navigate(url);
    return Promise.resolve();
  } catch (error) { tab?.close(); return Promise.reject(error); }
}
