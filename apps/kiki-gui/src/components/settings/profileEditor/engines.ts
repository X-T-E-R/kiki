import { useQuery } from '@tanstack/react-query';

import type { ExecutorCatalogItem } from '@kiki/protocol';
import { isNativeExecutor, NATIVE_EXECUTOR, profileExecutor } from '@kiki/session-core/composer';

import type { NamedAgentProfile } from '../../../lib/client';
import { useConnection } from '../../../state/connection';

export const EXECUTORS_QUERY_KEY = ['executors'] as const;

/**
 * The engine catalog (`GET /executors`): registered executors and whether each
 * one's binary was found. Empty while loading or on a server without the route;
 * callers then show raw ids.
 */
export function useExecutorCatalog(): readonly ExecutorCatalogItem[] {
  return useExecutorCatalogQuery().data?.items ?? [];
}

/** The same catalog query with its loading / error state (Settings › Connections). */
export function useExecutorCatalogQuery() {
  const { client } = useConnection();
  return useQuery({
    queryKey: EXECUTORS_QUERY_KEY,
    queryFn: () => client.listExecutors(),
    enabled: typeof client.listExecutors === 'function',
    staleTime: 60_000,
    retry: false,
  });
}

export function engineLabel(id: string | undefined, nativeLabel: string, catalog: readonly ExecutorCatalogItem[] = []): string {
  if (id === undefined || id === '' || id === 'native') return nativeLabel;
  return catalog.find((item) => item.id === id)?.label ?? id;
}

/**
 * One level of the config's free-form `raw` record, when it really is an
 * object. Config echoes several domains as untyped records, so every read of
 * one has to survive whatever the server sent.
 */
export function asConfigRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** The `agent_executor_overrides` record off a config response, if it has one. */
export function engineOverridesOf(config: { readonly raw?: unknown } | undefined): Readonly<Record<string, unknown>> | undefined {
  return asConfigRecord(asConfigRecord(config?.raw)?.['agent_executor_overrides']);
}

/** Engines the editor can offer: native, every catalog engine, and any id a loaded profile names. */
export function engineChoices(profiles: readonly NamedAgentProfile[], catalog: readonly ExecutorCatalogItem[]): string[] {
  const ids = new Set(catalog.map((item) => item.id).filter((id) => id !== 'native'));
  for (const profile of profiles) {
    if (profile.executor !== undefined && profile.executor !== 'native') ids.add(profile.executor);
  }
  return ['', ...[...ids].toSorted((a, b) => engineLabel(a, a, catalog).localeCompare(engineLabel(b, b, catalog)))];
}

/**
 * The display choice for external engines, read from the config's own record.
 *
 * This is a *visibility* preference, and the two levels are deliberately
 * separate. `[agent_executor_overrides.<id>]` already exists per engine and is
 * the natural home for a per-engine flag; a global switch lives beside them
 * under one reserved key so turning every engine off is a single value rather
 * than N writes that then have to be undone engine by engine.
 *
 * Display only. Nothing here removes an engine from the catalog the server
 * launches, and nothing here cancels a run: an engine the user stopped wanting
 * to see in a picker is still installed, still checkable in Settings, and still
 * runs whatever a session was already bound to. Only the list in the profile
 * and execution pickers reads it.
 *
 * Reads defensively. The section is a free-form record on the wire, so a value
 * that is absent, or present in a shape this build does not know, means "show" —
 * the failure mode of a preference is a hidden engine someone still uses, which
 * is worse than an engine they never chose to hide.
 */
export interface EngineVisibilityPrefs {
  /** False hides every external engine at once, whatever the per-engine flags say. */
  readonly externalsVisible: boolean;
  /** Per-engine opt-out, by executor id. Absent means visible. */
  readonly hidden: ReadonlySet<string>;
}

export const DEFAULT_ENGINE_VISIBILITY: EngineVisibilityPrefs = {
  externalsVisible: true,
  hidden: new Set<string>(),
};

/** Reserved id under `[agent_executor_overrides]` holding the global switch. */
export const EXTERNAL_VISIBILITY_KEY = '_external_engines';

type VisibilityFlag = unknown;

function flagValue(entry: unknown): VisibilityFlag {
  if (typeof entry !== 'object' || entry === null) return undefined;
  return (entry as Record<string, unknown>)['show_in_profile_list'];
}

/**
 * Read the visibility choice out of the raw `agent_executor_overrides` record
 * the config echoes. `undefined` sections and unknown shapes read as "show".
 */
export function engineVisibilityOf(
  overrides: Readonly<Record<string, unknown>> | undefined,
): EngineVisibilityPrefs {
  if (overrides === undefined) return DEFAULT_ENGINE_VISIBILITY;
  const hidden = new Set<string>();
  let externalsVisible = true;
  for (const [id, entry] of Object.entries(overrides)) {
    const flag = flagValue(entry);
    if (id === EXTERNAL_VISIBILITY_KEY) {
      // The global switch is stored as its own record, so the value is the
      // record itself rather than a field on it.
      externalsVisible = (entry as { externals_visible?: unknown } | undefined)?.externals_visible !== false;
      continue;
    }
    if (flag === false) hidden.add(id);
  }
  return externalsVisible ? { externalsVisible, hidden } : { externalsVisible, hidden };
}

/** The patch one toggle writes, for `client.patchConfig`. */
export function engineVisibilityPatch(
  current: EngineVisibilityPrefs,
  change: { externals?: boolean; engine?: { id: string; visible: boolean } },
): Record<string, unknown> | undefined {
  if (change.engine === undefined) {
    if (change.externals === undefined || change.externals === current.externalsVisible) return undefined;
    return {
      agent_executor_overrides: {
        [EXTERNAL_VISIBILITY_KEY]: { externals_visible: change.externals },
      },
    };
  }
  const { id, visible } = change.engine;
  // A per-engine flag only means anything while the global switch allows it;
  // otherwise the engine is hidden for a reason no per-engine value can fix.
  if (!current.externalsVisible && !visible) return undefined;
  if (current.hidden.has(id) === !visible) return undefined;
  return { agent_executor_overrides: { [id]: { show_in_profile_list: visible } } };
}

/**
 * Whether one engine may appear in a profile / execution picker.
 *
 * An engine is *configured* when the machine has actually set it up — a profile
 * bound to it, or an engine launch override. That is what makes an engine a
 * choice rather than a product name: offering "run Codex as it is" on a machine
 * that has never installed Codex offers a run that cannot work, and it buries
 * the engines that would.
 *
 * `default_profile` is deliberately *not* part of this. It is what the shipped
 * descriptor declares, so every engine has it from the start and it would
 * make the test true for all of them.
 */
export function isConfiguredEngine(
  id: string,
  profiles: readonly NamedAgentProfile[],
  overrides: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (isNativeExecutor(id)) return true;
  if (profiles.some((profile) => profileExecutor(profile) === id)) return true;
  // An override of any kind is a person pointing Kiki at this engine.
  if (overrides !== undefined) {
    const entry = overrides[id];
    if (typeof entry === 'object' && entry !== null && Object.keys(entry).length > 0) return true;
  }
  return false;
}

/**
 * The engines a profile / execution picker may show, in catalog order.
 *
 * Native always comes first and is never hidden — it is Kiki itself, not
 * something the user opted into. An external engine appears only when the
 * machine is actually set up for it and the display choice still allows it, so
 * the picker lists engines that can run rather than every engine Kiki knows
 * about. An engine the user hid is not removed from the catalog: Settings still
 * lists and checks it, and an existing session bound to it still runs it.
 */
export function visibleEngines(
  catalog: readonly ExecutorCatalogItem[],
  profiles: readonly NamedAgentProfile[],
  overrides: Readonly<Record<string, unknown>> | undefined,
): readonly ExecutorCatalogItem[] {
  const prefs = engineVisibilityOf(overrides);
  return catalog.filter((item) => {
    if (item.id === NATIVE_EXECUTOR) return true;
    if (!prefs.externalsVisible || prefs.hidden.has(item.id)) return false;
    return isConfiguredEngine(item.id, profiles, overrides);
  });
}
