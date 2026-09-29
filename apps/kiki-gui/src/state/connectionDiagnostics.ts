/**
 * A bounded record of why the event socket went away.
 *
 * "Reconnecting…" can come from the server closing the socket, the network
 * dropping, a heartbeat judged stale, or the WebView pausing this page's
 * timers while the window is hidden. The last two leave nothing in the
 * server log, so the client keeps its own account: every socket open, close
 * (with cause, close code, time since the last inbound frame and the
 * advertised heartbeat), retry, page visibility and focus change, and any
 * timer gap long enough to mean the page was throttled.
 *
 * In memory only, at most `MAX_ENTRIES`, newest last. Settings → Connection
 * copies it; `window.__kikiConnectionLog()` returns it from the dev console.
 */

import type { HttpSocketDiagnostic } from '@kiki/klient/http';

export type ConnectionLogEntry =
  | ({ readonly at: number } & HttpSocketDiagnostic)
  | { readonly at: number; readonly kind: 'visibility'; readonly state: DocumentVisibilityState }
  | { readonly at: number; readonly kind: 'focus'; readonly focused: boolean }
  | { readonly at: number; readonly kind: 'online'; readonly online: boolean }
  /** A 1 s timer fired `gapMs` late: the page's timers were paused or throttled. */
  | { readonly at: number; readonly kind: 'timer_gap'; readonly gapMs: number; readonly visibility: DocumentVisibilityState };

export const MAX_ENTRIES = 200;
/** A timer this late is not jitter; hidden-window throttling shows up as tens of seconds. */
export const TIMER_GAP_MS = 5_000;
const TICK_MS = 1_000;

const entries: ConnectionLogEntry[] = [];
const listeners = new Set<() => void>();
let snapshot: readonly ConnectionLogEntry[] = [];

type NewEntry = ConnectionLogEntry extends infer E ? E extends ConnectionLogEntry ? Omit<E, 'at'> : never : never;

export function recordConnectionEvent(entry: NewEntry, at = Date.now()): void {
  entries.push({ ...entry, at } as ConnectionLogEntry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  snapshot = entries.slice();
  for (const listener of listeners) listener();
}

export function connectionLog(): readonly ConnectionLogEntry[] {
  return snapshot;
}

export function subscribeConnectionLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Forget every entry (tests). */
export function resetConnectionLog(): void {
  entries.length = 0;
  snapshot = [];
}

/** One line per entry, oldest first, for pasting into a bug report. */
export function formatConnectionLog(log: readonly ConnectionLogEntry[]): string {
  return log.map((entry) => {
    const { at, kind, ...rest } = entry;
    const fields = Object.entries(rest)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
    return [new Date(at).toISOString(), kind, ...fields].join(' ');
  }).join('\n');
}

let watching = 0;
let stopWatching: (() => void) | null = null;

/**
 * Record page visibility, focus, network and timer gaps. Reference-counted:
 * the connection provider calls it once per mount.
 */
export function watchPageLifecycle(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  watching += 1;
  if (watching === 1) {
    const onVisibility = () => { recordConnectionEvent({ kind: 'visibility', state: document.visibilityState }); };
    const onFocus = () => { recordConnectionEvent({ kind: 'focus', focused: true }); };
    const onBlur = () => { recordConnectionEvent({ kind: 'focus', focused: false }); };
    const onOnline = () => { recordConnectionEvent({ kind: 'online', online: true }); };
    const onOffline = () => { recordConnectionEvent({ kind: 'online', online: false }); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    let last = Date.now();
    const tick = window.setInterval(() => {
      const now = Date.now();
      const gap = now - last - TICK_MS;
      last = now;
      if (gap >= TIMER_GAP_MS) recordConnectionEvent({ kind: 'timer_gap', gapMs: gap, visibility: document.visibilityState }, now);
    }, TICK_MS);
    const global = window as unknown as { __kikiConnectionLog?: () => string };
    global.__kikiConnectionLog = () => formatConnectionLog(connectionLog());
    stopWatching = () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.clearInterval(tick);
      delete global.__kikiConnectionLog;
    };
  }
  return () => {
    watching -= 1;
    if (watching === 0) {
      stopWatching?.();
      stopWatching = null;
    }
  };
}
