/**
 * Loads the connected server's appearance packs, registers their colors as
 * pack skins, and points the backdrop's media resolver at the pack file
 * route, so a pack selected on a previous launch repaints on this one.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { AppearancePack, AppearancePackSummary, SkinFile } from '@kiki/protocol';

import { useConnection } from '../../state/connection';
import { setBackdropMediaResolver } from './backdrop';
import { getMedia } from './mediaStore';
import { packSkinOf, parsePackMediaId } from './packs';
import { fetchPackFile, getAppearancePack, listAppearancePacks, type ServerEndpoint } from './packsApi';
import { effectiveSkinPrefs, setPackSkins, subscribeSkinPrefs } from './store';
import { isSkinNotFoundError, mapBounded, skinConnectionKey } from './useUserSkins';

const PACK_DETAIL_STALE_MS = 30_000;
const PACK_DETAIL_CONCURRENCY = 4;

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

export interface UseAppearancePacksOptions {
  /** Fetch every listed pack's detail (Settings → Appearance), not only the active selection. */
  readonly allDetails?: boolean;
}

const EMPTY_PACKS: readonly AppearancePackEntry[] = [];
const EMPTY_SKIPPED: readonly { file: string; reason: string }[] = [];

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

function selectedPackSkinIdSnapshot(): string | null {
  const { selection } = effectiveSkinPrefs();
  return selection.source === 'pack' ? selection.id : null;
}

function selectedPackSkinIdServerSnapshot(): string | null {
  return null;
}

export function useAppearancePacks(options: UseAppearancePacksOptions = {}): {
  data: AppearancePackCatalog;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
} {
  const { allDetails = false } = options;
  const connection = useConnection();
  const { wsStatus } = connection;
  const endpoint = useServerEndpoint();
  const connectionKey = skinConnectionKey(connection);
  const queryClient = useQueryClient();
  const selectedId = useSyncExternalStore(
    subscribeSkinPrefs,
    selectedPackSkinIdSnapshot,
    selectedPackSkinIdServerSnapshot,
  );

  const listQuery = useQuery({
    queryKey: ['appearance-packs', connectionKey, 'list'] as const,
    staleTime: PACK_DETAIL_STALE_MS,
    queryFn: async () => {
      const listing = await listAppearancePacks(endpoint);
      return listing ?? null;
    },
  });

  const targetSummaries = useMemo(() => {
    const listing = listQuery.data;
    if (listing === undefined || listing === null) return [] as readonly AppearancePackSummary[];
    if (allDetails) {
      const seen = new Set<string>();
      const unique: AppearancePackSummary[] = [];
      for (const item of listing.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        unique.push(item);
      }
      return unique;
    }
    if (selectedId !== null) {
      const found = listing.items.find((item) => item.id === selectedId);
      return found !== undefined ? [found] : ([] as readonly AppearancePackSummary[]);
    }
    return [] as readonly AppearancePackSummary[];
  }, [allDetails, listQuery.data, selectedId]);

  const targetKey = targetSummaries.map((summary) => summary.id).join('\0');
  const detailsQuery = useQuery({
    queryKey: ['appearance-packs', connectionKey, 'details', targetKey] as const,
    enabled: targetSummaries.length > 0,
    staleTime: PACK_DETAIL_STALE_MS,
    queryFn: async (): Promise<{ readonly packs: readonly AppearancePackEntry[]; readonly transientSelectedFailure: boolean }> => {
      let transientSelectedFailure = false;
      const resolved = await mapBounded(
        targetSummaries,
        PACK_DETAIL_CONCURRENCY,
        async (summary): Promise<AppearancePackEntry | null> => {
          try {
            const pack = await queryClient.fetchQuery({
              queryKey: ['appearance-packs', connectionKey, 'detail', summary.id] as const,
              staleTime: PACK_DETAIL_STALE_MS,
              queryFn: async (): Promise<AppearancePack | null> => {
                try {
                  return (await getAppearancePack(endpoint, summary.id)).pack;
                } catch (error) {
                  if (isSkinNotFoundError(error)) return null;
                  throw error;
                }
              },
            });
            return pack !== null ? { summary, pack } : null;
          } catch (error) {
            if (!allDetails) throw error;
            if (summary.id === selectedId) transientSelectedFailure = true;
            return null;
          }
        },
      );
      return {
        packs: resolved.filter((entry): entry is AppearancePackEntry => entry !== null),
        transientSelectedFailure,
      };
    },
  });

  const packs = targetSummaries.length === 0 ? EMPTY_PACKS : (detailsQuery.data?.packs ?? EMPTY_PACKS);

  const data = useMemo<AppearancePackCatalog>(() => {
    const listing = listQuery.data;
    if (listing === undefined) {
      return { packs: EMPTY_PACKS, directory: null, skipped: EMPTY_SKIPPED, unsupported: false };
    }
    if (listing === null) {
      return { packs: EMPTY_PACKS, directory: null, skipped: EMPTY_SKIPPED, unsupported: true };
    }
    return {
      packs,
      directory: listing.directory,
      skipped: listing.skipped,
      unsupported: false,
    };
  }, [listQuery.data, packs]);

  const detailsLoading = targetSummaries.length > 0 && detailsQuery.isPending;
  const detailsFailed = targetSummaries.length > 0 && (detailsQuery.isError || detailsQuery.data?.transientSelectedFailure === true);
  const isLoading = listQuery.isLoading || detailsLoading;

  useEffect(() => {
    setBackdropMediaResolver(mediaResolverFor(endpoint));
  }, [endpoint]);

  useEffect(() => {
    if (wsStatus !== 'open') return;
    if (listQuery.isError) void listQuery.refetch();
    if (detailsQuery.isError) void detailsQuery.refetch();
  }, [wsStatus, listQuery.isError, detailsQuery.isError, listQuery.refetch, detailsQuery.refetch]);

  useEffect(() => {
    if (listQuery.data === undefined || detailsLoading || detailsFailed) return;
    setPackSkins(data.packs.map((entry) => packSkinOf(entry.pack)).filter((skin): skin is SkinFile => skin !== null));
  }, [listQuery.data, detailsLoading, detailsFailed, data.packs]);

  return {
    data,
    isLoading,
    error: listQuery.error ?? detailsQuery.error,
    refetch: () => {
      void queryClient.invalidateQueries({ queryKey: ['appearance-packs', connectionKey] });
    },
  };
}
