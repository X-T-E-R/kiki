/**
 * Shared read model for the right rail's two modes.
 *
 * Every variant sees the same session through this one hook: the agent
 * fleet flattened from the forest, the session-wide pending queue, the main
 * agent's context and compactions, cost, and the user's own prompts. The
 * variants differ only in what they put first and how they draw it.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  MAIN_AGENT_ID,
  type AgentForest,
  type ApprovalBlock,
  type QuestionBlock,
  type SessionViewState,
} from '@kiki/session-core/session';

export type Family = 'opus' | 'sol' | 'luna' | 'ds' | 'other';
export type FleetState = 'waiting' | 'running' | 'done' | 'failed' | 'stopped';
export type PendingItem = ApprovalBlock | QuestionBlock;

export interface FleetAgent {
  readonly id: string;
  readonly label: string;
  readonly description: string | undefined;
  readonly model: string | undefined;
  readonly family: Family;
  readonly state: FleetState;
  readonly parentId: string;
  readonly depth: number;
  readonly startedAt: number | undefined;
  readonly endedAt: number | undefined;
  readonly summary: string | undefined;
  readonly error: string | undefined;
  readonly toolCalls: number;
}

export interface RailPrompt {
  readonly id: string;
  readonly text: string;
  readonly at: number;
}

export interface RailData {
  readonly now: number;
  readonly agents: readonly FleetAgent[];
  readonly byState: Readonly<Record<FleetState, number>>;
  readonly byFamily: Readonly<Record<Family, number>>;
  readonly pending: readonly PendingItem[];
  readonly waitingIds: ReadonlySet<string>;
  readonly contextTokens: number | undefined;
  readonly contextLimit: number | undefined;
  readonly compactions: readonly number[];
  readonly costUsd: number | undefined;
  readonly turns: number | undefined;
  readonly cacheRate: number | undefined;
  readonly prompts: readonly RailPrompt[];
  readonly mainBusy: boolean;
  readonly mainStartedAt: number | undefined;
  readonly mainSaying: string | undefined;
  readonly sessionStartedAt: number | undefined;
}

export const FAMILIES: readonly Family[] = ['opus', 'sol', 'luna', 'ds', 'other'];

/** Model family from a model id; the fleet is read by family, not by id. */
export function familyOf(model: string | undefined): Family {
  const id = (model ?? '').toLowerCase();
  if (id.includes('opus') || id.includes('claude')) return 'opus';
  if (id.includes('sol')) return 'sol';
  if (id.includes('luna')) return 'luna';
  if (id.includes('deepseek')) return 'ds';
  return 'other';
}

/** Family colour as token utilities: fill, text, and a soft wash. */
export const FAMILY_TONE: Readonly<Record<Family, { fill: string; text: string; soft: string }>> = {
  opus: { fill: 'bg-section-ink', text: 'text-section-ink', soft: 'bg-section-ink/15' },
  sol: { fill: 'bg-selected-ink', text: 'text-selected-ink', soft: 'bg-selected-ink/15' },
  luna: { fill: 'bg-amber-rule', text: 'text-amber-ink', soft: 'bg-amber-rule/20' },
  ds: { fill: 'bg-ink-faint', text: 'text-ink-soft', soft: 'bg-ink-faint/15' },
  other: { fill: 'bg-hairline-strong', text: 'text-ink-faint', soft: 'bg-hairline-strong/25' },
};

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
export function useRailData(
  state: SessionViewState,
  forest: AgentForest,
  pending: readonly PendingItem[],
): RailData {
  const now = useNow();
  return useMemo(() => {
    const waitingIds = new Set<string>();
    for (const item of pending) {
      if (item.originAgentId !== undefined && item.originAgentId !== MAIN_AGENT_ID) waitingIds.add(item.originAgentId);
    }
    const agents: FleetAgent[] = [];
    const visit = (id: string, depth: number) => {
      const node = forest.byId[id];
      if (node === undefined) return;
      if (id !== MAIN_AGENT_ID) {
        agents.push({
          id,
          label: node.label,
          description: node.description,
          model: node.model,
          family: familyOf(node.model),
          state: stateOf(node.status, waitingIds.has(id)),
          parentId: node.parentAgentId ?? MAIN_AGENT_ID,
          depth,
          startedAt: parseTime(node.startedAt),
          endedAt: parseTime(node.endedAt),
          summary: node.summary,
          error: node.error,
          toolCalls: node.toolCallCount,
        });
      }
      for (const child of node.childIds) visit(child, id === MAIN_AGENT_ID ? depth : depth + 1);
    };
    const main = forest.byId[MAIN_AGENT_ID];
    if (main !== undefined) visit(MAIN_AGENT_ID, 0);
    else for (const root of forest.roots) visit(root.agentId, 0);

    const byState: Record<FleetState, number> = { waiting: 0, running: 0, done: 0, failed: 0, stopped: 0 };
    const byFamily: Record<Family, number> = { opus: 0, sol: 0, luna: 0, ds: 0, other: 0 };
    for (const agent of agents) {
      byState[agent.state] += 1;
      byFamily[agent.family] += 1;
    }

    const compactions: number[] = [];
    const prompts: RailPrompt[] = [];
    let mainSaying: string | undefined;
    for (const block of state.blocks) {
      if (block.kind === 'notice' && block.i18n?.key.startsWith('transcript.marker.compaction') === true) {
        const at = parseTime(block.createdAt);
        if (at !== undefined) compactions.push(at);
      } else if (block.kind === 'user' && block.agentMessage === undefined && block.text.trim() !== '') {
        const at = parseTime(block.createdAt);
        if (at !== undefined) prompts.push({ id: block.id, text: block.text.trim(), at });
      } else if (block.kind === 'assistant' && block.text.trim() !== '') {
        mainSaying = block.text.trim();
      }
    }
    const usage = state.session?.usage;
    const cacheRate = usage !== undefined && usage.input_tokens + usage.cache_read_tokens > 0
      ? usage.cache_read_tokens / (usage.input_tokens + usage.cache_read_tokens)
      : undefined;
    return {
      now,
      agents,
      byState,
      byFamily,
      pending,
      waitingIds,
      contextTokens: state.contextTokens ?? usage?.context_tokens,
      contextLimit: state.maxContextTokens ?? (usage !== undefined && usage.context_limit > 0 ? usage.context_limit : undefined),
      compactions,
      costUsd: usage?.total_cost_usd,
      turns: usage?.turn_count,
      cacheRate,
      prompts,
      mainBusy: state.busy,
      mainStartedAt: state.turnStartedAt,
      mainSaying,
      sessionStartedAt: parseTime(state.session?.created_at),
    };
  }, [state.blocks, state.session, state.contextTokens, state.maxContextTokens, state.busy, state.turnStartedAt, forest, pending, now]);
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

export function money(usd: number | undefined): string | undefined {
  if (usd === undefined) return undefined;
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}

export function tokens(count: number | undefined): string {
  if (count === undefined) return '—';
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 2 : 1)}M`;
}
