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
const CONVERSATION_SEEN_KEY = 'kiki.conversationSeen.v2';
const LEGACY_SEED_MARKER_PREFIX = `${CONVERSATION_SEEN_KEY}.legacySeed.`;

/** The high-water mark for one session: the last event sequence seen. */
export type SessionSeenMap = Readonly<Record<string, number>>;

/** A conversation kind has a distinct identity even when its id is shared. */
export type ConversationKind = 'session' | 'room';

/** The explicit space and kind that own a conversation id. */
export interface ConversationRef {
  readonly spaceKey: string;
  readonly kind: ConversationKind;
  readonly id: string;
}

/** Encode a conversation identity without delimiter collisions. */
export function encodeConversationRef(ref: ConversationRef): string {
  return JSON.stringify([ref.spaceKey, ref.kind, ref.id]);
}

/** The cursor at which a conversation was read. */
export interface AttentionCursor {
  readonly epoch?: string;
  readonly seq: number;
}

/** A persisted conversation read mark and the time it was written. */
export interface ConversationSeenRecord extends AttentionCursor {
  readonly updatedAt: number;
}

/** Alias for a persisted conversation read mark. */
export type SeenRecord = ConversationSeenRecord;

/** Read marks keyed by `encodeConversationRef(ref)`. */
export type ConversationSeenMap = Readonly<Record<string, ConversationSeenRecord>>;

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
 * Lower one session's mark to just before `lastSeq`, explicitly re-flagging it
 * as unread. Unlike `markSessionSeen`, this operation is intentionally allowed
 * to move a mark backwards.
 */
export function markSessionUnread(sessionId: string, lastSeq: number): void {
  if (sessionId === '' || !Number.isFinite(lastSeq)) return;
  const seq = Math.max(0, Math.trunc(lastSeq) - 1);
  const current = read();
  const merged = mergeSeen(current, readStored());
  if (merged[sessionId] === seq) {
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

const EMPTY_CONVERSATION_SEEN: ConversationSeenMap = {};

let conversationCache: ConversationSeenMap | undefined;
let conversationSnapshotCache: ConversationSeenMap | undefined;
let conversationGeneration = 0;
const conversationListeners = new Set<() => void>();
let conversationStorageBound = false;
let nextConversationOverlayId = 0;

interface ConversationOverlay {
  readonly id: number;
  readonly key: string;
  readonly record: ConversationSeenRecord;
  readonly baselineGeneration: number;
  readonly baselineRecord: ConversationSeenRecord | undefined;
}

const conversationOverlays = new Map<number, ConversationOverlay>();

function localStorageOrUndefined(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function normalizeConversationRef(ref: ConversationRef): ConversationRef | undefined {
  if (ref === null || typeof ref !== 'object') return undefined;
  if (typeof ref.spaceKey !== 'string' || ref.spaceKey === '') return undefined;
  if (ref.kind !== 'session' && ref.kind !== 'room') return undefined;
  if (typeof ref.id !== 'string' || ref.id === '') return undefined;
  return ref;
}

function normalizeCursor(cursor: AttentionCursor): AttentionCursor | undefined {
  if (cursor === null || typeof cursor !== 'object' || !Number.isFinite(cursor.seq)) return undefined;
  const seq = Math.max(0, Math.trunc(cursor.seq));
  if (cursor.epoch !== undefined && typeof cursor.epoch !== 'string') return undefined;
  return cursor.epoch === undefined ? { seq } : { epoch: cursor.epoch, seq };
}

function recordFromCursor(cursor: AttentionCursor, updatedAt = Date.now()): ConversationSeenRecord {
  return cursor.epoch === undefined
    ? { seq: cursor.seq, updatedAt }
    : { epoch: cursor.epoch, seq: cursor.seq, updatedAt };
}

function parseConversationRecord(value: unknown): ConversationSeenRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record['seq'] !== 'number' || !Number.isFinite(record['seq'])) return undefined;
  const epoch = record['epoch'];
  if (epoch !== undefined && typeof epoch !== 'string') return undefined;
  const updatedAt = typeof record['updatedAt'] === 'number' && Number.isFinite(record['updatedAt'])
    ? Math.max(0, Math.trunc(record['updatedAt']))
    : 0;
  const seq = Math.max(0, Math.trunc(record['seq']));
  return epoch === undefined ? { seq, updatedAt } : { epoch, seq, updatedAt };
}

function parseConversationSeen(raw: string | null): ConversationSeenMap {
  if (raw === null) return EMPTY_CONVERSATION_SEEN;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_CONVERSATION_SEEN;
    const out: Record<string, ConversationSeenRecord> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const record = parseConversationRecord(value);
      if (record !== undefined) out[key] = record;
    }
    return Object.keys(out).length === 0 ? EMPTY_CONVERSATION_SEEN : out;
  } catch {
    return EMPTY_CONVERSATION_SEEN;
  }
}

function readConversationStored(): ConversationSeenMap {
  const storage = localStorageOrUndefined();
  if (storage === undefined) return conversationCache ?? EMPTY_CONVERSATION_SEEN;
  try {
    return parseConversationSeen(storage.getItem(CONVERSATION_SEEN_KEY));
  } catch {
    return conversationCache ?? EMPTY_CONVERSATION_SEEN;
  }
}

function ensureConversationCache(): ConversationSeenMap {
  if (conversationCache === undefined) {
    conversationCache = readConversationStored();
    conversationGeneration += 1;
  }
  return conversationCache;
}

function sameEpoch(left: AttentionCursor | undefined, right: AttentionCursor | undefined): boolean {
  return left?.epoch === right?.epoch;
}

function recordsEqual(left: ConversationSeenRecord | undefined, right: ConversationSeenRecord | undefined): boolean {
  return left?.epoch === right?.epoch && left?.seq === right?.seq && left?.updatedAt === right?.updatedAt;
}

function mapsEqual(left: ConversationSeenMap, right: ConversationSeenMap): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!recordsEqual(left[key], right[key])) return false;
  }
  return true;
}

/** Merge a seen mark, treating an epoch change as a new cursor domain. */
function mergeConversationSeenRecord(
  current: ConversationSeenRecord | undefined,
  incoming: ConversationSeenRecord,
): ConversationSeenRecord | undefined {
  if (current === undefined) return incoming;
  if (sameEpoch(current, incoming)) return incoming.seq > current.seq ? incoming : current;
  if (incoming.epoch === undefined && current.epoch !== undefined) return current;
  return incoming;
}

function withConversationRecord(
  map: ConversationSeenMap,
  key: string,
  record: ConversationSeenRecord,
): ConversationSeenMap {
  if (recordsEqual(map[key], record)) return map;
  return { ...map, [key]: record };
}

function withoutConversationRecord(map: ConversationSeenMap, key: string): ConversationSeenMap {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

function overlayCanShow(overlay: ConversationOverlay, real: ConversationSeenMap): boolean {
  const current = real[overlay.key];
  if (current === undefined || sameEpoch(current, overlay.record)) return true;
  if (overlay.baselineGeneration >= conversationGeneration) return true;
  return sameEpoch(current, overlay.baselineRecord);
}

function buildConversationSnapshot(real: ConversationSeenMap): ConversationSeenMap {
  if (conversationOverlays.size === 0) return real;
  const visible: Record<string, ConversationSeenRecord> = { ...real };
  for (const overlay of conversationOverlays.values()) {
    if (!overlayCanShow(overlay, real)) continue;
    const merged = mergeConversationSeenRecord(visible[overlay.key], overlay.record);
    if (merged !== undefined) visible[overlay.key] = merged;
  }
  return visible;
}

function notifyConversationListeners(): void {
  for (const listener of conversationListeners) listener();
}

function persistConversationSeen(map: ConversationSeenMap): boolean {
  const storage = localStorageOrUndefined();
  if (storage === undefined) return false;
  try {
    storage.setItem(CONVERSATION_SEEN_KEY, JSON.stringify(map));
    return true;
  } catch {
    // storage full / unavailable — keep the in-memory snapshot usable
    return false;
  }
}

function readLatestConversationForMutation(): ConversationSeenMap {
  conversationCache = readConversationStored();
  conversationGeneration += 1;
  conversationSnapshotCache = undefined;
  return conversationCache;
}

function publishConversationMutation(
  before: ConversationSeenMap,
  next: ConversationSeenMap,
  changed: boolean,
): void {
  if (changed) persistConversationSeen(next);
  conversationCache = next;
  conversationGeneration += 1;
  conversationSnapshotCache = undefined;
  const after = conversationSeenSnapshot();
  if (mapsEqual(before, after)) conversationSnapshotCache = before;
  else notifyConversationListeners();
}

function updateConversationSeen(
  update: (latest: ConversationSeenMap) => ConversationSeenMap,
): { readonly next: ConversationSeenMap; readonly changed: boolean } {
  const before = conversationSeenSnapshot();
  const latest = readLatestConversationForMutation();
  const next = update(latest);
  publishConversationMutation(before, next, next !== latest);
  return { next, changed: next !== latest };
}

function conversationStorageEvent(event: StorageEvent): void {
  if (event.key !== null && event.key !== CONVERSATION_SEEN_KEY) return;
  if (event.storageArea !== undefined && event.storageArea !== null) {
    const storage = localStorageOrUndefined();
    if (storage !== undefined && event.storageArea !== storage) return;
  }
  conversationCache = undefined;
  conversationSnapshotCache = undefined;
  conversationGeneration += 1;
  notifyConversationListeners();
}

function bindConversationStorage(): void {
  if (conversationStorageBound) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('storage', conversationStorageEvent);
  conversationStorageBound = true;
}

/** Current global conversation read marks, including pending open overlays. */
export function conversationSeenSnapshot(): ConversationSeenMap {
  conversationSnapshotCache ??= buildConversationSnapshot(ensureConversationCache());
  return conversationSnapshotCache;
}

export function subscribeConversationSeen(listener: () => void): () => void {
  conversationListeners.add(listener);
  bindConversationStorage();
  return () => { conversationListeners.delete(listener); };
}

/** Record a conversation as seen, advancing only within its current epoch. */
export function markConversationSeen(ref: ConversationRef, cursor: AttentionCursor): void {
  const normalizedRef = normalizeConversationRef(ref);
  const normalizedCursor = normalizeCursor(cursor);
  if (normalizedRef === undefined || normalizedCursor === undefined) return;
  const key = encodeConversationRef(normalizedRef);
  const incoming = recordFromCursor(normalizedCursor);
  updateConversationSeen((latest) => {
    const merged = mergeConversationSeenRecord(latest[key], incoming);
    return merged === undefined ? latest : withConversationRecord(latest, key, merged);
  });
}

/** Record several conversations as seen in one storage transaction. */
export function markConversationsSeen(
  entries: readonly { readonly ref: ConversationRef; readonly cursor: AttentionCursor }[],
): void {
  const normalized = entries.flatMap(({ ref, cursor }) => {
    const normalizedRef = normalizeConversationRef(ref);
    const normalizedCursor = normalizeCursor(cursor);
    if (normalizedRef === undefined || normalizedCursor === undefined) return [];
    return [{ key: encodeConversationRef(normalizedRef), record: recordFromCursor(normalizedCursor) }];
  });
  if (normalized.length === 0) return;
  updateConversationSeen((latest) => {
    let next = latest;
    for (const { key, record } of normalized) {
      const merged = mergeConversationSeenRecord(next[key], record);
      if (merged !== undefined) next = withConversationRecord(next, key, merged);
    }
    return next;
  });
}

/** Lower a mark to just before the supplied cursor, explicitly making it unread. */
export function markConversationUnread(ref: ConversationRef, cursor: AttentionCursor): void {
  const normalizedRef = normalizeConversationRef(ref);
  const normalizedCursor = normalizeCursor(cursor);
  if (normalizedRef === undefined || normalizedCursor === undefined) return;
  const key = encodeConversationRef(normalizedRef);
  const targetSeq = Math.max(0, normalizedCursor.seq - 1);
  updateConversationSeen((latest) => {
    const current = latest[key];
    const effectiveEpoch = normalizedCursor.epoch ?? current?.epoch;
    const target = effectiveEpoch === undefined
      ? { seq: targetSeq, updatedAt: Date.now() }
      : { epoch: effectiveEpoch, seq: targetSeq, updatedAt: Date.now() };
    if (current !== undefined && sameEpoch(current, target) && current.seq <= targetSeq) return latest;
    return withConversationRecord(latest, key, target);
  });
}

/** Forget exactly one conversation's mark, preserving all other fresh storage values. */
export function forgetConversationSeen(ref: ConversationRef): void {
  const normalizedRef = normalizeConversationRef(ref);
  if (normalizedRef === undefined) return;
  const key = encodeConversationRef(normalizedRef);
  updateConversationSeen((latest) => withoutConversationRecord(latest, key));
}

function legacyMarkerKey(spaceKey: string): string {
  return `${LEGACY_SEED_MARKER_PREFIX}${encodeURIComponent(spaceKey)}`;
}

function hasLegacySeedMarker(spaceKey: string): boolean {
  const storage = localStorageOrUndefined();
  if (storage === undefined) return false;
  try {
    return storage.getItem(legacyMarkerKey(spaceKey)) !== null;
  } catch {
    return false;
  }
}

function writeLegacySeedMarker(spaceKey: string): boolean {
  const storage = localStorageOrUndefined();
  if (storage === undefined) return false;
  try {
    storage.setItem(legacyMarkerKey(spaceKey), '1');
    return true;
  } catch {
    return false;
  }
}

function legacyRef(spaceKey: string, id: string): ConversationRef | undefined {
  if (id.startsWith('room:')) {
    const roomId = id.slice('room:'.length);
    return roomId === '' ? undefined : { spaceKey, kind: 'room', id: roomId };
  }
  return id === '' ? undefined : { spaceKey, kind: 'session', id };
}

/**
 * Seed the v2 global store from one explicitly verified space's v1 marks. A
 * durable marker prevents later calls for that same space from re-importing a
 * changed legacy map; records already in a newer epoch are retained.
 */
export function seedLegacySeenForSpace(spaceKey: string, legacySeenMap: SessionSeenMap): void {
  if (typeof spaceKey !== 'string' || spaceKey === '' || hasLegacySeedMarker(spaceKey)) return;
  const legacyEntries: Array<{ readonly key: string; readonly record: ConversationSeenRecord }> = [];
  const updatedAt = Date.now();
  for (const [id, value] of Object.entries(legacySeenMap)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const ref = legacyRef(spaceKey, id);
    if (ref === undefined) continue;
    legacyEntries.push({
      key: encodeConversationRef(ref),
      record: recordFromCursor({ seq: Math.max(0, Math.trunc(value)) }, updatedAt),
    });
  }

  const before = conversationSeenSnapshot();
  const latest = readLatestConversationForMutation();
  let next = latest;
  for (const { key, record } of legacyEntries) {
    const merged = mergeConversationSeenRecord(next[key], record);
    if (merged !== undefined) next = withConversationRecord(next, key, merged);
  }
  const persisted = next === latest ? true : persistConversationSeen(next);
  conversationCache = next;
  conversationGeneration += 1;
  conversationSnapshotCache = undefined;
  const after = conversationSeenSnapshot();
  if (!mapsEqual(before, after)) notifyConversationListeners();

  // A marker is written only when a changed map was persisted successfully.
  // Empty/fully current seeds still get a marker, so they remain one-time.
  if (persisted) writeLegacySeedMarker(spaceKey);
}

/** Begin an optimistic open; only commit writes the durable mark. */
export function beginOpenConversation(
  ref: ConversationRef,
  cursor: AttentionCursor,
): { commit(): void; cancel(): void } {
  const normalizedRef = normalizeConversationRef(ref);
  const normalizedCursor = normalizeCursor(cursor);
  if (normalizedRef === undefined || normalizedCursor === undefined) {
    return { commit: () => {}, cancel: () => {} };
  }
  const key = encodeConversationRef(normalizedRef);
  const real = ensureConversationCache();
  const overlayId = ++nextConversationOverlayId;
  const overlay: ConversationOverlay = {
    id: overlayId,
    key,
    record: recordFromCursor(normalizedCursor),
    baselineGeneration: conversationGeneration,
    baselineRecord: real[key],
  };
  const before = conversationSeenSnapshot();
  conversationOverlays.set(overlayId, overlay);
  conversationSnapshotCache = undefined;
  const after = conversationSeenSnapshot();
  if (!mapsEqual(before, after)) notifyConversationListeners();

  let settled = false;
  return {
    commit: () => {
      if (settled) return;
      settled = true;
      const currentOverlay = conversationOverlays.get(overlayId);
      if (currentOverlay === undefined) return;
      const beforeCommit = conversationSeenSnapshot();
      const latest = readLatestConversationForMutation();
      const current = latest[key];
      const canCommit = current === undefined || sameEpoch(current, currentOverlay.record) ||
        sameEpoch(current, currentOverlay.baselineRecord);
      const merged = canCommit ? mergeConversationSeenRecord(current, currentOverlay.record) : current;
      const next = merged === undefined || merged === current
        ? latest
        : withConversationRecord(latest, key, merged);
      if (next !== latest) persistConversationSeen(next);
      conversationOverlays.delete(overlayId);
      conversationCache = next;
      conversationGeneration += 1;
      conversationSnapshotCache = undefined;
      const afterCommit = conversationSeenSnapshot();
      if (!mapsEqual(beforeCommit, afterCommit)) notifyConversationListeners();
    },
    cancel: () => {
      if (settled) return;
      settled = true;
      if (!conversationOverlays.has(overlayId)) return;
      const beforeCancel = conversationSeenSnapshot();
      conversationOverlays.delete(overlayId);
      conversationSnapshotCache = undefined;
      const afterCancel = conversationSeenSnapshot();
      if (!mapsEqual(beforeCancel, afterCancel)) notifyConversationListeners();
    },
  };
}

/** Test seam: clear v2 conversation read marks, pending overlays, and legacy seed markers. */
export function resetConversationSeen(): void {
  const hadData = conversationOverlays.size > 0 || Object.keys(conversationSeenSnapshot()).length > 0;
  conversationOverlays.clear();
  conversationCache = EMPTY_CONVERSATION_SEEN;
  conversationSnapshotCache = EMPTY_CONVERSATION_SEEN;
  conversationGeneration += 1;
  const storage = localStorageOrUndefined();
  if (storage !== undefined) {
    try {
      storage.removeItem(CONVERSATION_SEEN_KEY);
      const markerKeys: string[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key !== null && key.startsWith(LEGACY_SEED_MARKER_PREFIX)) markerKeys.push(key);
      }
      for (const key of markerKeys) storage.removeItem(key);
    } catch {
      // ignore unavailable storage
    }
  }
  if (hadData) notifyConversationListeners();
}
