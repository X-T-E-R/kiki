/**
 * Per-conversation inbox triage marks (`kiki.conversationTriage.v1`).
 *
 * Adapted from Vibe42's reversible, cursor-bound triage state machine:
 *   - `settled`: acknowledged at a specific attention cursor (never hides an
 *     unresolved `needsYou` approval/question/budget gate).
 *   - `snoozed`: deferred until timestamp `u` at a specific cursor; auto-wakes
 *     early when the attention cursor advances, and resurfaces into `active`
 *     once `nowMs >= u` even if the underlying turn was already read.
 *   - `archived`: inbox-level hide at a specific cursor (distinct from backend
 *     `Session.archived`); reversible and auto-wakes on new attention activity.
 *
 * Stored globally in `localStorage` keyed by `encodeConversationRef(ref)` so
 * multi-space and remote conversations never collide. Every write performs a
 * read-merge-write transaction to preserve concurrent updates from other
 * windows, and subscribes to `storage` events for live cross-window sync.
 */

import type { InboxReason } from '../sessions/inbox';
import {
  encodeConversationRef,
  type AttentionCursor,
  type ConversationRef,
} from './sessionReadState';

const TRIAGE_STORAGE_KEY = 'kiki.conversationTriage.v1';
const STALE_TRIAGE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Reversible inbox-level triage disposition (distinct from backend `Session.archived`). */
export type TriageMark = 'settled' | 'snoozed' | 'archived';

/** Effective inbox bucket/visibility class for one conversation at a given instant. */
export type TriageClass = 'active' | 'working' | 'snoozed' | 'settled' | 'archived' | 'hidden';

/** Standard snooze durations (`tomorrow` = next local calendar day at 09:00). */
export type SnoozePreset = '30m' | '1h' | '3h' | 'tomorrow';

/** Persisted triage record bound to the attention cursor observed when triaged. */
export interface TriageRecord {
  readonly s: TriageMark;
  readonly epoch?: string;
  readonly seq: number;
  readonly reason?: InboxReason;
  /** Wake-up timestamp in epoch ms (present for `snoozed`). */
  readonly u?: number;
  /** Record creation/update timestamp in epoch ms. */
  readonly t: number;
}

/** Triage marks keyed by `encodeConversationRef(ref)`. */
export type ConversationTriageMap = Readonly<Record<string, TriageRecord>>;

/** Live conversation state fed into `classifyConversationTriage`. */
export interface TriageClassifyInput {
  readonly needsYou: boolean;
  readonly busy: boolean;
  readonly unread: boolean;
  readonly cursor: AttentionCursor;
  readonly reason?: InboxReason;
}

/** One conversation's current cursor for pruning obsolete triage marks. */
export interface TriageCursorEntry {
  readonly ref: ConversationRef;
  readonly cursor: AttentionCursor;
}

const VALID_REASONS: ReadonlySet<string> = new Set<InboxReason>([
  'approval',
  'question',
  'budget',
  'completed',
  'failed',
  'cancelled',
  'running',
]);

const EMPTY_TRIAGE_MAP: ConversationTriageMap = {};

/** Compute the target wake-up epoch-ms for a snooze preset. */
export function computeSnoozeUntilMs(preset: SnoozePreset, now?: Date): number {
  const base = now ?? new Date();
  switch (preset) {
    case '30m':
      return base.getTime() + 30 * 60_000;
    case '1h':
      return base.getTime() + 60 * 60_000;
    case '3h':
      return base.getTime() + 3 * 60 * 60_000;
    case 'tomorrow': {
      const next = new Date(base.getTime());
      next.setDate(next.getDate() + 1);
      next.setHours(9, 0, 0, 0);
      return next.getTime();
    }
  }
}

/** True when `cursor` matches the triage record's seq (and epoch when both carry one). */
export function isAttentionCursorSame(
  cursor: AttentionCursor,
  record: Pick<TriageRecord, 'epoch' | 'seq'>,
): boolean {
  if (!Number.isFinite(cursor.seq)) return false;
  if (Math.max(0, Math.trunc(cursor.seq)) !== record.seq) return false;
  if (cursor.epoch !== undefined && record.epoch !== undefined) {
    return cursor.epoch === record.epoch;
  }
  return true;
}

/**
 * Classify a conversation's effective inbox state against its triage record.
 *
 * Precedence invariants:
 *   1. `needsYou` gates can only be deferred by an active snooze at the same
 *      cursor — settling or archiving never hides an unresolved gate.
 *   2. Actively running (`busy`) conversations stay in `working` unless
 *      inbox-archived at the same cursor.
 *   3. An expired snooze at the same cursor resurfaces into `active` even if
 *      the underlying turn was already read.
 *   4. Unread idle turns respect same-cursor `archived` / `snoozed` / `settled`,
 *      and wake immediately into `active` when the cursor advances.
 *   5. Already-read idle turns stay in `snoozed` / `archived` while the same
 *      cursor holds, otherwise `hidden`.
 */
export function classifyConversationTriage(
  input: TriageClassifyInput,
  record: TriageRecord | undefined,
  nowMs: number,
): TriageClass {
  const sameCursor = record !== undefined && isAttentionCursorSame(input.cursor, record);
  const activeSnooze = sameCursor && record.s === 'snoozed' && record.u !== undefined && nowMs < record.u;
  const expiredSnooze = sameCursor && record.s === 'snoozed' && record.u !== undefined && nowMs >= record.u;

  if (input.needsYou) {
    return activeSnooze ? 'snoozed' : 'active';
  }
  if (input.busy) {
    return sameCursor && record.s === 'archived' ? 'archived' : 'working';
  }
  if (expiredSnooze) {
    return 'active';
  }
  if (input.unread) {
    if (sameCursor && record.s === 'archived') return 'archived';
    if (activeSnooze) return 'snoozed';
    if (sameCursor && record.s === 'settled') return 'settled';
    return 'active';
  }
  if (activeSnooze) return 'snoozed';
  if (sameCursor && record.s === 'archived') return 'archived';
  return 'hidden';
}

/** Earliest future snooze expiration in `map` strictly after `nowMs`, or `undefined`. */
export function nextSnoozeExpiryMs(
  map: ConversationTriageMap,
  nowMs: number = Date.now(),
): number | undefined {
  let earliest: number | undefined;
  for (const record of Object.values(map)) {
    if (record.s !== 'snoozed' || record.u === undefined) continue;
    if (record.u <= nowMs) continue;
    if (earliest === undefined || record.u < earliest) earliest = record.u;
  }
  return earliest;
}

// ---- transactional localStorage store ----

let triageCache: ConversationTriageMap | undefined;
const triageListeners = new Set<() => void>();
let triageStorageBound = false;

function localStorageOrUndefined(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function normalizeRef(ref: ConversationRef): ConversationRef | undefined {
  if (ref === null || typeof ref !== 'object') return undefined;
  if (typeof ref.spaceKey !== 'string' || ref.spaceKey === '') return undefined;
  if (ref.kind !== 'session' && ref.kind !== 'room') return undefined;
  if (typeof ref.id !== 'string' || ref.id === '') return undefined;
  return ref;
}

function normalizeCursor(cursor: AttentionCursor): AttentionCursor | undefined {
  if (cursor === null || typeof cursor !== 'object' || !Number.isFinite(cursor.seq)) return undefined;
  const seq = Math.max(0, Math.trunc(cursor.seq));
  if (cursor.epoch !== undefined) {
    if (typeof cursor.epoch !== 'string') return undefined;
    if (cursor.epoch === '') return { seq };
    return { epoch: cursor.epoch, seq };
  }
  return { seq };
}

function parseReason(value: unknown): InboxReason | undefined {
  return typeof value === 'string' && VALID_REASONS.has(value) ? (value as InboxReason) : undefined;
}

function parseTriageRecord(value: unknown): TriageRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const mark = raw['s'];
  if (mark !== 'settled' && mark !== 'snoozed' && mark !== 'archived') return undefined;
  if (typeof raw['seq'] !== 'number' || !Number.isFinite(raw['seq'])) return undefined;
  const seq = Math.max(0, Math.trunc(raw['seq']));
  const rawEpoch = raw['epoch'];
  if (rawEpoch !== undefined && typeof rawEpoch !== 'string') return undefined;
  const epoch = typeof rawEpoch === 'string' && rawEpoch !== '' ? rawEpoch : undefined;
  const reason = parseReason(raw['reason']);
  const rawUntil = raw['u'];
  const u = typeof rawUntil === 'number' && Number.isFinite(rawUntil) ? Math.max(0, Math.trunc(rawUntil)) : undefined;
  if (mark === 'snoozed' && u === undefined) return undefined;
  const rawTime = raw['t'];
  const t = typeof rawTime === 'number' && Number.isFinite(rawTime) ? Math.max(0, Math.trunc(rawTime)) : 0;
  return {
    s: mark,
    ...(epoch !== undefined ? { epoch } : {}),
    seq,
    ...(reason !== undefined ? { reason } : {}),
    ...(u !== undefined ? { u } : {}),
    t,
  };
}

function parseTriageMap(raw: string | null): ConversationTriageMap {
  if (raw === null) return EMPTY_TRIAGE_MAP;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_TRIAGE_MAP;
    const out: Record<string, TriageRecord> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const record = parseTriageRecord(value);
      if (record !== undefined) out[key] = record;
    }
    return Object.keys(out).length === 0 ? EMPTY_TRIAGE_MAP : out;
  } catch {
    return EMPTY_TRIAGE_MAP;
  }
}

function readStoredTriage(): ConversationTriageMap {
  const storage = localStorageOrUndefined();
  if (storage === undefined) return triageCache ?? EMPTY_TRIAGE_MAP;
  try {
    return parseTriageMap(storage.getItem(TRIAGE_STORAGE_KEY));
  } catch {
    return triageCache ?? EMPTY_TRIAGE_MAP;
  }
}

function ensureTriageCache(): ConversationTriageMap {
  triageCache ??= readStoredTriage();
  return triageCache;
}

function recordsEqual(left: TriageRecord | undefined, right: TriageRecord | undefined): boolean {
  return (
    left?.s === right?.s
    && left?.epoch === right?.epoch
    && left?.seq === right?.seq
    && left?.reason === right?.reason
    && left?.u === right?.u
    && left?.t === right?.t
  );
}

function mapsEqual(left: ConversationTriageMap, right: ConversationTriageMap): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!recordsEqual(left[key], right[key])) return false;
  }
  return true;
}

function pruneTriageMap(map: ConversationTriageMap, nowMs: number): ConversationTriageMap {
  const entries = Object.entries(map);
  if (entries.length === 0) return EMPTY_TRIAGE_MAP;

  const fresh = entries.filter(([, record]) => {
    const stale = nowMs - record.t > STALE_TRIAGE_AGE_MS;
    const activeFutureSnooze = record.s === 'snoozed' && record.u !== undefined && nowMs < record.u;
    return !stale || activeFutureSnooze;
  });

  if (fresh.length === entries.length) return map;
  if (fresh.length === 0) return EMPTY_TRIAGE_MAP;
  const out: Record<string, TriageRecord> = {};
  for (const [key, record] of fresh) out[key] = record;
  return out;
}

function persistTriageMap(map: ConversationTriageMap): void {
  const storage = localStorageOrUndefined();
  if (storage === undefined) return;
  try {
    if (Object.keys(map).length === 0) storage.removeItem(TRIAGE_STORAGE_KEY);
    else storage.setItem(TRIAGE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // storage full / unavailable — keep in-memory state authoritative
  }
}

function notifyTriageListeners(): void {
  for (const listener of triageListeners) listener();
}

function updateTriageMap(
  mutate: (latest: ConversationTriageMap) => ConversationTriageMap,
): void {
  const before = ensureTriageCache();
  const latest = readStoredTriage();
  const next = mutate(latest);
  const changedStorage = next !== latest;
  if (changedStorage) persistTriageMap(next);
  triageCache = next;
  if (mapsEqual(before, next)) {
    triageCache = before;
    return;
  }
  notifyTriageListeners();
}

function handleTriageStorageEvent(event: StorageEvent): void {
  if (event.key !== null && event.key !== TRIAGE_STORAGE_KEY) return;
  if (event.storageArea !== undefined && event.storageArea !== null) {
    const storage = localStorageOrUndefined();
    if (storage !== undefined && event.storageArea !== storage) return;
  }
  triageCache = undefined;
  notifyTriageListeners();
}

function bindTriageStorage(): void {
  if (triageStorageBound) return;
  const target = globalThis as { addEventListener?: (type: string, listener: (event: StorageEvent) => void) => void };
  if (typeof target.addEventListener !== 'function') return;
  target.addEventListener('storage', handleTriageStorageEvent);
  triageStorageBound = true;
}

/** Current triage snapshot; reference-stable between writes for `useSyncExternalStore`. */
export function conversationTriageSnapshot(): ConversationTriageMap {
  return ensureTriageCache();
}

/** Subscribe to local and cross-window triage mutations. */
export function subscribeConversationTriage(listener: () => void): () => void {
  triageListeners.add(listener);
  bindTriageStorage();
  return () => {
    triageListeners.delete(listener);
  };
}

function writeTriageRecord(
  ref: ConversationRef,
  cursor: AttentionCursor,
  mark: TriageMark,
  reason: InboxReason | undefined,
  untilMs: number | undefined,
  nowMs: number,
): void {
  const normalizedRef = normalizeRef(ref);
  const normalizedCursor = normalizeCursor(cursor);
  if (normalizedRef === undefined || normalizedCursor === undefined) return;
  if (mark === 'snoozed' && (untilMs === undefined || !Number.isFinite(untilMs))) return;
  const key = encodeConversationRef(normalizedRef);
  const normalizedReason = parseReason(reason);
  const stamp = Number.isFinite(nowMs) ? Math.max(0, Math.trunc(nowMs)) : Date.now();
  const record: TriageRecord = {
    s: mark,
    ...(normalizedCursor.epoch !== undefined ? { epoch: normalizedCursor.epoch } : {}),
    seq: normalizedCursor.seq,
    ...(normalizedReason !== undefined ? { reason: normalizedReason } : {}),
    ...(untilMs !== undefined ? { u: Math.max(0, Math.trunc(untilMs)) } : {}),
    t: stamp,
  };
  updateTriageMap((latest) => {
    const base = recordsEqual(latest[key], record) ? latest : { ...latest, [key]: record };
    return pruneTriageMap(base, stamp);
  });
}

/** Mark an unread conversation settled at its current attention cursor. */
export function settleConversation(
  ref: ConversationRef,
  cursor: AttentionCursor,
  reason?: InboxReason,
  nowMs: number = Date.now(),
): void {
  writeTriageRecord(ref, cursor, 'settled', reason, undefined, nowMs);
}

/** Snooze a conversation until an explicit timestamp or preset duration. */
export function snoozeConversation(
  ref: ConversationRef,
  cursor: AttentionCursor,
  untilMsOrPreset: number | SnoozePreset,
  reason?: InboxReason,
  nowMs: number = Date.now(),
): void {
  const stamp = Number.isFinite(nowMs) ? Math.max(0, Math.trunc(nowMs)) : Date.now();
  const untilMs = typeof untilMsOrPreset === 'string'
    ? computeSnoozeUntilMs(untilMsOrPreset, new Date(stamp))
    : untilMsOrPreset;
  writeTriageRecord(ref, cursor, 'snoozed', reason, untilMs, stamp);
}

/** Hide a conversation in the inbox `archived` bucket at its current cursor (reversible, auto-wakes). */
export function archiveConversationTriage(
  ref: ConversationRef,
  cursor: AttentionCursor,
  reason?: InboxReason,
  nowMs: number = Date.now(),
): void {
  writeTriageRecord(ref, cursor, 'archived', reason, undefined, nowMs);
}

/** Remove a conversation's triage mark (unarchive / unsnooze / unsettle). */
export function clearConversationTriage(ref: ConversationRef): void {
  const normalizedRef = normalizeRef(ref);
  if (normalizedRef === undefined) return;
  const key = encodeConversationRef(normalizedRef);
  updateTriageMap((latest) => {
    if (!(key in latest)) return latest;
    const next = { ...latest };
    delete next[key];
    return Object.keys(next).length === 0 ? EMPTY_TRIAGE_MAP : next;
  });
}

/**
 * Remove triage records whose live conversation cursor has moved past the
 * stored record's cursor. Accepts an encoded-key map, record, or `{ ref, cursor }` list.
 * Returns the number of cleared entries.
 */
export function clearChangedTriageMarks(
  cursors:
    | ReadonlyMap<string, AttentionCursor>
    | Readonly<Record<string, AttentionCursor>>
    | readonly TriageCursorEntry[],
): number {
  const pairs: Array<readonly [string, AttentionCursor]> = [];
  if (cursors instanceof Map) {
    for (const [key, cursor] of cursors) pairs.push([key, cursor]);
  } else if (Array.isArray(cursors)) {
    for (const entry of cursors) {
      const normalizedRef = normalizeRef(entry.ref);
      if (normalizedRef !== undefined) pairs.push([encodeConversationRef(normalizedRef), entry.cursor]);
    }
  } else {
    for (const [key, cursor] of Object.entries(cursors)) pairs.push([key, cursor]);
  }
  if (pairs.length === 0) return 0;

  let cleared = 0;
  updateTriageMap((latest) => {
    let next: Record<string, TriageRecord> | undefined;
    for (const [key, cursor] of pairs) {
      const record = latest[key];
      if (record === undefined) continue;
      if (isAttentionCursorSame(cursor, record)) continue;
      next ??= { ...latest };
      delete next[key];
      cleared += 1;
    }
    if (next === undefined) return latest;
    return Object.keys(next).length === 0 ? EMPTY_TRIAGE_MAP : next;
  });
  return cleared;
}

/** Clear all triage marks and remove the persisted store (primarily for tests). */
export function resetConversationTriage(): void {
  const hadData = Object.keys(ensureTriageCache()).length > 0;
  triageCache = EMPTY_TRIAGE_MAP;
  persistTriageMap(EMPTY_TRIAGE_MAP);
  if (hadData) notifyTriageListeners();
}
