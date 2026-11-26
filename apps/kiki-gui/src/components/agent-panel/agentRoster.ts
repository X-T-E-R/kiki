/**
 * The inspector's agent roster as data: status buckets, a summary count per
 * bucket, and the visible rows for a collapsible, possibly deep tree. Pure so
 * a session with hundreds of agents is one linear pass per change, and so the
 * ordering rules are testable without a DOM.
 *
 * Buckets: only what needs the user is set apart. Everything else is either
 * still running or has ended; a failed agent ends like any other (its row
 * says so in words, the list never sorts or filters by failure).
 *
 * Ordering: agents that need the user, then running, then idle. A historical
 * unknown subtree — nothing waiting, running, or idle below it — folds into
 * one "N status unknown" group once there are more than three, the same
 * handful as finished agents. An unknown parent with a waiting, running, or
 * idle descendant stays in the open list. Ended agents keep their own group.
 * A parent sorts by the most urgent agent in its subtree, so a finished lead
 * with a waiting worker stays at the top; within the same urgency the most
 * recently updated subtree (latest start or end) comes first. Below the
 * first level every branch starts folded.
 *
 * Filtering (a status or a search) switches to a flat list: each match keeps
 * the names of the agents between the root and itself, so its place in the
 * tree reads without expanding anything.
 */

import { MAIN_AGENT_ID, type AgentForest, type AgentTreeNode } from '@kiki/session-core/session';
import type { SessionAgentCounts } from '@kiki/protocol';
import { getSubagentScaleConfig } from '../../lib/subagentScaleConfig';

export type RosterBucket = 'waiting' | 'running' | 'idle' | 'unknown' | 'ended';

export const ROSTER_BUCKETS: readonly RosterBucket[] = ['waiting', 'running', 'idle', 'unknown', 'ended'];

const RANK: Record<RosterBucket, number> = { waiting: 0, running: 1, idle: 2, unknown: 3, ended: 4 };

export function rosterBucket(node: AgentTreeNode, waiting: ReadonlySet<string>): RosterBucket {
  if (waiting.has(node.agentId) || node.status === 'suspended') return 'waiting';
  switch (node.status) {
    case 'running':
    case 'background':
      return 'running';
    case 'idle':
      return 'idle';
    case 'unknown':
      return 'unknown';
    default:
      return 'ended';
  }
}

export interface RosterAgentRow {
  readonly kind: 'agent';
  readonly node: AgentTreeNode;
  readonly bucket: RosterBucket;
  /** Indent level under the roster root (0 = its direct children). */
  readonly depth: number;
  readonly childCount: number;
  readonly expanded: boolean;
  /** Agents below this one that need the user (shown on a folded branch). */
  readonly waitingBelow: number;
  /** Labels between the roster root and this agent (flat mode only). */
  readonly path: readonly string[];
}

export interface RosterGroupRow {
  readonly kind: 'group';
  /** Historical unknown, or settled. Each group has its own open flag. */
  readonly bucket: 'unknown' | 'ended';
  readonly count: number;
  readonly open: boolean;
}

export type RosterRow = RosterAgentRow | RosterGroupRow;

export interface RosterModel {
  readonly counts: Readonly<Record<RosterBucket, number>>;
  readonly total: number;
  /** Exact total including unhydrated server-side subagents when `agentCounts` is present. */
  readonly displayTotal: number;
  readonly rows: readonly RosterRow[];
  /** True when the visible settled/unknown slice is capped below the total count. */
  readonly settledTruncated: boolean;
  readonly settledShown: number;
  readonly settledTotal: number;
}

export interface RosterInput {
  readonly forest: AgentForest;
  /** Whose team this is: main, or a focused agent with children of its own. */
  readonly rootId: string;
  readonly waiting: ReadonlySet<string>;
  /** Branches the user opened. Every branch starts folded. */
  readonly expanded: ReadonlySet<string>;
  readonly filter: RosterBucket | 'all';
  readonly query: string;
  /**
   * Historical-unknown group. Omitted or undefined stays closed, independent
   * of `doneOpen`.
   */
  readonly unknownOpen?: boolean;
  /** The trailing "N finished" group is open. Independent of `unknownOpen`. */
  readonly doneOpen: boolean;
  /** Optional server-side exact counts when the local forest is a bounded window. */
  readonly agentCounts?: SessionAgentCounts;
  /** Optional remote search hits (from `controller.searchSubagents`) merged by `agentId`. */
  readonly extraNodes?: readonly AgentTreeNode[];
  /** Override for bounded settled display cap (default: `getSubagentScaleConfig().settledRosterWindow`). */
  readonly settledCap?: number;
}

import { isEphemeralBtwNode } from './InspectorBranches';

function isConversationBranch(node: AgentTreeNode): boolean {
  return node.isBranch === true || node.branchSealed === true || isEphemeralBtwNode(node);
}

function childrenOf(forest: AgentForest, rootId: string): AgentTreeNode[] {
  if (rootId === MAIN_AGENT_ID) {
    const main = forest.byId[MAIN_AGENT_ID];
    // Subagents hang under main when main is known; otherwise every root that
    // is not main is a top-level team member. Conversation branches live in
    // their own dedicated rail section, never mixed into background workers.
    const ids = main !== undefined
      ? main.childIds
      : forest.roots.map((root) => root.agentId);
    const extra = main !== undefined ? forest.roots.filter((root) => root.agentId !== MAIN_AGENT_ID) : [];
    return [...ids.flatMap((id) => (forest.byId[id] === undefined ? [] : [forest.byId[id]!])), ...extra]
      .filter((node) => !isConversationBranch(node));
  }
  return (forest.byId[rootId]?.childIds ?? [])
    .flatMap((id) => (forest.byId[id] === undefined ? [] : [forest.byId[id]!]))
    .filter((node) => !isConversationBranch(node));
}

function matches(node: AgentTreeNode, needle: string): boolean {
  if (needle === '') return true;
  return [node.label, node.name, node.agentId, node.description, node.model, node.summary, node.error]
    .some((value) => value !== undefined && value.toLowerCase().includes(needle));
}

/** Epoch ms of an ISO time; unknown sorts oldest. */
function timeOf(iso: string | undefined): number {
  const value = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(value) ? value : 0;
}

export function buildRoster(input: RosterInput): RosterModel {
  const {
    forest,
    rootId,
    waiting,
    expanded,
    filter,
    unknownOpen = false,
    doneOpen,
    agentCounts,
    extraNodes,
    settledCap = getSubagentScaleConfig().settledRosterWindow,
  } = input;
  const needle = input.query.trim().toLowerCase();
  const counts: Record<RosterBucket, number> = { waiting: 0, running: 0, idle: 0, unknown: 0, ended: 0 };
  const bucketOf = new Map<string, RosterBucket>();
  const subtreeRank = new Map<string, number>();
  const waitingBelow = new Map<string, number>();
  const updatedAt = new Map<string, number>();
  const kids = new Map<string, AgentTreeNode[]>();
  const seen = new Set<string>([rootId]);

  // Single post-order pass: bucket, subtree urgency, waiting descendants, and
  // iterative subtree latest timestamp (no Math.max(...children) stack spread).
  const visit = (node: AgentTreeNode, ancestorEnded = false): void => {
    const rawBucket = rosterBucket(node, waiting);
    const bucket: RosterBucket = ancestorEnded && rawBucket === 'unknown' ? 'ended' : rawBucket;
    const nextAncestorEnded = ancestorEnded || bucket === 'ended';
    bucketOf.set(node.agentId, bucket);
    counts[bucket] += 1;
    const children: AgentTreeNode[] = [];
    for (const id of node.childIds) {
      const child = forest.byId[id];
      if (child === undefined || isConversationBranch(child) || seen.has(id)) continue;
      seen.add(id);
      children.push(child);
    }
    let rank = RANK[bucket];
    let below = 0;
    let maxTime = Math.max(timeOf(node.endedAt), timeOf(node.startedAt));
    for (const child of children) {
      visit(child, nextAncestorEnded);
      const childRank = subtreeRank.get(child.agentId)!;
      if (childRank < rank && !(bucket === 'ended' && childRank >= RANK.unknown)) {
        rank = childRank;
      }
      below += waitingBelow.get(child.agentId)! + (bucketOf.get(child.agentId) === 'waiting' ? 1 : 0);
      const childTime = updatedAt.get(child.agentId)!;
      if (childTime > maxTime) maxTime = childTime;
    }
    subtreeRank.set(node.agentId, rank);
    waitingBelow.set(node.agentId, below);
    updatedAt.set(node.agentId, maxTime);
    kids.set(node.agentId, children);
  };
  const top = childrenOf(forest, rootId).filter((node) => {
    if (seen.has(node.agentId)) return false;
    seen.add(node.agentId);
    return true;
  });
  for (const node of top) visit(node);
  const total = counts.waiting + counts.running + counts.idle + counts.unknown + counts.ended;

  const useServerCounts = rootId === MAIN_AGENT_ID && agentCounts !== undefined && agentCounts.subagents > total;
  const effectiveCounts: Record<RosterBucket, number> = useServerCounts
    ? {
        waiting: counts.waiting,
        running: Math.max(counts.running, Math.max(0, agentCounts.active - counts.waiting)),
        idle: Math.max(counts.idle, agentCounts.idle ?? 0),
        unknown: Math.max(counts.unknown, agentCounts.unknown),
        ended: Math.max(counts.ended, agentCounts.completed + agentCounts.failed + agentCounts.cancelled),
      }
    : counts;
  const displayTotal = rootId === MAIN_AGENT_ID && agentCounts !== undefined
    ? Math.max(total, agentCounts.subagents)
    : total;

  const stampOf = (agentId: string, node: AgentTreeNode): number =>
    updatedAt.get(agentId) ?? Math.max(timeOf(node.endedAt), timeOf(node.startedAt));

  const byUrgency = (list: readonly AgentTreeNode[]) =>
    list
      .map((node, index) => ({ node, index }))
      .sort((a, b) => subtreeRank.get(a.node.agentId)! - subtreeRank.get(b.node.agentId)! || stampOf(b.node.agentId, b.node) - stampOf(a.node.agentId, a.node) || a.index - b.index)
      .map((entry) => entry.node);

  const rowFor = (node: AgentTreeNode, depth: number, path: readonly string[]): RosterAgentRow => ({
    kind: 'agent',
    node,
    bucket: bucketOf.get(node.agentId) ?? rosterBucket(node, waiting),
    depth,
    childCount: kids.get(node.agentId)?.length ?? 0,
    expanded: expanded.has(node.agentId),
    waitingBelow: waitingBelow.get(node.agentId) ?? 0,
    path,
  });

  const rows: RosterRow[] = [];
  if (filter !== 'all' || needle !== '') {
    const flat: { row: RosterAgentRow; rank: number; time: number; order: number }[] = [];
    const matchedIds = new Set<string>();
    let order = 0;
    const walk = (node: AgentTreeNode, path: readonly string[]): void => {
      const bucket = bucketOf.get(node.agentId)!;
      if ((filter === 'all' || bucket === filter) && matches(node, needle)) {
        matchedIds.add(node.agentId);
        flat.push({
          row: { ...rowFor(node, 0, path), expanded: false, childCount: 0 },
          rank: RANK[bucket],
          time: stampOf(node.agentId, node),
          order: order++,
        });
      }
      for (const child of kids.get(node.agentId) ?? []) walk(child, [...path, node.label]);
    };
    for (const node of top) walk(node, []);

    // Merge remote server-search hits (deduped by agentId) when searching.
    if (needle !== '' && extraNodes !== undefined && extraNodes.length > 0) {
      for (const remote of extraNodes) {
        if (remote.agentId === rootId || isConversationBranch(remote) || matchedIds.has(remote.agentId)) continue;
        const bucket = rosterBucket(remote, waiting);
        if (filter !== 'all' && bucket !== filter) continue;
        matchedIds.add(remote.agentId);
        flat.push({
          row: {
            kind: 'agent',
            node: remote,
            bucket,
            depth: 0,
            childCount: 0,
            expanded: false,
            waitingBelow: 0,
            path: agentTrail(forest, remote.agentId),
          },
          rank: RANK[bucket],
          time: Math.max(timeOf(remote.endedAt), timeOf(remote.startedAt)),
          order: order++,
        });
      }
    }

    flat.sort((a, b) => a.rank - b.rank || b.time - a.time || a.order - b.order);
    const shouldCapFlat = needle === '' && (filter === 'ended' || filter === 'unknown') && flat.length > settledCap;
    const sliced = shouldCapFlat ? flat.slice(0, settledCap) : flat;
    const totalForFilter = needle === '' && filter !== 'all'
      ? Math.max(flat.length, effectiveCounts[filter])
      : flat.length;
    const truncated = needle === '' && (filter === 'ended' || filter === 'unknown') && totalForFilter > sliced.length;
    return {
      counts: effectiveCounts,
      total,
      displayTotal,
      rows: sliced.map((entry) => entry.row),
      settledTruncated: truncated,
      settledShown: truncated ? sliced.length : 0,
      settledTotal: truncated ? totalForFilter : 0,
    };
  }

  let settledTruncated = false;
  let settledShown = 0;
  let settledTotal = 0;

  const emit = (node: AgentTreeNode, depth: number): void => {
    const row = rowFor(node, depth, []);
    rows.push(row);
    if (!row.expanded) return;
    for (const child of byUrgency(kids.get(node.agentId) ?? [])) emit(child, depth + 1);
  };
  // More than three is the existing handful. Fewer stay rows unless server
  // counts report additional unhydrated settled/unknown subagents, or when
  // settled itself already folds (never sandwich inline unknown rows above a
  // folded "N finished" group).
  const foldWhenMany = (
    nodes: readonly AgentTreeNode[],
    bucket: 'unknown' | 'ended',
    open: boolean,
    forceFold = false,
  ): void => {
    const serverCount = useServerCounts ? effectiveCounts[bucket] : 0;
    const groupCount = Math.max(nodes.length, serverCount);
    if (groupCount === 0) return;
    if (!forceFold && groupCount <= 3) {
      for (const node of nodes) emit(node, 0);
      return;
    }
    rows.push({ kind: 'group', bucket, count: groupCount, open });
    if (open) {
      const limit = Math.min(nodes.length, settledCap);
      for (let i = 0; i < limit; i += 1) emit(nodes[i]!, 0);
      if (groupCount > limit) {
        settledTruncated = true;
        settledShown += limit;
        settledTotal += groupCount;
      }
    }
  };
  const ordered = byUrgency(top);
  // Subtree rank, not the parent's own bucket. An unknown parent whose
  // descendant is waiting, running, or idle stays with the open list.
  const active = ordered.filter((node) => subtreeRank.get(node.agentId)! < RANK.unknown);
  const historicalUnknown = ordered.filter((node) => subtreeRank.get(node.agentId)! === RANK.unknown);
  const settled = ordered.filter((node) => subtreeRank.get(node.agentId)! === RANK.ended);
  const settledGroupCount = Math.max(settled.length, useServerCounts ? effectiveCounts.ended : 0);
  for (const node of active) emit(node, 0);
  foldWhenMany(historicalUnknown, 'unknown', unknownOpen, settledGroupCount > 3);
  foldWhenMany(settled, 'ended', doneOpen);
  return {
    counts: effectiveCounts,
    total,
    displayTotal,
    rows,
    settledTruncated,
    settledShown,
    settledTotal,
  };
}

/** Labels from the roster root down to (not including) `agentId`. */
export function agentTrail(forest: AgentForest, agentId: string): string[] {
  const trail: string[] = [];
  const seen = new Set<string>();
  let current = forest.byId[agentId]?.parentAgentId;
  while (current !== undefined && current !== MAIN_AGENT_ID && !seen.has(current)) {
    seen.add(current);
    const node = forest.byId[current];
    if (node === undefined) break;
    trail.unshift(node.label);
    current = node.parentAgentId;
  }
  return trail;
}
