/**
 * Busy-session accounting shared by the settings restart entries (display-only
 * cached hook) and the app-global restart banner (fresh scan on click).
 */

import type { SessionListTransport } from '../transport';

const BUSY_SCAN_PAGE_SIZE = 100;
const BUSY_SCAN_MAX_PAGES = 10;

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
export async function fetchBusySessionCount(client: SessionListTransport): Promise<BusySessionProbe> {
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