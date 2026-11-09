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
 */

import { spaceStorage, spaceStorageKey } from '../storage/spaceStorage';

const KEY = 'kiki.sessionSeen.v1';

/** The high-water mark for one session: the last event sequence seen. */
export type SessionSeenMap = Readonly<Record<string, number>>;

const EMPTY: SessionSeenMap = {};

let cache: SessionSeenMap | undefined;
let cacheKey: string | undefined;
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

function readStored(): SessionSeenMap {
  try {
    return parse(spaceStorage.getItem(KEY));
  } catch {
    return EMPTY;
  }
}

function mergeSeen(base: SessionSeenMap, incoming: SessionSeenMap): SessionSeenMap {
  const out: Record<string, number> = { ...base };
  let changed = false;
  for (const [sessionId, value] of Object.entries(incoming)) {
    const seq = Math.max(0, Math.trunc(value));
    if ((out[sessionId] ?? -1) < seq) {
      out[sessionId] = seq;
      changed = true;
    }
  }
  return changed ? out : base;
}

function read(): SessionSeenMap {
  const key = spaceStorageKey(KEY);
  if (cache !== undefined && cacheKey === key) return cache;
  cacheKey = key;
  cache = readStored();
  return cache;
}

function commit(next: SessionSeenMap, remove = false): void {
  cacheKey = spaceStorageKey(KEY);
  cache = next;
  try {
    if (remove) spaceStorage.removeItem(KEY);
    else spaceStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage full / unavailable — read state is a convenience
  }
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
  const merged = mergeSeen(current, readStored());
  if ((merged[sessionId] ?? -1) >= seq) {
    if (merged !== current) commit(merged);
    return;
  }
  commit({ ...merged, [sessionId]: seq });
}

/**
 * Mark several sessions seen in one write ("Mark all as read"). Same rules as
 * `markSessionSeen`: marks never move backwards, and an all-current batch
 * writes nothing.
 */
export function markSessionsSeen(entries: readonly { readonly sessionId: string; readonly lastSeq: number }[]): void {
  const current = read();
  const merged = mergeSeen(current, readStored());
  const next: Record<string, number> = { ...merged };
  let changed = merged !== current;
  for (const { sessionId, lastSeq } of entries) {
    if (sessionId === '' || !Number.isFinite(lastSeq)) continue;
    const seq = Math.max(0, Math.trunc(lastSeq));
    if ((next[sessionId] ?? -1) >= seq) continue;
    next[sessionId] = seq;
    changed = true;
  }
  if (!changed) return;
  commit(next);
}

/** Drop one session's mark (it was deleted, or the user asked to re-flag it). */
export function forgetSessionSeen(sessionId: string): void {
  const current = read();
  const merged = mergeSeen(current, readStored());
  if (!(sessionId in merged)) {
    if (merged !== current) commit(merged);
    return;
  }
  const next = { ...merged };
  delete next[sessionId];
  commit(next);
}

/** Test seam: forget everything, including the cached snapshot. */
export function resetSessionSeen(): void {
  commit(EMPTY, true);
}
