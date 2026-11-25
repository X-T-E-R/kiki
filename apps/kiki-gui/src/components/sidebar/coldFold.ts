/**
 * Historical time-bucket cold-fold partitioner for the `会话` (Sessions) sidebar view.
 *
 * When search & filters are inactive in calendar-grouped (`groupBy === 'time'`) view,
 * quiet read conversations in the post-week historical buckets (`month` and `older`
 * from `TimeGroupKey` in `@kiki/session-core/sessions`) are folded behind a single
 * quiet disclosure row (`更早 · N` / `Older · N`), keeping `pinned`, `today`,
 * `yesterday`, and `week` directly visible and protecting:
 *   - the active conversation
 *   - pinned conversations
 *   - conversations needing user input (`needs-me` / `cleanup-pending`)
 *   - running conversations (`busy`)
 *   - unread conversations
 */

import type {
  SessionRowState,
  SidebarDisplayBucket,
  SidebarDisplayItem,
  SidebarSessionGroupEntry,
  TimeGroupKey,
} from '@kiki/session-core/sessions';
import type { ConversationTreeNode } from '../../lib/sessionThreads';

const HISTORICAL_TIME_GROUP_KEYS: ReadonlySet<string> = new Set<TimeGroupKey>(['month', 'older']);

export interface ColdFoldGroup<TGroup extends { readonly key: string; readonly label: string; readonly nodes: readonly ConversationTreeNode[]; readonly total: number }> {
  readonly visibleGroups: readonly TGroup[];
  readonly coldNodes: readonly ConversationTreeNode[];
}

export interface UnitColdFoldResult {
  readonly visibleBuckets: readonly SidebarDisplayBucket[];
  readonly coldItems: readonly SidebarDisplayItem[];
  readonly coldCount: number;
}

function isProtectedUnitItem(
  item: SidebarDisplayItem,
  options: {
    readonly activeSessionId?: string;
    readonly activeRouteSpaceKey?: string;
    readonly activeRoomHref?: string;
    readonly currentSpaceKey?: string;
    readonly rowStateOf: (item: Exclude<SidebarDisplayItem, SidebarSessionGroupEntry>) => SessionRowState;
  },
): boolean {
  if (item.pinned) return true;
  if (item.kind === 'session-group') {
    for (const member of item.members) {
      if (isProtectedUnitItem(member, options)) return true;
    }
    return false;
  }
  if (item.kind === 'session') {
    const memberSpaceKey = item.spaceKey ?? options.currentSpaceKey;
    if (
      item.session.id === options.activeSessionId
      && (options.activeRouteSpaceKey === undefined || memberSpaceKey === options.activeRouteSpaceKey)
    ) {
      return true;
    }
  } else if (item.kind === 'room' && item.href === options.activeRoomHref) {
    return true;
  }
  return options.rowStateOf(item) !== 'read';
}

export function partitionUnitColdFold(
  buckets: readonly SidebarDisplayBucket[],
  options: {
    readonly enabled: boolean;
    readonly activeSessionId?: string;
    readonly activeRouteSpaceKey?: string;
    readonly activeRoomHref?: string;
    readonly currentSpaceKey?: string;
    readonly rowStateOf: (item: Exclude<SidebarDisplayItem, SidebarSessionGroupEntry>) => SessionRowState;
  },
): UnitColdFoldResult {
  if (!options.enabled || buckets.length === 0) {
    return { visibleBuckets: buckets, coldItems: [], coldCount: 0 };
  }
  const visibleBuckets: SidebarDisplayBucket[] = [];
  const coldItems: SidebarDisplayItem[] = [];
  let coldCount = 0;

  for (const bucket of buckets) {
    if (!HISTORICAL_TIME_GROUP_KEYS.has(bucket.key)) {
      visibleBuckets.push(bucket);
      continue;
    }
    const kept: SidebarDisplayItem[] = [];
    let keptTotal = 0;
    for (const item of bucket.items) {
      const weight = item.kind === 'session-group' ? item.memberCount : 1;
      if (!isProtectedUnitItem(item, options)) {
        coldItems.push(item);
        coldCount += weight;
      } else {
        kept.push(item);
        keptTotal += weight;
      }
    }
    if (kept.length > 0) {
      visibleBuckets.push(
        kept.length === bucket.items.length
          ? bucket
          : { ...bucket, items: kept, total: keptTotal },
      );
    }
  }

  return { visibleBuckets, coldItems, coldCount };
}

function isProtectedNode(
  node: ConversationTreeNode,
  options: {
    readonly activeSessionId?: string;
    readonly activeRoomHref?: string;
    readonly rowStateOf: (node: ConversationTreeNode) => SessionRowState;
  },
): boolean {
  const { item } = node;
  if (item.pinned) return true;
  if (item.kind === 'session' && item.session.id === options.activeSessionId) return true;
  if (item.kind === 'room' && item.href === options.activeRoomHref) return true;
  const state = options.rowStateOf(node);
  if (state !== 'read') return true;
  for (const child of node.children) {
    if (isProtectedNode(child, options)) return true;
  }
  return false;
}

export function partitionColdFold<
  TGroup extends {
    readonly key: string;
    readonly label: string;
    readonly nodes: readonly ConversationTreeNode[];
    readonly total: number;
  },
>(
  groups: readonly TGroup[],
  options: {
    readonly enabled: boolean;
    readonly activeSessionId?: string;
    readonly activeRoomHref?: string;
    readonly rowStateOf: (node: ConversationTreeNode) => SessionRowState;
  },
): ColdFoldGroup<TGroup> {
  if (!options.enabled || groups.length === 0) {
    return { visibleGroups: groups, coldNodes: [] };
  }
  const visibleGroups: TGroup[] = [];
  const coldNodes: ConversationTreeNode[] = [];

  for (const group of groups) {
    if (!HISTORICAL_TIME_GROUP_KEYS.has(group.key)) {
      visibleGroups.push(group);
      continue;
    }
    const kept: ConversationTreeNode[] = [];
    for (const node of group.nodes) {
      if (!isProtectedNode(node, options)) {
        coldNodes.push(node);
      } else {
        kept.push(node);
      }
    }
    if (kept.length > 0) {
      visibleGroups.push(
        kept.length === group.nodes.length
          ? group
          : { ...group, nodes: kept, total: kept.length },
      );
    }
  }

  return { visibleGroups, coldNodes };
}
