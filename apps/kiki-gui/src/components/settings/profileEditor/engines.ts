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

/** The `agent_executor_display` record off a config response, if it has one. */
export function engineDisplayOf(config: { readonly raw?: unknown } | undefined): Readonly<Record<string, unknown>> | undefined {
  return asConfigRecord(asConfigRecord(config?.raw)?.['agent_executor_display']);
}

/** The user-authored `agent_executors` descriptors off a config response, if any. */
export function configuredEngineDescriptors(config: { readonly raw?: unknown } | undefined): Readonly<Record<string, unknown>> | undefined {
  return asConfigRecord(asConfigRecord(config?.raw)?.['agent_executors']);
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
 * The display choice for external engines, read from the two records the server
 * echoes.
 *
 * The two levels are separate records, not one. A per-engine flag rides in the
 * existing `[agent_executor_overrides.<id>]` entry beside that engine's launch
 * fields; the global switch is its own `[agent_executor_display]` section,
 * because turning every engine off is one value rather than N writes that then
 * have to be undone engine by engine — and because a reserved key inside the
 * overrides map would be a fake executor id the rest of the config would have
 * to learn to ignore.
 *
 * Display only. Nothing here removes an engine from the catalog the server
 * launches, changes its descriptor or revision, or cancels a run: an engine the
 * user stopped wanting to see in a picker is still installed, still checkable in
 * Settings, and still runs whatever a session was already bound to. Only the
 * list in the profile and execution pickers reads it.
 *
 * Reads defensively. Both sections are free-form records on the wire, so an
 * absent value — or one in a shape this build does not know — means "show". The
 * failure mode of a preference is a hidden engine someone still uses, which is
 * worse than an engine they never chose to hide.
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

/**
 * Read the visibility choice off the two echoed records. Both are optional, and
 * both read as "show" when absent.
 */
export function engineVisibilityOf(
  overrides: Readonly<Record<string, unknown>> | undefined,
  display: Readonly<Record<string, unknown>> | undefined = undefined,
): EngineVisibilityPrefs {
  // `externals_visible: false` is the only value that changes anything; an
  // absent section is an empty `{}` on the server, which is also "show".
  const externalsVisible = display?.['externals_visible'] !== false;
  const hidden = new Set<string>();
  for (const [id, entry] of Object.entries(overrides ?? {})) {
    if (asConfigRecord(entry)?.['show_in_profile_list'] === false) hidden.add(id);
  }
  return { externalsVisible, hidden };
}

/**
 * The patch one toggle writes, for `client.patchConfig`.
 *
 * `false` and `null` are both offered so the two records read the way the server
 * expects them: a per-engine flag clears with `null`, and the global switch
 * clears with `false` to mean "not set" — which resolves to the default.
 */
export function engineVisibilityPatch(
  current: EngineVisibilityPrefs,
  change: { externals?: boolean; engine?: { id: string; visible: boolean } },
): Record<string, unknown> | undefined {
  if (change.engine === undefined) {
    if (change.externals === undefined || change.externals === current.externalsVisible) return undefined;
    return { agent_executor_display: { externals_visible: change.externals } };
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
 * An engine is *configured* when the machine has actually set it up. That is
 * what makes an engine a choice rather than a product name: offering "run Codex
 * as it is" on a machine that has never installed Codex offers a run that
 * cannot work, and it buries the engines that would.
 *
 * Three facts count, and each is a thing a person actually did:
 *  - a profile is bound to the engine;
 *  - the engine's override carries a real launch field or its `defaults` block
 *    — a path, a working directory, flags, environment variables, or the
 *    per-engine defaults;
 *  - the user wrote a `[agent_executors.<id>]` descriptor of their own, which is
 *    an engine they configured rather than one Kiki ships.
 *
 * Two things deliberately do *not* count. `default_profile` is what the shipped
 * descriptor declares, so every engine has it from the start. And
 * `show_in_profile_list` is a display preference: its presence says the user
 * looked at this engine's visibility, not that the engine exists on this
 * machine, so counting it would make hiding an engine the thing that
 * "configures" it.
 */
export function isConfiguredEngine(
  id: string,
  profiles: readonly NamedAgentProfile[],
  overrides: Readonly<Record<string, unknown>> | undefined,
  descriptors?: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (isNativeExecutor(id)) return true;
  if (profiles.some((profile) => profileExecutor(profile) === id)) return true;
  if (descriptors !== undefined && asConfigRecord(descriptors[id]) !== undefined) return true;
  const entry = asConfigRecord(overrides?.[id]);
  if (entry === undefined) return false;
  // Any key other than the display preference is a real configuration act.
  return Object.keys(entry).some((key) => key !== 'show_in_profile_list');
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
  display?: Readonly<Record<string, unknown>> | undefined,
  descriptors?: Readonly<Record<string, unknown>> | undefined,
): readonly ExecutorCatalogItem[] {
  const prefs = engineVisibilityOf(overrides, display);
  return catalog.filter((item) => {
    if (item.id === NATIVE_EXECUTOR) return true;
    if (!prefs.externalsVisible || prefs.hidden.has(item.id)) return false;
    return isConfiguredEngine(item.id, profiles, overrides, descriptors);
  });
}
