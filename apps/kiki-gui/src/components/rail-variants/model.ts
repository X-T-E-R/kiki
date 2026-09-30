/**
 * Read model for the right rail: which parts show for the viewed agent, the
 * fleet under it, and the small formatting helpers both overview modes use.
 *
 * The rail describes one agent at a time. Every rule that makes the main
 * agent's page differ from a subagent's lives in `railVisibility`, so the two
 * never grow separate copies of the same panel.
 */

import { useEffect, useState } from 'react';

import {
  MAIN_AGENT_ID,
  type AgentForest,
  type ApprovalBlock,
  type Block,
  type QuestionBlock,
} from '@kiki/session-core/session';

export type FleetState = 'waiting' | 'running' | 'done' | 'failed' | 'stopped';
export type PendingItem = ApprovalBlock | QuestionBlock;

export interface FleetAgent {
  readonly id: string;
  readonly label: string;
  readonly description: string | undefined;
  readonly state: FleetState;
  /** Levels below the viewed agent (its own children are 0). */
  readonly depth: number;
  readonly startedAt: number | undefined;
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
      return 'failed';
    case 'cancelled':
      return 'stopped';
    default:
      return 'done';
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
      depth,
      startedAt: parseTime(node.startedAt),
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
