import { useQuery } from '@tanstack/react-query';

import type { QueryClient } from '@tanstack/react-query';

import type { ExecutorCatalogItem } from '@kiki/protocol';
import { isNativeExecutor, NATIVE_EXECUTOR, profileExecutor } from '@kiki/session-core/composer';

import type { ExecutorCheckResult, NamedAgentProfile } from '../../../lib/client';
import { useConnection } from '../../../state/connection';

export const EXECUTORS_QUERY_KEY = ['executors'] as const;

/** Catalog checks belong to a connection scope and server incarnation; prefix invalidation still refreshes them. */
export function executorCatalogQueryKey(scopeId: string, serverId?: string) {
  return [...EXECUTORS_QUERY_KEY, scopeId, serverId] as const;
}

/**
 * The engine catalog (`GET /executors`): registered executors with their latest
 * checks, or unknown while unchecked. Empty while loading or on a server without
 * the route; callers then show raw ids.
 */
export function useExecutorCatalog(): readonly ExecutorCatalogItem[] {
  return useExecutorCatalogQuery().data?.items ?? [];
}

/** The same catalog query with its loading / error state (Settings › Connections). */
export function useExecutorCatalogQuery() {
  const { client, scopeId, meta } = useConnection();
  return useQuery({
    queryKey: executorCatalogQueryKey(scopeId, meta?.server_id),
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

/**
 * Engines a profile may newly choose: native, plus external engines explicitly
 * turned on. `retain` keeps the ids this profile or session is already bound
 * to, including hidden and unavailable ones, so the current value stays a
 * restore entry. Other profiles' engines are not added.
 */
export function engineChoices(
  _profiles: readonly NamedAgentProfile[],
  catalog: readonly ExecutorCatalogItem[],
  choice?: {
    readonly overrides?: Readonly<Record<string, unknown>>;
    readonly display?: Readonly<Record<string, unknown>>;
    readonly retain?: readonly string[];
  },
): string[] {
  const prefs = engineVisibilityOf(choice?.overrides, choice?.display);
  const ids = new Set<string>();
  if (prefs.externalsVisible) {
    for (const item of catalog) {
      if (item.id !== 'native' && prefs.enabled.has(item.id)) ids.add(item.id);
    }
  }
  for (const id of choice?.retain ?? []) {
    if (id !== '' && id !== 'native') ids.add(id);
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
 * Reads defensively. An absent per-engine flag is not a choice: only an
 * explicit `true` turns an external engine on, and only an explicit `false`
 * turns it off. An unknown shape is neither, so a preference this build does
 * not understand cannot hide an engine the user turned on or revive one they
 * turned off. `externals_visible: false` is the only global value that blocks
 * every external engine; an absent global section leaves the per-engine flags
 * in force and does not turn them all on.
 */
export interface EngineVisibilityPrefs {
  /** False blocks every external engine at once, whatever the per-engine flags say. */
  readonly externalsVisible: boolean;
  /** Per-engine opt-in. Absent is not a member. */
  readonly enabled: ReadonlySet<string>;
  /** Per-engine opt-out. Absent is not a member; a member stays off across refresh and re-import. */
  readonly disabled: ReadonlySet<string>;
}

export const DEFAULT_ENGINE_VISIBILITY: EngineVisibilityPrefs = {
  externalsVisible: true,
  enabled: new Set<string>(),
  disabled: new Set<string>(),
};

/** `true` or `false` when the user has said so; `undefined` when they have not. */
export function showInProfileListOf(
  overrides: Readonly<Record<string, unknown>> | undefined,
  id: string,
): boolean | undefined {
  const flag = asConfigRecord(overrides?.[id])?.['show_in_profile_list'];
  return flag === true ? true : flag === false ? false : undefined;
}

/**
 * Read the visibility choice off the two echoed records.
 *
 * The global switch defaults to open. A per-engine flag defaults to neither
 * on nor off.
 */
export function engineVisibilityOf(
  overrides: Readonly<Record<string, unknown>> | undefined,
  display: Readonly<Record<string, unknown>> | undefined = undefined,
): EngineVisibilityPrefs {
  const externalsVisible = display?.['externals_visible'] !== false;
  const enabled = new Set<string>();
  const disabled = new Set<string>();
  for (const [id, entry] of Object.entries(overrides ?? {})) {
    const flag = asConfigRecord(entry)?.['show_in_profile_list'];
    if (flag === true) enabled.add(id);
    else if (flag === false) disabled.add(id);
  }
  return { externalsVisible, enabled, disabled };
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
  const already = visible ? current.enabled.has(id) : current.disabled.has(id);
  if (already) return undefined;
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

/** Picker eligibility, not launch proof: pending discovery or login checks do not hide a registered engine. */
export function isRunnableEngine(
  item: ExecutorCatalogItem,
  overrides: Readonly<Record<string, unknown>> | undefined,
  descriptors?: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (isNativeExecutor(item.id)) return true;
  if (item.status === 'unavailable') return false;
  if (item.connection?.login_status === 'logged_in') return true;
  const descriptor = asConfigRecord(descriptors?.[item.id]);
  const apiKeyEnv = item.connection?.api_key_env;
  const env = { ...asConfigRecord(descriptor?.['env']), ...asConfigRecord(asConfigRecord(overrides?.[item.id])?.['env']) };
  const value = apiKeyEnv === undefined ? undefined : env[apiKeyEnv];
  if (typeof value === 'string' && value.trim() !== '') return true;
  return item.connection?.login_status !== 'logged_out';
}

/**
 * New execution choices: native, plus external engines the user has turned on
 * that can still be launched. An explicit off, a closed global switch, a
 * missing binary and a confirmed sign-out stay out. A profile binding is not
 * an on switch. Settings still lists the whole catalog.
 */
export function visibleEngines(
  catalog: readonly ExecutorCatalogItem[],
  _profiles: readonly NamedAgentProfile[],
  overrides: Readonly<Record<string, unknown>> | undefined,
  display?: Readonly<Record<string, unknown>> | undefined,
  descriptors?: Readonly<Record<string, unknown>> | undefined,
): readonly ExecutorCatalogItem[] {
  const prefs = engineVisibilityOf(overrides, display);
  return catalog.filter((item) => {
    if (item.id === NATIVE_EXECUTOR) return true;
    if (!prefs.externalsVisible || !prefs.enabled.has(item.id)) return false;
    return isRunnableEngine(item, overrides, descriptors);
  });
}

/** Success may turn an engine on only while the user has never said on or off. */
export function shouldAutoEnableEngine(
  overrides: Readonly<Record<string, unknown>> | undefined,
  id: string,
  status: ExecutorCheckResult['status'],
): boolean {
  return status !== 'unavailable' && showInProfileListOf(overrides, id) === undefined;
}

/** One engine's check, written into that scope's catalog cache and nowhere else. */
export function applyExecutorCheck(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  id: string,
  result: ExecutorCheckResult,
  checkedAt: string,
): void {
  queryClient.setQueryData(queryKey, (current: { readonly items?: readonly ExecutorCatalogItem[] } | undefined) => {
    if (current?.items === undefined) return current;
    return {
      ...current,
      items: current.items.map((item) => item.id === id ? mergeCheckedEngine(item, result, checkedAt) : item),
    };
  });
}

function mergeCheckedEngine(item: ExecutorCatalogItem, result: ExecutorCheckResult, checkedAt: string): ExecutorCatalogItem {
  const programFailed = result.requirements?.some((requirement) => requirement.role === 'program' && requirement.status !== 'ok') === true;
  const unavailable = result.status === 'unavailable' || programFailed;
  const connection = item.connection;
  return {
    ...item,
    status: unavailable ? 'unavailable' : 'ready',
    version: result.version ?? item.version,
    check_status: result.status,
    checked_at: checkedAt,
    check_stale: false,
    connection: {
      command: result.command || connection?.command,
      source: result.selected_source ?? connection?.source,
      install_hint: connection?.install_hint,
      login_command: connection?.login_command,
      api_key_env: connection?.api_key_env,
      login_status: result.login_status,
      credential_source: result.credential_source ?? connection?.credential_source,
      credential_detail: result.credential_detail ?? connection?.credential_detail,
      home_env: connection?.home_env,
      override: connection?.override,
      default_args: result.resolved_args.length > 0 ? [...result.resolved_args] : connection?.default_args ?? [],
    },
  };
}
