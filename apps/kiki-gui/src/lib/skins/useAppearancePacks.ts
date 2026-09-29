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

/**
 * Pack files kept in memory, oldest dropped first once past this many bytes.
 * Enough for one pack video at the size ceiling plus its pictures; a file
 * already on screen stays alive through its object URL regardless.
 */
export const PACK_MEDIA_CACHE_BYTES = 128 * 1024 * 1024;

type PackMediaResolver = (ref: { id: string }) => Promise<Blob | null>;

let shared: { key: string; resolve: PackMediaResolver } | null = null;

/**
 * Media bytes for any ref: `pack:` ids from the server, the rest from this
 * device. One resolver per server: every `useAppearancePacks` mount (app
 * shell, settings page, skin picker) gets the same one, so opening settings
 * neither re-downloads a pack video nor keeps a second copy of it.
 */
export function mediaResolverFor(endpoint: ServerEndpoint): PackMediaResolver {
  const key = `${endpoint.url}\n${endpoint.token}`;
  if (shared?.key === key) return shared.resolve;
  const cache = new Map<string, { pending: Promise<Blob | null>; bytes: number }>();
  const trim = () => {
    let total = 0;
    for (const entry of cache.values()) total += entry.bytes;
    for (const [id, entry] of cache) {
      if (total <= PACK_MEDIA_CACHE_BYTES || cache.size <= 1) break;
      cache.delete(id);
      total -= entry.bytes;
    }
  };
  const resolve: PackMediaResolver = (ref) => {
    const pack = parsePackMediaId(ref.id);
    if (pack === null) return getMedia(ref.id);
    const hit = cache.get(ref.id);
    if (hit !== undefined) {
      // Refresh recency.
      cache.delete(ref.id);
      cache.set(ref.id, hit);
      return hit.pending;
    }
    const entry = { pending: fetchPackFile(endpoint, pack.packId, pack.file).catch(() => null), bytes: 0 };
    cache.set(ref.id, entry);
    void entry.pending.then((blob) => {
      if (cache.get(ref.id) !== entry) return;
      if (blob === null) {
        cache.delete(ref.id);
        return;
      }
      entry.bytes = blob.size;
      trim();
    });
    return entry.pending;
  };
  shared = { key, resolve };
  return resolve;
}

/** Forget the shared resolver (tests). */
export function resetPackMediaResolver(): void {
  shared = null;
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
