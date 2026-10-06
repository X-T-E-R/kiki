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
 * Ordering: agents that need the user, then running; ended agents fold into
 * one "N finished" group at the end once there are more than three of them.
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
  readonly count: number;
  readonly open: boolean;
}

export type RosterRow = RosterAgentRow | RosterGroupRow;

export interface RosterModel {
  readonly counts: Readonly<Record<RosterBucket, number>>;
  readonly total: number;
  readonly rows: readonly RosterRow[];
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
  /** The trailing "N finished" group is open. */
  readonly doneOpen: boolean;
}

function childrenOf(forest: AgentForest, rootId: string): AgentTreeNode[] {
  if (rootId === MAIN_AGENT_ID) {
    const main = forest.byId[MAIN_AGENT_ID];
    // Subagents hang under main when main is known; otherwise every root that
    // is not main is a top-level team member.
    const ids = main !== undefined
      ? main.childIds
      : forest.roots.map((root) => root.agentId);
    const extra = main !== undefined ? forest.roots.filter((root) => root.agentId !== MAIN_AGENT_ID) : [];
    return [...ids.flatMap((id) => (forest.byId[id] === undefined ? [] : [forest.byId[id]!])), ...extra];
  }
  return (forest.byId[rootId]?.childIds ?? []).flatMap((id) => (forest.byId[id] === undefined ? [] : [forest.byId[id]!]));
}

function matches(node: AgentTreeNode, needle: string): boolean {
  if (needle === '') return true;
  return [node.label, node.name, node.description, node.model, node.summary, node.error]
    .some((value) => value !== undefined && value.toLowerCase().includes(needle));
}

/** Epoch ms of an ISO time; unknown sorts oldest. */
function timeOf(iso: string | undefined): number {
  const value = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(value) ? value : 0;
}

export function buildRoster(input: RosterInput): RosterModel {
  const { forest, rootId, waiting, expanded, filter, doneOpen } = input;
  const needle = input.query.trim().toLowerCase();
  const counts: Record<RosterBucket, number> = { waiting: 0, running: 0, idle: 0, unknown: 0, ended: 0 };
  const bucketOf = new Map<string, RosterBucket>();
  const subtreeRank = new Map<string, number>();
  const waitingBelow = new Map<string, number>();
  const kids = new Map<string, AgentTreeNode[]>();
  const seen = new Set<string>([rootId]);

  // One post-order pass: bucket, subtree urgency, waiting descendants.
  const visit = (node: AgentTreeNode): void => {
    const bucket = rosterBucket(node, waiting);
    bucketOf.set(node.agentId, bucket);
    counts[bucket] += 1;
    const children = node.childIds.flatMap((id) => {
      const child = forest.byId[id];
      if (child === undefined || seen.has(id)) return [];
      seen.add(id);
      return [child];
    });
    let rank = RANK[bucket];
    let below = 0;
    for (const child of children) {
      visit(child);
      rank = Math.min(rank, subtreeRank.get(child.agentId)!);
      below += waitingBelow.get(child.agentId)! + (bucketOf.get(child.agentId) === 'waiting' ? 1 : 0);
    }
    subtreeRank.set(node.agentId, rank);
    waitingBelow.set(node.agentId, below);
    kids.set(node.agentId, children);
  };
  const top = childrenOf(forest, rootId).filter((node) => {
    if (seen.has(node.agentId)) return false;
    seen.add(node.agentId);
    return true;
  });
  for (const node of top) visit(node);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

  // Within a rank, the most recently updated first: a node's update time is
  // the latest start or end anywhere in its subtree.
  const updatedAt = new Map<string, number>();
  const stamp = (node: AgentTreeNode): number => {
    const known = updatedAt.get(node.agentId);
    if (known !== undefined) return known;
    const own = Math.max(timeOf(node.endedAt), timeOf(node.startedAt));
    const value = Math.max(own, ...(kids.get(node.agentId) ?? []).map(stamp));
    updatedAt.set(node.agentId, value);
    return value;
  };
  const byUrgency = (list: readonly AgentTreeNode[]) =>
    list
      .map((node, index) => ({ node, index }))
      .sort((a, b) => subtreeRank.get(a.node.agentId)! - subtreeRank.get(b.node.agentId)! || stamp(b.node) - stamp(a.node) || a.index - b.index)
      .map((entry) => entry.node);

  const rowFor = (node: AgentTreeNode, depth: number, path: readonly string[]): RosterAgentRow => ({
    kind: 'agent',
    node,
    bucket: bucketOf.get(node.agentId)!,
    depth,
    childCount: kids.get(node.agentId)?.length ?? 0,
    expanded: expanded.has(node.agentId),
    waitingBelow: waitingBelow.get(node.agentId) ?? 0,
    path,
  });

  const rows: RosterRow[] = [];
  if (filter !== 'all' || needle !== '') {
    const flat: { row: RosterAgentRow; rank: number; order: number }[] = [];
    let order = 0;
    const walk = (node: AgentTreeNode, path: readonly string[]): void => {
      const bucket = bucketOf.get(node.agentId)!;
      if ((filter === 'all' || bucket === filter) && matches(node, needle)) {
        flat.push({ row: { ...rowFor(node, 0, path), expanded: false, childCount: 0 }, rank: RANK[bucket], order: order++ });
      }
      for (const child of kids.get(node.agentId) ?? []) walk(child, [...path, node.label]);
    };
    for (const node of top) walk(node, []);
    flat.sort((a, b) => a.rank - b.rank || stamp(b.row.node) - stamp(a.row.node) || a.order - b.order);
    return { counts, total, rows: flat.map((entry) => entry.row) };
  }

  const emit = (node: AgentTreeNode, depth: number): void => {
    const row = rowFor(node, depth, []);
    rows.push(row);
    if (!row.expanded) return;
    for (const child of byUrgency(kids.get(node.agentId) ?? [])) emit(child, depth + 1);
  };
  const ordered = byUrgency(top);
  const active = ordered.filter((node) => subtreeRank.get(node.agentId)! < RANK.ended);
  const settled = ordered.filter((node) => subtreeRank.get(node.agentId)! === RANK.ended);
  for (const node of active) emit(node, 0);
  if (settled.length > 0) {
    // A handful of settled agents is not worth a fold.
    if (settled.length <= 3) {
      for (const node of settled) emit(node, 0);
    } else {
      rows.push({ kind: 'group', count: settled.length, open: doneOpen });
      if (doneOpen) for (const node of settled) emit(node, 0);
    }
  }
  return { counts, total, rows };
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
