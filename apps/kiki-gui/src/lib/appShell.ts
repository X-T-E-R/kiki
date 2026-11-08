/**
 * The Android / iOS app shell (`apps/kiki-gui/mobile`) loads this same GUI from
 * the server, inside a WebView with no address bar. It tags the WebView's user
 * agent so the few places that would otherwise say "open a link" can send the
 * person back to the shell's own connect screen instead.
 */

import { writeStoredConfig } from '../state/connectionConfig';

const SHELL_AGENT = /\bKikiApp\/(android|ios)\b/;

/** The shell's connect screen, opened to enter a new server address or link. */
export function appShellConnectUrl(userAgent: string = globalThis.navigator?.userAgent ?? ''): string | null {
  const platform = SHELL_AGENT.exec(userAgent)?.[1];
  if (platform === 'android') return 'https://localhost/index.html#change';
  if (platform === 'ios') return 'capacitor://localhost/index.html#change';
  return null;
}

export interface ShellCredentialDetail {
  readonly origin: string;
  readonly token: string;
}

export interface ShellWindowLike {
  readonly location: { readonly origin: string };
  readonly localStorage?: { setItem(key: string, value: string): void } | null;
  readonly sessionStorage?: { setItem(key: string, value: string): void } | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void;
  dispatchEvent(event: Event): boolean;
}

/**
 * Accepts post-commit peer credentials delivered by the mobile launcher (`postMessage`
 * targeted at this exact origin) or native shell (`kiki:shell-token` event), without
 * placing `#token=` in the navigation URL or mutating `location.hash` / `history.state`.
 */
export function installAppShellCredentialListener(
  win: ShellWindowLike | undefined = globalThis.window,
): () => void {
  if (!win) return () => {};
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: unknown; origin?: unknown; token?: unknown } | null;
    if (!data || typeof data !== 'object' || data.type !== 'kiki:shell-credential') return;
    if (typeof data.origin !== 'string' || data.origin !== win.location.origin) return;
    const token = typeof data.token === 'string' ? data.token.trim() : '';
    if (!token) return;

    writeStoredConfig({ url: '', token }, win.localStorage ?? undefined);
    try {
      win.sessionStorage?.setItem('kiki.peer.token', token);
    } catch {
      // Session storage may be unavailable in restricted contexts.
    }
    try {
      win.dispatchEvent(
        new CustomEvent<ShellCredentialDetail>('kiki:shell-token', {
          detail: { origin: win.location.origin, token },
        }),
      );
    } catch {
      // CustomEvent dispatch is best-effort when running in a pre-commit frame.
    }
    const source = event.source as { postMessage?: (message: unknown, targetOrigin: string) => void } | null;
    if (source && typeof source.postMessage === 'function' && typeof event.origin === 'string' && event.origin !== '') {
      try {
        source.postMessage(
          { type: 'kiki:shell-credential-ack', origin: win.location.origin },
          event.origin,
        );
      } catch {
        // Ignore cross-frame ack errors.
      }
    }
  };

  win.addEventListener('message', onMessage);
  return () => {
    win.removeEventListener('message', onMessage);
  };
}
