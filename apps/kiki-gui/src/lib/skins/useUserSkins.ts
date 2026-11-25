/**
 * Loads the connected server's user skin files into the skin store.
 *
 * Two-step on purpose: the list route returns summaries (cheap, one directory
 * scan), and only the skins needed right now get their full token set fetched —
 * the selected skin at app start, and every listed skin once Settings →
 * Appearance opens.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { SkinFile, SkinPluginOrigin } from '@kiki/protocol';

import { useConnection } from '../../state/connection';
import { effectiveSkinPrefs, setUserSkins, subscribeSkinPrefs } from './store';

const SKIN_DETAIL_STALE_MS = 30_000;
const SKIN_DETAIL_CONCURRENCY = 4;

export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

export interface UserSkinCatalog {
  readonly skins: readonly SkinFile[];
  /** Skin id → contributing plugin, for skins served from enabled plugins. */
  readonly plugins: Readonly<Record<string, SkinPluginOrigin>>;
  readonly directory: string | null;
  readonly skipped: readonly { file: string; reason: string }[];
  /** True when the connected server is too old to expose the skin routes. */
  readonly unsupported: boolean;
}

export interface UseUserSkinsOptions {
  /** Fetch every listed skin's detail (Settings → Appearance), not only the active selection. */
  readonly allDetails?: boolean;
}

const EMPTY_SKINS: readonly SkinFile[] = [];
const EMPTY_PLUGINS: Readonly<Record<string, SkinPluginOrigin>> = {};
const EMPTY_SKIPPED: readonly { file: string; reason: string }[] = [];

function selectedUserSkinIdSnapshot(): string | null {
  const { selection } = effectiveSkinPrefs();
  return selection.source === 'user' ? selection.id : null;
}

function selectedUserSkinIdServerSnapshot(): string | null {
  return null;
}

export function useUserSkins(options: UseUserSkinsOptions = {}): {
  data: UserSkinCatalog;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
} {
  const { allDetails = false } = options;
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const selectedId = useSyncExternalStore(
    subscribeSkinPrefs,
    selectedUserSkinIdSnapshot,
    selectedUserSkinIdServerSnapshot,
  );

  const listQuery = useQuery({
    queryKey: ['skins', 'list'],
    staleTime: SKIN_DETAIL_STALE_MS,
    queryFn: async () => {
      const listing = await client.listSkins();
      return listing ?? null;
    },
  });

  const targetIds = useMemo(() => {
    const listing = listQuery.data;
    if (listing === undefined || listing === null) return [] as readonly string[];
    if (allDetails) return [...new Set(listing.items.map((item) => item.id))];
    if (selectedId !== null && listing.items.some((item) => item.id === selectedId)) {
      return [selectedId];
    }
    return [] as readonly string[];
  }, [allDetails, listQuery.data, selectedId]);

  const targetKey = targetIds.join('\0');
  const detailsQuery = useQuery({
    queryKey: ['skins', 'details', targetKey] as const,
    enabled: targetIds.length > 0,
    staleTime: SKIN_DETAIL_STALE_MS,
    queryFn: async (): Promise<readonly SkinFile[]> => {
      const resolved = await mapBounded(targetIds, SKIN_DETAIL_CONCURRENCY, async (id): Promise<SkinFile | null> => {
        try {
          return await queryClient.fetchQuery({
            queryKey: ['skins', 'detail', id] as const,
            staleTime: SKIN_DETAIL_STALE_MS,
            queryFn: async (): Promise<SkinFile | null> => {
              try {
                return (await client.getSkin(id)).skin;
              } catch {
                // A file that vanished between list and read is not an error worth
                // failing the whole catalog for.
                return null;
              }
            },
          });
        } catch {
          return null;
        }
      });
      return resolved.filter((file): file is SkinFile => file !== null);
    },
  });

  const skins = targetIds.length === 0 ? EMPTY_SKINS : (detailsQuery.data ?? EMPTY_SKINS);

  const data = useMemo<UserSkinCatalog>(() => {
    const listing = listQuery.data;
    if (listing === undefined) {
      return {
        skins: EMPTY_SKINS,
        plugins: EMPTY_PLUGINS,
        directory: null,
        skipped: EMPTY_SKIPPED,
        unsupported: false,
      };
    }
    if (listing === null) {
      return {
        skins: EMPTY_SKINS,
        plugins: EMPTY_PLUGINS,
        directory: null,
        skipped: EMPTY_SKIPPED,
        unsupported: true,
      };
    }
    const plugins: Record<string, SkinPluginOrigin> = {};
    for (const summary of listing.items) {
      if (summary.plugin !== undefined) plugins[summary.id] = summary.plugin;
    }
    return {
      skins,
      plugins,
      directory: listing.directory,
      skipped: listing.skipped,
      unsupported: false,
    };
  }, [listQuery.data, skins]);

  const detailsLoading = targetIds.length > 0 && detailsQuery.isPending;
  const isLoading = listQuery.isLoading || detailsLoading;

  // Push into the store once any needed detail query has settled, so a cold
  // start does not wipe the selected skin's localStorage paint cache while the
  // selected skin's detail request is still in flight.
  useEffect(() => {
    if (listQuery.data === undefined || detailsLoading) return;
    setUserSkins(data.skins, data.directory);
  }, [listQuery.data, detailsLoading, data.skins, data.directory]);

  return {
    data,
    isLoading,
    error: listQuery.error,
    refetch: () => {
      void queryClient.invalidateQueries({ queryKey: ['skins'] });
    },
  };
}
