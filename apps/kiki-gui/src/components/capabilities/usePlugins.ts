/**
 * One data layer for every plugin surface. The Capabilities page and the
 * settings Plugins leaf read the same query keys, so an install, toggle or
 * removal made in one is what the other shows.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { PluginUsageTarget } from '@kiki/protocol';

import type { PluginInfo, PluginMarketplaceEntry, PluginSummary } from '../../lib/client';
import { localizeEntry, type CatalogLocale } from '../../lib/pluginCatalog';
import { invalidatePluginQueries } from '../../lib/pluginFreshness';
import { useConnection, useOptionalConnection } from '../../state/connection';
import { scopeKey } from './pluginUsage';

export const PLUGIN_QUERY_KEYS = {
  installed: ['plugins'] as const,
  marketplace: ['plugin-marketplace'] as const,
  githubUpdates: ['plugin-github-updates'] as const,
  info: (id: string) => ['plugin', id] as const,
  recommendations: (signals: string) => ['plugin-recommendations', signals] as const,
  panels: (targetKey: string) => ['plugin-panels', targetKey] as const,
  commands: (targetKey: string) => ['plugin-commands', targetKey] as const,
  usage: (targetKey: string) => ['plugin-usage', targetKey] as const,
  panelDocument: (pluginId: string, panelId: string, targetKey: string) => ['plugin-panel-document', pluginId, panelId, targetKey] as const,
  skins: ['skins'] as const,
};

export function useInstalledPlugins() {
  const { client } = useConnection();
  return useQuery({
    queryKey: PLUGIN_QUERY_KEYS.installed,
    queryFn: () => client.listPlugins(),
    staleTime: 15_000,
  });
}

/**
 * The installed plugins, or an empty list where there is no connection to ask
 * (a settings tree mounted before a server is chosen, a test harness that has
 * no client at all). The settings navigation uses it because its job is to name
 * what can be opened, and "nothing is connected yet" is a truthful answer to
 * that rather than a reason to fail the whole navigation.
 *
 * It observes the installed list rather than merely reading it once. A reader
 * who arrives here before the list has loaded — by opening a plugin's own page
 * directly, say — would otherwise keep seeing an empty navigation until some
 * unrelated re-render happened to re-run the read; and a plugin removed or
 * turned off from the page beside it would leave a stale entry behind. The
 * observer issues no request of its own: `enabled: false` means it only reads
 * what whoever owns the fetch has already put in the cache.
 */
export function useOptionalInstalledPlugins(): { readonly plugins: readonly PluginSummary[] } {
  const connection = useOptionalConnection();
  const query = useQuery({
    queryKey: PLUGIN_QUERY_KEYS.installed,
    queryFn: () => connection!.client.listPlugins(),
    enabled: false,
    staleTime: 15_000,
  });
  return { plugins: query.data?.plugins ?? EMPTY_PLUGIN_LIST };
}

const EMPTY_PLUGIN_LIST: readonly PluginSummary[] = [];

export function usePluginMarketplace() {
  const { client } = useConnection();
  return useQuery({
    queryKey: PLUGIN_QUERY_KEYS.marketplace,
    queryFn: () => client.listPluginMarketplace(),
    staleTime: 30_000,
  });
}

/**
 * GitHub update check for GitHub-installed plugins. It asks GitHub for every
 * such plugin, so it runs only while a GitHub install exists, keeps its answer
 * for ten minutes, and never retries on its own: a failed check just means
 * no GitHub update is shown. Checking never installs.
 */
export function usePluginGithubUpdates(enabled: boolean) {
  const { client } = useConnection();
  return useQuery({
    queryKey: PLUGIN_QUERY_KEYS.githubUpdates,
    queryFn: () => client.checkPluginUpdates(),
    enabled,
    staleTime: 10 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function usePluginInfo(pluginId: string | undefined) {
  const { client } = useConnection();
  return useQuery({
    queryKey: PLUGIN_QUERY_KEYS.info(pluginId ?? ''),
    queryFn: () => client.getPlugin(pluginId!),
    enabled: pluginId !== undefined,
    staleTime: 15_000,
    retry: false,
  });
}

/**
 * Task-relevant suggestions. The server matches only official/curated entries
 * against signals the caller supplies (it never scans a workspace itself);
 * the GUI sends the workspace root it already knows.
 */
export function usePluginRecommendations(cwd: string | undefined) {
  const { client } = useConnection();
  return useQuery({
    queryKey: PLUGIN_QUERY_KEYS.recommendations(cwd ?? ''),
    queryFn: () => client.recommendPlugins({ cwd }),
    enabled: cwd !== undefined,
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Panels in a scope. The target is part of the key, so the workspace a panel
 * was opened for and the sidebar set can never answer each other's cache, and
 * closing one leaves nothing executable behind.
 */
export function usePluginPanels(target?: PluginUsageTarget) {
  const { client } = useConnection();
  const targetKey = scopeKey(target);
  return useQuery({
    queryKey: PLUGIN_QUERY_KEYS.panels(targetKey),
    queryFn: () => client.listPluginPanels(target),
    staleTime: 15_000,
    retry: false,
  });
}

/** Commands usable in the same scope as the panels. */
export function usePluginCommands(target?: PluginUsageTarget) {
  const { client } = useConnection();
  const targetKey = scopeKey(target);
  return useQuery({
    queryKey: PLUGIN_QUERY_KEYS.commands(targetKey),
    queryFn: () => client.listPluginCommands(target),
    staleTime: 15_000,
    retry: false,
  });
}

/** Skins the server lists; plugin skins carry `plugin.id`. */
export function usePluginSkins(pluginId: string | undefined) {
  const { client } = useConnection();
  const query = useQuery({
    queryKey: PLUGIN_QUERY_KEYS.skins,
    queryFn: () => client.listSkins(),
    enabled: pluginId !== undefined,
    staleTime: 30_000,
    retry: false,
  });
  return {
    ...query,
    skins: (query.data?.items ?? []).filter((item) => item.plugin?.id === pluginId),
  };
}

/**
 * Refresh every plugin surface after a change. `code: true` (an install,
 * update or rollback replaced the plugin's files) also re-asks GitHub for
 * updates; a toggle or removal does not cost a GitHub round-trip.
 *
 * What a plugin contributes is not only what the plugin list shows: agent
 * capabilities, the workspace skill catalog and the MCP server lists all move
 * with it, so they are re-read too. `event.plugin.changed` and a reconnect both
 * land here, which is why the capability query is included — leaving it out is
 * what made the rail keep naming tools that were already gone.
 */
export function useInvalidatePlugins() {
  const queryClient = useQueryClient();
  return async (options?: { readonly code?: boolean }) => {
    await Promise.all([
      ...(options?.code === true ? [queryClient.invalidateQueries({ queryKey: PLUGIN_QUERY_KEYS.githubUpdates })] : []),
      invalidatePluginQueries(queryClient),
    ]);
  };
}

/**
 * The item a detail view opens: an installed plugin, a catalog entry, or both
 * (installed from the catalog). Detail reads whichever exists.
 */
export interface PluginSubject {
  readonly id: string;
  readonly installed?: PluginSummary;
  readonly entry?: PluginMarketplaceEntry;
}

export function subjectName(subject: PluginSubject): string {
  return subject.installed?.displayName ?? subject.entry?.displayName ?? subject.id;
}

/**
 * The name to show for the reader's language. An installed plugin is named by
 * its own manifest, so only a catalog entry that is not installed yet can be
 * renamed by the catalog's localization — and only when the catalog supplied
 * one.
 */
export function localizedSubjectName(subject: PluginSubject, locale: CatalogLocale): string {
  if (subject.entry === undefined) return subjectName(subject);
  return subject.installed?.displayName ?? localizeEntry(subject.entry, locale).displayName;
}

export function subjectIcon(subject: PluginSubject, info?: PluginInfo): string | undefined {
  return info?.icon ?? subject.installed?.icon ?? subject.entry?.icon;
}
