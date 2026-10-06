/**
 * One data layer for every plugin surface. The Capabilities page and the
 * settings Plugins leaf read the same query keys, so an install, toggle or
 * removal made in one is what the other shows.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { PluginInfo, PluginMarketplaceEntry, PluginSummary } from '../../lib/client';
import { localizeEntry, type CatalogLocale } from '../../lib/pluginCatalog';
import { useConnection } from '../../state/connection';

export const PLUGIN_QUERY_KEYS = {
  installed: ['plugins'] as const,
  marketplace: ['plugin-marketplace'] as const,
  githubUpdates: ['plugin-github-updates'] as const,
  info: (id: string) => ['plugin', id] as const,
  recommendations: (signals: string) => ['plugin-recommendations', signals] as const,
  panels: ['plugin-panels'] as const,
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

export function usePluginPanels() {
  const { client } = useConnection();
  return useQuery({
    queryKey: PLUGIN_QUERY_KEYS.panels,
    queryFn: () => client.listPluginPanels(),
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
 */
export function useInvalidatePlugins() {
  const queryClient = useQueryClient();
  return async (options?: { readonly code?: boolean }) => {
    await Promise.all([
      ...(options?.code === true ? [queryClient.invalidateQueries({ queryKey: PLUGIN_QUERY_KEYS.githubUpdates })] : []),
      queryClient.invalidateQueries({ queryKey: PLUGIN_QUERY_KEYS.installed }),
      queryClient.invalidateQueries({ queryKey: PLUGIN_QUERY_KEYS.marketplace }),
      queryClient.invalidateQueries({ queryKey: ['plugin'] }),
      queryClient.invalidateQueries({ queryKey: ['plugin-recommendations'] }),
      queryClient.invalidateQueries({ queryKey: PLUGIN_QUERY_KEYS.panels }),
      queryClient.invalidateQueries({ queryKey: PLUGIN_QUERY_KEYS.skins }),
      queryClient.invalidateQueries({ queryKey: ['workspace-skills'] }),
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] }),
      queryClient.invalidateQueries({ queryKey: ['mcp-managed-servers'] }),
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
