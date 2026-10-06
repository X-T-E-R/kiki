/**
 * Read model for the right rail: which parts show for the viewed agent, the
 * fleet under it, the session execution graph, and the small formatting
 * helpers both overview modes use.
 *
 * The rail describes one agent at a time. Every rule that makes the main
 * agent's page differ from a subagent's lives in `railVisibility`, so the two
 * never grow separate copies of the same panel.
 *
 * The cockpit deliberately does not follow that rule. Its subject is the
 * whole current session, so it reads the forest from the root every time;
 * which agent the reader happens to have selected only marks a row.
 */

import { useEffect, useState } from 'react';

import {
  MAIN_AGENT_ID,
  type AgentForest,
  type ApprovalBlock,
  type Block,
  type QuestionBlock,
} from '@kiki/session-core/session';

/**
 * Agent state as the graph reads it. `unknown` is a real state, kept distinct
 * from `done`: an agent whose status was never reported has not finished, and
 * folding it into "done" would let a cold or partial read look like a session
 * that completed.
 */
export type FleetState = 'waiting' | 'running' | 'done' | 'failed' | 'stopped' | 'unknown';
export type PendingItem = ApprovalBlock | QuestionBlock;

export interface FleetAgent {
  readonly id: string;
  readonly label: string;
  readonly description: string | undefined;
  readonly state: FleetState;
  /** 正等待用户批准/回答(needs-you 集合);纯依赖挂起不算。 */
  readonly needsUser: boolean;
  readonly depth: number;
  readonly startedAt: number | undefined;
  readonly endedAt: number | undefined;
}

export interface LaneWindow {
  readonly start: number;
  readonly end: number;
  /** 升序刻度,含末刻度=end;2–6 个。 */
  readonly ticks: readonly number[];
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const LANE_STEPS = [
  MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  60 * MINUTE, 2 * 60 * MINUTE, 4 * 60 * MINUTE, 6 * 60 * MINUTE, 12 * 60 * MINUTE,
  DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY, 365 * DAY,
];

/** Cover the lane's known history, with at least 15 minutes and ticks anchored at now. */
export function laneWindow(input: {
  readonly starts: readonly (number | undefined)[];
  readonly markers: readonly number[];
  readonly now: number;
}): LaneWindow {
  const end = input.now;
  let start = end - 15 * MINUTE;
  for (const at of input.starts) {
    if (at !== undefined && Number.isFinite(at)) start = Math.min(start, at);
  }
  for (const at of input.markers) {
    if (Number.isFinite(at)) start = Math.min(start, at);
  }
  const span = end - start;
  const step = LANE_STEPS.find((candidate) => candidate >= span / 5)
    ?? Math.ceil(span / 5 / DAY) * DAY;
  const ticks: number[] = [];
  for (let k = Math.floor(span / step); k >= 0; k--) {
    const tick = end - k * step;
    if (tick >= start) ticks.push(tick);
  }
  return { start, end, ticks };
}

/**
 * What the rail shows for the viewed agent. Everything not listed here is
 * the same on every page.
 *
 *   openAgent       "Open agent" under Now: only when the timeline on screen
 *                   is not already this agent's own page
 *   locateSpawn     "Locate" under Now: every subagent (main was not spawned)
 *   subagentStory   Now reads the brief / result / failure of the run
 *   stopAll         bulk stop of running subagents: the main page only
 *   comms           thread messages: the main page only (the session's own)
 *   taskOwner       background tasks cancel through the viewed agent's own
 *                   task service; main uses the session default
 */
export interface RailVisibility {
  readonly isMain: boolean;
  readonly openAgent: boolean;
  readonly locateSpawn: boolean;
  readonly subagentStory: boolean;
  readonly stopAll: boolean;
  readonly comms: boolean;
  readonly taskOwner: string | undefined;
}

export function railVisibility(agentId: string, surfaceAgentId: string): RailVisibility {
  const isMain = agentId === MAIN_AGENT_ID;
  return {
    isMain,
    openAgent: !isMain && surfaceAgentId !== agentId,
    locateSpawn: !isMain,
    subagentStory: !isMain,
    stopAll: isMain,
    comms: isMain,
    taskOwner: isMain ? undefined : agentId,
  };
}

/** Everyone under `rootId` (main: the whole team), depth-first. */
export function descendantIds(forest: AgentForest, rootId: string): string[] {
  if (rootId === MAIN_AGENT_ID) return Object.keys(forest.byId).filter((id) => id !== MAIN_AGENT_ID);
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [...(forest.byId[rootId]?.childIds ?? [])].reverse();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    stack.push(...[...(forest.byId[id]?.childIds ?? [])].reverse());
  }
  return out;
}

function stateOf(status: string, waiting: boolean): FleetState {
  if (waiting || status === 'suspended') return 'waiting';
  switch (status) {
    case 'running':
    case 'background':
      return 'running';
    case 'failed':
    case 'lost':
      return 'failed';
    case 'cancelled':
      return 'stopped';
    case 'completed':
      return 'done';
    // 'unknown' and anything the wire adds later stay unknown rather than
    // being counted as finished work.
    default:
      return 'unknown';
  }
}

const parseTime = (iso: string | undefined): number | undefined => {
  if (iso === undefined || iso === '') return undefined;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? undefined : value;
};

/** The agents under `rootId` as fleet rows, depth counted from the viewed agent. */
export function fleetUnder(forest: AgentForest, rootId: string, waitingIds: ReadonlySet<string>): FleetAgent[] {
  const out: FleetAgent[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = forest.byId[id];
    if (node === undefined) return;
    out.push({
      id,
      label: node.label,
      description: node.description,
      state: stateOf(node.status, waitingIds.has(id)),
      needsUser: waitingIds.has(id),
      depth,
      startedAt: parseTime(node.startedAt),
      endedAt: parseTime(node.endedAt),
    });
    for (const child of node.childIds) visit(child, depth + 1);
  };
  const root = forest.byId[rootId];
  const top = root !== undefined ? root.childIds : rootId === MAIN_AGENT_ID ? forest.roots.map((node) => node.agentId).filter((id) => id !== MAIN_AGENT_ID) : [];
  for (const id of top) visit(id, 0);
  return out;
}

/** Agents a pending request came from (main excluded). */
export function waitingAgentIds(pending: readonly PendingItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of pending) {
    if (item.originAgentId !== undefined && item.originAgentId !== MAIN_AGENT_ID) ids.add(item.originAgentId);
  }
  return ids;
}

/**
 * How long a reader has actually been blocked, when that is knowable.
 *
 * A long-running agent is not a long wait: the API worker in the design's
 * scenario had been alive 29 minutes and had been waiting on the user for 3.
 * So the clock starts at the request's own `createdAt` and stays undefined
 * when the pending item carries no creation time, rather than borrowing the
 * agent's start.
 */
export function waitingSince(pending: readonly PendingItem[], agentId: string): number | undefined {
  const times: number[] = [];
  for (const item of pending) {
    if (item.originAgentId !== agentId) continue;
    const at = parseTime(item.request.created_at);
    if (at !== undefined) times.push(at);
  }
  return times.length === 0 ? undefined : Math.min(...times);
}

// ---------------------------------------------------------------- session graph

/** A status, in the order a reader scans them: what needs them first. */
export const STATE_ORDER: readonly FleetState[] = ['waiting', 'running', 'failed', 'stopped', 'done', 'unknown'];

export interface StatusComposition {
  readonly state: FleetState;
  readonly count: number;
  /** True for the wait that is specifically the user's to answer. */
  readonly needsUser: boolean;
}

/**
 * The whole session as one list of graph rows, folded at first-level branches.
 *
 * `expanded` holds the branch ids the reader opened; everything else stays a
 * single group row, so eight branches read as eight lines and sixty-five
 * agents read as the eight groups that contain them. Expansion only deepens
 * the same graph.
 */
export interface GraphBranch {
  readonly kind: 'branch';
  readonly id: string;
  readonly label: string;
  /** How many agents this group contains, itself included. */
  readonly size: number;
  /** States of every agent in the group, counted. Denominator = size. */
  readonly composition: readonly StatusComposition[];
  /**
   * Earliest start and latest end known anywhere in the group. This is the
   * period the group has records for, not continuous execution time: agents
   * inside it ran at different moments, and nothing here claims otherwise.
   */
  readonly from: number | undefined;
  readonly to: number | undefined;
  /** Waiting on the user from a pending request's own creation time. */
  readonly waitingSince: number | undefined;
}

export interface GraphAgent {
  readonly kind: 'agent';
  readonly id: string;
  readonly label: string;
  readonly state: FleetState;
  readonly needsUser: boolean;
  /** Depth from the main agent. */
  readonly depth: number;
  readonly startedAt: number | undefined;
  readonly endedAt: number | undefined;
  readonly waitingSince: number | undefined;
}

export interface GraphMain {
  readonly kind: 'main';
  readonly id: string;
  readonly label: string;
  readonly state: FleetState;
  /** The current turn's start; the session's own lane. */
  readonly startedAt: number | undefined;
}

export type GraphRow = GraphMain | GraphBranch | GraphAgent;

export interface SessionGraph {
  readonly rows: readonly GraphRow[];
  /** Every agent in the session, main included. The denominator for totals. */
  readonly agentCount: number;
  /** Composition over every agent, not only the visible rows. */
  readonly composition: readonly StatusComposition[];
  /** Earliest start known in the session; the axis opens here. */
  readonly from: number | undefined;
}

function compose(states: readonly { state: FleetState; needsUser: boolean }[]): StatusComposition[] {
  const counts = new Map<string, { count: number; needsUser: boolean }>();
  for (const entry of states) {
    const key = entry.state === 'waiting' && entry.needsUser ? 'waiting:you' : entry.state;
    const existing = counts.get(key);
    if (existing === undefined) counts.set(key, { count: 1, needsUser: entry.needsUser });
    else existing.count += 1;
  }
  // A wait on the user and a wait that is not the user's are different
  // obligations, so they are two segments of the same state rather than one
  // number that hides which one is theirs.
  const out: StatusComposition[] = [];
  for (const state of STATE_ORDER) {
    if (state === 'waiting') {
      const you = counts.get('waiting:you');
      if (you !== undefined) out.push({ state, count: you.count, needsUser: true });
      const other = counts.get(state);
      if (other !== undefined && other.count > 0) out.push({ state, count: other.count, needsUser: false });
      continue;
    }
    const plain = counts.get(state);
    if (plain !== undefined) out.push({ state, count: plain.count, needsUser: plain.needsUser });
  }
  return out;
}

function spanOf(nodes: readonly { startedAt: number | undefined; endedAt: number | undefined }[]) {
  let from: number | undefined;
  let to: number | undefined;
  for (const node of nodes) {
    if (node.startedAt !== undefined) from = from === undefined ? node.startedAt : Math.min(from, node.startedAt);
    const end = node.endedAt;
    if (end !== undefined) to = to === undefined ? end : Math.max(to, end);
  }
  // A group with only open-ended runs still has a latest moment: the earliest
  // start is the only thing recorded, and the axis reads it as open, not zero.
  return { from, to: to ?? from };
}

/** The branch agent and everything under it, in dispatch order. */
function collect(forest: AgentForest, rootId: string, out: FleetAgent[], seen: Set<string>): void {
  if (seen.has(rootId)) return;
  seen.add(rootId);
  const node = forest.byId[rootId];
  if (node === undefined) return;
  out.push({
    id: rootId,
    label: node.label,
    description: node.description,
    state: stateOf(node.status, false),
    needsUser: false,
    depth: 0,
    startedAt: parseTime(node.startedAt),
    endedAt: parseTime(node.endedAt),
  });
  for (const childId of node.childIds) collect(forest, childId, out, seen);
}

/**
 * The whole session as graph rows, folded to first-level branches.
 *
 * The scope is the whole forest and the main agent is the root lane: the
 * cockpit answers "how is this session going", and a selected agent is a
 * highlight, never a narrower scope. Branch labels are the labels the
 * dispatch already used; nothing here guesses a workflow phase from text.
 */
export function sessionGraph(input: {
  readonly forest: AgentForest;
  readonly pending: readonly PendingItem[];
  readonly mainState: { readonly busy: boolean; readonly turnStartedAt: number | undefined };
  readonly expanded: ReadonlySet<string>;
  readonly mainLabel: string;
}): SessionGraph {
  const { forest, pending, mainState, expanded, mainLabel } = input;
  const branches = firstLevelBranchIds(forest);
  const rows: GraphRow[] = [];
  const everything: { state: FleetState; needsUser: boolean }[] = [];
  const mainStateWord: FleetState = mainState.busy ? 'running' : 'done';
  rows.push({
    kind: 'main',
    id: MAIN_AGENT_ID,
    label: mainLabel,
    state: mainStateWord,
    startedAt: mainState.turnStartedAt,
  });
  everything.push({ state: mainStateWord, needsUser: false });
  let from = mainState.turnStartedAt;
  for (const branchId of branches) {
    const nodes: FleetAgent[] = [];
    collect(forest, branchId, nodes, new Set());
    // A branch with no agent in the forest is not a branch; an agent with no
    // children is, and must still appear.
    if (nodes.length === 0) continue;
    const enriched = nodes.map((node) => {
      const wait = waitingSince(pending, node.id);
      return {
        ...node,
        state: wait !== undefined ? 'waiting' as const : node.state,
        needsUser: wait !== undefined,
        waitingSince: wait,
      };
    });
    for (const node of enriched) {
      everything.push({ state: node.state, needsUser: node.needsUser });
    }
    if (expanded.has(branchId)) {
      for (const node of enriched) {
        rows.push({
          kind: 'agent',
          id: node.id,
          label: node.label,
          state: node.state,
          needsUser: node.needsUser,
          depth: depthIn(forest, node.id),
          startedAt: node.startedAt,
          endedAt: node.endedAt,
          waitingSince: node.waitingSince,
        });
      }
      continue;
    }
    const groupSpan = spanOf(enriched);
    // The axis covers the session's own records, main's current turn included,
    // so a session whose oldest work is a three-day-old agent is not drawn
    // from today backwards.
    for (const at of [groupSpan.from, groupSpan.to]) {
      if (at !== undefined) from = from === undefined ? at : Math.min(from, at);
    }
    rows.push({
      kind: 'branch',
      id: branchId,
      label: forest.byId[branchId]?.label ?? branchId,
      size: enriched.length,
      composition: compose(enriched),
      from: groupSpan.from,
      to: groupSpan.to,
      waitingSince: waitingSince(pending, branchId),
    });
  }
  return { rows, agentCount: everything.length, composition: compose(everything), from };
}

/** The main agent's first-level children, in dispatch order. */
export function firstLevelBranchIds(forest: AgentForest): string[] {
  const main = forest.byId[MAIN_AGENT_ID];
  if (main !== undefined) return [...main.childIds];
  return forest.roots.map((node) => node.agentId).filter((id) => id !== MAIN_AGENT_ID);
}

/**
 * Levels below the main agent, which is the graph's root and draws no lane of
 * its own in the expanded rows. So a first-level branch is depth 1 and its
 * workers depth 2, which is also how far the label is indented.
 */
function depthIn(forest: AgentForest, agentId: string): number {
  let depth = 0;
  let current: string | undefined = agentId;
  const seen = new Set<string>();
  while (current !== undefined && current !== MAIN_AGENT_ID && !seen.has(current)) {
    seen.add(current);
    depth += 1;
    current = forest.byId[current]?.parentAgentId;
  }
  return Math.max(1, depth);
}

/** The axis window: the session's own earliest known start through now. */
export function sessionWindow(from: number | undefined, now: number): LaneWindow {
  return laneWindow({ starts: [from], markers: [], now });
}

/**
 * The ticks an axis can actually print, thinned by the room each label needs.
 *
 * A label is centered on its tick, so two ticks closer than a label's width
 * read as one run-together string. Both ends always survive: the window's
 * start and `now` are what tell a reader the range, and dropping either would
 * leave the axis unanchored. Interior ticks yield to whichever neighbour was
 * printed last, so a long history thins evenly instead of dropping every other
 * label at one end.
 *
 * `labelPx` is the measured width of one label; `width` is the axis column.
 */
export function axisTicks(
  ticks: readonly number[],
  pct: (at: number) => number,
  width: number,
  labelPx: number,
): { readonly tick: number; readonly last: boolean }[] {
  if (ticks.length === 0) return [];
  const out: { tick: number; last: boolean }[] = [];
  for (const [index, tick] of ticks.entries()) {
    const last = index === ticks.length - 1;
    if (last) { out.push({ tick, last: true }); break; }
    if (index === 0) { out.push({ tick, last: false }); continue; }
    const previous = out[out.length - 1]!.tick;
    const gapPx = width === 0 ? Number.POSITIVE_INFINITY : (pct(tick) - pct(previous)) * (width / 100);
    if (gapPx < labelPx) continue;
    out.push({ tick, last: false });
  }
  return out;
}


/** Epoch ms of each context compaction in these blocks. */
export function compactionTimes(blocks: readonly Block[]): number[] {
  const out: number[] = [];
  for (const block of blocks) {
    if (block.kind === 'notice' && block.i18n?.key.startsWith('transcript.marker.compaction') === true) {
      const at = parseTime(block.createdAt);
      if (at !== undefined) out.push(at);
    }
  }
  return out;
}

/** A clock that advances every `ms` so live bars and ages keep moving. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => { setNow(Date.now()); }, ms);
    return () => { window.clearInterval(id); };
  }, [ms]);
  return now;
}

export function pendingId(item: PendingItem): string {
  return item.kind === 'approval' ? item.request.approval_id : item.request.question_id;
}

/** The object of a pending request in a few words: the command, the file, the question. */
export function pendingSubject(item: PendingItem): string {
  if (item.kind === 'question') return item.request.questions[0]?.question ?? item.request.questions[0]?.header ?? '';
  const display = item.request.tool_input_display as { command?: string; path?: string; url?: string } | null;
  if (display !== null && typeof display === 'object') {
    if (typeof display.command === 'string' && display.command !== '') return display.command.split('\n', 1)[0]!;
    if (typeof display.path === 'string' && display.path !== '') return display.path;
    if (typeof display.url === 'string' && display.url !== '') return display.url;
  }
  return item.request.action.replace(/^Run:\s*/, '');
}

/** True for a plain yes/no approval the rail may decide in place. */
export function decidable(item: PendingItem): item is ApprovalBlock {
  if (item.kind !== 'approval' || item.request.ssh !== undefined) return false;
  const display = item.request.tool_input_display as { kind?: unknown } | null;
  const kind = typeof display === 'object' && display !== null ? display.kind : undefined;
  return kind !== 'plan_enter' && kind !== 'plan_exit' && kind !== 'plan_review' && kind !== 'external_permission';
}

/** Compact age: 3m, 4h, 2d — the unit a coordinator scans by. */
export function age(ms: number, locale: 'en' | 'zh'): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return locale === 'zh' ? '刚刚' : 'now';
  if (minutes < 60) return locale === 'zh' ? `${minutes} 分` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return locale === 'zh' ? `${hours} 时` : `${hours}h`;
  return locale === 'zh' ? `${Math.floor(hours / 24)} 天` : `${Math.floor(hours / 24)}d`;
}
