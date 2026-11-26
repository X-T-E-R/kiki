import type { ModelCatalogItem, RequestGovernanceSnapshot } from '@kiki/protocol';
import { roomRefLink, type InboxItem, type InboxReason } from '@kiki/session-core/sessions';
import { resolveCatalogModel } from '@kiki/session-core/settings';

import type { ExecutionControlState } from '../../lib/executionControls';
import {
  agentActivityStatusLabels,
  type AgentActivityPhase,
  type ConcurrencyRule,
  type LiveAgentAgentItem,
  type LiveAgentSnapshot,
  type LiveAgentWaitingItem,
} from '../../lib/liveAgentGovernance';
import { sanitizeDisplayTitle } from '../../lib/threadTitles';
import type { SessionLabel } from './ExecutionControls';

export interface FormattedModelLabel {
  readonly display: string;
  readonly technical?: string;
}

/**
 * Format a wire model ID into a human-readable catalog display name without
 * exposing raw provider prefixes (`gateway/model-pro`) as default titles.
 */
export function formatRuntimeModelLabel(
  modelId: string | null | undefined,
  models: readonly ModelCatalogItem[],
  unknownLabel: string,
): FormattedModelLabel {
  const trimmed = modelId?.trim() ?? '';
  if (trimmed === '' || trimmed === 'unknown') {
    return { display: unknownLabel };
  }
  const resolved = resolveCatalogModel(models, trimmed);
  if (resolved?.display_name !== undefined && resolved.display_name.trim() !== '') {
    return { display: resolved.display_name.trim(), technical: trimmed };
  }
  const tail = trimmed.includes('/') ? (trimmed.split('/').pop()?.trim() ?? '') : trimmed;
  if (tail !== '' && !/^[a-f0-9-]{16,}$/i.test(tail)) {
    const human = tail
      .replace(/[-_]+/g, ' ')
      .replace(/\b([a-z])/g, (m) => m.toUpperCase());
    return { display: human, technical: trimmed };
  }
  return { display: unknownLabel, technical: trimmed };
}

export type LiveConcurrencyDimension = 'model' | 'provider' | 'executor' | 'role';

export interface LiveConcurrencyBucketRow {
  readonly key: string;
  readonly id: string;
  readonly dimension: LiveConcurrencyDimension;
  readonly display: string;
  readonly technical?: string;
  readonly active: number;
  readonly queued: number;
  readonly activeAgents?: number;
  readonly limit?: number;
  readonly ruleId?: string;
  readonly subDetail?: string;
}

export interface LivePressuredRuleRow {
  readonly ruleId: string;
  readonly resource: ConcurrencyRule['resource'];
  readonly scope: ConcurrencyRule['scope'];
  readonly targetSummary: string;
  readonly active: number;
  readonly limit: number;
  readonly queued: number;
}

export interface LiveConcurrencyProjection {
  readonly availableDimensions: readonly LiveConcurrencyDimension[];
  readonly defaultDimension: LiveConcurrencyDimension;
  readonly rowsByDimension: Readonly<Record<LiveConcurrencyDimension, readonly LiveConcurrencyBucketRow[]>>;
  readonly pressuredRules: readonly LivePressuredRuleRow[];
}

export interface LivePendingRow {
  readonly key: string;
  readonly sessionId: string;
  readonly roomId?: string;
  readonly title: string;
  readonly reason: InboxReason;
  readonly href: string;
  readonly runningAgentCount: number;
  readonly activeRequests: number;
  readonly startedAtMs?: number;
  readonly executionState?: ExecutionControlState;
}

export interface LiveSessionAgentLink {
  readonly agentId: string;
  readonly role: LiveAgentAgentItem['role'];
  readonly phase: AgentActivityPhase;
  readonly profileId?: string;
  readonly modelDisplay?: string;
  readonly modelTechnical?: string;
  readonly href: string;
}

export interface LiveSessionRow {
  readonly sessionId: string;
  readonly label: SessionLabel;
  readonly href: string;
  readonly priorityBucket: 0 | 1 | 2;
  readonly phaseLabel: string;
  readonly phaseKind: 'queued' | 'running' | 'paused' | 'pausing' | 'failed' | 'suspended';
  readonly activeRequests: number;
  readonly queuedRequests: number;
  readonly modelDisplay?: string;
  readonly modelTechnical?: string;
  readonly startedAtMs?: number;
  readonly waitedMs?: number;
  readonly agents: readonly LiveSessionAgentLink[];
  readonly extraAgentCount: number;
  readonly blockingRules: readonly string[];
  readonly waiterAttemptIds: readonly string[];
  readonly executionState?: ExecutionControlState;
}

export interface LiveRuntimeProjection {
  readonly pendingRows: readonly LivePendingRow[];
  readonly sessionRows: readonly LiveSessionRow[];
  readonly unattributedWaiters: readonly RequestGovernanceSnapshot['waiting'][number][];
  readonly concurrency: LiveConcurrencyProjection;
}

function parseTimestamp(iso: string | undefined): number | undefined {
  if (iso === undefined || iso === '') return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function agentRank(agent: LiveAgentAgentItem): number {
  if (agent.role === 'main') return 0;
  if (agent.phase === 'tool_waiting' || agent.phase === 'running') return 1;
  if (agent.phase === 'suspended') return 2;
  return 3;
}

export function sessionHref(sessionId: string, agentId?: string): string {
  const base = `/s/${encodeURIComponent(sessionId)}`;
  if (agentId !== undefined && agentId !== '' && agentId !== 'main') {
    return `${base}/agent/${encodeURIComponent(agentId)}`;
  }
  return base;
}

function formatExecutorDisplay(
  id: string | null | undefined,
  kikiLabel: string,
  unknownLabel: string,
): { display: string; technical?: string } {
  const trimmed = id?.trim() ?? '';
  if (trimmed === '' || trimmed === 'unknown') return { display: unknownLabel };
  const lower = trimmed.toLowerCase();
  if (lower === 'kiki' || lower === 'builtin' || lower === 'native' || lower === 'local') {
    return { display: kikiLabel, technical: trimmed };
  }
  return { display: trimmed, technical: trimmed };
}

function findDirectBucketCapRule(
  enabledRules: readonly ConcurrencyRule[],
  dimension: LiveConcurrencyDimension,
  bucketId: string,
  blockedCounts: ReadonlyMap<string, number>,
): { readonly limit: number; readonly ruleId: string } | undefined {
  const candidates: ConcurrencyRule[] = [];
  for (const rule of enabledRules) {
    if (rule.scope !== 'global' || typeof rule.maxConcurrent !== 'number' || rule.maxConcurrent <= 0) continue;
    if (dimension === 'model' && rule.resource === 'model_request') {
      if (rule.subagentsOnly || (rule.roles !== undefined && rule.roles.length > 0 && rule.roles.length < 3)) continue;
      if (rule.models?.length === 1 && rule.models[0] === bucketId) {
        const provOk = !rule.providers?.length || (rule.providers.length === 1 && bucketId.startsWith(`${rule.providers[0]}/`));
        if (provOk) candidates.push(rule);
      }
    } else if (dimension === 'provider' && rule.resource === 'model_request') {
      if (rule.subagentsOnly || rule.models?.length || (rule.roles !== undefined && rule.roles.length > 0 && rule.roles.length < 3)) continue;
      if (rule.providers?.length === 1 && rule.providers[0] === bucketId) {
        candidates.push(rule);
      }
    } else if (dimension === 'role' && rule.resource === 'model_request') {
      if (rule.models?.length || rule.providers?.length) continue;
      if (bucketId === 'subagent' && (rule.subagentsOnly === true || (rule.roles?.length === 1 && rule.roles[0] === 'subagent'))) {
        candidates.push(rule);
      } else if ((bucketId === 'root' || bucketId === 'main') && !rule.subagentsOnly && rule.roles?.length === 1 && rule.roles[0] === 'main') {
        candidates.push(rule);
      }
    } else if (dimension === 'executor' && rule.resource === 'agent_execution') {
      if (rule.subagentsOnly || rule.profiles?.length || rule.models?.length || rule.providers?.length) continue;
      if (rule.roles !== undefined && rule.roles.length > 0 && rule.roles.length < 3) continue;
      if (rule.executors?.length === 1 && rule.executors[0]!.toLowerCase() === bucketId.toLowerCase()) {
        candidates.push(rule);
      }
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => {
    const aBlocked = blockedCounts.get(a.id) ?? 0;
    const bBlocked = blockedCounts.get(b.id) ?? 0;
    if (aBlocked !== bBlocked) return bBlocked - aBlocked;
    return (a.maxConcurrent ?? Number.MAX_SAFE_INTEGER) - (b.maxConcurrent ?? Number.MAX_SAFE_INTEGER);
  });
  const chosen = candidates[0]!;
  return { limit: chosen.maxConcurrent!, ruleId: chosen.id };
}

function summarizeRuleTarget(
  rule: ConcurrencyRule,
  models: readonly ModelCatalogItem[],
  locale: 'zh' | 'en',
  unknownModelLabel: string,
  executorKikiLabel: string,
  unknownExecutorLabel: string,
): string {
  const parts: string[] = [];
  if (rule.models?.length) {
    parts.push(rule.models.map((m) => formatRuntimeModelLabel(m, models, unknownModelLabel).display).join(', '));
  }
  if (rule.providers?.length) {
    parts.push(rule.providers.join(', '));
  }
  if (rule.executors?.length) {
    parts.push(rule.executors.map((e) => formatExecutorDisplay(e, executorKikiLabel, unknownExecutorLabel).display).join(', '));
  }
  if (rule.profiles?.length) {
    parts.push(rule.profiles.join(', '));
  }
  if (rule.subagentsOnly) {
    parts.push(locale === 'zh' ? '仅子智能体' : 'Subagents only');
  } else if (rule.roles?.length && rule.roles.length < 3) {
    parts.push(rule.roles.join(', '));
  }
  if (rule.scope === 'each_session') {
    parts.push(locale === 'zh' ? '每会话' : 'Each session');
  }
  if (parts.length === 0) {
    return rule.resource === 'agent_execution'
      ? (locale === 'zh' ? '全部智能体' : 'All agents')
      : (locale === 'zh' ? '全部请求' : 'All requests');
  }
  return parts.join(' · ');
}

function computeRuleActiveCount(
  rule: ConcurrencyRule,
  requestSnapshot: RequestGovernanceSnapshot | undefined,
  agentSnapshot: LiveAgentSnapshot | null | undefined,
  queuedForRule: number,
): number | undefined {
  const cap = rule.maxConcurrent ?? 0;
  if (rule.scope === 'each_session') {
    return queuedForRule > 0 && cap > 0 ? cap : undefined;
  }
  if (rule.resource === 'model_request') {
    if (requestSnapshot === undefined) return undefined;
    const dims = requestSnapshot.dimensions;
    if (rule.models?.length && !rule.subagentsOnly && !(rule.roles?.length)) {
      const allowedProviders = rule.providers?.length ? new Set(rule.providers) : null;
      const modelSet = new Set(rule.models);
      return dims
        .filter((d) => d.dimension === 'model' && modelSet.has(d.id) && (allowedProviders === null || [...allowedProviders].some((p) => d.id.startsWith(`${p}/`))))
        .reduce((sum, d) => sum + d.active, 0);
    }
    if (rule.providers?.length && !rule.models?.length && !rule.subagentsOnly && !(rule.roles?.length)) {
      const provSet = new Set(rule.providers);
      return dims
        .filter((d) => d.dimension === 'provider' && provSet.has(d.id))
        .reduce((sum, d) => sum + d.active, 0);
    }
    if (!rule.models?.length && !rule.providers?.length) {
      if (rule.subagentsOnly || (rule.roles?.length === 1 && rule.roles[0] === 'subagent')) {
        return dims.find((d) => d.dimension === 'role' && d.id === 'subagent')?.active ?? 0;
      }
      if (!rule.roles?.length || rule.roles.length >= 3) {
        return requestSnapshot.active;
      }
    }
    return undefined;
  }

  // agent_execution (global)
  if (agentSnapshot === null || agentSnapshot === undefined) return undefined;
  if (agentSnapshot.agents !== undefined && agentSnapshot.agents.length > 0) {
    const execSet = rule.executors?.length ? new Set(rule.executors.map((e) => e.toLowerCase())) : null;
    const profSet = rule.profiles?.length ? new Set(rule.profiles) : null;
    const modelSet = rule.models?.length ? new Set(rule.models) : null;
    const provSet = rule.providers?.length ? new Set(rule.providers) : null;
    const roleSet = rule.subagentsOnly
      ? new Set(['subagent'])
      : rule.roles?.length
        ? new Set(rule.roles)
        : null;
    return agentSnapshot.agents.filter((agent) => {
      if (execSet !== null) {
        const agentExec = (agent.executorId ?? 'kiki').toLowerCase();
        const isKikiAlias = (agentExec === 'kiki' || agentExec === 'builtin' || agentExec === 'native' || agentExec === 'local')
          && (execSet.has('kiki') || execSet.has('builtin') || execSet.has('native') || execSet.has('local'));
        if (!execSet.has(agentExec) && !isKikiAlias) return false;
      }
      if (profSet !== null && (agent.profileId === undefined || !profSet.has(agent.profileId))) return false;
      if (modelSet !== null && (agent.modelId === undefined || !modelSet.has(agent.modelId))) return false;
      if (provSet !== null && (agent.providerId === undefined || !provSet.has(agent.providerId))) return false;
      if (roleSet !== null && !roleSet.has(agent.role)) return false;
      return true;
    }).length;
  }

  const agDims = agentSnapshot.dimensions;
  if (rule.executors?.length && !rule.profiles?.length && !rule.models?.length && !rule.subagentsOnly && !(rule.roles?.length)) {
    const execSet = new Set(rule.executors.map((e) => e.toLowerCase()));
    return agDims
      .filter((d) => d.dimension === 'executor' && d.id !== null && execSet.has(d.id.toLowerCase()))
      .reduce((sum, d) => sum + (d.totalActive ?? d.active ?? 0), 0);
  }
  if (rule.profiles?.length && !rule.executors?.length && !rule.models?.length && !rule.subagentsOnly && !(rule.roles?.length)) {
    const profSet = new Set(rule.profiles);
    return agDims
      .filter((d) => d.dimension === 'profile' && d.id !== null && profSet.has(d.id))
      .reduce((sum, d) => sum + (d.totalActive ?? d.active ?? 0), 0);
  }
  if (!rule.executors?.length && !rule.profiles?.length && !rule.models?.length && !rule.providers?.length) {
    if (rule.subagentsOnly || (rule.roles?.length === 1 && rule.roles[0] === 'subagent')) {
      return agentSnapshot.subActive ?? agentSnapshot.subagent ?? 0;
    }
    if (!rule.roles?.length || rule.roles.length >= 3) {
      return agentSnapshot.totalActive ?? agentSnapshot.active ?? 0;
    }
  }
  return undefined;
}

export function projectLiveConcurrency({
  requestSnapshot,
  agentSnapshot,
  rules,
  models,
  locale,
  unknownModelLabel,
  roleRootLabel,
  roleSubagentLabel,
  executorKikiLabel,
  unknownExecutorLabel,
}: {
  readonly requestSnapshot: RequestGovernanceSnapshot | undefined;
  readonly agentSnapshot: LiveAgentSnapshot | null | undefined;
  readonly rules: readonly ConcurrencyRule[];
  readonly models: readonly ModelCatalogItem[];
  readonly locale: 'zh' | 'en';
  readonly unknownModelLabel: string;
  readonly roleRootLabel: string;
  readonly roleSubagentLabel: string;
  readonly executorKikiLabel: string;
  readonly unknownExecutorLabel: string;
}): LiveConcurrencyProjection {
  const enabledRules = rules.filter((r) => r.enabled && typeof r.maxConcurrent === 'number' && r.maxConcurrent > 0);
  const blockedCounts = new Map<string, number>();
  for (const w of requestSnapshot?.waiting ?? []) {
    for (const rid of w.blockingRules) blockedCounts.set(rid, (blockedCounts.get(rid) ?? 0) + 1);
  }
  for (const w of agentSnapshot?.waiting ?? []) {
    for (const rid of w.blockingRules) blockedCounts.set(rid, (blockedCounts.get(rid) ?? 0) + 1);
  }

  const reqDims = (requestSnapshot?.dimensions ?? []).filter((d) => d.dimension !== 'session' && (d.active > 0 || d.queued > 0));

  const activeAgentsByModel = new Map<string, number>();
  const activeAgentsByProvider = new Map<string, number>();
  let activeMainAgents = 0;
  let activeSubAgents = 0;
  for (const agent of agentSnapshot?.agents ?? []) {
    if (agent.phase !== 'running' && agent.phase !== 'tool_waiting') continue;
    if (agent.modelId !== undefined && agent.modelId !== '') {
      activeAgentsByModel.set(agent.modelId, (activeAgentsByModel.get(agent.modelId) ?? 0) + 1);
    }
    if (agent.providerId !== undefined && agent.providerId !== '') {
      activeAgentsByProvider.set(agent.providerId, (activeAgentsByProvider.get(agent.providerId) ?? 0) + 1);
    }
    if (agent.role === 'subagent') activeSubAgents += 1;
    else if (agent.role === 'main') activeMainAgents += 1;
  }

  const buildReqDimensionRows = (dim: 'model' | 'provider' | 'role'): LiveConcurrencyBucketRow[] =>
    reqDims
      .filter((d) => d.dimension === dim)
      .sort((a, b) => b.active - a.active || b.queued - a.queued || a.id.localeCompare(b.id))
      .map((d) => {
        const cap = findDirectBucketCapRule(enabledRules, dim, d.id, blockedCounts);
        if (dim === 'model') {
          const m = formatRuntimeModelLabel(d.id, models, unknownModelLabel);
          return {
            key: `model:${d.id}`,
            id: d.id,
            dimension: 'model',
            display: m.display,
            technical: m.technical,
            active: d.active,
            queued: d.queued,
            activeAgents: activeAgentsByModel.get(d.id),
            limit: cap?.limit,
            ruleId: cap?.ruleId,
          };
        }
        if (dim === 'role') {
          const display = d.id === 'subagent' ? roleSubagentLabel : roleRootLabel;
          return {
            key: `role:${d.id}`,
            id: d.id,
            dimension: 'role',
            display,
            active: d.active,
            queued: d.queued,
            activeAgents: d.id === 'subagent'
              ? (activeSubAgents || undefined)
              : (activeMainAgents || undefined),
            limit: cap?.limit,
            ruleId: cap?.ruleId,
          };
        }
        return {
          key: `provider:${d.id}`,
          id: d.id,
          dimension: 'provider',
          display: d.id,
          technical: d.id,
          active: d.active,
          queued: d.queued,
          activeAgents: activeAgentsByProvider.get(d.id),
          limit: cap?.limit,
          ruleId: cap?.ruleId,
        };
      });

  const modelRows = buildReqDimensionRows('model');
  const providerRows = buildReqDimensionRows('provider');
  const roleRows = buildReqDimensionRows('role');

  const executorRows: LiveConcurrencyBucketRow[] = (agentSnapshot?.dimensions ?? [])
    .filter((d) => d.dimension === 'executor')
    .map((d) => {
      const id = d.id ?? 'unknown';
      const active = d.totalActive ?? d.active ?? 0;
      const queued = d.totalQueued ?? d.queued ?? 0;
      const mainCount = d.mainActive ?? d.main ?? 0;
      const subCount = d.subActive ?? d.subagent ?? 0;
      const indCount = d.independentActive ?? d.independent ?? 0;
      const fmt = formatExecutorDisplay(d.id, executorKikiLabel, unknownExecutorLabel);
      const cap = findDirectBucketCapRule(enabledRules, 'executor', id, blockedCounts);
      const subParts = [
        locale === 'zh' ? `主 ${mainCount}` : `main ${mainCount}`,
        locale === 'zh' ? `子 ${subCount}` : `sub ${subCount}`,
        ...(indCount > 0 ? [locale === 'zh' ? `独 ${indCount}` : `ind ${indCount}`] : []),
      ];
      return {
        key: `executor:${id}`,
        id,
        dimension: 'executor' as const,
        display: fmt.display,
        technical: fmt.technical,
        active,
        queued,
        limit: cap?.limit,
        ruleId: cap?.ruleId,
        subDetail: active > 0 ? subParts.join(' · ') : undefined,
      };
    })
    .filter((row) => row.active > 0 || row.queued > 0)
    .sort((a, b) => b.active - a.active || b.queued - a.queued || a.id.localeCompare(b.id));

  const rowsByDimension: Record<LiveConcurrencyDimension, readonly LiveConcurrencyBucketRow[]> = {
    model: modelRows,
    provider: providerRows,
    executor: executorRows,
    role: roleRows,
  };

  const TAB_ORDER: readonly LiveConcurrencyDimension[] = ['model', 'provider', 'executor', 'role'];
  const availableDimensions = TAB_ORDER.filter((dim) => rowsByDimension[dim].length > 0);
  const DEFAULT_PRIORITY: readonly LiveConcurrencyDimension[] = ['model', 'provider', 'role', 'executor'];
  const defaultDimension = DEFAULT_PRIORITY.find((dim) => rowsByDimension[dim].length > 0) ?? 'model';

  const pressuredRules: LivePressuredRuleRow[] = [];
  for (const rule of enabledRules) {
    const queued = blockedCounts.get(rule.id) ?? 0;
    const computedActive = computeRuleActiveCount(rule, requestSnapshot, agentSnapshot, queued);
    const active = computedActive ?? 0;
    if (active > 0 || queued > 0) {
      pressuredRules.push({
        ruleId: rule.id,
        resource: rule.resource,
        scope: rule.scope,
        targetSummary: summarizeRuleTarget(rule, models, locale, unknownModelLabel, executorKikiLabel, unknownExecutorLabel),
        active,
        limit: rule.maxConcurrent!,
        queued,
      });
    }
  }
  pressuredRules.sort((a, b) => {
    if (a.queued !== b.queued) return b.queued - a.queued;
    const aRatio = a.limit > 0 ? a.active / a.limit : 0;
    const bRatio = b.limit > 0 ? b.active / b.limit : 0;
    if (aRatio !== bRatio) return bRatio - aRatio;
    return a.ruleId.localeCompare(b.ruleId);
  });

  return {
    availableDimensions,
    defaultDimension,
    rowsByDimension,
    pressuredRules,
  };
}

export function projectLiveRuntime({
  requestSnapshot,
  agentSnapshot,
  rules = [],
  executionStates,
  inboxNeedsYou,
  models,
  locale,
  unknownModelLabel,
  queuedLabel,
  pausedLabel,
  pausingLabel,
  failedLabel,
  roleRootLabel,
  roleSubagentLabel,
  executorKikiLabel,
  unknownExecutorLabel,
  resolveSessionLabel,
  untitledLabel,
}: {
  readonly requestSnapshot: RequestGovernanceSnapshot | undefined;
  readonly agentSnapshot: LiveAgentSnapshot | null | undefined;
  readonly rules?: readonly ConcurrencyRule[];
  readonly executionStates: Readonly<Record<string, ExecutionControlState | undefined>>;
  readonly inboxNeedsYou: readonly InboxItem[];
  readonly models: readonly ModelCatalogItem[];
  readonly locale: 'zh' | 'en';
  readonly unknownModelLabel: string;
  readonly queuedLabel: string;
  readonly pausedLabel: string;
  readonly pausingLabel: string;
  readonly failedLabel: string;
  readonly roleRootLabel: string;
  readonly roleSubagentLabel: string;
  readonly executorKikiLabel: string;
  readonly unknownExecutorLabel: string;
  readonly resolveSessionLabel: (sessionId: string) => SessionLabel;
  readonly untitledLabel: string;
}): LiveRuntimeProjection {
  const agentsBySession = new Map<string, LiveAgentAgentItem[]>();
  for (const agent of agentSnapshot?.agents ?? []) {
    if (!agent.sessionId) continue;
    const list = agentsBySession.get(agent.sessionId);
    if (list === undefined) agentsBySession.set(agent.sessionId, [agent]);
    else list.push(agent);
  }

  const sessionRequestCounts = new Map<string, { readonly active: number; readonly queued: number }>();
  for (const dimRow of requestSnapshot?.dimensions ?? []) {
    if (dimRow.dimension === 'session' && dimRow.id !== '') {
      sessionRequestCounts.set(dimRow.id, { active: dimRow.active, queued: dimRow.queued });
    }
  }

  const requestWaitersBySession = new Map<string, RequestGovernanceSnapshot['waiting'][number][]>();
  const unattributedWaiters: RequestGovernanceSnapshot['waiting'][number][] = [];
  for (const waiter of requestSnapshot?.waiting ?? []) {
    if (waiter.sessionId === undefined || waiter.sessionId === '') {
      unattributedWaiters.push(waiter);
      continue;
    }
    const list = requestWaitersBySession.get(waiter.sessionId);
    if (list === undefined) requestWaitersBySession.set(waiter.sessionId, [waiter]);
    else list.push(waiter);
  }

  const agentWaitersBySession = new Map<string, LiveAgentWaitingItem[]>();
  for (const waiter of agentSnapshot?.waiting ?? []) {
    if (!waiter.sessionId) continue;
    const list = agentWaitersBySession.get(waiter.sessionId);
    if (list === undefined) agentWaitersBySession.set(waiter.sessionId, [waiter]);
    else list.push(waiter);
  }

  // 1. Needs you (oldest wait first, independent of model request count)
  const pendingSessionIds = new Set<string>();
  const pendingRows: LivePendingRow[] = inboxNeedsYou.map((item) => {
    if (item.roomId === undefined) pendingSessionIds.add(item.sessionId);
    const sessionAgents = item.roomId === undefined ? (agentsBySession.get(item.sessionId) ?? []) : [];
    const reqCounts = item.roomId === undefined ? sessionRequestCounts.get(item.sessionId) : undefined;
    const safeTitle = sanitizeDisplayTitle(item.title) ?? (item.roomId === undefined ? resolveSessionLabel(item.sessionId).text : untitledLabel);
    const earliestAgentStart = sessionAgents.reduce<number | undefined>((min, agent) => {
      const ts = parseTimestamp(agent.startedAt);
      if (ts === undefined) return min;
      return min === undefined ? ts : Math.min(min, ts);
    }, undefined);
    return {
      key: item.roomId !== undefined ? `room:${item.roomId}` : item.sessionId,
      sessionId: item.sessionId,
      roomId: item.roomId,
      title: safeTitle,
      reason: item.reason,
      href: item.roomId !== undefined ? roomRefLink(item.roomId) : sessionHref(item.sessionId),
      runningAgentCount: sessionAgents.length,
      activeRequests: reqCounts?.active ?? 0,
      startedAtMs: earliestAgentStart ?? parseTimestamp(item.at),
      executionState: item.roomId === undefined ? executionStates[item.sessionId] : undefined,
    };
  });

  // 2. Active, queued-waiting, and held/recovery sessions (never folded)
  const candidateIds = new Set<string>();
  for (const id of agentsBySession.keys()) candidateIds.add(id);
  for (const id of sessionRequestCounts.keys()) candidateIds.add(id);
  for (const id of requestWaitersBySession.keys()) candidateIds.add(id);
  for (const id of agentWaitersBySession.keys()) candidateIds.add(id);
  for (const [id, state] of Object.entries(executionStates)) {
    if (state !== undefined && state.phase !== 'running') candidateIds.add(id);
  }

  const sessionRows: LiveSessionRow[] = [];
  for (const sessionId of candidateIds) {
    if (pendingSessionIds.has(sessionId)) continue;
    const agents = [...(agentsBySession.get(sessionId) ?? [])].sort(
      (a, b) => agentRank(a) - agentRank(b) || a.agentId.localeCompare(b.agentId),
    );
    const reqWaiters = requestWaitersBySession.get(sessionId) ?? [];
    const agWaiters = agentWaitersBySession.get(sessionId) ?? [];
    const reqCounts = sessionRequestCounts.get(sessionId);
    const activeRequests = reqCounts?.active ?? 0;
    const queuedRequests = Math.max(reqCounts?.queued ?? 0, reqWaiters.length + agWaiters.length);
    const execState = executionStates[sessionId];
    const hasWaiters = reqWaiters.length > 0 || agWaiters.length > 0 || (reqCounts?.queued ?? 0) > 0;

    const primaryAgent = agents[0];
    const primaryReqWaiter = reqWaiters[0];
    const primaryAgWaiter = agWaiters[0];

    const blockingRules = [
      ...new Set([
        ...reqWaiters.flatMap((w) => w.blockingRules),
        ...agWaiters.flatMap((w) => w.blockingRules),
      ]),
    ];

    const rawModelId = primaryAgent?.modelId ?? primaryReqWaiter?.modelId ?? primaryAgWaiter?.modelId;
    const formattedModel = rawModelId !== undefined && rawModelId !== ''
      ? formatRuntimeModelLabel(rawModelId, models, unknownModelLabel)
      : undefined;

    let phaseLabel: string;
    let phaseKind: LiveSessionRow['phaseKind'];
    let priorityBucket: 0 | 1 | 2;
    if (execState?.phase === 'failed') {
      phaseLabel = failedLabel;
      phaseKind = 'failed';
      priorityBucket = 0;
    } else if (hasWaiters && activeRequests === 0) {
      phaseLabel = queuedLabel;
      phaseKind = 'queued';
      priorityBucket = 0;
    } else if (execState?.phase === 'paused') {
      phaseLabel = pausedLabel;
      phaseKind = 'paused';
      priorityBucket = 2;
    } else if (execState?.phase === 'pausing') {
      phaseLabel = pausingLabel;
      phaseKind = 'pausing';
      priorityBucket = 1;
    } else if (primaryAgent !== undefined) {
      const labels = agentActivityStatusLabels[primaryAgent.phase];
      phaseLabel = locale === 'zh' ? labels.zh : labels.en;
      phaseKind = primaryAgent.phase === 'suspended' ? 'suspended' : 'running';
      priorityBucket = hasWaiters ? 0 : 1;
    } else {
      phaseLabel = locale === 'zh' ? '运行中' : 'Running';
      phaseKind = 'running';
      priorityBucket = 1;
    }

    const earliestStartMs = agents.reduce<number | undefined>((min, agent) => {
      const ts = parseTimestamp(agent.startedAt);
      if (ts === undefined) return min;
      return min === undefined ? ts : Math.min(min, ts);
    }, undefined);
    const maxWaitedMs = [
      ...reqWaiters.map((w) => w.waitedMs),
      ...agWaiters.map((w) => w.waitedMs),
    ].reduce<number | undefined>((max, ms) => (max === undefined ? ms : Math.max(max, ms)), undefined);

    const agentLinks: LiveSessionAgentLink[] = agents.map((agent) => {
      const m = agent.modelId ? formatRuntimeModelLabel(agent.modelId, models, unknownModelLabel) : undefined;
      return {
        agentId: agent.agentId,
        role: agent.role,
        phase: agent.phase,
        profileId: agent.profileId,
        modelDisplay: m?.display,
        modelTechnical: m?.technical,
        href: sessionHref(sessionId, agent.agentId),
      };
    });

    const primaryHref = primaryAgent !== undefined && primaryAgent.role !== 'main'
      ? sessionHref(sessionId, primaryAgent.agentId)
      : sessionHref(sessionId);

    sessionRows.push({
      sessionId,
      label: resolveSessionLabel(sessionId),
      href: primaryHref,
      priorityBucket,
      phaseLabel,
      phaseKind,
      activeRequests,
      queuedRequests,
      modelDisplay: formattedModel?.display,
      modelTechnical: formattedModel?.technical,
      startedAtMs: earliestStartMs,
      waitedMs: hasWaiters && earliestStartMs === undefined ? maxWaitedMs : undefined,
      agents: agentLinks,
      extraAgentCount: Math.max(0, agents.length - 1),
      blockingRules,
      waiterAttemptIds: reqWaiters.map((w) => w.attemptId),
      executionState: execState,
    });
  }

  sessionRows.sort((a, b) => {
    if (a.priorityBucket !== b.priorityBucket) return a.priorityBucket - b.priorityBucket;
    if (a.activeRequests !== b.activeRequests) return b.activeRequests - a.activeRequests;
    const aStart = a.startedAtMs ?? Number.MAX_SAFE_INTEGER;
    const bStart = b.startedAtMs ?? Number.MAX_SAFE_INTEGER;
    if (aStart !== bStart) return aStart - bStart;
    return a.sessionId.localeCompare(b.sessionId);
  });

  const concurrency = projectLiveConcurrency({
    requestSnapshot,
    agentSnapshot,
    rules,
    models,
    locale,
    unknownModelLabel,
    roleRootLabel,
    roleSubagentLabel,
    executorKikiLabel,
    unknownExecutorLabel,
  });

  return {
    pendingRows,
    sessionRows,
    unattributedWaiters,
    concurrency,
  };
}
