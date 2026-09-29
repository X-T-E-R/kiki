/**
 * Which sessions the user has already looked at, in localStorage
 * (`kiki.sessionSeen.v1`).
 *
 * A session is "unread" when it produced events the user has not opened since:
 * we remember the `last_seq` observed while the session was on screen and
 * compare it with the session's current `last_seq`. The sequence number is the
 * server's own monotonic event counter, so this needs no backend field and
 * cannot drift the way a wall-clock comparison would (`updated_at` also moves
 * when the client writes metadata, which would mark sessions unread by
 * accident).
 *
 * The store is a pub/sub with a cached snapshot, like `layoutPrefs`, because
 * both the sidebar rows and the activity page read it through
 * `useSyncExternalStore` and must repaint the moment a session is opened.
 * Entries for long-gone sessions are pruned on write.
 */

import { spaceStorage, spaceStorageKey } from '../storage/spaceStorage';

const KEY = 'kiki.sessionSeen.v1';
const MAX_ENTRIES = 300;

/** The high-water mark for one session: the last event sequence seen. */
export type SessionSeenMap = Readonly<Record<string, number>>;

const EMPTY: SessionSeenMap = {};

let cache: SessionSeenMap | undefined;
const listeners = new Set<() => void>();
let storageBound = false;

function parse(raw: string | null): SessionSeenMap {
  if (raw === null) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return EMPTY;
    const out: Record<string, number> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      out[sessionId] = Math.max(0, Math.trunc(value));
    }
    return out;
  } catch {
    return EMPTY;
  }
}

function read(): SessionSeenMap {
  if (cache !== undefined) return cache;
  try {
    cache = parse(spaceStorage.getItem(KEY));
  } catch {
    cache = EMPTY;
  }
  return cache;
}

function publish(next: SessionSeenMap): void {
  cache = next;
  for (const listener of listeners) listener();
}

/** Current snapshot; stable between writes so `useSyncExternalStore` is happy. */
export function sessionSeenSnapshot(): SessionSeenMap {
  return read();
}

export function subscribeSessionSeen(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageBound) {
    storageBound = true;
    try {
      // Another window (or another tab of the desktop app) opened a session.
      window.addEventListener('storage', (event) => {
        if (event.key !== null && event.key !== spaceStorageKey(KEY)) return;
        cache = undefined;
        for (const each of listeners) each();
      });
    } catch {
      // no window (tests, SSR) — in-process writes still notify
    }
  }
  return () => { listeners.delete(listener); };
}

/**
 * Record that the user has seen this session up to `lastSeq`. Never moves the
 * mark backwards, and writes nothing when the mark is already current, so
 * re-rendering an open session does not churn storage or subscribers.
 */
export function markSessionSeen(sessionId: string, lastSeq: number): void {
  if (sessionId === '' || !Number.isFinite(lastSeq)) return;
  const seq = Math.max(0, Math.trunc(lastSeq));
  const current = read();
  if ((current[sessionId] ?? -1) >= seq) return;
  const next: Record<string, number> = { ...current, [sessionId]: seq };
  const keys = Object.keys(next);
  if (keys.length > MAX_ENTRIES) {
    // Insertion order: the oldest recorded sessions fall out first.
    for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) delete next[stale];
  }
  publish(next);
  try {
    spaceStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage full / unavailable — read state is a convenience
  }
}

/** Drop one session's mark (it was deleted, or the user asked to re-flag it). */
export function forgetSessionSeen(sessionId: string): void {
  const current = read();
  if (!(sessionId in current)) return;
  const next = { ...current };
  delete next[sessionId];
  publish(next);
  try {
    spaceStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

/** Test seam: forget everything, including the cached snapshot. */
export function resetSessionSeen(): void {
  publish(EMPTY);
  try {
    spaceStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
