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
      const anyRule = rule as Record<string, unknown>;
      const rawResource = anyRule.resource;
      const resource = rawResource === 'live_agent' ? 'agent_execution' : (rawResource ?? 'model_request');
      return {
        id: rule.id,
        resource,
        scope: rule.scope,
        ...(rule.models !== undefined ? { models: [...rule.models] } : {}),
        ...(rule.providers !== undefined ? { providers: [...rule.providers] } : {}),
        ...(rule.executors !== undefined ? { executors: [...rule.executors] } : {}),
        ...(rule.profiles !== undefined ? { profiles: [...rule.profiles] } : {}),
        ...(rule.roles !== undefined ? { roles: [...rule.roles] } : {}),
        ...(rule.subagentsOnly !== undefined || anyRule.subagents_only !== undefined
          ? { subagents_only: Boolean(rule.subagentsOnly ?? anyRule.subagents_only) }
          : {}),
        ...(rule.maxConcurrent !== undefined || anyRule.max_concurrent !== undefined
          ? { max_concurrent: rule.maxConcurrent ?? anyRule.max_concurrent }
          : {}),
        overflow: rule.overflow,
        ...(rule.maxWaitMs !== undefined || anyRule.max_wait_ms !== undefined
          ? { max_wait_ms: rule.maxWaitMs ?? anyRule.max_wait_ms }
          : {}),
        enabled: rule.enabled,
      };
    }),
  };
}

/**
 * Normalizes live agent activity snapshot so main/subagent/independent and queued fields are always populated.
 */
export function normalizeLiveAgentSnapshot(raw: any): LiveAgentSnapshot | null {
  if (!raw) return null;
  const active = typeof raw.active === 'number' ? raw.active : (raw.totalActive ?? raw.activeTotal ?? 0);
  const queued = typeof raw.queued === 'number' ? raw.queued : (raw.totalQueued ?? raw.queuedTotal ?? 0);
  const main = typeof raw.main === 'number' ? raw.main : (raw.mainActive ?? raw.activeMain ?? 0);
  const subagent = typeof raw.subagent === 'number' ? raw.subagent : (raw.subActive ?? raw.activeSub ?? 0);
  const independent = typeof raw.independent === 'number' ? raw.independent : (raw.independentActive ?? raw.activeIndependent ?? 0);

  const queuedMain = typeof raw.queuedMain === 'number' ? raw.queuedMain : (raw.mainQueued ?? 0);
  const queuedSubagent = typeof raw.queuedSubagent === 'number' ? raw.queuedSubagent : (raw.subQueued ?? 0);
  const queuedIndependent = typeof raw.queuedIndependent === 'number' ? raw.queuedIndependent : (raw.independentQueued ?? 0);

  const rawDimensions: any[] = Array.isArray(raw.dimensions) ? raw.dimensions : [];
  const dimensions: LiveAgentRow[] = rawDimensions.map((d) => {
    const dActive = typeof d.active === 'number' ? d.active : (d.totalActive ?? (d.mainActive ?? 0) + (d.subActive ?? 0) + (d.independentActive ?? 0));
    const dQueued = typeof d.queued === 'number' ? d.queued : (d.totalQueued ?? 0);
    const dMain = typeof d.main === 'number' ? d.main : (d.mainActive ?? 0);
    const dSub = typeof d.subagent === 'number' ? d.subagent : (d.subActive ?? 0);
    const dInd = typeof d.independent === 'number' ? d.independent : (d.independentActive ?? 0);
    return {
      dimension: d.dimension,
      id: d.id,
      label: d.label,
      isNative: d.isNative,
      active: dActive,
      queued: dQueued,
      main: dMain,
      subagent: dSub,
      independent: dInd,
      queuedMain: d.queuedMain ?? d.mainQueued ?? 0,
      queuedSubagent: d.queuedSubagent ?? d.subQueued ?? 0,
      queuedIndependent: d.queuedIndependent ?? d.independentQueued ?? 0,
      mainActive: dMain,
      subActive: dSub,
      independentActive: dInd,
      totalActive: dActive,
      mainQueued: d.queuedMain ?? d.mainQueued ?? 0,
      subQueued: d.queuedSubagent ?? d.subQueued ?? 0,
      independentQueued: d.queuedIndependent ?? d.independentQueued ?? 0,
      totalQueued: dQueued,
    };
  });

  return {
    domainId: raw.domainId ?? 'this-service',
    runtimeEpoch: raw.runtimeEpoch,
    seq: raw.seq,
    asOf: raw.asOf ?? new Date().toISOString(),
    coverage: raw.coverage ?? 'this_process',
    unit: raw.unit ?? 'agent_execution',
    active,
    queued,
    main,
    subagent,
    independent,
    queuedMain,
    queuedSubagent,
    queuedIndependent,
    dimensions,
    agents: raw.agents ?? [],
    waiting: raw.waiting ?? [],
    rules: raw.rules ?? [],
    mainActive: main,
    subActive: subagent,
    independentActive: independent,
    totalActive: active,
    mainQueued: queuedMain,
    subQueued: queuedSubagent,
    independentQueued: queuedIndependent,
    totalQueued: queued,
    activeMain: main,
    activeSub: subagent,
    activeIndependent: independent,
    activeTotal: active,
  };
}

/**
 * Hook to retrieve live agent activity snapshot.
 * Binds to client.getAgentActivity() or client.getLiveAgentGovernance().
 */
export function useLiveAgentGovernance(options?: { readonly enabled?: boolean }) {
  const { client, scopeId, wsStatus } = useConnection();
  const query = useQuery({
    queryKey: ['live-agent-governance', scopeId],
    queryFn: async (): Promise<LiveAgentSnapshot | null> => {
      const anyClient = client as unknown as {
        getAgentActivity?: () => Promise<LiveAgentSnapshot>;
        getLiveAgentGovernance?: () => Promise<LiveAgentSnapshot>;
      };
      if (typeof anyClient.getAgentActivity === 'function') {
        const raw = await anyClient.getAgentActivity();
        return normalizeLiveAgentSnapshot(raw);
      }
      if (typeof anyClient.getLiveAgentGovernance === 'function') {
        const raw = await anyClient.getLiveAgentGovernance();
        return normalizeLiveAgentSnapshot(raw);
      }
      return null;
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
