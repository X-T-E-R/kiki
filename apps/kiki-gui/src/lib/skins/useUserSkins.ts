/**
 * Loads the connected server's user skin files into the skin store.
 *
 * Two-step on purpose: the list route returns summaries (cheap, one directory
 * scan), and only the skins the user can actually select get their full token
 * set fetched. In practice a themes directory holds a handful of files, so
 * this fetches them all — but the shape stays correct if someone keeps fifty.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import type { SkinFile, SkinPluginOrigin } from '@kiki/protocol';

import { useConnection } from '../../state/connection';
import { setUserSkins } from './store';

export interface UserSkinCatalog {
  readonly skins: readonly SkinFile[];
  /** Skin id → contributing plugin, for skins served from enabled plugins. */
  readonly plugins: Readonly<Record<string, SkinPluginOrigin>>;
  readonly directory: string | null;
  readonly skipped: readonly { file: string; reason: string }[];
  /** True when the connected server is too old to expose the skin routes. */
  readonly unsupported: boolean;
}

const EMPTY: UserSkinCatalog = {
  skins: [],
  plugins: {},
  directory: null,
  skipped: [],
  unsupported: false,
};

export function useUserSkins(): {
  data: UserSkinCatalog;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
} {
  const { client } = useConnection();

  const query = useQuery({
    queryKey: ['skins'],
    staleTime: 30_000,
    queryFn: async (): Promise<UserSkinCatalog> => {
      const listing = await client.listSkins();
      if (listing === undefined) return { ...EMPTY, unsupported: true };
      const files = await Promise.all(
        listing.items.map(async (summary) => {
          try {
            return (await client.getSkin(summary.id)).skin;
          } catch {
            // A file that vanished between list and read is not an error worth
            // failing the whole catalog for.
            return null;
          }
        }),
      );
      const plugins: Record<string, SkinPluginOrigin> = {};
      for (const summary of listing.items) if (summary.plugin !== undefined) plugins[summary.id] = summary.plugin;
      return {
        skins: files.filter((file): file is SkinFile => file !== null),
        plugins,
        directory: listing.directory,
        skipped: listing.skipped,
        unsupported: false,
      };
    },
  });

  // Push into the store so the document-level sync (which has no React
  // context) can resolve a `user` selection.
  useEffect(() => {
    if (query.data === undefined) return;
    setUserSkins(query.data.skins, query.data.directory);
  }, [query.data]);

  return {
    data: query.data ?? EMPTY,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => { void query.refetch(); },
  };
}
