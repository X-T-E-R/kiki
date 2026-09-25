import type { HostAdapter } from './host';

/**
 * Open a URL outside the GUI. Native hosts own this path so webview popup
 * policies cannot turn a normal link click into a blocked new-window request;
 * the browser host falls back to its user-initiated external-tab behavior.
 */
export function openExternalUrl(
  host: Pick<HostAdapter, 'openUrl'>,
  url: string,
  popupBlockedMessage: string,
): Promise<void> {
  if (host.openUrl !== undefined) return host.openUrl(url);
  if (typeof window === 'undefined' || typeof window.open !== 'function') {
    return Promise.reject(new Error(popupBlockedMessage));
  }
  if (window.open(url, '_blank', 'noopener,noreferrer') === null) {
    return Promise.reject(new Error(popupBlockedMessage));
  }
  return Promise.resolve();
}
