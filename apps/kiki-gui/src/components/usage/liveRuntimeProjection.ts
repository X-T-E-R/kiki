import type { ModelCatalogItem, RequestGovernanceSnapshot } from '@kiki/protocol';
import { roomRefLink, type InboxItem, type InboxReason } from '@kiki/session-core/sessions';
import { resolveCatalogModel } from '@kiki/session-core/settings';

import type { ExecutionControlState } from '../../lib/executionControls';
import {
  agentActivityStatusLabels,
  type AgentActivityPhase,
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
 * exposing raw provider prefixes (`axon-message/...`) as default titles.
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

export interface LivePendingRow {
  readonly key: string;
  readonly sessionId: string;
  readonly roomId?: string;
  readonly title: string;
  readonly reason: InboxReason;
  readonly href: string;
  readonly runningAgentCount: number;
  readonly startedAtMs?: number;
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

export function projectLiveRuntime({
  requestSnapshot,
  agentSnapshot,
  executionStates,
  inboxNeedsYou,
  models,
  locale,
  unknownModelLabel,
  queuedLabel,
  pausedLabel,
  pausingLabel,
  failedLabel,
  resolveSessionLabel,
  untitledLabel,
}: {
  readonly requestSnapshot: RequestGovernanceSnapshot | undefined;
  readonly agentSnapshot: LiveAgentSnapshot | null | undefined;
  readonly executionStates: Readonly<Record<string, ExecutionControlState | undefined>>;
  readonly inboxNeedsYou: readonly InboxItem[];
  readonly models: readonly ModelCatalogItem[];
  readonly locale: 'zh' | 'en';
  readonly unknownModelLabel: string;
  readonly queuedLabel: string;
  readonly pausedLabel: string;
  readonly pausingLabel: string;
  readonly failedLabel: string;
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
      startedAtMs: earliestAgentStart ?? parseTimestamp(item.at),
    };
  });

  // 2. Active, queued-waiting, and held/recovery sessions (never folded)
  const candidateIds = new Set<string>();
  for (const id of agentsBySession.keys()) candidateIds.add(id);
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
    const execState = executionStates[sessionId];
    const hasWaiters = reqWaiters.length > 0 || agWaiters.length > 0;
    const isHeld = execState !== undefined && (execState.phase === 'paused' || execState.phase === 'pausing' || execState.phase === 'failed');

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
    } else if (hasWaiters) {
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
      priorityBucket = 1;
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
    const aStart = a.startedAtMs ?? Number.MAX_SAFE_INTEGER;
    const bStart = b.startedAtMs ?? Number.MAX_SAFE_INTEGER;
    if (aStart !== bStart) return aStart - bStart;
    return a.sessionId.localeCompare(b.sessionId);
  });

  return {
    pendingRows,
    sessionRows,
    unattributedWaiters,
  };
}
