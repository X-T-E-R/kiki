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
export const SHELL_DOCUMENT_STAGED_PROP = '__kikiShellStagedCredential';
export const SHELL_TOKEN_EVENT = 'kiki:shell-token';

const adoptedShellTokenByWindow = new WeakMap<object, { origin: string; token: string }>();

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
  readonly document?: object | null;
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

function clearDocumentStagedSlot(win: ShellWindowLike | undefined): void {
  const target = (win?.document ?? win) as Record<string, unknown> | undefined;
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return;
  try {
    delete target[SHELL_DOCUMENT_STAGED_PROP];
  } catch {
    try {
      target[SHELL_DOCUMENT_STAGED_PROP] = undefined;
    } catch {
      // Ignore read-only document/window targets.
    }
  }
}

function stageDocumentCredentialSlot(
  win: ShellWindowLike,
  expectedOrigin: string,
  token: string,
): boolean {
  const target = (win.document ?? win) as Record<string, unknown> | undefined;
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return false;
  let consumed = false;
  try {
    Object.defineProperty(target, SHELL_DOCUMENT_STAGED_PROP, {
      configurable: true,
      enumerable: false,
      get() {
        if (consumed) return null;
        consumed = true;
        try {
          delete target[SHELL_DOCUMENT_STAGED_PROP];
        } catch {
          // Ignore delete errors on custom hosts.
        }
        return { origin: expectedOrigin, token };
      },
    });
    return true;
  } catch {
    try {
      target[SHELL_DOCUMENT_STAGED_PROP] = { origin: expectedOrigin, token };
      return true;
    } catch {
      return false;
    }
  }
}

function consumeDocumentStagedSlot(win: ShellWindowLike | undefined): ShellCredentialDetail | null {
  if (!win) return null;
  const target = (win.document ?? win) as Record<string, unknown> | undefined;
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return null;
  try {
    const raw = target[SHELL_DOCUMENT_STAGED_PROP] as
      | { origin?: unknown; token?: unknown }
      | null
      | undefined;
    try {
      delete target[SHELL_DOCUMENT_STAGED_PROP];
    } catch {
      try {
        target[SHELL_DOCUMENT_STAGED_PROP] = undefined;
      } catch {
        // Ignore cleanup errors.
      }
    }
    if (!raw || typeof raw !== 'object') return null;
    const origin = typeof raw.origin === 'string' ? raw.origin : '';
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';
    if (!origin || !token || origin !== win.location.origin) return null;
    return { origin, token };
  } catch {
    return null;
  }
}

/**
 * Retires mobile-shell managed markers, legacy session storage keys, and
 * in-memory document-staged peer tokens so a manual owner connection, explicit
 * disconnect, or HttpOnly web-cookie session is not overwritten on reload or re-entry.
 */
export function clearAppShellCredentialState(
  win: Pick<ShellWindowLike, 'localStorage' | 'sessionStorage' | 'document'> | undefined = globalThis.window,
): void {
  if (win && typeof win === 'object') {
    adoptedShellTokenByWindow.delete(win);
    clearDocumentStagedSlot(win as ShellWindowLike);
  }
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
 * Returns the shell peer token adopted in memory for the current `win` document,
 * or consumes a pending one-shot document-staged slot if one was injected before
 * `ConnectionProvider` mounted. Never reads from `localStorage` or `sessionStorage`.
 */
export function readAdoptedShellCredential(
  win: ShellWindowLike | undefined = globalThis.window,
): string | null {
  if (!win) return null;
  if (webAccessBootstrap().kind === 'signed-in') {
    clearAppShellCredentialState(win);
    return null;
  }
  if (hasExistingOwnerCredential(win.localStorage)) {
    clearAppShellCredentialState(win);
    return null;
  }
  const staged = consumeDocumentStagedSlot(win);
  if (staged) {
    adoptedShellTokenByWindow.set(win, staged);
    return staged.token;
  }
  const existing = adoptedShellTokenByWindow.get(win);
  if (existing && existing.origin === win.location.origin && existing.token.trim() !== '') {
    return existing.token;
  }
  return null;
}

/**
 * Returns true when `storage` already holds a non-empty connection token that
 * was not provisioned by the mobile shell (`kiki.shell.managed !== '1'`), or
 * when a manual owner config has superseded a legacy shell-managed marker.
 */
export function hasExistingOwnerCredential(
  storage?: { getItem?(key: string): string | null; removeItem?(key: string): void } | null,
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
    return false;
  } catch {
    return false;
  }
}

/**
 * Applies a peer credential injected by the native shell after verifying that
 * navigation committed at `expectedOrigin`. Stages the credential only in the
 * current document's memory (never in `localStorage`, `sessionStorage`, or
 * `window.name`) and refuses to overwrite an existing owner connection or
 * web-cookie session.
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
  if (hasExistingOwnerCredential(win.localStorage)) {
    clearAppShellCredentialState(win);
    return false;
  }

  try {
    win.localStorage?.removeItem?.(CONNECTION_STORAGE_KEY);
    win.localStorage?.removeItem?.(SHELL_MANAGED_STORAGE_KEY);
  } catch {
    // Ignore storage cleanup errors in restricted contexts.
  }
  try {
    win.sessionStorage?.removeItem?.(SHELL_PEER_TOKEN_KEY);
  } catch {
    // Ignore session storage cleanup errors in restricted contexts.
  }

  if (!stageDocumentCredentialSlot(win, expectedOrigin, trimmedToken)) {
    return false;
  }
  try {
    win.dispatchEvent(
      new CustomEvent<ShellCredentialDetail>(SHELL_TOKEN_EVENT, {
        detail: { origin: expectedOrigin, token: trimmedToken },
      }),
    );
  } catch {
    // CustomEvent dispatch is best-effort; the one-shot slot remains consumable on boot.
  }
  return true;
}

/**
 * Synchronizes credentials delivered by the native host's post-commit
 * same-origin evaluation (`document.__kikiShellStagedCredential` + `kiki:shell-token`).
 * Never reads or writes credentials in `localStorage`, `sessionStorage`, `window.name`,
 * or `postMessage`, and never overwrites an existing owner connection or web-cookie session.
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

  const adoptVerifiedDetail = (detail: ShellCredentialDetail): void => {
    const trimmed = detail.token.trim();
    if (!trimmed || detail.origin !== win.location.origin) return;
    if (webAccessBootstrap().kind === 'signed-in') {
      clearAppShellCredentialState(win);
      return;
    }
    if (hasExistingOwnerCredential(win.localStorage)) {
      clearAppShellCredentialState(win);
      return;
    }
    try {
      win.localStorage?.removeItem?.(CONNECTION_STORAGE_KEY);
      win.localStorage?.removeItem?.(SHELL_MANAGED_STORAGE_KEY);
    } catch {
      // Ignore storage errors.
    }
    try {
      win.sessionStorage?.removeItem?.(SHELL_PEER_TOKEN_KEY);
    } catch {
      // Ignore session storage errors.
    }
    const normalized: ShellCredentialDetail = { origin: win.location.origin, token: trimmed };
    adoptedShellTokenByWindow.set(win, normalized);
    onCredential?.(normalized);
  };

  try {
    win.sessionStorage?.removeItem?.(SHELL_PEER_TOKEN_KEY);
  } catch {
    // Ignore session storage errors.
  }

  try {
    if (webAccessBootstrap().kind === 'signed-in') {
      clearAppShellCredentialState(win);
    } else if (hasExistingOwnerCredential(win.localStorage)) {
      clearAppShellCredentialState(win);
    } else {
      if (win.localStorage?.getItem?.(SHELL_MANAGED_STORAGE_KEY) === '1') {
        win.localStorage?.removeItem?.(CONNECTION_STORAGE_KEY);
        win.localStorage?.removeItem?.(SHELL_MANAGED_STORAGE_KEY);
      }
      const staged = consumeDocumentStagedSlot(win);
      if (staged) {
        adoptVerifiedDetail(staged);
      } else {
        const adopted = adoptedShellTokenByWindow.get(win);
        if (adopted && adopted.origin === win.location.origin) {
          onCredential?.(adopted);
        }
      }
    }
  } catch {
    // Ignore restricted storage access.
  }

  const onShellToken = (event: Event): void => {
    const detail = (event as CustomEvent<{ origin?: unknown; token?: unknown }>).detail;
    const staged = consumeDocumentStagedSlot(win);
    if (!staged) return;
    if (
      detail &&
      typeof detail.origin === 'string' &&
      detail.origin === staged.origin &&
      typeof detail.token === 'string' &&
      detail.token.trim() === staged.token
    ) {
      adoptVerifiedDetail(staged);
    }
  };

  win.addEventListener?.(SHELL_TOKEN_EVENT, onShellToken);
  return () => {
    win.removeEventListener?.(SHELL_TOKEN_EVENT, onShellToken);
  };
}
