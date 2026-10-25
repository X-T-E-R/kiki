/**
 * What work modes this home offers, and which one this window is in.
 *
 * The server owns the truth: a mode the user never enabled is not available
 * here, and a mode they removed is not quietly reinstated by reading this
 * list. `resolveWindowMode` reconciles the window's stored preference against
 * that answer, so a removed mode falls back to the baseline instead of
 * showing a surface whose packages are gone.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type { WorkPresetItem } from '@kiki/protocol';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../i18n';
import { BASE_MODE_ID, readWindowModeId, subscribeWorkMode, windowIdOf, writeWindowModeId } from './workModes';

export const workModeKeys = { all: ['work-presets'] as const };

/** The `meta` answer the client reports; the flag table is optional. */
export interface ExperimentalFlagsMeta {
  readonly experimental_flags?: Record<string, boolean>;
}

/**
 * The server's own flag (`KIKI_EXPERIMENTAL_WORK_PRESETS`). Work modes are
 * still being built, so their entry points appear only where the host says they
 * do. The flag gates the entry, not the file preview, which is useful whether
 * or not any mode is on. A host that does not report the field has no Work
 * modes, which is the same answer as reporting it off.
 */
export function workPresetsEnabled(meta: ExperimentalFlagsMeta | undefined): boolean {
  return meta?.experimental_flags?.['work_presets'] === true;
}

export interface WorkModeCatalog {
  readonly status: 'loading' | 'ready' | 'failed';
  readonly homeId?: string;
  readonly items: readonly WorkPresetItem[];
  readonly error?: string;
  readonly reload: () => void;
}

/** The baseline mode, plus every mode this home has enabled and kept. */
export function availableModes(items: readonly WorkPresetItem[]): readonly WorkPresetItem[] {
  return items.filter((item) => !item.removed);
}

export function findMode(items: readonly WorkPresetItem[], id: string): WorkPresetItem | undefined {
  return items.find((item) => item.id === id);
}

/** The mode this window shows, given what the home actually has. */
export function resolveWindowMode(items: readonly WorkPresetItem[]): WorkPresetItem | undefined {
  const stored = readWindowModeId();
  const available = availableModes(items);
  return findMode(available, stored) ?? findMode(available, BASE_MODE_ID) ?? available[0];
}

/** The mode a new window on this home should open in. */
export function defaultModeId(items: readonly WorkPresetItem[]): string {
  return resolveWindowMode(items)?.id ?? BASE_MODE_ID;
}

/**
 * Read the catalog once per client and keep it fresh. A failed read is a real
 * state, not an empty list: the picker then says it could not load instead of
 * claiming a home has no modes.
 */
export function useWorkModes(client: { listWorkPresets: () => Promise<{ home_id: string; items: WorkPresetItem[] }> } | undefined, enabled = true): WorkModeCatalog {
  const { locale } = useI18n();
  const [state, setState] = useState<{ generation: number; value: { homeId?: string; items: readonly WorkPresetItem[]; error?: string } | undefined; failed: boolean }>({ generation: 0, value: undefined, failed: false });

  useEffect(() => {
    if (client === undefined || !enabled) return;
    let cancelled = false;
    const generation = state.generation;
    client.listWorkPresets().then((response) => {
      if (cancelled || generation !== state.generation) return;
      setState({ generation, value: { homeId: response.home_id, items: response.items }, failed: false });
    }, (error: unknown) => {
      if (cancelled || generation !== state.generation) return;
      setState({ generation, value: { items: [], error: errorText(locale, error) }, failed: true });
    });
    return () => { cancelled = true; };
  }, [client, enabled, locale, state.generation]);

  const reload = useCallback(() => { setState((previous) => ({ generation: previous.generation + 1, value: undefined, failed: false })); }, []);

  return useMemo(() => ({
    status: state.value === undefined ? 'loading' : state.failed ? 'failed' : 'ready',
    homeId: state.value?.homeId,
    items: state.value?.items ?? [],
    error: state.value?.error,
    reload,
  }), [reload, state.failed, state.value]);
}

/** This window's mode id, re-rendered when it changes or another window writes. */
export function useWindowModeId(): [string, (next: string) => void] {
  const modeId = useSyncExternalStore(subscribeWorkMode, readWindowModeId, readWindowModeId);
  return [modeId, writeWindowModeId];
}

/** Identity of this window, for a label that distinguishes two windows. */
export function useWindowTag(): { windowId: string; modeId: string } {
  const [modeId] = useWindowModeId();
  return useMemo(() => ({ windowId: windowIdOf(), modeId }), [modeId]);
}
