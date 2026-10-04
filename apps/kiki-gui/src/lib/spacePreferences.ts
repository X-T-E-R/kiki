/**
 * Space preferences at the app level (design 2026-10-02 §6.1, §6.2).
 *
 * One space detail feeds two consumers that cannot read it themselves: the
 * desktop settings store, through the portable bridge it already exposes, and
 * the skin / background stores, through `spaceAuthority`. The bridge keeps
 * portable writes on the space path even while endpoint identity is unknown;
 * reads may use device values, but an unconfirmed target never writes them.
 * Server-qualified cached preferences load only once the endpoint is known.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  configureSpacePortableSettings,
  DEFAULT_DESKTOP_SETTINGS,
  readDeviceSettings,
  refreshSpacePortableSettings,
  type SpacePortableDesktopSettings,
} from '@kiki/session-core/settings';
import type { SpaceDetail, SpacePreferenceValues } from '@kiki/protocol';

import type { KikiClient } from './client';
import { DEFAULT_BACKGROUND_PREFS, readStoredBackgroundPrefs, spaceBackgroundOf } from './skins/background';
import { DEFAULT_SKIN_PREFS, readSkinPrefs, spaceTweaksOf } from './skins/store';
import {
  clearSpaceAuthority,
  configureSpaceAuthority,
  configureSpacePreferencePorts,
  spaceDeviceConflictResolved,
  importDevicePreferences,
  loadCachedSpacePreferences,
  markSpaceDeviceConflict,
  readSpacePreferenceDetail,
  resolveSpaceDeviceConflict,
  spacePreferenceValue,
  writeSpacePreferenceValues,
  spaceAuthorityServerSnapshot,
  spaceAuthoritySnapshot,
  spaceDeviceId,
  subscribeSpaceAuthority,
  writeSpacePreferenceItem,
  type SpaceAuthorityState,
  type SpaceIdentity,
} from './spaceAuthority';
import { spaceSettingsKeys, type SpacePreferenceItem, type SpaceSettingsTarget } from './spaceSettings';

export function useSpaceAuthorityState(): SpaceAuthorityState {
  return useSyncExternalStore(subscribeSpaceAuthority, spaceAuthoritySnapshot, spaceAuthorityServerSnapshot);
}

/**
 * What this device already had, in wire terms. Only the values a space may
 * carry: device habits (motion, shortcuts, notifications) stay behind, and a
 * background whose pictures live only here is left out rather than sent as a
 * value that would lose them.
 */
export function deviceSpacePreferences(): Partial<SpacePreferenceValues> {
  const settings = readDeviceSettings();
  const skin = readSkinPrefs();
  const background = spaceBackgroundOf(readStoredBackgroundPrefs());
  return {
    theme: settings.theme,
    proseFont: settings.proseFont,
    defaultAppendTiming: settings.defaultAppendTiming,
    foldSteps: settings.foldSteps,
    worktreeSkipConfirm: settings.worktreeSkipConfirm,
    skin: { source: skin.selection.source, id: skin.selection.id },
    tweaks: spaceTweaksOf(skin.tweaks),
    ...(background === undefined ? {} : { background }),
  };
}

/** The keys the design calls "this device's look" (design §6.1). */
const APPEARANCE_KEYS = ['theme', 'skin', 'tweaks', 'background', 'proseFont'] as const;

/** This device's own look only, for the conflict choice that asks about it. */
export function deviceAppearancePreferences(): Partial<SpacePreferenceValues> {
  const all = deviceSpacePreferences();
  return Object.fromEntries(APPEARANCE_KEYS.filter((key) => all[key] !== undefined).map((key) => [key, all[key]]));
}

/** True when this device's own look is not the one the space carries. */
export function deviceLookDiffers(space: SpacePreferenceValues): boolean {
  const device = deviceAppearancePreferences();
  return Object.entries(device).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(space[key as keyof SpacePreferenceValues]));
}

function differsFromDefaults(values: Partial<SpacePreferenceValues>): boolean {
  const defaults: Partial<SpacePreferenceValues> = {
    skin: DEFAULT_SKIN_PREFS.selection,
    tweaks: spaceTweaksOf(DEFAULT_SKIN_PREFS.tweaks),
    background: spaceBackgroundOf(DEFAULT_BACKGROUND_PREFS),
    theme: DEFAULT_DESKTOP_SETTINGS.theme,
    proseFont: DEFAULT_DESKTOP_SETTINGS.proseFont,
    defaultAppendTiming: DEFAULT_DESKTOP_SETTINGS.defaultAppendTiming,
    foldSteps: DEFAULT_DESKTOP_SETTINGS.foldSteps,
    worktreeSkipConfirm: DEFAULT_DESKTOP_SETTINGS.worktreeSkipConfirm,
  };
  return Object.entries(values).some(([key, value]) => (
    JSON.stringify(value) !== JSON.stringify(defaults[key as keyof SpacePreferenceValues])
  ));
}

function portableFromAuthority(): Partial<SpacePortableDesktopSettings> {
  const state = spaceAuthoritySnapshot();
  if (state.confirmed === null) return {};
  return {
    theme: spacePreferenceValue('theme'),
    proseFont: spacePreferenceValue('proseFont'),
    defaultAppendTiming: spacePreferenceValue('defaultAppendTiming'),
    foldSteps: spacePreferenceValue('foldSteps'),
    worktreeSkipConfirm: spacePreferenceValue('worktreeSkipConfirm'),
  };
}

/** The device-only items the portable bridge covers, for its write callback. */
const PORTABLE_ITEMS: readonly SpacePreferenceItem[] = [
  'theme', 'proseFont', 'defaultAppendTiming', 'foldSteps', 'worktreeSkipConfirm',
];

/**
 * Keep one space's preferences in step with the server: read the detail, hand
 * the values to the consumers above, and offer this device's older values to a
 * space that has never carried any.
 */
export function useSpacePreferencesFrame(target: SpaceSettingsTarget | null): void {
  const queryClient = useQueryClient();
  const client = target?.client ?? null;
  const identity = target?.identity ?? null;
  const spaceId = identity?.homeId ?? 'unidentified';
  const serverIdentity = identity?.serverId;
  const detail = useQuery({
    queryKey: [...spaceSettingsKeys.detail(spaceId), serverIdentity ?? 'unidentified'],
    queryFn: async ({ signal }) => {
      if (identity === null || client === null) throw new Error('Space server is unidentified');
      const next = await readSpacePreferenceDetail(client, identity);
      signal.throwIfAborted();
      return next;
    },
    enabled: identity !== null,
    staleTime: 30_000,
    retry: false,
  });
  const detailData = detail.data;

  useEffect(() => subscribeSpaceAuthority(() => { refreshSpacePortableSettings(); }), []);
  useEffect(() => {
    clearSpaceAuthority();
    if (identity !== null) loadCachedSpacePreferences(identity.homeId, identity.serverId);
    return () => { clearSpaceAuthority(); };
  }, [client, serverIdentity, spaceId]);

  useEffect(() => {
    configureSpacePortableSettings({
      read: portableFromAuthority,
      write: (patch) => {
        for (const item of PORTABLE_ITEMS) {
          const value = patch[item as keyof SpacePortableDesktopSettings];
          if (value === undefined) continue;
          void writeSpacePreferenceItem(item, value as never);
        }
      },
    });
    return () => { configureSpacePortableSettings(undefined); };
  }, []);

  useEffect(() => {
    configureSpacePreferencePorts({
      client: () => client,
      spaceId: () => spaceId,
      identity: () => identity,
      onDetail: (next: SpaceDetail) => { queryClient.setQueryData([...spaceSettingsKeys.detail(spaceId), serverIdentity ?? 'unidentified'], next); },
    });
    return () => { configureSpacePreferencePorts(undefined); };
  }, [queryClient, client, spaceId, serverIdentity]);

  useEffect(() => {
    if (identity === null || client === null || detailData === undefined) return;
    const first = !spaceDeviceConflictResolved(identity);
    configureSpaceAuthority(identity, detailData);
    if (detailData.preference_authority) {
      if (first && deviceLookDiffers(detailData.preferences)) markSpaceDeviceConflict();
      return;
    }
    const device = deviceSpacePreferences();
    if (!differsFromDefaults(device)) return;
    void importDevicePreferences(client, identity, spaceDeviceId(), device);
  }, [client, serverIdentity, spaceId, detailData]);
}

/**
 * The second explicit choice of §6.2 step three: this device's appearance
 * becomes the space's. A preview and an apply like every other change — two
 * options, never a silent overwrite.
 */
export async function applyDeviceAppearanceToSpace(client: KikiClient, identity: SpaceIdentity): Promise<boolean> {
  const saved = await writeSpacePreferenceValues(client, identity, deviceAppearancePreferences());
  if (saved) resolveSpaceDeviceConflict(identity);
  return saved;
}
