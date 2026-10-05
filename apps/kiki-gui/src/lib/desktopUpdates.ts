/**
 * Desktop update offers — the one place that decides whether a discovered
 * update is worth interrupting for, and the one place that remembers what the
 * user already said about it.
 *
 * The native side keeps owning what an update *is*: signature verification, the
 * signed feed, the channel endpoint, which distributions have an updater at all,
 * and the confirmation before a running session is closed. Nothing here talks
 * to the network or decides that an update may be installed; this decides only
 * whether to show a dialog, and that dialog installs through the same
 * `host.install` the About page uses.
 *
 * Two rules shape the whole module. Checks are single-flight, because the same
 * scheduler is mounted once but several callers (startup, the 24h tick, a manual
 * check) can want one at the same moment. Native actions change the latest
 * app-scope record under its preferences lock; only their successful result is
 * mirrored locally. A local write alone is a cache, never the durable record.
 */

import {
  readDesktopPrefs,
  writeDesktopPrefs,
  type AutoUpdateMode,
  type DesktopNativePrefs,
  type DesktopUpdateState,
  type UpdateChannel,
} from '@kiki/session-core/settings';

import type { DesktopUpdate, DesktopUpdateMutation } from '../host';

/** How long "remind me later" keeps a known update quiet. */
export const UPDATE_SNOOZE_MS = 24 * 60 * 60 * 1000;

/**
 * How often a long-open window looks for a new version. There is no short-cycle
 * poll: the check only happens this far after the last one, or when a manual
 * check asks for it.
 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Debounce before a check runs once the app has painted its first screen. */
export const UPDATE_STARTUP_DELAY_MS = 1_500;

/** One update worth offering, bound to the channel it was found on. */
export interface UpdateOffer {
  readonly update: DesktopUpdate;
  readonly channel: UpdateChannel;
}

/** Reads the switches the scheduler and the About page both consult. */
export interface UpdatePrefs {
  readonly autoUpdate: AutoUpdateMode;
  readonly updateChannel: UpdateChannel;
}

export function readUpdatePrefs(): UpdatePrefs {
  const prefs = readDesktopPrefs();
  return { autoUpdate: prefs.autoUpdate, updateChannel: prefs.updateChannel };
}

/** Whether the app checks on its own. `off` is the only state that stops it. */
export function autoCheckEnabled(mode: AutoUpdateMode): boolean {
  return mode !== 'off';
}

/**
 * The narrow host surface the update record needs. A host without it (a browser
 * build) keeps the record in the local store only, which is a real cache for
 * this window and nothing more.
 */
export interface UpdatePrefsHost {
  readonly readDesktopPrefs?: () => Promise<DesktopNativePrefs | null>;
  readonly writeDesktopPrefs?: (prefs: Partial<DesktopNativePrefs>) => Promise<void>;
  readonly mutateDesktopUpdateState?: (mutation: DesktopUpdateMutation) => Promise<DesktopUpdateState>;
}

let preferenceWrites = Promise.resolve();

/** Preserve the order of optimistic choices, including choices made in another component. */
export function persistUpdatePreference(host: UpdatePrefsHost, patch: Partial<DesktopNativePrefs>): Promise<void> {
  const write = preferenceWrites.then(async () => { await host.writeDesktopPrefs?.(patch); });
  preferenceWrites = write.catch(() => {});
  return write;
}

/** Refresh the app-scope authority without replacing a choice whose write is still pending. */
export async function hydrateUpdatePrefs(host: UpdatePrefsHost): Promise<void> {
  if (host.readDesktopPrefs === undefined) return;
  try {
    const pending = preferenceWrites;
    await pending;
    const native = await host.readDesktopPrefs();
    if (pending !== preferenceWrites) return hydrateUpdatePrefs(host);
    if (native !== null) writeDesktopPrefs({ ...native, updateState: native.updateState ?? {} });
  } catch {
    // An unavailable native read leaves the existing mirror intact.
  }
}

async function mutateUpdateState(mutation: DesktopUpdateMutation, next: () => DesktopUpdateState, host?: UpdatePrefsHost): Promise<boolean> {
  if (host?.mutateDesktopUpdateState === undefined) return persistUpdateState(next(), host);
  const mutate = host.mutateDesktopUpdateState;
  const write = preferenceWrites.then(async () => {
    const updated = await mutate(mutation);
    writeDesktopPrefs({ updateState: updated });
  });
  preferenceWrites = write.catch(() => {});
  try {
    await write;
    return true;
  } catch {
    return false;
  }
}

function state(): DesktopUpdateState {
  return readDesktopPrefs().updateState ?? {};
}

function skippedVersions(channel: UpdateChannel): readonly string[] {
  return state().skipped?.[channel] ?? [];
}

/**
 * Commit one change to the update record.
 *
 * The native side replaces the record whole: a patch that omits `updateState`
 * keeps whatever is stored, and a patch that carries one replaces all of it.
 * A field left out of that object is a field to clear, `{}` clears the record
 * entirely, and `null` is accepted as no value. So the record is built here in
 * full, field by field, from what should be true after the change — never by
 * spreading a possibly-stale snapshot that happens to be missing a field the
 * native side is still holding.
 *
 * Only `updateState` goes in the patch. A snapshot of every other preference
 * would overwrite a change another window made since this one was loaded.
 *
 * Returns whether the record is now on the native side. A false means it is
 * held locally only, so a caller that needs the user to know can say so.
 */
export async function persistUpdateState(
  next: DesktopUpdateState,
  host?: UpdatePrefsHost,
): Promise<boolean> {
  writeDesktopPrefs({ updateState: next });
  if (host?.writeDesktopPrefs === undefined) return false;
  try {
    // The local store answers the next read; the native side is what makes the
    // record outlive this window. Only the record goes in the patch: a snapshot
    // of every other preference would overwrite a change another window made
    // since this one was loaded.
    await host.writeDesktopPrefs({ updateState: next });
    return true;
  } catch {
    return false;
  }
}

/**
 * The whole record, with one channel's skip list replaced.
 *
 * The native side replaces the record whole, so every field the change does not
 * touch is carried over explicitly and the empty channel becomes `null`. The
 * one thing that must never happen here is dropping a field by omission: on the
 * native side an omitted field is a field to clear, not one to keep.
 */
function skippedPatch(channel: UpdateChannel, versions: readonly string[]): DesktopUpdateState {
  const { skipped, snoozedUntil, lastCheckedAt } = state();
  const other = channel === 'stable' ? skipped?.beta ?? null : skipped?.stable ?? null;
  const mine = versions.length > 0 ? [...versions] : null;
  return {
    skipped: channel === 'stable' ? { stable: mine, beta: other } : { stable: other, beta: mine },
    snoozedUntil: snoozedUntil ?? null,
    lastCheckedAt: lastCheckedAt ?? null,
  };
}

/** Compare dotted numeric versions, ignoring a leading `v` and any pre-release tail. */
export function compareVersions(left: string, right: string): number {
  const parts = (version: string) =>
    version.trim().replace(/^v/i, '').split(/[-+]/)[0]!.split('.').map((part) => {
      const value = Number.parseInt(part, 10);
      return Number.isFinite(value) ? value : 0;
    });
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Whether this version may interrupt. A skip only covers the version it names
 * on the channel it was offered on, so a newer release or a different channel
 * still gets through.
 */
export function mayOfferUpdate(version: string, channel: UpdateChannel, now: number): boolean {
  if (skippedVersions(channel).includes(version)) return false;
  const snoozedUntil = state().snoozedUntil ?? undefined;
  return snoozedUntil === undefined || now >= snoozedUntil;
}

/** A version the user skipped, until a higher one shows up. */
export async function skipUpdateVersion(
  version: string,
  channel: UpdateChannel,
  host?: UpdatePrefsHost,
): Promise<boolean> {
  return mutateUpdateState({ kind: 'skip', channel, version }, () => {
    const kept = skippedVersions(channel).filter((skipped) => compareVersions(skipped, version) < 0);
    return skippedPatch(channel, [...kept, version]);
  }, host);
}

/**
 * The whole record with `changes` applied over what is stored.
 *
 * Every field is always present, because the native side replaces the record
 * whole and reads an absent field as a field to clear. Building the record in
 * one place is what keeps a new field from being forgotten by the next writer.
 */
function wholeRecord(changes: Partial<DesktopUpdateState>): DesktopUpdateState {
  const { skipped, snoozedUntil, lastCheckedAt } = state();
  return {
    skipped: changes.skipped !== undefined
      ? changes.skipped
      : { stable: skipped?.stable ?? null, beta: skipped?.beta ?? null },
    snoozedUntil: changes.snoozedUntil !== undefined ? changes.snoozedUntil : snoozedUntil ?? null,
    lastCheckedAt: changes.lastCheckedAt !== undefined ? changes.lastCheckedAt : lastCheckedAt ?? null,
  };
}

/** Put a known update off for a day, without forgetting a skip. */
export async function snoozeUpdateUntil(now: number, host?: UpdatePrefsHost): Promise<boolean> {
  return mutateUpdateState({ kind: 'snooze', until: now + UPDATE_SNOOZE_MS }, () => wholeRecord({ snoozedUntil: now + UPDATE_SNOOZE_MS }), host);
}

/** The scheduler's cadence anchor. A failed check counts: it must not retry in a loop. */
export async function markUpdateChecked(now: number, host?: UpdatePrefsHost): Promise<boolean> {
  return mutateUpdateState({ kind: 'checked', at: now }, () => wholeRecord({ lastCheckedAt: now }), host);
}

/** Whether the interval has run out since the last check of this install. */
export function updateCheckDue(now: number): boolean {
  const lastCheckedAt = state().lastCheckedAt ?? undefined;
  return lastCheckedAt === undefined || now - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS;
}

/**
 * Epoch ms of the last recorded check, or `undefined` when this install has
 * never checked. The scheduler measures its next delay from this, so a window
 * focused often does not keep pushing the check further out.
 */
export function lastUpdateCheckAt(): number | undefined {
  return state().lastCheckedAt ?? undefined;
}

/**
 * A check the user asked for, with the result and whether the check itself was
 * recorded. It goes through the same single-flight path as the scheduled one, so
 * pressing the button during an automatic check on the same channel waits for
 * that result rather than asking the feed a second time, and it advances the
 * same cadence anchor: a manual check counts as today's check.
 *
 * The channel is the one in force now, not the one the last scheduled check
 * used, so a check started after the user moved channels asks the feed the user
 * is actually on.
 */
export async function checkForUpdateNow(
  host: DesktopUpdateHost & UpdatePrefsHost,
  now: number = Date.now(),
  channel: UpdateChannel = 'stable',
): Promise<{ readonly result: UpdateCheckResult; readonly persisted: boolean; readonly channel: UpdateChannel }> {
  const result = await checkDesktopUpdateOnce(host, now, channel);
  const persisted = await markUpdateChecked(now, host);
  return { result, persisted, channel };
}

// ---------------------------------------------------------------------------
// Single-flight check
// ---------------------------------------------------------------------------

/**
 * One check at a time per window, per channel.
 *
 * The channel is part of the key because the two feeds are different documents:
 * a cached stable result reused for a beta check would hand back a version the
 * user is not on, carrying an `install` handle the beta feed never described.
 * Two callers on the same channel share the in-flight promise rather than
 * issuing a second signed-feed request; a caller that arrives within the reuse
 * window gets the same answer instead of starting a fresh one.
 */
const inFlight = new Map<UpdateChannel, Promise<UpdateCheckResult>>();
const cached = new Map<UpdateChannel, { readonly at: number; readonly result: UpdateCheckResult }>();

/** How long a finished check is reused before a new one may start. */
const CACHE_TTL_MS = 30_000;

export interface DesktopUpdateHost {
  readonly supportsDesktopUpdates?: () => Promise<boolean>;
  readonly checkDesktopUpdate?: (channel: UpdateChannel) => Promise<DesktopUpdate | null>;
}

/**
 * What one check found. `unsupported` is a normal outcome for a distribution
 * without an updater; `failed` is separate so the About page can say the check
 * itself did not work rather than claiming the app is current.
 */
export type UpdateCheckResult =
  | { readonly kind: 'update'; readonly update: DesktopUpdate }
  | { readonly kind: 'current' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed' };

export function resetUpdateCheckCache(): void {
  inFlight.clear();
  cached.clear();
}

async function runCheck(host: DesktopUpdateHost, channel: UpdateChannel): Promise<UpdateCheckResult> {
  if (host.supportsDesktopUpdates === undefined) return { kind: 'unsupported' };
  let supported: boolean;
  try {
    supported = await host.supportsDesktopUpdates();
  } catch {
    return { kind: 'failed' };
  }
  if (!supported) return { kind: 'unsupported' };
  if (host.checkDesktopUpdate === undefined) return { kind: 'unsupported' };
  try {
    const update = await host.checkDesktopUpdate(channel);
    return update === null ? { kind: 'current' } : { kind: 'update', update };
  } catch {
    return { kind: 'failed' };
  }
}

/** Ask the host for this channel; concurrent callers share the complete settled promise. */
export function checkDesktopUpdateOnce(
  host: DesktopUpdateHost,
  now: number = Date.now(),
  channel: UpdateChannel = 'stable',
): Promise<UpdateCheckResult> {
  const running = inFlight.get(channel);
  if (running !== undefined) return running;
  const previous = cached.get(channel);
  if (previous !== undefined && now - previous.at < CACHE_TTL_MS) {
    return Promise.resolve(previous.result);
  }
  const settle = runCheck(host, channel).then((result) => {
    if (inFlight.get(channel) === settle) {
      inFlight.delete(channel);
      cached.set(channel, { at: now, result });
    }
    return result;
  });
  inFlight.set(channel, settle);
  return settle;
}
