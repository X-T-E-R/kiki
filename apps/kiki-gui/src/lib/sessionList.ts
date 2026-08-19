/** Session-list cache helpers: page-1 poll merge + overlap dedupe, plus
 * client-local pin state keyed off the wire `Session.metadata`. */

import type { InfiniteData } from '@tanstack/react-query';

import type { PageResponse, Session, Workspace } from '@moonshot-ai/protocol';

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

/**
 * Within-bucket sort order for the session list. Pinned sessions always float
 * to the top of their bucket (newest-pinned first) regardless of this order
 * — the selected order only arranges the unpinned remainder.
 */
export type SessionSortOrder = 'updated-desc' | 'updated-asc' | 'title';

function byUpdatedDesc(a: Session, b: Session): number {
  return b.updated_at.localeCompare(a.updated_at);
}

function byUpdatedAsc(a: Session, b: Session): number {
  return a.updated_at.localeCompare(b.updated_at);
}

function byTitle(a: Session, b: Session): number {
  const an = a.title.trim();
  const bn = b.title.trim();
  if (an !== bn) {
    return an.localeCompare(bn, undefined, { sensitivity: 'base', numeric: true });
  }
  // Deterministic tie-break that does not drift with the runtime locale.
  return b.updated_at.localeCompare(a.updated_at);
}

/** Pinned sessions float to the top (newest-pinned first by `updated_at`). */
export function arrangePinnedFirst(sessions: readonly Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const ap = isPinnedSession(a);
    const bp = isPinnedSession(b);
    if (ap !== bp) return ap ? -1 : 1;
    return byUpdatedDesc(a, b);
  });
}

/**
 * Order one bucket's worth of sessions: pinned first (newest-pinned first),
 * then the unpinned remainder by the requested order (`updated-desc` mirrors
 * `arrangePinnedFirst` exactly).
 */
export function sortSessionItems(
  sessions: readonly Session[],
  order: SessionSortOrder,
): Session[] {
  const pinned: Session[] = [];
  const rest: Session[] = [];
  for (const session of sessions) {
    (isPinnedSession(session) ? pinned : rest).push(session);
  }
  pinned.sort(byUpdatedDesc);
  if (order === 'title') rest.sort(byTitle);
  else if (order === 'updated-asc') rest.sort(byUpdatedAsc);
  else rest.sort(byUpdatedDesc);
  return [...pinned, ...rest];
}

export interface SessionGroup {
  /**
   * Stable bucket key. Time grouping: `pinned` / `week` / `month` / `older`
   * (pinned rows all report `pinned`). Workspace grouping: the workspace id,
   * with `__none` for sessions lacking a resolvable workspace.
   */
  readonly key: string;
  /** Human label for the group header (baked in so the renderer stays dumb). */
  readonly label: string;
  readonly items: Session[];
}

/** `pinned` / `week` / `month` / `older` (pinned rows all report `pinned`). */
export type TimeGroupKey = 'pinned' | 'week' | 'month' | 'older';
export type TimeGroup = SessionGroup & { readonly key: TimeGroupKey };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// 4 weeks (28 days) is the "month" bucket cut-off; earlier than that is
// "older". The week bucket is [now-6d, now], matching common sidebar idioms.
const MONTH_WINDOW_MS = 4 * WEEK_MS;

/**
 * Split a freshly-ordered list into bucketed groups: pinned sessions first,
 * then "past 7 days" + "past 4 weeks" + "older". Invalid timestamps land in
 * `older` rather than crashing the list. `labels` overrides the four group
 * header labels for localization; when omitted, bare keys are used (tests).
 */
export function groupSessionsByTime(
  sessions: readonly Session[],
  nowMs: number,
  labels: { pinned?: string; week?: string; month?: string; older?: string } = {},
): TimeGroup[] {
  const buckets: TimeGroup[] = [
    { key: 'pinned', label: labels.pinned ?? 'pinned', items: [] },
    { key: 'week', label: labels.week ?? 'week', items: [] },
    { key: 'month', label: labels.month ?? 'month', items: [] },
    { key: 'older', label: labels.older ?? 'older', items: [] },
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

/** Bucket key for sessions whose `workspace_id` cannot be resolved. */
export const WORKSPACE_UNGROUPED_KEY = '__none';

/**
 * Bucket sessions by workspace, ordered by the `workspaces` list order (the
 * caller pre-sorts by recency). A session whose `workspace_id` no longer maps
 * to a registered workspace — or is missing — lands in the trailing "unknown"
 * group alongside all other orphans. Item order within each bucket is
 * preserved as given (the caller applies `sortSessionItems` first). `label`
 * resolves via `resolveName(workspace)`; `ungroupedLabel` names the orphan
 * bucket.
 */
export function groupSessionsByWorkspace(
  sessions: readonly Session[],
  workspaces: readonly Workspace[],
  resolveName: (workspace: Workspace) => string = (workspace) => workspace.name,
  ungroupedLabel = 'ungrouped',
): SessionGroup[] {
  const order = new Map<string, number>(workspaces.map((workspace, index) => [workspace.id, index]));
  const named = new Map<string, string>();
  for (const workspace of workspaces) named.set(workspace.id, resolveName(workspace));

  // Preserve the workspaces-list order for buckets that actually have rows.
  const buckets = new Map<string, SessionGroup>();
  const ensure = (key: string, label: string): SessionGroup => {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { key, label, items: [] };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  for (const session of sessions) {
    const workspaceKey = session.workspace_id;
    const index = order.get(workspaceKey);
    if (index !== undefined) ensure(workspaceKey, named.get(workspaceKey) ?? workspaceKey).items.push(session);
    else ensure(WORKSPACE_UNGROUPED_KEY, ungroupedLabel).items.push(session);
  }

  const result: SessionGroup[] = [];
  for (const [index, workspace] of workspaces.entries()) {
    const bucket = buckets.get(workspace.id);
    if (bucket !== undefined) result[index] = bucket;
  }
  const orphan = buckets.get(WORKSPACE_UNGROUPED_KEY);
  if (orphan !== undefined) result.push(orphan);

  return result.filter((group): group is SessionGroup => group !== undefined);
}
