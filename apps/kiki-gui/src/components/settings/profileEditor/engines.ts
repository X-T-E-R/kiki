import { useQuery } from '@tanstack/react-query';

import type { ExecutorCatalogItem } from '@kiki/protocol';
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

/** Engines the editor can offer: native, every catalog engine, and any id a loaded profile names. */
export function engineChoices(profiles: readonly NamedAgentProfile[], catalog: readonly ExecutorCatalogItem[]): string[] {
  const ids = new Set(catalog.map((item) => item.id).filter((id) => id !== 'native'));
  for (const profile of profiles) {
    if (profile.executor !== undefined && profile.executor !== 'native') ids.add(profile.executor);
  }
  return ['', ...[...ids].toSorted((a, b) => engineLabel(a, a, catalog).localeCompare(engineLabel(b, b, catalog)))];
}
