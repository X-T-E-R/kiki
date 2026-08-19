/** Session-list cache helpers: page-1 poll merge + overlap dedupe, plus
 * client-local pin state keyed off the wire `Session.metadata`. */

import type { InfiniteData } from '@tanstack/react-query';

import type { PageResponse, Session } from '@moonshot-ai/protocol';

export type SessionListData = InfiniteData<PageResponse<Session>>;

/** Custom-metadata key carrying the client-local pin at (`true` pins, absent
 * or `false` is unpinned). Lives on the session's `metadata.custom` document,
 * which round-trips through the v1 `/profile` metadata patch — no invented
 * wire field, no super-set plumbing. When the server is an older build that
 * does not hand `custom` back through `metadata`, pinning silently degrades
 * to a local-only session-scoped highlight. */
export const SESSION_PIN_META_KEY = 'kiki.pinned';

export function isPinnedSession(session: Session): boolean {
  return session.metadata[SESSION_PIN_META_KEY] === true;
}

/**
 * Build the `metadata` to send with a pin/unpin patch. It round-trips the
 * full wire `metadata` document (including the authoritative `cwd`) with the
 * pin flag toggled, so the patch is never empty — the v1 profile route skips
 * empty metadata patches, which would otherwise make "unpin" a silent no-op.
 * `buildWireMetadata` on the server overlays the real `cwd` back in, so
 * echoing it here is harmless and matches the wire contract.
 */
export function pinMetadataPatch(session: Session, pinned: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = { ...session.metadata };
  if (pinned) base[SESSION_PIN_META_KEY] = true;
  else delete base[SESSION_PIN_META_KEY];
  return base;
}

/** Flip the pin state: pinned → unpinned, unpinned → pinned. */
export function togglePinned(current: boolean): boolean {
  return !current;
}

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

/** Pinned sessions float to the top (newest-pinned first by `updated_at`). */
export function arrangePinnedFirst(sessions: readonly Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const ap = isPinnedSession(a);
    const bp = isPinnedSession(b);
    if (ap !== bp) return ap ? -1 : 1;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

export interface TimeGroup {
  /** `pinned` / `week` / `month` / `older` (pinned rows all report `pinned`). */
  readonly key: 'pinned' | 'week' | 'month' | 'older';
  readonly items: Session[];
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// 4 weeks (28 days) is the "month" bucket cut-off; earlier than that is
// "older". The week bucket is [now-6d, now], matching common sidebar idioms.
const MONTH_WINDOW_MS = 4 * WEEK_MS;

/**
 * Split a freshly-ordered list into bucketed groups: pinned sessions first,
 * then "past 7 days" + "past 4 weeks" + "older". Invalid timestamps land in
 * `older` rather than crashing the list.
 */
export function groupSessionsByTime(
  sessions: readonly Session[],
  nowMs: number,
): TimeGroup[] {
  const buckets: TimeGroup[] = [
    { key: 'pinned', items: [] },
    { key: 'week', items: [] },
    { key: 'month', items: [] },
    { key: 'older', items: [] },
  ];
  for (const session of sessions) {
    let group: TimeGroup;
    if (isPinnedSession(session)) {
      group = buckets[0]!;
    } else {
      const ts = Date.parse(session.updated_at);
      if (!Number.isFinite(ts)) {
        group = buckets[3]!;
      } else {
        const age = nowMs - ts;
        if (age < WEEK_MS) group = buckets[1]!;
        else if (age < MONTH_WINDOW_MS) group = buckets[2]!;
        else group = buckets[3]!;
      }
    }
    group.items.push(session);
  }
  return buckets.filter((group) => group.items.length > 0);
}
