/**
 * The Android / iOS app shell (`apps/kiki-gui/mobile`) loads this same GUI from
 * the server, inside a WebView with no address bar. It tags the WebView's user
 * agent so the few places that would otherwise say "open a link" can send the
 * person back to the shell's own connect screen instead.
 */

import { CONNECTION_STORAGE_KEY } from '../state/connectionConfig';
import { webAccessBootstrap } from './webAccess';

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
 * Retires mobile-shell managed markers and staged peer tokens so a manual
 * owner connection, explicit disconnect, or HttpOnly web-cookie session is not
 * overwritten on reload or re-entry.
 */
export function clearAppShellCredentialState(
  win: Pick<ShellWindowLike, 'localStorage' | 'sessionStorage'> | undefined = globalThis.window,
): void {
  try {
    if (win?.localStorage?.getItem?.(SHELL_MANAGED_STORAGE_KEY) === '1') {
      win.localStorage.removeItem?.(CONNECTION_STORAGE_KEY);
    }
    win?.localStorage?.removeItem?.(SHELL_MANAGED_STORAGE_KEY);
  } catch {
    // Ignore storage removal errors in restricted contexts.
  }
  try {
    win?.sessionStorage?.removeItem?.(SHELL_PEER_TOKEN_KEY);
  } catch {
    // Ignore session storage removal errors in restricted contexts.
  }
}

/**
 * Returns true when `storage` already holds a non-empty connection token that
 * was not provisioned by the mobile shell (`kiki.shell.managed !== '1'`), or
 * when a manual owner config has superseded a legacy shell-managed marker.
 */
export function hasExistingOwnerCredential(
  storage?: { getItem?(key: string): string | null; removeItem?(key: string): void } | null,
  sessionStorage?: { getItem?(key: string): string | null } | null,
): boolean {
  if (!storage || typeof storage.getItem !== 'function') return false;
  try {
    const raw = storage.getItem(CONNECTION_STORAGE_KEY);
    if (raw === null) return false;
    const parsed = JSON.parse(raw) as { url?: unknown; token?: unknown } | null;
    if (!parsed || typeof parsed.url !== 'string' || typeof parsed.token !== 'string') return false;
    const existingToken = parsed.token.trim();
    if (existingToken === '') return false;
    if (parsed.url.trim() !== '') return true;
    if (storage.getItem(SHELL_MANAGED_STORAGE_KEY) !== '1') return true;
    if (sessionStorage && typeof sessionStorage.getItem === 'function') {
      const staged = sessionStorage.getItem(SHELL_PEER_TOKEN_KEY);
      if (typeof staged === 'string' && staged.trim() !== '' && staged.trim() !== existingToken) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Applies a peer credential injected by the native shell after verifying that
 * navigation committed at `expectedOrigin`. Refuses mismatched origins and
 * never overwrites an existing non-shell owner connection or web-cookie session.
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
  if (webAccessBootstrap().kind === 'signed-in') {
    clearAppShellCredentialState(win);
    return false;
  }
  if (hasExistingOwnerCredential(win.localStorage, win.sessionStorage)) {
    try {
      win.localStorage?.removeItem?.(SHELL_MANAGED_STORAGE_KEY);
    } catch {
      // Ignore storage removal errors.
    }
    try {
      win.sessionStorage?.removeItem?.(SHELL_PEER_TOKEN_KEY);
    } catch {
      // Ignore session storage removal errors.
    }
    return false;
  }

  try {
    if (!win.sessionStorage) return false;
    win.sessionStorage.setItem(SHELL_PEER_TOKEN_KEY, trimmedToken);
  } catch {
    return false;
  }
  try {
    win.localStorage?.removeItem?.(CONNECTION_STORAGE_KEY);
    win.localStorage?.removeItem?.(SHELL_MANAGED_STORAGE_KEY);
  } catch {
    // Ignore storage cleanup errors in restricted contexts.
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
 * overwrites an existing non-shell owner connection or web-cookie session.
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
    if (webAccessBootstrap().kind === 'signed-in') {
      clearAppShellCredentialState(win);
      return;
    }
    if (hasExistingOwnerCredential(win.localStorage, win.sessionStorage)) {
      try {
        win.localStorage?.removeItem?.(SHELL_MANAGED_STORAGE_KEY);
      } catch {
        // Ignore storage removal errors.
      }
      try {
        win.sessionStorage?.removeItem?.(SHELL_PEER_TOKEN_KEY);
      } catch {
        // Ignore session storage removal errors.
      }
      return;
    }
    try {
      win.localStorage?.removeItem?.(CONNECTION_STORAGE_KEY);
      win.localStorage?.removeItem?.(SHELL_MANAGED_STORAGE_KEY);
    } catch {
      // Ignore storage errors.
    }
    try {
      win.sessionStorage?.setItem(SHELL_PEER_TOKEN_KEY, trimmed);
    } catch {
      // Ignore session storage errors.
    }
    onCredential?.({ origin: win.location.origin, token: trimmed });
  };

  try {
    if (webAccessBootstrap().kind === 'signed-in') {
      clearAppShellCredentialState(win);
    } else if (hasExistingOwnerCredential(win.localStorage, win.sessionStorage)) {
      win.localStorage?.removeItem?.(SHELL_MANAGED_STORAGE_KEY);
      win.sessionStorage?.removeItem?.(SHELL_PEER_TOKEN_KEY);
    } else {
      const stagedSessionToken = win.sessionStorage?.getItem?.(SHELL_PEER_TOKEN_KEY) ?? null;
      if (typeof stagedSessionToken === 'string' && stagedSessionToken.trim() !== '') {
        syncCommittedToken(stagedSessionToken);
      } else if (win.localStorage?.getItem?.(SHELL_MANAGED_STORAGE_KEY) === '1') {
        win.localStorage?.removeItem?.(CONNECTION_STORAGE_KEY);
        win.localStorage?.removeItem?.(SHELL_MANAGED_STORAGE_KEY);
      }
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
    if (webAccessBootstrap().kind === 'signed-in') {
      clearAppShellCredentialState(win);
      return;
    }
    if (hasExistingOwnerCredential(win.localStorage, win.sessionStorage)) {
      try {
        win.localStorage?.removeItem?.(SHELL_MANAGED_STORAGE_KEY);
      } catch {
        // Ignore storage removal errors.
      }
      try {
        win.sessionStorage?.removeItem?.(SHELL_PEER_TOKEN_KEY);
      } catch {
        // Ignore session storage removal errors.
      }
      return;
    }
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
