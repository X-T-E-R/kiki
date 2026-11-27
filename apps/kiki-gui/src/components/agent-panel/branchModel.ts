import { MAIN_AGENT_ID, type AgentForest, type AgentTreeNode, type Block } from '@kiki/session-core/session';
import { plainInline } from '@kiki/session-core/util';

import { displayUserMessageText } from '../message/messageSource';

export const MERGED_BRANCH_INLINE_LIMIT = 5;

export type BranchLifecycleState = 'waiting' | 'running' | 'open' | 'merged' | 'failed';

export function isEphemeralBtwNode(
  node: Pick<AgentTreeNode, 'agentId' | 'label' | 'toolsLocked' | 'branchSealed' | 'nameSource'> | undefined,
): boolean {
  if (node === undefined || node.branchSealed === true) return false;
  if (/^(?:btw|agent[-_]btw)[-_]/i.test(node.agentId)) return true;
  return node.toolsLocked === true && (node.label === 'BTW' || node.label.trim() === '' || node.nameSource === 'unreported');
}

export function isSessionBranchNode(node: AgentTreeNode | undefined): node is AgentTreeNode {
  return (
    node !== undefined &&
    node.agentId !== MAIN_AGENT_ID &&
    (node.isBranch === true || node.branchSealed === true) &&
    !isEphemeralBtwNode(node)
  );
}

export function branchLifecycleState(node: AgentTreeNode, waiting: ReadonlySet<string>): BranchLifecycleState {
  if (waiting.has(node.agentId) || node.status === 'suspended') return 'waiting';
  if (node.status === 'running' || node.status === 'background' || node.busy) return 'running';
  if (node.status === 'failed') return 'failed';
  if (node.status === 'cancelled') return 'open';
  if (node.branchSealed === true) return 'merged';
  return 'open';
}

function branchSortRank(state: BranchLifecycleState): number {
  switch (state) {
    case 'waiting':
      return 0;
    case 'running':
      return 1;
    case 'open':
      return 2;
    case 'failed':
      return 3;
    case 'merged':
      return 4;
  }
}

function parseTime(iso: string | undefined): number {
  if (iso === undefined || iso === '') return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function branchRecency(node: AgentTreeNode): number {
  return Math.max(parseTime(node.endedAt), parseTime(node.startedAt), parseTime(node.createdAt));
}

export interface OrderedBranches {
  readonly all: readonly AgentTreeNode[];
  readonly open: readonly AgentTreeNode[];
  readonly merged: readonly AgentTreeNode[];
}

export function collectSessionBranches(
  forest: AgentForest,
  waitingAgentIds: ReadonlySet<string>,
): OrderedBranches {
  const entries = Object.values(forest.byId)
    .filter(isSessionBranchNode)
    .map((node, index) => ({
      node,
      state: branchLifecycleState(node, waitingAgentIds),
      stamp: branchRecency(node),
      index,
    }));

  entries.sort((left, right) => {
    const rankDiff = branchSortRank(left.state) - branchSortRank(right.state);
    if (rankDiff !== 0) return rankDiff;
    const timeDiff = right.stamp - left.stamp;
    if (timeDiff !== 0) return timeDiff;
    return right.index - left.index;
  });

  const all = entries.map((entry) => entry.node);
  const open = entries.filter((entry) => entry.state !== 'merged').map((entry) => entry.node);
  const merged = entries.filter((entry) => entry.state === 'merged').map((entry) => entry.node);
  return { all, open, merged };
}

/** Extract merged/folded branch summary previews from projected timeline blocks. */
export function extractBranchFoldSummaries(blocks: readonly Block[]): ReadonlyMap<string, string> {
  const summaries = new Map<string, string>();
  for (const block of blocks) {
    if (block.kind !== 'user' || block.branchFold === undefined) continue;
    const cleaned = plainInline(displayUserMessageText(block).text).trim();
    if (cleaned !== '') summaries.set(block.branchFold.branchId, cleaned);
  }
  return summaries;
}
