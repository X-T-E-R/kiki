/**
 * Loads the connected server's appearance packs, registers their colors as
 * pack skins, and points the backdrop's media resolver at the pack file
 * route, so a pack selected on a previous launch repaints on this one.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import type { AppearancePack, AppearancePackSummary, SkinFile } from '@kiki/protocol';

import { useConnection } from '../../state/connection';
import { setBackdropMediaResolver } from './backdrop';
import { getMedia } from './mediaStore';
import { packSkinOf, parsePackMediaId } from './packs';
import { fetchPackFile, getAppearancePack, listAppearancePacks, type ServerEndpoint } from './packsApi';
import { setPackSkins } from './store';

export interface AppearancePackEntry {
  readonly summary: AppearancePackSummary;
  readonly pack: AppearancePack;
}

export interface AppearancePackCatalog {
  readonly packs: readonly AppearancePackEntry[];
  readonly directory: string | null;
  readonly skipped: readonly { file: string; reason: string }[];
  readonly unsupported: boolean;
}

const EMPTY: AppearancePackCatalog = { packs: [], directory: null, skipped: [], unsupported: false };

export function useServerEndpoint(): ServerEndpoint {
  const { config } = useConnection();
  return useMemo(() => ({ url: config.url, token: config.token }), [config.url, config.token]);
}

/** Media bytes for any ref: `pack:` ids from the server, the rest from this device. */
export function mediaResolverFor(endpoint: ServerEndpoint) {
  const cache = new Map<string, Promise<Blob | null>>();
  return (ref: { id: string }) => {
    const pack = parsePackMediaId(ref.id);
    if (pack === null) return getMedia(ref.id);
    let pending = cache.get(ref.id);
    if (pending === undefined) {
      pending = fetchPackFile(endpoint, pack.packId, pack.file).catch(() => null);
      cache.set(ref.id, pending);
      void pending.then((blob) => { if (blob === null) cache.delete(ref.id); });
    }
    return pending;
  };
}

export function useAppearancePacks(): {
  data: AppearancePackCatalog;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
} {
  const endpoint = useServerEndpoint();

  const query = useQuery({
    queryKey: ['appearance-packs', endpoint.url],
    staleTime: 30_000,
    queryFn: async (): Promise<AppearancePackCatalog> => {
      const listing = await listAppearancePacks(endpoint);
      if (listing === undefined) return { ...EMPTY, unsupported: true };
      const packs = await Promise.all(listing.items.map(async (summary) => {
        try {
          return { summary, pack: (await getAppearancePack(endpoint, summary.id)).pack };
        } catch {
          return null;
        }
      }));
      return {
        packs: packs.filter((entry): entry is AppearancePackEntry => entry !== null),
        directory: listing.directory,
        skipped: listing.skipped,
        unsupported: false,
      };
    },
  });

  useEffect(() => {
    setBackdropMediaResolver(mediaResolverFor(endpoint));
  }, [endpoint]);

  useEffect(() => {
    if (query.data === undefined) return;
    setPackSkins(query.data.packs.map((entry) => packSkinOf(entry.pack)).filter((skin): skin is SkinFile => skin !== null));
  }, [query.data]);

  return {
    data: query.data ?? EMPTY,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => { void query.refetch(); },
  };
}
