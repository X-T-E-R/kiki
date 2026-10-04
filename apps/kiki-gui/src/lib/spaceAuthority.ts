/**
 * Space preference authority (spaces semantics design 2026-10-02 §6.1, §6.2).
 *
 * A space's appearance and reading choices belong to the space, not to the
 * machine showing them: `SpaceDetail.preferences` from the server is the fact,
 * and everything in this module is either a cache of it or a draft a save is
 * still carrying. Nothing here writes back to the older device-global settings.
 *
 * Two identities matter and they are not the same: `homeId` says which space,
 * and `serverId` says which server serves it. The cache is keyed by both, so
 * two connections that happen to use the same home id never read each other's
 * values. At boot only the home is known, so a "last known" entry is used until
 * `/meta` and the space detail arrive; the confirmed values then replace it.
 */

import type { SpaceDetail, SpacePreferenceValues } from '@kiki/protocol';


import type { KikiClient } from './client';
import { SPACE_ITEM_IDS, spaceSettingsApi, type SpacePreferenceItem } from './spaceSettings';

export interface SpaceIdentity {
  readonly serverId: string;
  readonly homeId: string;
}

export function spaceIdentityKey(identity: SpaceIdentity): string {
  return `${identity.serverId}|${identity.homeId}`;
}

/** `null` until `/meta` identifies the server; the home alone is not enough. */
export function spaceIdentityOf(serverId: string | undefined, homeId: string): SpaceIdentity | null {
  return serverId === undefined || serverId === '' ? null : { serverId, homeId };
}

// ---------------------------------------------------------------------------
// The device cache, keyed by server + home.
// ---------------------------------------------------------------------------

const CACHE_KEY = 'kiki.spacePreferences.cache';

interface SpacePreferenceCache {
  readonly entries: Record<string, SpacePreferenceValues>;
  /** Written on every confirm so the next launch paints before the server answers. */
  readonly lastKnown: { readonly homeId: string; readonly serverId: string; readonly values: SpacePreferenceValues } | null;
  /** Spaces whose "which look is mine" question this device has already settled. */
  readonly resolved: Record<string, true>;
}

const EMPTY_CACHE: SpacePreferenceCache = { entries: {}, lastKnown: null, resolved: {} };

function readCache(): SpacePreferenceCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw === null) return EMPTY_CACHE;
    const parsed = JSON.parse(raw) as Partial<SpacePreferenceCache>;
    return {
      entries: typeof parsed.entries === 'object' && parsed.entries !== null ? parsed.entries : {},
      lastKnown: parsed.lastKnown ?? null,
      resolved: typeof parsed.resolved === 'object' && parsed.resolved !== null ? parsed.resolved : {},
    };
  } catch {
    return EMPTY_CACHE;
  }
}

function writeCache(next: SpacePreferenceCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    // The cache is a convenience; the server stays authoritative.
  }
}

/** Forget this device's cached copy for one space (tests and explicit resets). */
export function dropCachedSpacePreferences(identity: SpaceIdentity): void {
  const cache = readCache();
  const entries = { ...cache.entries };
  delete entries[spaceIdentityKey(identity)];
  const resolved = { ...cache.resolved };
  delete resolved[spaceIdentityKey(identity)];
  const matchesLastKnown = cache.lastKnown?.homeId === identity.homeId && cache.lastKnown.serverId === identity.serverId;
  writeCache({ ...cache, entries, resolved, lastKnown: matchesLastKnown ? null : cache.lastKnown });
}

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

/** How a preference item's write is going, per item. */
export interface SpaceWriteState {
  readonly state: 'saving' | 'error';
  readonly error?: unknown;
}

export interface SpaceAuthorityState {
  readonly identity: SpaceIdentity | null;
  /** The server's own preferences for this space; `null` before the first read. */
  readonly confirmed: SpacePreferenceValues | null;
  /** False while only the boot cache is known, or the space has no authority yet. */
  readonly authoritative: boolean;
  /** The value a person just asked for, before the server confirmed it. */
  readonly drafts: Readonly<Partial<Record<SpacePreferenceItem, unknown>>>;
  readonly writes: Readonly<Partial<Record<SpacePreferenceItem, SpaceWriteState>>>;
  /** This device kept a different appearance than the space's own. */
  readonly deviceConflict: boolean;
  /** Set once a detail has been read, so surfaces can tell "empty" from "unread". */
  readonly loaded: boolean;
}

const IDLE: SpaceAuthorityState = {
  identity: null, confirmed: null, authoritative: false,
  drafts: {}, writes: {}, deviceConflict: false, loaded: false,
};

let state: SpaceAuthorityState = IDLE;
let generation = 0;
let writeSequence = 0;
let confirmedVersion = 0;
let latestWrites: Partial<Record<SpacePreferenceItem, number>> = {};
let fieldVersions: Partial<Record<SpacePreferenceItem, number>> = {};
const listeners = new Set<() => void>();

function holdsIdentity(identity: SpaceIdentity): boolean {
  return state.identity !== null && spaceIdentityKey(state.identity) === spaceIdentityKey(identity);
}

function resetGeneration(): void {
  generation += 1;
  latestWrites = {};
  fieldVersions = {};
}

export function subscribeSpaceAuthority(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Stable identity between changes, for `useSyncExternalStore`. */
export function spaceAuthoritySnapshot(): SpaceAuthorityState {
  return state;
}

/** First-render snapshot for the same hook. */
export function spaceAuthorityServerSnapshot(): SpaceAuthorityState {
  return IDLE;
}

function publish(next: SpaceAuthorityState): void {
  state = next;
  for (const listener of listeners) listener();
  notifySinks();
}

/** Remember one space's values for the next launch, without touching the rest. */
function rememberValues(identity: SpaceIdentity, values: SpacePreferenceValues, lastKnown = true): void {
  const cache = readCache();
  writeCache({
    ...cache,
    entries: { ...cache.entries, [spaceIdentityKey(identity)]: values },
    lastKnown: lastKnown ? { homeId: identity.homeId, serverId: identity.serverId, values } : cache.lastKnown,
  });
}

/** True once this device has settled the "which look is mine" question here. */
export function spaceDeviceConflictResolved(identity: SpaceIdentity): boolean {
  return readCache().resolved[spaceIdentityKey(identity)] === true;
}

/** Home-only fallback is for boot; a known server reads only its own entry. */
export function loadCachedSpacePreferences(homeId: string, serverId?: string): void {
  const cache = readCache();
  const boot = cache.lastKnown?.homeId === homeId ? cache.lastKnown : null;
  const identity = serverId === undefined ? (boot === null ? null : { serverId: boot.serverId, homeId }) : { serverId, homeId };
  if (identity === null || (holdsIdentity(identity) && state.loaded)) return;
  const confirmed = serverId === undefined ? boot?.values ?? null : cache.entries[spaceIdentityKey(identity)] ?? null;
  if (!holdsIdentity(identity)) resetGeneration();
  publish({ ...IDLE, identity, confirmed });
}

/** Accept a fresh detail without discarding this identity's unsaved edits. */
export function configureSpaceAuthority(identity: SpaceIdentity, detail: SpaceDetail): void {
  const same = holdsIdentity(identity);
  if (!same) resetGeneration();
  rememberValues(identity, detail.preferences);
  publish({
    ...(same ? state : IDLE),
    identity,
    confirmed: detail.preferences,
    authoritative: detail.preference_authority,
    loaded: true,
  });
}

/** No detail (browser host, or a server without the route): back to device values. */
export function clearSpaceAuthority(): void {
  if (state === IDLE) return;
  resetGeneration();
  publish(IDLE);
}

/**
 * This device kept a different appearance than the space's own. Raised once per
 * device and space, never as a silent overwrite: the person chooses which one
 * the space uses.
 */
export function markSpaceDeviceConflict(): void {
  if (state.deviceConflict) return;
  publish({ ...state, deviceConflict: true });
}

export function resolveSpaceDeviceConflict(identity?: SpaceIdentity): void {
  const target = identity ?? state.identity;
  if (target !== null) {
    const cache = readCache();
    writeCache({ ...cache, resolved: { ...cache.resolved, [spaceIdentityKey(target)]: true } });
  }
  if (target !== null && holdsIdentity(target) && state.deviceConflict) publish({ ...state, deviceConflict: false });
}

/** The value to show or apply: the draft if a save is carrying one, else confirmed. */
export function spacePreferenceValue<K extends SpacePreferenceItem>(item: K): SpacePreferenceValues[K] | undefined {
  const draft = state.drafts[item];
  if (draft !== undefined) return draft as SpacePreferenceValues[K];
  return state.confirmed === null ? undefined : state.confirmed[item];
}

/** The value the server confirmed — never a draft. */
export function spaceConfirmedValue<K extends SpacePreferenceItem>(item: K): SpacePreferenceValues[K] | undefined {
  return state.confirmed === null ? undefined : state.confirmed[item];
}

export function spacePreferenceEnabled(): boolean {
  return state.confirmed !== null || ports !== undefined;
}

// ---------------------------------------------------------------------------
// Writing: every change is a preview and its apply, never a direct write.
// ---------------------------------------------------------------------------

export interface SpacePreferencePorts {
  /** The connected client, or `null` while disconnected. */
  readonly client: () => KikiClient | null;
  /** The space whose preferences are on screen (`main` included). */
  readonly spaceId: () => string;
  readonly identity: () => SpaceIdentity | null;
  /** The detail an apply returned, so the page's query shows the real result. */
  readonly onDetail?: (detail: SpaceDetail) => void;
}

let ports: SpacePreferencePorts | undefined;
/** Sinks run on every state change; the detail surface refreshes its query here. */
const sinks = new Set<() => void>();

export function configureSpacePreferencePorts(next?: SpacePreferencePorts): void {
  ports = next;
}

export function subscribeSpacePreferenceSinks(listener: () => void): () => void {
  sinks.add(listener);
  return () => { sinks.delete(listener); };
}

function notifySinks(): void {
  for (const sink of sinks) sink();
}

/** Preserve fields saved since a request began; revisions on the wire are opaque. */
function reconcileDetail(identity: SpaceIdentity, detail: SpaceDetail, version: number, stale: readonly SpacePreferenceItem[] = []): SpaceDetail {
  if (!holdsIdentity(identity) || state.confirmed === null) return detail;
  const preferences = { ...detail.preferences };
  for (const item of Object.keys(SPACE_ITEM_IDS) as SpacePreferenceItem[]) {
    if ((fieldVersions[item] ?? 0) > version || stale.includes(item)) {
      Object.assign(preferences, { [item]: state.confirmed[item] });
    }
  }
  const savedWhilePending = Object.values(fieldVersions).some((saved) => saved > version);
  return { ...detail, preferences, preference_authority: savedWhilePending ? state.authoritative : detail.preference_authority };
}

/** A background detail read must not undo a save completed while it was pending. */
export async function readSpacePreferenceDetail(client: KikiClient, identity: SpaceIdentity): Promise<SpaceDetail> {
  const version = confirmedVersion;
  const detail = await spaceSettingsApi(client).detail(identity.homeId);
  return reconcileDetail(identity, detail, version);
}

/**
 * Write one preference through preview → apply. A failure keeps the draft and
 * records the error. Only this identity's latest operation may settle its draft.
 */
export async function writeSpacePreferenceItem<K extends SpacePreferenceItem>(
  item: K,
  value: SpacePreferenceValues[K],
): Promise<boolean> {
  const active = ports;
  const client = active?.client() ?? null;
  const identity = active?.identity() ?? null;
  if (active === undefined || client === null || identity === null || active.spaceId() !== identity.homeId) return false;
  return writeSpacePreferenceValues(client, identity, { [item]: value });
}

/** The explicit device-look choice uses the same guarded write path as one item. */
export async function writeSpacePreferenceValues(
  client: KikiClient,
  identity: SpaceIdentity,
  values: Partial<SpacePreferenceValues>,
): Promise<boolean> {
  if (!holdsIdentity(identity)) return false;
  const items = (Object.keys(SPACE_ITEM_IDS) as SpacePreferenceItem[]).filter((item) => values[item] !== undefined);
  if (items.length === 0) return false;
  const active = ports;
  const startedGeneration = generation;
  const version = confirmedVersion;
  const sequence = ++writeSequence;
  const drafts = { ...state.drafts };
  const writes = { ...state.writes };
  for (const item of items) {
    latestWrites[item] = sequence;
    drafts[item] = values[item];
    writes[item] = { state: 'saving' };
  }
  publish({ ...state, drafts, writes });
  const current = () => generation === startedGeneration && holdsIdentity(identity);
  const latest = () => items.filter((item) => latestWrites[item] === sequence);
  try {
    const api = spaceSettingsApi(client);
    const changes = items.map((item) => ({ id: SPACE_ITEM_IDS[item], value: values[item] }));
    const preview = await api.preview(identity.homeId, { action: 'edit', changes });
    for (const change of changes) {
      const row = preview.rows.find((candidate) => candidate.id === change.id);
      if (row === undefined || row.blocked_reason !== undefined) {
        throw new Error(row?.blocked_reason ?? `The server returned no plan for ${change.id}`);
      }
    }
    const result = await api.apply(identity.homeId, { token: preview.token, selected: changes.map((change) => change.id) });
    if (!current()) {
      // A legal old-space apply can finish, but not replace a newer visit's cache.
      if (!holdsIdentity(identity)) rememberValues(identity, result.detail.preferences, false);
      return true;
    }
    const settled = latest();
    if (settled.length === 0) return true;
    const next = reconcileDetail(identity, result.detail, version, items.filter((item) => !settled.includes(item)));
    const nextDrafts = { ...state.drafts };
    const nextWrites = { ...state.writes };
    confirmedVersion += 1;
    for (const item of settled) {
      fieldVersions[item] = confirmedVersion;
      delete nextDrafts[item];
      delete nextWrites[item];
    }
    rememberValues(identity, next.preferences);
    publish({ ...state, confirmed: next.preferences, authoritative: next.preference_authority, loaded: true, drafts: nextDrafts, writes: nextWrites });
    const sinkIdentity = active?.identity();
    if (current() && sinkIdentity !== null && sinkIdentity !== undefined && spaceIdentityKey(sinkIdentity) === spaceIdentityKey(identity)) active?.onDetail?.(next);
    return true;
  } catch (error) {
    if (current()) {
      const nextWrites = { ...state.writes };
      for (const item of latest()) nextWrites[item] = { state: 'error', error };
      if (latest().length > 0) publish({ ...state, writes: nextWrites });
    }
    return false;
  }
}

/** Send the draft again after a failed write. */
export function retrySpacePreferenceItem(item: SpacePreferenceItem): void {
  const draft = state.drafts[item];
  if (draft === undefined) return;
  void writeSpacePreferenceItem(item, draft as SpacePreferenceValues[typeof item]);
}

// ---------------------------------------------------------------------------
// Importing what this device already had (§6.2 step three)
// ---------------------------------------------------------------------------

/**
 * Only a space without its own authority accepts an import, and only this
 * device's older values go with it. Once authority exists the server refuses,
 * which is what `device_conflict` reports back.
 */
export async function importDevicePreferences(
  client: KikiClient,
  identity: SpaceIdentity,
  deviceId: string,
  values: Partial<SpacePreferenceValues>,
): Promise<{ imported: boolean; conflict: boolean } | null> {
  const startedGeneration = generation;
  const version = confirmedVersion;
  const active = ports;
  try {
    const result = await spaceSettingsApi(client).importPreferences(identity.homeId, { values, device_id: deviceId });
    if (generation !== startedGeneration || (state.identity !== null && !holdsIdentity(identity))) {
      if (!holdsIdentity(identity)) rememberValues(identity, result.detail.preferences, false);
      return { imported: result.imported, conflict: result.device_conflict };
    }
    const next = reconcileDetail(identity, result.detail, version);
    if (state.identity === null) resetGeneration();
    confirmedVersion += 1;
    for (const item of Object.keys(SPACE_ITEM_IDS) as SpacePreferenceItem[]) fieldVersions[item] = confirmedVersion;
    rememberValues(identity, next.preferences);
    publish({
      ...state,
      identity,
      confirmed: next.preferences,
      authoritative: next.preference_authority,
      deviceConflict: result.device_conflict,
      loaded: true,
    });
    const sinkIdentity = active?.identity();
    if (holdsIdentity(identity) && sinkIdentity !== null && sinkIdentity !== undefined && spaceIdentityKey(sinkIdentity) === spaceIdentityKey(identity)) active?.onDetail?.(next);
    return { imported: result.imported, conflict: result.device_conflict };
  } catch {
    return null;
  }
}

/** A stable per-device id for the import handshake; not a secret. */
export function spaceDeviceId(): string {
  const key = 'kiki.deviceId';
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null && stored !== '') return stored;
    const created = globalThis.crypto?.randomUUID?.() ?? `device-${Date.now().toString(36)}`;
    localStorage.setItem(key, created);
    return created;
  } catch {
    return 'device-unknown';
  }
}
