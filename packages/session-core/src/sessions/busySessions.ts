/**
 * Busy-session accounting shared by the settings restart entries (display-only
 * cached hook) and the app-global restart banner (fresh scan on click).
 */

import { useQuery } from '@tanstack/react-query';

import { useConnection } from '../state/connection';
import type { KikiClient } from './client';

const BUSY_SCAN_PAGE_SIZE = 100;
const BUSY_SCAN_MAX_PAGES = 10;

/**
 * Cached first-page busy count for the settings confirm dialogs. Those entries
 * always confirm before restarting, so an under-count only affects copy, never
 * a restart decision.
 */
export function useBusySessionCount(): number | undefined {
  const { client } = useConnection();
  const query = useQuery({
    queryKey: ['sessions', 'restart-confirm'],
    queryFn: () => client.listSessions({ page_size: BUSY_SCAN_PAGE_SIZE }),
    staleTime: 10_000,
    select: (page) => page.items.filter((session) => session.busy).length,
  });
  return query.data;
}

export type BusySessionProbe =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly count: number }
  | { readonly kind: 'unknown' };

/**
 * Fresh, complete busy-session scan for the restart-decision path. Walks the
 * keyset cursor (`before_id`) until `has_more` is false so a set larger than
 * one page cannot hide a busy session; only an end-to-end scan with zero busy
 * sessions yields `idle`. Errors, a stalled/empty cursor, or exceeding the page
 * budget resolve `unknown` — the caller must treat those as "confirm".
 */
export async function fetchBusySessionCount(client: KikiClient): Promise<BusySessionProbe> {
  let beforeId: string | undefined;
  let busyTotal = 0;
  for (let page = 0; page < BUSY_SCAN_MAX_PAGES; page += 1) {
    const response = await client.listSessions({ page_size: BUSY_SCAN_PAGE_SIZE, before_id: beforeId });
    busyTotal += response.items.filter((session) => session.busy).length;
    if (!response.has_more) {
      return busyTotal > 0 ? { kind: 'busy', count: busyTotal } : { kind: 'idle' };
    }
    const last = response.items[response.items.length - 1];
    if (last === undefined || last.id === beforeId) return { kind: 'unknown' };
    beforeId = last.id;
  }
  return busyTotal > 0 ? { kind: 'busy', count: busyTotal } : { kind: 'unknown' };
}