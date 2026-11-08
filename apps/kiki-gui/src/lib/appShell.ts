/**
 * The Android / iOS app shell (`apps/kiki-gui/mobile`) loads this same GUI from
 * the server, inside a WebView with no address bar. It tags the WebView's user
 * agent so the few places that would otherwise say "open a link" can send the
 * person back to the shell's own connect screen instead.
 */

import { writeStoredConfig } from '../state/connectionConfig';

const SHELL_AGENT = /\bKikiApp\/(android|ios)\b/;
export const SHELL_HANDOFF_TYPE = 'kiki:shell-handoff';
export const SHELL_HANDOFF_MAX_AGE_MS = 30_000;
export const SHELL_MANAGED_STORAGE_KEY = 'kiki.shell.managed';

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

export interface ShellHandoffEnvelope {
  readonly type: typeof SHELL_HANDOFF_TYPE;
  readonly origin: string;
  readonly token: string;
  readonly issuedAt: number;
  readonly sig: string;
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
  } | null;
  readonly navigator?: { readonly userAgent?: string } | null;
  readonly opener?: unknown;
  readonly parent?: unknown;
  name?: string;
  addEventListener?(type: string, listener: (event: MessageEvent) => void): void;
  removeEventListener?(type: string, listener: (event: MessageEvent) => void): void;
  dispatchEvent(event: Event): boolean;
}

export function computeShellHandoffTag(origin: string, token: string, issuedAt: number): string {
  const input = `kiki:shell-handoff:v1|${origin}|${token}|${String(issuedAt)}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.codePointAt(i) ?? 0;
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + ((i & 0xff) << 8);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  const p1 = (h1 < 0 ? h1 + 0x100000000 : h1).toString(16).padStart(8, '0');
  const p2 = (h2 < 0 ? h2 + 0x100000000 : h2).toString(16).padStart(8, '0');
  return `${p1}${p2}`;
}

export function createShellHandoffEnvelope(
  origin: string,
  token: string,
  issuedAt: number = Date.now(),
): ShellHandoffEnvelope {
  const normalizedOrigin = new URL(origin).origin;
  const trimmedToken = token.trim();
  return {
    type: SHELL_HANDOFF_TYPE,
    origin: normalizedOrigin,
    token: trimmedToken,
    issuedAt,
    sig: computeShellHandoffTag(normalizedOrigin, trimmedToken, issuedAt),
  };
}

/**
 * Consumes a one-time top-level navigation credential handoff staged by the
 * mobile launcher for this exact origin. Immediately scrubs `window.name`,
 * rejects any window with an external `opener` or parent frame, refuses to
 * overwrite non-shell connections, and never listens to arbitrary `postMessage`.
 */
export function consumeAppShellHandoff(
  win: ShellWindowLike | undefined = globalThis.window,
  now: number = Date.now(),
): boolean {
  if (!win) return false;
  const rawName = typeof win.name === 'string' ? win.name : '';
  if (rawName !== '') {
    try {
      win.name = '';
    } catch {
      // Ignore read-only window.name in restricted contexts.
    }
  }
  if (!rawName) return false;

  if (win.opener !== undefined && win.opener !== null) return false;
  if (win.parent !== undefined && win.parent !== null && win.parent !== win) return false;
  const userAgent = win.navigator?.userAgent ?? globalThis.navigator?.userAgent ?? '';
  if (!SHELL_AGENT.test(userAgent)) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawName);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const data = parsed as {
    type?: unknown;
    origin?: unknown;
    token?: unknown;
    issuedAt?: unknown;
    sig?: unknown;
  };
  if (data.type !== SHELL_HANDOFF_TYPE) return false;
  if (typeof data.origin !== 'string' || data.origin !== win.location.origin) return false;
  const token = typeof data.token === 'string' ? data.token.trim() : '';
  if (!token) return false;
  if (typeof data.issuedAt !== 'number' || !Number.isFinite(data.issuedAt)) return false;
  if (Math.abs(now - data.issuedAt) > SHELL_HANDOFF_MAX_AGE_MS) return false;
  if (
    typeof data.sig !== 'string' ||
    data.sig !== computeShellHandoffTag(win.location.origin, token, data.issuedAt)
  ) {
    return false;
  }

  writeStoredConfig({ url: '', token }, win.localStorage ?? undefined);
  try {
    win.localStorage?.setItem(SHELL_MANAGED_STORAGE_KEY, '1');
  } catch {
    // Ignore storage quota or access errors.
  }
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
    // CustomEvent dispatch is best-effort.
  }
  return true;
}

export function installAppShellCredentialListener(
  win: ShellWindowLike | undefined = globalThis.window,
): () => void {
  consumeAppShellHandoff(win);
  return () => {};
}
