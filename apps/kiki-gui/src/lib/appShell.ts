/**
 * The Android / iOS app shell (`apps/kiki-gui/mobile`) loads this same GUI from
 * the server, inside a WebView with no address bar. It tags the WebView's user
 * agent so the few places that would otherwise say "open a link" can send the
 * person back to the shell's own connect screen instead.
 */

import { readStoredConfig, writeStoredConfig } from '../state/connectionConfig';

const SHELL_AGENT = /\bKikiApp\/(android|ios)\b/;
export const SHELL_MANAGED_STORAGE_KEY = 'kiki.shell.managed';
export const SHELL_PEER_TOKEN_KEY = 'kiki.peer.token';
export const SHELL_TOKEN_EVENT = 'kiki:shell-token';

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
  readonly localStorage?: {
    getItem?(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem?(key: string): void;
  } | null;
  readonly sessionStorage?: {
    getItem?(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem?(key: string): void;
  } | null;
  name?: string;
  addEventListener?(type: string, listener: (event: Event) => void): void;
  removeEventListener?(type: string, listener: (event: Event) => void): void;
  dispatchEvent(event: Event): boolean;
}

/**
 * Returns true when `storage` already holds a non-empty connection token that
 * was not provisioned by the mobile shell (`kiki.shell.managed !== '1'`).
 */
export function hasExistingOwnerCredential(
  storage?: { getItem?(key: string): string | null } | null,
): boolean {
  if (!storage || typeof storage.getItem !== 'function') return false;
  try {
    if (storage.getItem(SHELL_MANAGED_STORAGE_KEY) === '1') return false;
    const existing = readStoredConfig({ getItem: (key) => storage.getItem!(key) });
    return existing !== null && existing.token.trim() !== '';
  } catch {
    return false;
  }
}

/**
 * Applies a peer credential injected by the native shell after verifying that
 * navigation committed at `expectedOrigin`. Refuses mismatched origins and
 * never overwrites an existing non-shell owner connection.
 */
export function applyCommittedShellCredential(
  win: ShellWindowLike | undefined,
  expectedOrigin: string,
  token: string,
): boolean {
  if (!win || typeof expectedOrigin !== 'string' || expectedOrigin === '') return false;
  if (win.location.origin !== expectedOrigin) return false;
  const trimmedToken = typeof token === 'string' ? token.trim() : '';
  if (!trimmedToken) return false;
  if (hasExistingOwnerCredential(win.localStorage)) return false;

  if (!writeStoredConfig({ url: '', token: trimmedToken }, win.localStorage ?? undefined)) {
    return false;
  }
  try {
    win.localStorage?.setItem(SHELL_MANAGED_STORAGE_KEY, '1');
  } catch {
    return false;
  }
  try {
    win.sessionStorage?.setItem(SHELL_PEER_TOKEN_KEY, trimmedToken);
  } catch {
    // Session storage may be unavailable in restricted contexts.
  }
  try {
    win.dispatchEvent(
      new CustomEvent<ShellCredentialDetail>(SHELL_TOKEN_EVENT, {
        detail: { origin: expectedOrigin, token: trimmedToken },
      }),
    );
  } catch {
    // CustomEvent dispatch is best-effort.
  }
  return true;
}

/**
 * Synchronizes credentials delivered by the native host's post-commit
 * same-origin evaluation (`kiki:shell-token` + `sessionStorage['kiki.peer.token']`).
 * Never reads credentials from `window.name` or `postMessage`, and never
 * overwrites an existing non-shell owner connection.
 */
export function installAppShellCredentialListener(
  win: ShellWindowLike | undefined = globalThis.window,
  onCredential?: (detail: ShellCredentialDetail) => void,
): () => void {
  if (!win) return () => {};

  if (typeof win.name === 'string' && win.name !== '') {
    try {
      win.name = '';
    } catch {
      // Ignore read-only window.name in restricted contexts.
    }
  }

  const syncCommittedToken = (candidateToken: string): void => {
    const trimmed = candidateToken.trim();
    if (!trimmed) return;
    if (hasExistingOwnerCredential(win.localStorage)) {
      try {
        win.sessionStorage?.removeItem?.(SHELL_PEER_TOKEN_KEY);
      } catch {
        // Ignore session storage errors.
      }
      return;
    }
    writeStoredConfig({ url: '', token: trimmed }, win.localStorage ?? undefined);
    try {
      win.localStorage?.setItem(SHELL_MANAGED_STORAGE_KEY, '1');
    } catch {
      // Ignore storage errors.
    }
    onCredential?.({ origin: win.location.origin, token: trimmed });
  };

  try {
    const stagedSessionToken = win.sessionStorage?.getItem?.(SHELL_PEER_TOKEN_KEY) ?? null;
    if (typeof stagedSessionToken === 'string' && stagedSessionToken.trim() !== '') {
      syncCommittedToken(stagedSessionToken);
    }
  } catch {
    // Session storage may be unavailable.
  }

  const onShellToken = (event: Event): void => {
    const detail = (event as CustomEvent<{ origin?: unknown; token?: unknown }>).detail;
    if (!detail || typeof detail.origin !== 'string' || detail.origin !== win.location.origin) {
      return;
    }
    const token = typeof detail.token === 'string' ? detail.token.trim() : '';
    if (!token) return;
    if (hasExistingOwnerCredential(win.localStorage)) return;
    try {
      if (win.sessionStorage?.getItem?.(SHELL_PEER_TOKEN_KEY) !== token) return;
    } catch {
      return;
    }
    syncCommittedToken(token);
  };

  win.addEventListener?.(SHELL_TOKEN_EVENT, onShellToken);
  return () => {
    win.removeEventListener?.(SHELL_TOKEN_EVENT, onShellToken);
  };
}
