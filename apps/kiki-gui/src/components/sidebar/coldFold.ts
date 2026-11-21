/**
 * 72-hour cold-fold partitioner for the `会话` (Sessions) sidebar view.
 *
 * When search & filters are inactive in time/flat view, conversations older
 * than 72 hours are folded behind a single quiet disclosure row (`更早 · N` /
 * `Older · N`), excluding:
 *   - the active conversation
 *   - pinned conversations
 *   - conversations needing user input (`needs-me` / `cleanup-pending`)
 *   - running conversations (`busy`)
 *   - unread conversations
 */

import type { SessionRowState } from '@kiki/session-core/sessions';
import type { ConversationTreeNode } from '../../lib/sessionThreads';

export const COLD_FOLD_THRESHOLD_MS = 72 * 60 * 60 * 1000;

export interface ColdFoldGroup<TGroup extends { readonly key: string; readonly label: string; readonly nodes: readonly ConversationTreeNode[]; readonly total: number }> {
  readonly visibleGroups: readonly TGroup[];
  readonly coldNodes: readonly ConversationTreeNode[];
}

function nodeTimestampMs(node: ConversationTreeNode): number {
  const raw = node.item.updated_at;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
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
    readonly nowMs: number;
    readonly activeSessionId?: string;
    readonly activeRoomHref?: string;
    readonly rowStateOf: (node: ConversationTreeNode) => SessionRowState;
  },
): ColdFoldGroup<TGroup> {
  if (!options.enabled || groups.length === 0) {
    return { visibleGroups: groups, coldNodes: [] };
  }
  const cutoffMs = options.nowMs - COLD_FOLD_THRESHOLD_MS;
  const visibleGroups: TGroup[] = [];
  const coldNodes: ConversationTreeNode[] = [];

  for (const group of groups) {
    if (group.key === 'pinned' || group.key === 'today' || group.key === 'yesterday') {
      visibleGroups.push(group);
      continue;
    }
    const kept: ConversationTreeNode[] = [];
    for (const node of group.nodes) {
      const ts = nodeTimestampMs(node);
      if (ts > 0 && ts < cutoffMs && !isProtectedNode(node, options)) {
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
