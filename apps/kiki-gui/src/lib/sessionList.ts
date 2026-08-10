/** Session-list cache helpers: page-1 poll merge + overlap dedupe. */

import type { InfiniteData } from '@tanstack/react-query';

import type { PageResponse, Session } from '@moonshot-ai/protocol';

export type SessionListData = InfiniteData<PageResponse<Session>, unknown>;

/**
 * Poll merge for the 5s cadence: only page 1 is refetched (every sidebar
 * change lands there); older loaded pages are kept as-is and refresh on
 * demand (load-more) or invalidation. Interval-refetching an infinite query
 * would otherwise refetch ALL loaded pages on every tick.
 */
export function mergeSessionFirstPage(
  old: SessionListData | undefined,
  first: PageResponse<Session>,
): SessionListData | undefined {
  if (old === undefined) return old;
  return { ...old, pages: [first, ...old.pages.slice(1)] };
}

/** A fresher page 1 can overlap an older loaded page as sessions shift. */
export function dedupeSessions(data: SessionListData | undefined): Session[] {
  const seen = new Set<string>();
  return (data?.pages ?? [])
    .flatMap((page) => page.items)
    .filter((session) => {
      if (seen.has(session.id)) return false;
      seen.add(session.id);
      return true;
    });
}
