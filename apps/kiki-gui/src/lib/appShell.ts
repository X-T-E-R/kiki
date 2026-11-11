/**
 * The Android / iOS app shell (`apps/kiki-gui/mobile`) loads this same GUI from
 * the server, inside a WebView with no address bar. It tags the WebView's user
 * agent so the few places that would otherwise say "open a link" can send the
 * person back to the shell's own connect screen instead.
 */

import { CONNECTION_STORAGE_KEY } from '../state/connectionConfig';
import { webAccessBootstrap } from './webAccess';

const SHELL_AGENT = /\bKikiApp\/(android|ios)\b/;
const EMBEDDED_AGENT = /\bKikiEmbedded\/(\d+)\b/;
export const SHELL_MANAGED_STORAGE_KEY = 'kiki.shell.managed';
export const SHELL_PEER_TOKEN_KEY = 'kiki.peer.token';
export const SHELL_DOCUMENT_STAGED_PROP = '__kikiShellStagedCredential';
export const SHELL_DOCUMENT_NAV_NONCE_PROP = '__kikiShellNavNonce';
export const SHELL_TOKEN_EVENT = 'kiki:shell-token';

/** True when running inside the embedded Kiki Android WebView host (`KikiApp/android` + `KikiEmbedded/1`). */
export function isEmbeddedAndroidHost(userAgent: string = globalThis.navigator?.userAgent ?? ''): boolean {
  return SHELL_AGENT.exec(userAgent)?.[1] === 'android' && EMBEDDED_AGENT.test(userAgent);
}

interface WindowShellChannel {
  adopted: { documentRef: object | null; origin: string; token: string } | null;
  subscribers: Set<(detail: ShellCredentialDetail) => void>;
  installedDomListener: ((event: Event) => void) | null;
}

const channelByWindow = new WeakMap<object, WindowShellChannel>();

function getWindowChannel(win: object): WindowShellChannel {
  let channel = channelByWindow.get(win);
  if (!channel) {
    channel = {
      adopted: null,
      subscribers: new Set(),
      installedDomListener: null,
    };
    channelByWindow.set(win, channel);
  }
  return channel;
}

/** The shell's connect screen, opened to enter a new server address or link. */
export function appShellConnectUrl(userAgent: string = globalThis.navigator?.userAgent ?? ''): string | null {
  if (isEmbeddedAndroidHost(userAgent)) return 'kiki-shell://connect';
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

function currentDocumentRef(win: ShellWindowLike | undefined): object | null {
  if (!win) return null;
  if (win.document && typeof win.document === 'object') return win.document;
  return win;
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
 * Never deletes an existing manual owner `kiki.connection`.
 */
export function clearAppShellCredentialState(
  win: Pick<ShellWindowLike, 'localStorage' | 'sessionStorage' | 'document'> | undefined = globalThis.window,
): void {
  if (win && typeof win === 'object') {
    const channel = channelByWindow.get(win);
    if (channel) {
      channel.adopted = null;
    }
    clearDocumentStagedSlot(win as ShellWindowLike);
  }
  try {
    const storage = win?.localStorage;
    if (storage?.getItem?.(SHELL_MANAGED_STORAGE_KEY) === '1') {
      if (!hasExistingOwnerCredential(storage, win?.sessionStorage)) {
        storage.removeItem?.(CONNECTION_STORAGE_KEY);
      }
    }
    storage?.removeItem?.(SHELL_MANAGED_STORAGE_KEY);
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
  if (hasExistingOwnerCredential(win.localStorage, win.sessionStorage)) {
    clearAppShellCredentialState(win);
    return null;
  }
  const docRef = currentDocumentRef(win);
  const channel = getWindowChannel(win);
  const staged = consumeDocumentStagedSlot(win);
  if (staged) {
    channel.adopted = { documentRef: docRef, origin: staged.origin, token: staged.token };
    return staged.token;
  }
  if (
    channel.adopted &&
    channel.adopted.documentRef === docRef &&
    channel.adopted.origin === win.location.origin &&
    channel.adopted.token.trim() !== ''
  ) {
    return channel.adopted.token;
  }
  return null;
}

/**
 * Returns true when `storage` already holds a non-empty connection token that
 * was not provisioned by the mobile shell (`kiki.shell.managed !== '1'`), or
 * when a manual owner config (`url !== ''` or differing from legacy staged token)
 * has superseded a legacy shell-managed marker.
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
 * navigation committed at `expectedOrigin` (and optional `expectedNavNonce`).
 * Stages the credential only in the current document's memory (never in
 * `localStorage`, `sessionStorage`, or `window.name`) and refuses to overwrite
 * an existing owner connection or web-cookie session.
 */
export function applyCommittedShellCredential(
  win: ShellWindowLike | undefined,
  expectedOrigin: string,
  token: string,
  expectedNavNonce?: string,
): boolean {
  if (!win || typeof expectedOrigin !== 'string' || expectedOrigin === '') return false;
  if (win.location.origin !== expectedOrigin) return false;
  if (expectedNavNonce !== undefined && expectedNavNonce !== '') {
    const docTarget = (win.document ?? win) as Record<string, unknown> | undefined;
    if (!docTarget || docTarget[SHELL_DOCUMENT_NAV_NONCE_PROP] !== expectedNavNonce) {
      return false;
    }
  }
  const trimmedToken = typeof token === 'string' ? token.trim() : '';
  if (!trimmedToken) return false;
  if (webAccessBootstrap().kind === 'signed-in') {
    clearAppShellCredentialState(win);
    return false;
  }
  if (hasExistingOwnerCredential(win.localStorage, win.sessionStorage)) {
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
 * Multiple callers on the same `win` share a single one-shot consumption and
 * broadcast channel so late delivery reaches every subscriber while unbacked
 * `CustomEvent('kiki:shell-token')` dispatches remain rejected.
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

  const channel = getWindowChannel(win);
  if (onCredential) {
    channel.subscribers.add(onCredential);
  }

  const adoptAndPublish = (detail: ShellCredentialDetail, notifyOnly?: (detail: ShellCredentialDetail) => void): void => {
    const trimmed = detail.token.trim();
    if (!trimmed || detail.origin !== win.location.origin) return;
    if (webAccessBootstrap().kind === 'signed-in') {
      clearAppShellCredentialState(win);
      return;
    }
    if (hasExistingOwnerCredential(win.localStorage, win.sessionStorage)) {
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
    channel.adopted = {
      documentRef: currentDocumentRef(win),
      origin: normalized.origin,
      token: normalized.token,
    };
    if (notifyOnly) {
      notifyOnly(normalized);
      return;
    }
    for (const sub of Array.from(channel.subscribers)) {
      sub(normalized);
    }
  };

  try {
    if (webAccessBootstrap().kind === 'signed-in') {
      clearAppShellCredentialState(win);
    } else if (hasExistingOwnerCredential(win.localStorage, win.sessionStorage)) {
      clearAppShellCredentialState(win);
    } else {
      try {
        win.sessionStorage?.removeItem?.(SHELL_PEER_TOKEN_KEY);
      } catch {
        // Ignore session storage errors.
      }
      if (win.localStorage?.getItem?.(SHELL_MANAGED_STORAGE_KEY) === '1') {
        win.localStorage?.removeItem?.(CONNECTION_STORAGE_KEY);
        win.localStorage?.removeItem?.(SHELL_MANAGED_STORAGE_KEY);
      }
      const staged = consumeDocumentStagedSlot(win);
      if (staged) {
        adoptAndPublish(staged);
      } else if (
        onCredential &&
        channel.adopted &&
        channel.adopted.documentRef === currentDocumentRef(win) &&
        channel.adopted.origin === win.location.origin
      ) {
        adoptAndPublish({ origin: channel.adopted.origin, token: channel.adopted.token }, onCredential);
      }
    }
  } catch {
    // Ignore restricted storage access.
  }

  if (!channel.installedDomListener) {
    const domListener = (event: Event): void => {
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
        adoptAndPublish(staged);
      }
    };
    channel.installedDomListener = domListener;
    win.addEventListener?.(SHELL_TOKEN_EVENT, domListener);
  }

  return () => {
    if (onCredential) {
      channel.subscribers.delete(onCredential);
    }
    if (channel.subscribers.size === 0 && channel.installedDomListener) {
      win.removeEventListener?.(SHELL_TOKEN_EVENT, channel.installedDomListener);
      channel.installedDomListener = null;
    }
  };
}
