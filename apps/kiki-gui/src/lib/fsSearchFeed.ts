/**
 * Paged workspace file search for the ＋ menu and the `@` picker.
 *
 * The server returns one bounded page (`sort_scope: 'page'`) and a
 * `next_cursor`. This feed never walks that cursor on its own: the first page
 * loads when the search is enabled, and another page loads only through
 * `loadMore` (the continue row, or the mention list reaching its end). An
 * empty page with a cursor is unfinished work, not a miss. Pages stay in
 * arrival order until the cursor is gone; only the exhausted chain is merged
 * into global order (score descending, path ascending; directories first when
 * the query is empty). A changed query, a closed surface, or a newer page
 * drops the previous request so its rows cannot append. Entering a stale
 * chain again — reopening it, or returning to its query or scope while the
 * menu stays open — starts at the first page. Pages already continued are
 * not scanned again until the reader asks. A chain that stays on screen
 * keeps those pages when it becomes stale.
 */

import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';

import type { FsSearchHit } from '@kiki/protocol';

/** Wire code for an invalid or stale search cursor (directory generation changed). */
export const FS_SEARCH_STALE_CURSOR = 40001;

export const FS_SEARCH_FEED_KEY = 'fs-search-feed';

const FS_SEARCH_FEED_STALE_MS = 30_000;

function chainIdentity(scopeKey: string, query: string): string {
  return `${scopeKey.length}:${scopeKey}/${query}`;
}

export interface FsSearchPageArgs {
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

/** Filters that must be identical on the first page and every continuation. */
export interface FsSearchFeedFilters {
  readonly limit?: number;
  readonly include_globs?: readonly string[];
  readonly exclude_globs?: readonly string[];
  readonly follow_gitignore?: boolean;
}

export interface FsSearchWirePage {
  readonly items: readonly FsSearchHit[];
  readonly nextCursor?: string;
  readonly next_cursor?: string;
  readonly truncated?: boolean;
  readonly sortScope?: 'page';
  readonly sort_scope?: 'page';
}

/** A legacy caller still resolves the hit list and drops the cursor. */
export type FsSearchFeedResult = readonly FsSearchHit[] | FsSearchWirePage;

export type FsSearchFeedSearch = (
  query: string,
  page?: FsSearchPageArgs,
) => Promise<FsSearchFeedResult>;

export interface FsSearchPage {
  readonly items: readonly FsSearchHit[];
  readonly nextCursor?: string;
  readonly sortScope: 'page';
  readonly truncated: boolean;
}

export interface FsSearchFeedView {
  readonly items: readonly FsSearchHit[];
  /** No outstanding cursor. Empty until the first page arrives. */
  readonly exhausted: boolean;
  /** `page` while a cursor remains (arrival order). `complete` only once exhausted. */
  readonly order: 'page' | 'complete';
  readonly pendingInitial: boolean;
  readonly pendingMore: boolean;
  /** A stale cursor is being replaced. Rows from the old chain stay up. */
  readonly pendingRestart: boolean;
  /** The latest page failed. Rows already shown stay; `retry` repeats that page. */
  readonly failed: boolean;
  readonly loadMore: () => void;
  readonly retry: () => void;
}

export function fsSearchRequestBody(
  query: string,
  page: FsSearchPageArgs | undefined,
  filters: FsSearchFeedFilters = {},
): {
  query: string;
  limit?: number;
  cursor?: string;
  include_globs?: string[];
  exclude_globs?: string[];
  follow_gitignore?: boolean;
} {
  return {
    query,
    limit: filters.limit,
    include_globs: filters.include_globs?.slice(),
    exclude_globs: filters.exclude_globs?.slice(),
    follow_gitignore: filters.follow_gitignore,
    cursor: page?.cursor,
  };
}

function isWirePage(result: FsSearchFeedResult): result is FsSearchWirePage {
  return !Array.isArray(result);
}

function cursorOf(page: FsSearchWirePage): string | undefined {
  const raw = page.nextCursor ?? page.next_cursor;
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/** An array is one finished page. `truncated` follows the cursor, matching the server. */
export function normalizeFsSearchPage(result: FsSearchFeedResult): FsSearchPage {
  if (!isWirePage(result)) {
    return { items: result, sortScope: 'page', truncated: false };
  }
  const nextCursor = cursorOf(result);
  return {
    items: result.items,
    nextCursor,
    sortScope: 'page',
    truncated: nextCursor !== undefined,
  };
}

export function isStaleFsSearchCursor(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code: unknown }).code === FS_SEARCH_STALE_CURSOR;
}

function compareExhausted(query: string): (a: FsSearchHit, b: FsSearchHit) => number {
  const empty = query === '';
  return (a, b) => {
    if (empty && (a.kind === 'directory') !== (b.kind === 'directory')) {
      return a.kind === 'directory' ? -1 : 1;
    }
    if (!empty && a.score !== b.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  };
}

/**
 * Concatenate while any cursor remains, including a cursor on an empty page.
 * Sort only when the chain is exhausted, so a later higher score cannot pose
 * as the global top of a search that has not been read.
 */
export function mergeFsSearchPages(pages: readonly FsSearchPage[], query: string): {
  readonly items: readonly FsSearchHit[];
  readonly nextCursor?: string;
  readonly exhausted: boolean;
} {
  if (pages.length === 0) return { items: [], exhausted: true };
  const items: FsSearchHit[] = [];
  for (const page of pages) items.push(...page.items);
  const nextCursor = pages[pages.length - 1]?.nextCursor;
  if (nextCursor !== undefined) return { items, nextCursor, exhausted: false };
  items.sort(compareExhausted(query));
  return { items, exhausted: true };
}

function heldPlaceholder(items: readonly FsSearchHit[]): InfiniteData<FsSearchPage, string | undefined> {
  return {
    pages: [{ items, sortScope: 'page', truncated: true }],
    pageParams: [undefined],
  };
}

export function useFsSearchFeed({
  enabled,
  scopeKey,
  query,
  search,
}: {
  readonly enabled: boolean;
  readonly scopeKey: string;
  readonly query: string;
  readonly search: FsSearchFeedSearch;
}): FsSearchFeedView {
  const queryClient = useQueryClient();
  const searchRef = useRef(search);
  searchRef.current = search;
  const heldRef = useRef<readonly FsSearchHit[]>([]);
  const restartingRef = useRef(false);
  const restartedAt = useRef(-1);
  const enabledRef = useRef(false);
  const observedRef = useRef<string | null>(null);
  const epochsRef = useRef(new Map<string, number>());
  const [restartTick, setRestartTick] = useState(0);
  const identity = chainIdentity(scopeKey, query);
  const previous = useRef({ scopeKey, query });
  if (previous.current.scopeKey !== scopeKey || previous.current.query !== query) {
    previous.current = { scopeKey, query };
    restartingRef.current = false;
    heldRef.current = [];
    restartedAt.current = -1;
  }
  let epoch = epochsRef.current.get(identity) ?? 0;
  const entering = enabled && (observedRef.current !== identity || !enabledRef.current);
  const cachedKey = [FS_SEARCH_FEED_KEY, scopeKey, query, epoch] as const;
  const cached = queryClient.getQueryCache().find<InfiniteData<FsSearchPage, string | undefined>>({
    queryKey: cachedKey,
  });
  // query-core 5.99 refetches every cached page when a stale infinite query
  // is observed again. Re-enable and a changed query or scope are both
  // observations. A chain that is already on screen is left untouched.
  if (
    entering
    && cached !== undefined
    && cached.state.status === 'success'
    && (cached.state.data?.pages.length ?? 0) > 1
    && cached.isStaleByTime(FS_SEARCH_FEED_STALE_MS)
  ) {
    epoch += 1;
    epochsRef.current.set(identity, epoch);
  }
  if (enabled) observedRef.current = identity;
  enabledRef.current = enabled;
  const queryKey = [FS_SEARCH_FEED_KEY, scopeKey, query, epoch] as const;

  const pagesQuery = useInfiniteQuery({
    queryKey,
    enabled,
    staleTime: FS_SEARCH_FEED_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => normalizeFsSearchPage(await searchRef.current(
      query,
      pageParam === undefined ? { signal } : { cursor: pageParam, signal },
    )),
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: () => (
      restartingRef.current && heldRef.current.length > 0 ? heldPlaceholder(heldRef.current) : undefined
    ),
  });

  const staleContinuation = enabled && pagesQuery.isFetchNextPageError && isStaleFsSearchCursor(pagesQuery.error);
  if (staleContinuation && pagesQuery.errorUpdatedAt !== restartedAt.current) {
    heldRef.current = mergeFsSearchPages(pagesQuery.data?.pages ?? [], query).items;
    restartingRef.current = true;
    restartedAt.current = pagesQuery.errorUpdatedAt;
    epochsRef.current.set(identity, epoch + 1);
    setRestartTick((value) => value + 1);
  }

  // The replacement chain has landed. Drop the held rows in this render so the
  // new page is what the list shows, not a second copy underneath it.
  if (
    restartingRef.current
    && pagesQuery.isSuccess
    && !pagesQuery.isPlaceholderData
    && !pagesQuery.isFetching
    && !pagesQuery.isFetchNextPageError
  ) {
    restartingRef.current = false;
  }

  useEffect(() => {
    if (enabled) return;
    void queryClient.cancelQueries({ queryKey: [FS_SEARCH_FEED_KEY, scopeKey, query] });
  }, [enabled, queryClient, scopeKey, query]);

  useEffect(() => () => {
    void queryClient.cancelQueries({ queryKey: [FS_SEARCH_FEED_KEY, scopeKey, query, epoch] });
  }, [epoch, query, queryClient, restartTick, scopeKey]);

  const restarting = restartingRef.current || staleContinuation;
  const merged = mergeFsSearchPages(pagesQuery.data?.pages ?? [], query);
  const items = restarting && heldRef.current.length > 0 ? heldRef.current : merged.items;
  const exhausted = !restarting
    && pagesQuery.data !== undefined
    && !pagesQuery.isPlaceholderData
    && merged.exhausted;
  const pendingRestart = restarting && (pagesQuery.isFetching || pagesQuery.isPlaceholderData || staleContinuation);
  const continuationFailed = pagesQuery.isFetchNextPageError && !isStaleFsSearchCursor(pagesQuery.error);
  const restartFailed = restarting && pagesQuery.isError && !pagesQuery.isFetching && !staleContinuation;
  const initialFailed = !restarting && pagesQuery.isError && !pagesQuery.isFetchNextPageError && items.length === 0;

  const loadMore = () => {
    if (!enabled || restartingRef.current || staleContinuation) return;
    if (pagesQuery.isFetching || pagesQuery.isFetchingNextPage || !pagesQuery.hasNextPage) return;
    void pagesQuery.fetchNextPage();
  };
  const retry = () => {
    if (pagesQuery.isFetchNextPageError && !isStaleFsSearchCursor(pagesQuery.error)) {
      void pagesQuery.fetchNextPage();
      return;
    }
    void pagesQuery.refetch();
  };

  return {
    items,
    exhausted,
    order: exhausted ? 'complete' : 'page',
    pendingInitial: enabled && pagesQuery.isLoading && items.length === 0 && !restarting,
    pendingMore: pagesQuery.isFetchingNextPage,
    pendingRestart,
    failed: continuationFailed || restartFailed || initialFailed,
    loadMore,
    retry,
  };
}
