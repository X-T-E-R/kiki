/**
 * Live Agent Activity & Concurrency Governance models and helpers.
 *
 * Evidence-backed by:
 *   - Live Agent Activity Backend Contract (live-agent-activity-governance-20261010):
 *     `GET /api/usage/realtime/agents`, `klient.rest.agentActivity()`,
 *     `@kiki/protocol` `agentActivitySnapshotSchema`.
 *
 * Distinguishes:
 *   - Live model requests (instantaneous API turns, resource: 'model_request') vs
 *   - In-flight agents (running episodes, resource: 'agent_execution').
 *
 * Rules:
 *   - Main agents, subagents, and independent agents are tracked in distinct columns with clear totals.
 *   - Independent agents cannot be merged into main agents (created by external delegators).
 *   - Single-dimension cuts (executor, profile, model, role, session).
 *   - Ancestor limit rejection (request.agent_ancestor_limit) guidance displayed clearly without altering user rules.
 */

import { useQuery } from '@tanstack/react-query';
import type { AgentActivitySnapshot } from '@kiki/protocol';
import { useConnection } from '../state/connection';

export type GovernanceResource = 'model_request' | 'agent_execution';

export type AgentActivityRole = 'main' | 'subagent' | 'independent';

export type AgentActivityPhase =
  | 'starting'
  | 'running'
  | 'tool_waiting'
  | 'suspended'
  | 'cancelling'
  | 'finalizing';

export type AgentActivityDimension = 'executor' | 'profile' | 'model' | 'role' | 'session';

export type LiveAgentDimensionKind = AgentActivityDimension;

export interface AgentActivityCounts {
  readonly active: number;
  readonly queued: number;
  readonly main: number;
  readonly subagent: number;
  readonly independent: number;
  readonly queuedMain: number;
  readonly queuedSubagent: number;
  readonly queuedIndependent: number;

  // Convenient aliases for UI tables and test assertions
  readonly mainActive?: number;
  readonly subActive?: number;
  readonly independentActive?: number;
  readonly totalActive?: number;
  readonly mainQueued?: number;
  readonly subQueued?: number;
  readonly independentQueued?: number;
  readonly totalQueued?: number;
}

export interface LiveAgentRow extends AgentActivityCounts {
  readonly dimension: AgentActivityDimension;
  readonly id: string | null;
  readonly label?: string;
  readonly isNative?: boolean;
}

export interface LiveAgentAgentItem {
  readonly sessionId: string;
  readonly agentId: string;
  readonly parentAgentId?: string;
  readonly executorId?: string;
  readonly profileId?: string;
  readonly modelId?: string;
  readonly providerId?: string;
  readonly role: AgentActivityRole;
  readonly phase: AgentActivityPhase;
  readonly startedAt: string;
}

export interface LiveAgentWaitingItem {
  readonly attemptId?: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly executorId?: string;
  readonly profileId?: string;
  readonly modelId?: string;
  readonly role: AgentActivityRole;
  readonly waitedMs: number;
  readonly blockingRules: readonly string[];
}

export interface ConcurrencyRule {
  readonly id: string;
  readonly resource: GovernanceResource;
  readonly scope: 'global' | 'each_session';
  readonly executors?: readonly string[];
  readonly profiles?: readonly string[];
  readonly roles?: readonly AgentActivityRole[];
  readonly models?: readonly string[];
  readonly providers?: readonly string[];
  readonly subagentsOnly?: boolean;
  readonly roleScope?: 'all' | 'main_only' | 'subagent_only';
  readonly maxConcurrent?: number;
  readonly overflow: 'queue' | 'reject';
  readonly maxWaitMs?: number;
  readonly enabled: boolean;
}

export interface LiveAgentSnapshot extends AgentActivityCounts {
  readonly domainId: string;
  readonly runtimeEpoch?: string;
  readonly seq?: number;
  readonly asOf: string;
  readonly coverage?: 'this_process';
  readonly unit?: 'agent_execution';
  readonly dimensions: readonly LiveAgentRow[];
  readonly agents?: readonly LiveAgentAgentItem[];
  readonly waiting: readonly LiveAgentWaitingItem[];
  readonly rules?: readonly ConcurrencyRule[];

  // Compatibility aliases
  readonly activeMain?: number;
  readonly activeSub?: number;
  readonly activeIndependent?: number;
  readonly activeTotal?: number;
}

export interface AgentAncestorLimitDetails {
  readonly resource: 'agent_execution';
  readonly rules: readonly string[];
  readonly occupyingAncestors: readonly {
    readonly ruleId: string;
    readonly sessionId: string;
    readonly agentId: string;
  }[];
  readonly action: 'separate_main_subagent_rules_or_raise_limit';
}

export const agentActivityStatusLabels: Readonly<Record<AgentActivityPhase, { readonly en: string; readonly zh: string }>> = {
  starting: { en: 'Starting', zh: '启动中' },
  running: { en: 'Running', zh: '运行中' },
  tool_waiting: { en: 'Tool execution / waiting', zh: '工具执行／等待' },
  suspended: { en: 'Awaiting approval', zh: '等待审批' },
  cancelling: { en: 'Cancelling', zh: '取消中' },
  finalizing: { en: 'Finalizing', zh: '收尾中' },
};

/**
 * Filter and sort rows for one selected dimension.
 */
export function agentActivityRows(snapshot: LiveAgentSnapshot, dimension: AgentActivityDimension): readonly LiveAgentRow[] {
  return snapshot.dimensions
    .filter((row) => row.dimension === dimension)
    .sort((a, b) => b.active - a.active || b.queued - a.queued || (a.id ?? '').localeCompare(b.id ?? ''));
}

/**
 * Replace one resource's rules without deleting the other view's rules.
 */
export function replaceConcurrencyResourceRules(
  current: readonly ConcurrencyRule[],
  resource: GovernanceResource,
  replacement: readonly ConcurrencyRule[],
): ConcurrencyRule[] {
  if (replacement.some((rule) => rule.resource !== resource)) {
    throw new Error('Rule resource does not match the selected view.');
  }
  const preserved = current.filter((rule) => rule.resource !== resource);
  const ids = new Set(preserved.map((rule) => rule.id));
  for (const rule of replacement) {
    if (ids.has(rule.id)) throw new Error(`Rule ID already exists: ${rule.id}`);
    ids.add(rule.id);
  }
  return [...preserved, ...replacement];
}

/**
 * Formats full rule list to RequestGovernanceConfigPatch shape for POST /api/config.
 */
export function concurrencyRulesPatch(rules: readonly ConcurrencyRule[]): { rules: Record<string, unknown>[] } {
  return {
    rules: rules.map((rule) => {
      const raw: Record<string, unknown> = { ...rule };
      const rawResource = raw['resource'];
      const resource = rawResource === 'live_agent' ? 'agent_execution' : (rawResource ?? 'model_request');
      return {
        id: rule.id,
        resource,
        scope: rule.scope,
        models: rule.models === undefined ? undefined : [...rule.models],
        providers: rule.providers === undefined ? undefined : [...rule.providers],
        executors: rule.executors === undefined ? undefined : [...rule.executors],
        profiles: rule.profiles === undefined ? undefined : [...rule.profiles],
        roles: rule.roles === undefined ? undefined : [...rule.roles],
        subagents_only: rule.subagentsOnly ?? (typeof raw['subagents_only'] === 'boolean' ? raw['subagents_only'] : undefined),
        max_concurrent: rule.maxConcurrent ?? (typeof raw['max_concurrent'] === 'number' ? raw['max_concurrent'] : undefined),
        overflow: rule.overflow,
        max_wait_ms: rule.maxWaitMs ?? (typeof raw['max_wait_ms'] === 'number' ? raw['max_wait_ms'] : undefined),
        enabled: rule.enabled,
      };
    }),
  };
}

/**
 * Maps a typed protocol AgentActivitySnapshot into the GUI LiveAgentSnapshot shape.
 */
export function normalizeLiveAgentSnapshot(raw: AgentActivitySnapshot | null | undefined): LiveAgentSnapshot | null {
  if (!raw) return null;
  const dimensions: LiveAgentRow[] = raw.dimensions.map((d) => ({
    dimension: d.dimension,
    id: d.id,
    active: d.active,
    queued: d.queued,
    main: d.main,
    subagent: d.subagent,
    independent: d.independent,
    queuedMain: d.queuedMain,
    queuedSubagent: d.queuedSubagent,
    queuedIndependent: d.queuedIndependent,
    mainActive: d.main,
    subActive: d.subagent,
    independentActive: d.independent,
    totalActive: d.active,
    mainQueued: d.queuedMain,
    subQueued: d.queuedSubagent,
    independentQueued: d.queuedIndependent,
    totalQueued: d.queued,
  }));

  const rules: ConcurrencyRule[] = raw.rules.map((rule) => ({
    ...rule,
    resource: rule.resource ?? 'model_request',
  }));

  return {
    domainId: raw.domainId,
    runtimeEpoch: raw.runtimeEpoch,
    seq: raw.seq,
    asOf: raw.asOf,
    coverage: raw.coverage,
    unit: raw.unit,
    active: raw.active,
    queued: raw.queued,
    main: raw.main,
    subagent: raw.subagent,
    independent: raw.independent,
    queuedMain: raw.queuedMain,
    queuedSubagent: raw.queuedSubagent,
    queuedIndependent: raw.queuedIndependent,
    dimensions,
    agents: raw.agents,
    waiting: raw.waiting,
    rules,
    mainActive: raw.main,
    subActive: raw.subagent,
    independentActive: raw.independent,
    totalActive: raw.active,
    mainQueued: raw.queuedMain,
    subQueued: raw.queuedSubagent,
    independentQueued: raw.queuedIndependent,
    totalQueued: raw.queued,
    activeMain: raw.main,
    activeSub: raw.subagent,
    activeIndependent: raw.independent,
    activeTotal: raw.active,
  };
}

/**
 * Hook to retrieve live agent activity snapshot from client.getAgentActivity().
 */
export function useLiveAgentGovernance(options?: { readonly enabled?: boolean }) {
  const { client, scopeId, wsStatus } = useConnection();
  const query = useQuery({
    queryKey: ['live-agent-governance', scopeId],
    queryFn: async (): Promise<LiveAgentSnapshot | null> => {
      if (typeof client.getAgentActivity !== 'function') return null;
      const raw = await client.getAgentActivity();
      return normalizeLiveAgentSnapshot(raw);
    },
    refetchInterval: 1000,
    retry: false,
    enabled: options?.enabled ?? true,
  });

  return {
    snapshot: query.data,
    loading: query.isPending,
    isError: query.isError,
    stale: query.isError || wsStatus !== 'open',
    refetch: query.refetch,
  };
}
