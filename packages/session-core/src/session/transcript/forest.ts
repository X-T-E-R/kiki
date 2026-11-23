import type { SnapshotSubagent, Task } from '@kiki/protocol';
import type { AgentState, AgentTranscriptSnapshot, TranscriptTask } from '@kiki/transcript';

import type { AgentTranscriptAgent, AgentTranscriptResponse, AgentTranscriptTask } from '../../transport';
import {
  MAIN_AGENT_ID,
  buildAgentForest,
  stabilizeAgentForest,
  type AgentForest,
  type AgentLiveSource,
  type AgentRosterDescriptor,
  type AgentTaskItem,
} from '../agentTree';
import { agentBusyFromMeta, latestTurnOutcome, runningTurnAfterPhase, snapshotSubagentAgentId, turnOutcomeFromItem } from './project';
import { subagentBlocksFromState } from './selectors';
import type { SessionViewState, SubagentBlock } from './types';

export function rosterFromTranscriptAgents(
  agents: readonly AgentTranscriptAgent[] | undefined,
): readonly AgentRosterDescriptor[] {
  if (agents === undefined) return [];
  return agents.map((agent) => {
    const parentFromDelegator = agent.delegator?.kind === 'agent' ? agent.delegator.agentId : undefined;
    const status: AgentRosterDescriptor['status'] =
      agent.agentId === MAIN_AGENT_ID
        ? undefined
        : agent.branchSealed === true
          ? 'completed'
          : agent.isBranch === true
            ? 'idle'
            : 'unknown';
    return {
      agentId: agent.agentId,
      parentAgentId: agent.parentAgentId ?? parentFromDelegator,
      name: agent.label ?? agent.agentId,
      label: agent.label,
      isBranch: agent.isBranch,
      branchSeed: agent.branchSeed,
      branchInitiator: agent.branchInitiator,
      toolsLocked: agent.toolsLocked,
      branchSealed: agent.branchSealed,
      branchBaseTurnId: agent.branchBaseTurnId,
      branchBaseMessageId: agent.branchBaseMessageId,
      status,
      createdAt: agent.createdAt,
      disposedAt: agent.disposedAt,
    };
  });
}

export function agentStatusFromMeta(response: AgentTranscriptResponse | undefined): AgentRosterDescriptor['status'] {
  const phase = response?.meta?.agent?.phase;
  const outcome = response === undefined ? undefined : latestTurnOutcome(response);
  if (outcome !== undefined) return outcome.state;
  // Same rule as agentBusyFromMeta: a newer running turn outranks a stale terminal phase.
  if (
    response !== undefined &&
    (phase?.kind === 'ended' || phase?.kind === 'interrupted' || phase?.kind === 'idle') &&
    runningTurnAfterPhase(response, phase) !== undefined
  ) {
    return 'running';
  }
  switch (phase?.kind) {
    case 'running':
    case 'streaming':
    case 'tool_call':
    case 'retrying':
      return 'running';
    case 'awaiting_approval':
      return 'suspended';
    case 'ended':
      switch (phase['reason']) {
        case 'completed':
          return 'completed';
        case 'cancelled':
          return 'cancelled';
        case 'failed':
          return 'failed';
        case 'blocked':
          return 'suspended';
        default:
          return 'unknown';
      }
    case 'interrupted':
      return phase['reason'] === 'aborted' ? 'cancelled' : 'failed';
    case 'idle':
    default:
      return 'unknown';
  }
}

export function rosterFromTranscriptResponse(
  response: AgentTranscriptResponse | undefined,
): readonly AgentRosterDescriptor[] {
  const roster = [...rosterFromTranscriptAgents(response?.agents)];
  if (response === undefined) return roster;
  const meta = response.meta?.agent;
  if (meta === undefined) return roster;
  const index = roster.findIndex((agent) => agent.agentId === response.agent_id);
  const existing = index >= 0 ? roster[index] : undefined;
  const projectedStatus = agentStatusFromMeta(response);
  const resolvedStatus =
    response.agent_id === MAIN_AGENT_ID && projectedStatus === 'unknown'
      ? undefined
      : projectedStatus === 'unknown' && existing !== undefined
        ? existing.branchSealed === true
          ? 'completed'
          : existing.isBranch === true
            ? 'idle'
            : projectedStatus
        : projectedStatus;
  const statusFields = {
    model: meta.model,
    thinkingEffort: meta.thinkingEffort,
    contextTokens: meta.contextTokens,
    maxContextTokens: meta.maxContextTokens,
    usage: meta.usage,
    status: resolvedStatus,
    ...interruptedStatusFields(meta.phase, resolvedStatus),
    busy: agentBusyFromMeta(response),
  };
  if (index >= 0) roster[index] = { ...roster[index]!, ...statusFields };
  else roster.push({ agentId: response.agent_id, name: response.agent_id, ...statusFields });
  return roster;
}

function interruptedStatusFields(
  phase: { readonly kind: string; readonly message?: unknown; readonly at?: unknown } | undefined,
  status: AgentRosterDescriptor['status'],
): Partial<AgentRosterDescriptor> {
  if (phase?.kind !== 'interrupted' || typeof phase.message !== 'string' || typeof phase.at !== 'number' || status !== 'failed') return {};
  const at = new Date(phase.at);
  if (Number.isNaN(at.getTime())) return {};
  return { statusSource: 'runtime', error: phase.message, endedAt: at.toISOString() };
}

export function taskItemsFromTranscriptTasks(
  tasks: readonly AgentTranscriptTask[] | undefined,
  ownerAgentId?: string,
): readonly AgentTaskItem[] {
  if (tasks === undefined) return [];
  return tasks.flatMap((task) => {
    const agentId = task.agentId !== undefined && task.agentId !== '' ? task.agentId : ownerAgentId;
    if (agentId === undefined || agentId === '' || ((task.agentId === undefined || task.agentId === '') && task.state !== 'running')) return [];
    const parentAgentId =
      ownerAgentId !== undefined && ownerAgentId !== '' && agentId !== ownerAgentId
        ? ownerAgentId
        : undefined;
    return [
      {
        id: task.taskId,
        agentId,
        parentAgentId,
        parentToolCallId: task.parentToolCallId,
        kind: task.kind,
        name: task.name ?? task.subagentName,
        explicitName: task.name,
        description: task.description,
        status: task.state,
        model: task.model,
        thinkingEffort: task.thinkingEffort,
        thinkingEffortExplicit: task.thinkingEffortExplicit,
        executorId: task.executorId,
        executorProtocol: task.executorProtocol,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        summary: task.resultSummary,
        output_preview: task.outputTail,
        detached: task.detached,
      } satisfies AgentTaskItem,
    ];
  });
}

export function taskItemsFromSessionTasks(
  tasks: readonly Task[],
  ownerAgentId?: string,
): readonly AgentTaskItem[] {
  return tasks.flatMap((task) => {
    if (task.kind !== 'subagent' || task.agent_id === undefined || task.agent_id === '') return [];
    const parentAgentId =
      ownerAgentId !== undefined && ownerAgentId !== '' && task.agent_id !== ownerAgentId
        ? ownerAgentId
        : undefined;
    return [
      {
        id: task.id,
        agentId: task.agent_id,
        parentAgentId,
        kind: task.kind,
        description: task.description,
        status: task.status,
        model: task.model,
        thinking_effort: task.thinking_effort,
        thinking_effort_explicit: task.thinking_effort_explicit,
        executor_id: task.executor_id,
        executor_protocol: task.executor_protocol,
        started_at: task.started_at,
        completed_at: task.completed_at,
        output_preview: task.output_preview,
      } satisfies AgentTaskItem,
    ];
  });
}

export function liveSourcesFromSubagentBlocks(blocks: readonly SubagentBlock[]): readonly AgentLiveSource[] {
  return blocks.map((block) => ({
    subagentId: block.subagentId,
    parentAgentId: block.parentAgentId,
    parentToolCallId: block.parentToolCallId,
    name: block.name,
    label: block.label,
    model: block.model,
    thinkingEffort: block.thinkingEffort,
    thinkingEffortExplicit: block.thinkingEffortExplicit,
    executorId: block.executorId,
    executorProtocol: block.executorProtocol,
    status: block.status,
    description: block.description,
    summary: block.summary,
    error: block.error,
    startedAt: block.startedAt,
    endedAt: block.endedAt,
    toolCallCount: block.toolCallCount,
    toolCallCountKnown: block.toolCallCountKnown,
  }));
}

/**
 * Snapshot roster rows outlive the run they describe: a disposed agent keeps
 * its row so a later prompt can resume it, and the wire marks that row
 * `live: false`. Its run start is the boundary at or before which active
 * evidence is stale, so it lands on the descriptor as `disposedAt` — a run
 * starting strictly later is a new generation and revives the row.
 */
export function rosterFromSnapshotSubagents(
  subagents: readonly SnapshotSubagent[] | undefined,
): readonly AgentRosterDescriptor[] {
  if (subagents === undefined) return [];
  return subagents.flatMap((subagent) => {
    const agentId = snapshotSubagentAgentId(subagent);
    if (agentId === '') return [];
    const label = presentSnapshotText(subagent.label);
    const description = presentSnapshotText(subagent.description);
    const name = label ?? description ?? presentSnapshotText(subagent.profile) ?? agentId;
    const startedAt = subagent.started_at;
    return [
      {
        agentId,
        createdAt: subagent.created_at,
        parentAgentId: presentSnapshotText(subagent.parent_agent_id),
        parentToolCallId: presentSnapshotText(subagent.parent_tool_call_id),
        name,
        label,
        isBranch: subagent.is_branch,
        branchSeed: subagent.branch_seed,
        branchInitiator: subagent.branch_initiator,
        toolsLocked: subagent.tools_locked,
        branchSealed: subagent.branch_sealed,
        branchBaseTurnId: subagent.branch_base_turn_id,
        branchBaseMessageId: presentSnapshotText(subagent.branch_base_message_id),
        model: presentSnapshotText(subagent.model),
        thinkingEffort: presentSnapshotText(subagent.thinking_effort),
        thinkingEffortExplicit: subagent.thinking_effort_explicit,
        executorId: presentSnapshotText(subagent.executor_id),
        executorProtocol: presentSnapshotText(subagent.executor_protocol),
        status: subagent.activity_status ?? (subagent.subagent_phase === 'suspended' ? 'suspended' : subagent.status),
        statusSource: subagent.status_source,
        nameSource: subagent.name_source,
        refreshing: subagent.refreshing,
        refreshingUntil: subagent.refreshing_until,
        detached: subagent.run_in_background,
        disposedAt: subagent.live === false ? startedAt : undefined,
        toolCallCount: subagent.tool_call_count,
        toolCallCountKnown: subagent.tool_call_count === undefined ? undefined : true,
        startedAt,
        endedAt: subagent.completed_at,
        description,
        summary: presentSnapshotText(subagent.output_preview),
        error: presentSnapshotText(subagent.stop_reason) ??
          (subagent.status === 'failed' ? presentSnapshotText(subagent.output_preview) : undefined),
      } satisfies AgentRosterDescriptor,
    ];
  });
}

function presentSnapshotText(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

export function overlayLiveSourcesWithSnapshotSubagents(
  live: readonly AgentLiveSource[],
  snapshotSubagents: readonly SnapshotSubagent[] | undefined,
  precomputedRoster?: readonly AgentRosterDescriptor[],
): readonly AgentLiveSource[] {
  if (live.length === 0 || snapshotSubagents === undefined || snapshotSubagents.length === 0) return live;
  const rosterEntries = precomputedRoster ?? rosterFromSnapshotSubagents(snapshotSubagents);
  const rosterById = new Map<string, AgentRosterDescriptor>();
  for (const entry of rosterEntries) rosterById.set(entry.agentId, entry);
  if (rosterById.size === 0) return live;
  return live.map((source) => {
    const snapshot = rosterById.get(source.subagentId);
    if (snapshot === undefined) return source;
    const sourceCountAuthoritative = source.toolCallCountAuthoritative === true;
    const snapshotCount = snapshot.toolCallCount;
    const nextToolCallCount = sourceCountAuthoritative
      ? source.toolCallCount ?? 0
      : snapshotCount === undefined
        ? source.toolCallCount
        : Math.max(source.toolCallCount ?? 0, snapshotCount);
    const nextToolCallCountKnown = sourceCountAuthoritative
      ? source.toolCallCount === undefined
        ? false
        : source.toolCallCountKnown !== false
      : mergeKnown(source.toolCallCountKnown, snapshot.toolCallCountKnown);
    const snapshotRuntimeActive = snapshot.statusSource === 'runtime' &&
      (snapshot.status === 'running' || snapshot.status === 'suspended' || snapshot.status === 'background');
    const sourceTerminal = source.status === 'completed' || source.status === 'failed' || source.status === 'cancelled';
    const runtimeRestarted = snapshotRuntimeActive && sourceTerminal;
    const snapshotRuntimeTerminal = snapshot.statusSource === 'runtime' &&
      (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled');
    return {
      ...source,
      createdAt: presentSnapshotText(source.createdAt) ?? snapshot.createdAt,
      parentAgentId: source.parentAgentId ?? snapshot.parentAgentId,
      parentToolCallId: source.parentToolCallId ?? snapshot.parentToolCallId,
      name: source.name !== source.subagentId ? source.name : snapshot.name ?? source.name,
      label: source.label ?? snapshot.label,
      model: source.model ?? snapshot.model,
      thinkingEffort: source.thinkingEffort ?? snapshot.thinkingEffort,
      thinkingEffortExplicit: source.thinkingEffortExplicit ?? snapshot.thinkingEffortExplicit,
      executorId: source.executorId ?? snapshot.executorId,
      executorProtocol: source.executorProtocol ?? snapshot.executorProtocol,
      status: snapshot.statusSource === 'runtime'
        ? snapshot.status ?? source.status
        : source.status === 'unknown' ? snapshot.status ?? source.status : source.status,
      disposedAt: source.disposedAt ?? snapshot.disposedAt,
      description: source.description ?? snapshot.description,
      summary: runtimeRestarted ? undefined : (source.summary ?? snapshot.summary),
      error: runtimeRestarted ? undefined : (source.error ?? snapshot.error),
      startedAt: runtimeRestarted
        ? (presentSnapshotText(snapshot.startedAt) ?? presentSnapshotText(source.startedAt))
        : (presentSnapshotText(source.startedAt) ?? snapshot.startedAt),
      endedAt: runtimeRestarted
        ? undefined
        : snapshotRuntimeTerminal
          ? (snapshot.endedAt ?? source.endedAt)
          : (source.endedAt ?? snapshot.endedAt),
      toolCallCount: nextToolCallCount,
      toolCallCountKnown: nextToolCallCountKnown,
    };
  });
}

function mergeKnown(current: boolean | undefined, incoming: boolean | undefined): boolean | undefined {
  if (current === true || incoming === true) return true;
  return current ?? incoming;
}

function canonicalToolCallCountFields(source: {
  readonly toolCallCount?: number;
  readonly toolCallCountKnown?: boolean;
}): { readonly toolCallCount: number; readonly toolCallCountKnown: boolean } {
  const count = source.toolCallCount;
  return {
    toolCallCount: count ?? 0,
    toolCallCountKnown: count !== undefined && source.toolCallCountKnown !== false,
  };
}

function overlayForestDisplayFields(
  forest: AgentForest,
  live: readonly AgentLiveSource[],
): AgentForest {
  if (live.length === 0) return forest;
  const liveById = new Map(live.map((entry) => [entry.subagentId, entry]));
  let changed = false;
  const byId: Record<string, (typeof forest.byId)[string]> = { ...forest.byId };
  for (const [agentId, node] of Object.entries(byId)) {
    const source = liveById.get(agentId);
    if (source === undefined) continue;
    const sourceCountAuthoritative = source.toolCallCountAuthoritative === true;
    const nextToolCallCount = sourceCountAuthoritative
      ? source.toolCallCount ?? 0
      : node.toolCallCount;
    const nextToolCallCountKnown = sourceCountAuthoritative
      ? source.toolCallCount === undefined
        ? false
        : source.toolCallCountKnown !== false
      : node.toolCallCountKnown;
    const nextName = node.name !== node.agentId ? node.name : source.name;
    const nextLabel =
      node.label !== node.name && node.label !== node.agentId
        ? node.label
        : source.label ?? (source.name !== source.subagentId ? source.name : node.label);
    const nodeActive = node.status === 'running' || node.status === 'suspended' || node.status === 'background';
    const next = {
      ...node,
      name: nextName,
      label: nextLabel,
      model: node.model ?? source.model,
      thinkingEffort: node.thinkingEffort ?? source.thinkingEffort,
      thinkingEffortExplicit: node.thinkingEffortExplicit ?? source.thinkingEffortExplicit,
      executorId: node.executorId ?? source.executorId,
      executorProtocol: node.executorProtocol ?? source.executorProtocol,
      toolCallCount: nextToolCallCount,
      toolCallCountKnown: nextToolCallCountKnown,
      startedAt: presentSnapshotText(node.startedAt) ?? source.startedAt,
      endedAt: nodeActive ? node.endedAt : (node.endedAt ?? source.endedAt),
      description: node.description ?? source.description,
      summary: nodeActive ? node.summary : (node.summary ?? source.summary),
      error: nodeActive ? node.error : (node.error ?? source.error),
    };
    if (
      next.model !== node.model ||
      next.thinkingEffort !== node.thinkingEffort ||
      next.thinkingEffortExplicit !== node.thinkingEffortExplicit ||
      next.executorId !== node.executorId ||
      next.executorProtocol !== node.executorProtocol ||
      next.toolCallCount !== node.toolCallCount ||
      next.toolCallCountKnown !== node.toolCallCountKnown ||
      next.label !== node.label ||
      next.name !== node.name ||
      next.startedAt !== node.startedAt ||
      next.endedAt !== node.endedAt ||
      next.description !== node.description ||
      next.summary !== node.summary ||
      next.error !== node.error
    ) {
      byId[agentId] = next;
      changed = true;
    }
  }
  if (!changed) return forest;
  return { byId, roots: forest.roots.map((root) => byId[root.agentId] ?? root) };
}

export function sessionAgentForest(
  state: SessionViewState,
  roster?: readonly AgentRosterDescriptor[],
  extraTasks?: readonly AgentTaskItem[],
): AgentForest {
  const snapshotRoster = rosterFromSnapshotSubagents(state.snapshotSubagents);
  const live = overlayLiveSourcesWithSnapshotSubagents(
    liveSourcesFromSubagentBlocks(subagentBlocksFromState(state)),
    state.snapshotSubagents,
    snapshotRoster,
  );
  return overlayForestDisplayFields(
    buildAgentForest(live, [...snapshotRoster, ...(roster ?? [])], [...taskItemsFromSessionTasks(state.tasks), ...(extraTasks ?? [])]),
    live,
  );
}

export function sessionAgentForestFromTranscript(
  state: SessionViewState,
  response: AgentTranscriptResponse | undefined,
): AgentForest {
  return sessionAgentForest(state, rosterFromTranscriptResponse(response), taskItemsFromTranscriptTasks(response?.tasks, response?.agent_id));
}

/**
 * Overlay a routed child/branch view's own subagent blocks and tasks onto an
 * existing session forest so children spawned by that branch or subagent appear
 * immediately under `forest.byId[agentId].childIds` even before the main
 * session shell re-renders or finishes paging large snapshot rosters.
 */
export function mergeAgentViewIntoForest(
  forest: AgentForest,
  agentId: string,
  state: Pick<SessionViewState, 'blocks' | 'tasks'> & Partial<Pick<SessionViewState, 'snapshotSubagents'>>,
): AgentForest {
  if (agentId === '' || agentId === MAIN_AGENT_ID) return forest;
  const blocks = state.blocks.filter((block): block is SubagentBlock => block.kind === 'subagent');
  const subagentTasks = state.tasks.filter(
    (task) =>
      task.kind === 'subagent' &&
      task.agent_id !== undefined &&
      task.agent_id !== '' &&
      task.agent_id !== agentId,
  );
  if (blocks.length === 0 && subagentTasks.length === 0) return forest;

  const live = overlayLiveSourcesWithSnapshotSubagents(
    liveSourcesFromSubagentBlocks(blocks).map((entry) => ({
      ...entry,
      parentAgentId: entry.parentAgentId ?? agentId,
    })),
    state.snapshotSubagents,
  );
  const taskItems = taskItemsFromSessionTasks(subagentTasks, agentId);
  const roster: AgentRosterDescriptor[] = Object.values(forest.byId).map((node) => ({
    agentId: node.agentId,
    createdAt: node.createdAt,
    parentAgentId: node.parentAgentId,
    parentToolCallId: node.parentToolCallId,
    name: node.name,
    label: node.label,
    isBranch: node.isBranch,
    branchSeed: node.branchSeed,
    branchInitiator: node.branchInitiator,
    toolsLocked: node.toolsLocked,
    branchSealed: node.branchSealed,
    branchBaseTurnId: node.branchBaseTurnId,
    branchBaseMessageId: node.branchBaseMessageId,
    nameSource: node.nameSource,
    statusSource: node.statusSource,
    model: node.model,
    thinkingEffort: node.thinkingEffort,
    thinkingEffortExplicit: node.thinkingEffortExplicit,
    executorId: node.executorId,
    executorProtocol: node.executorProtocol,
    contextTokens: node.contextTokens,
    maxContextTokens: node.maxContextTokens,
    usage: node.usage,
    status: node.status === 'unknown' ? undefined : node.status,
    refreshing: node.refreshing,
    refreshingUntil: node.refreshingUntil,
    busy: node.busy,
    toolCallCount: node.toolCallCount,
    toolCallCountKnown: node.toolCallCountKnown,
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    description: node.description,
    summary: node.summary,
    error: node.error,
  }));
  if (forest.byId[agentId] === undefined) {
    roster.push({ agentId, name: agentId });
  }
  const rebuilt = overlayForestDisplayFields(buildAgentForest(live, roster, taskItems), live);
  const byId = { ...rebuilt.byId };
  for (const [id, prev] of Object.entries(forest.byId)) {
    const cur = byId[id];
    if (cur === undefined) continue;
    if (prev.nameSource !== undefined || prev.statusSource !== undefined || prev.turnOutcome !== undefined) {
      byId[id] = {
        ...cur,
        nameSource: cur.nameSource ?? prev.nameSource,
        statusSource: cur.statusSource ?? prev.statusSource,
        turnOutcome: cur.turnOutcome ?? prev.turnOutcome,
      };
    }
  }
  const merged: AgentForest = {
    byId,
    roots: rebuilt.roots.map((root) => byId[root.agentId] ?? root),
  };
  return stabilizeAgentForest(forest, merged);
}

interface SnapshotAgentRef {
  readonly agentId: string;
  readonly toolCallId: string;
  readonly startedAt?: string;
}

const snapshotAgentRefCache = new WeakMap<AgentTranscriptSnapshot['items'], readonly SnapshotAgentRef[]>();
const turnAgentRefCache = new WeakMap<object, readonly SnapshotAgentRef[]>();

function snapshotAgentRefs(items: AgentTranscriptSnapshot['items']): readonly SnapshotAgentRef[] {
  const cached = snapshotAgentRefCache.get(items);
  if (cached !== undefined) return cached;
  const refs = new Map<string, SnapshotAgentRef>();
  for (const item of items) {
    if (item.kind !== 'turn') continue;
    let turnRefs = turnAgentRefCache.get(item);
    if (turnRefs === undefined) {
      const entries = new Map<string, SnapshotAgentRef>();
      for (const step of item.steps) {
        for (const frame of step.frames) {
          if (frame.kind !== 'tool') continue;
          for (const ref of frame.agentRefs ?? []) {
            entries.set(ref.agentId, { agentId: ref.agentId, toolCallId: frame.toolCallId,
              startedAt: entries.get(ref.agentId)?.startedAt ?? step.startedAt ?? item.startedAt });
          }
        }
      }
      turnRefs = [...entries.values()];
      turnAgentRefCache.set(item, turnRefs);
    }
    for (const ref of turnRefs) {
      refs.set(ref.agentId, { ...ref, startedAt: refs.get(ref.agentId)?.startedAt ?? ref.startedAt });
    }
  }
  const result = [...refs.values()];
  snapshotAgentRefCache.set(items, result);
  return result;
}

function isSyntheticPhaseTaskId(taskId: string): boolean {
  return taskId.startsWith('agent-phase-');
}

function isAutonomousReceiptTaskId(taskId: string): boolean {
  return taskId.startsWith('agent-receipt-');
}

function parseSnapshotTaskTime(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function snapshotTaskStateRank(state: string): number {
  if (state === 'completed' || state === 'failed' || state === 'killed' || state === 'timed_out' || state === 'lost') return 2;
  if (state === 'running') return 1;
  return 0;
}

function snapshotTaskIsNewer(
  candidate: { readonly taskId: string; readonly state: string; readonly startedAt?: string; readonly endedAt?: string },
  current: { readonly taskId: string; readonly state: string; readonly startedAt?: string; readonly endedAt?: string },
): boolean {
  const candStart = parseSnapshotTaskTime(candidate.startedAt);
  const currStart = parseSnapshotTaskTime(current.startedAt);
  const candEnd = parseSnapshotTaskTime(candidate.endedAt);
  const currEnd = parseSnapshotTaskTime(current.endedAt);
  if (candidate.taskId !== current.taskId) {
    if (candStart !== undefined && currEnd !== undefined && candStart > currEnd) return true;
    if (currStart !== undefined && candEnd !== undefined && currStart > candEnd) return false;
    if (candEnd !== undefined && currEnd !== undefined && candEnd !== currEnd) {
      return candEnd > currEnd;
    }
  }
  if (candStart !== currStart) {
    if (candStart === undefined) return false;
    if (currStart === undefined) return true;
    return candStart > currStart;
  }
  const candRank = snapshotTaskStateRank(candidate.state);
  const currRank = snapshotTaskStateRank(current.state);
  if (candRank !== currRank) return candRank > currRank;
  if (candEnd !== currEnd) {
    if (candEnd === undefined) return false;
    if (currEnd === undefined) return true;
    return candEnd > currEnd;
  }
  return candidate.taskId >= current.taskId;
}

export function liveSourcesFromAgentSnapshots(
  snapshots: ReadonlyMap<string, AgentState | AgentTranscriptSnapshot>,
): readonly AgentLiveSource[] {
  const byId = new Map<string, AgentLiveSource>();
  for (const [parentAgentId, snapshot] of snapshots) {
    const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [...snapshot.tasks.values()];
    const grouped = new Map<string, typeof tasks>();
    for (const task of tasks) {
      if (task.kind !== 'subagent' || task.agentId === undefined || task.agentId === '') continue;
      const list = grouped.get(task.agentId);
      if (list === undefined) grouped.set(task.agentId, [task]);
      else list.push(task);
    }
    for (const [agentId, list] of grouped) {
      const nonPhase = list.filter((task) => !isSyntheticPhaseTaskId(task.taskId));
      const candidates = nonPhase.length > 0 ? nonPhase : list;
      const activeCandidates = candidates.filter((task) => task.state === 'running');
      const latestPool = activeCandidates.length > 0 ? activeCandidates : candidates;
      let latest = latestPool[0]!;
      let earliest = candidates[0]!;
      let anchored: TranscriptTask | undefined;
      let explicitName: string | undefined;
      let profileName: string | undefined;
      for (const task of latestPool) {
        if (task !== latest && snapshotTaskIsNewer(task, latest)) latest = task;
      }
      for (const task of candidates) {
        if (task !== earliest && snapshotTaskIsNewer(earliest, task)) earliest = task;
        if (anchored === undefined && presentSnapshotText(task.parentToolCallId) !== undefined) anchored = task;
        const nextExplicit = presentSnapshotText(task.name);
        if (nextExplicit !== undefined) explicitName = nextExplicit;
        const nextProfile = presentSnapshotText(task.subagentName);
        if (nextProfile !== undefined) profileName = nextProfile;
      }
      const existing = byId.get(agentId);
      const base = anchored ?? earliest;
      const latestParentToolCallId = presentSnapshotText(latest.parentToolCallId);
      const preserveBaseDescription =
        base !== latest &&
        presentSnapshotText(base.description) !== undefined &&
        (isAutonomousReceiptTaskId(latest.taskId) || (latestParentToolCallId === undefined && anchored !== undefined));
      const resolvedName =
        explicitName ??
        (existing?.name !== undefined && existing.name !== agentId ? existing.name : undefined) ??
        profileName ??
        agentId;
      const resolvedDescription = preserveBaseDescription
        ? base.description
        : presentSnapshotText(latest.description) ?? presentSnapshotText(base.description) ?? existing?.description;
      byId.set(agentId, {
        subagentId: agentId,
        parentAgentId,
        parentToolCallId: latestParentToolCallId ?? presentSnapshotText(base.parentToolCallId) ?? existing?.parentToolCallId,
        name: resolvedName,
        model: latest.model ?? base.model ?? existing?.model,
        thinkingEffort: latest.thinkingEffort ?? base.thinkingEffort ?? existing?.thinkingEffort,
        thinkingEffortExplicit: latest.thinkingEffortExplicit ?? base.thinkingEffortExplicit ?? existing?.thinkingEffortExplicit,
        executorId: latest.executorId ?? base.executorId ?? existing?.executorId,
        executorProtocol: latest.executorProtocol ?? base.executorProtocol ?? existing?.executorProtocol,
        status: latest.state,
        description: resolvedDescription,
        summary: presentSnapshotText(latest.resultSummary) ?? presentSnapshotText(latest.outputTail) ?? existing?.summary,
        error: latest.error ?? latest.stateReason,
        startedAt: latest.startedAt ?? base.startedAt ?? existing?.startedAt,
        endedAt: latest.endedAt,
        toolCallCount: existing?.toolCallCount,
        toolCallCountKnown: existing?.toolCallCountKnown,
        toolCallCountAuthoritative: existing?.toolCallCountAuthoritative,
      });
    }
    for (const ref of snapshotAgentRefs(snapshot.items)) {
      const existing = byId.get(ref.agentId);
      byId.set(ref.agentId, {
        ...existing,
        subagentId: ref.agentId,
        parentAgentId,
        parentToolCallId: ref.toolCallId,
        name: existing?.name ?? ref.agentId,
        status: existing?.status ?? 'unknown',
        startedAt: existing?.startedAt ?? ref.startedAt,
      });
    }
  }
  for (const [agentId, snapshot] of snapshots) {
    const meta = snapshot.meta.agent;
    const existing = byId.get(agentId);
    if (existing === undefined) continue;
    const count = canonicalToolCallCountFields(snapshot);
    byId.set(agentId, {
      ...existing,
      model: meta?.model ?? existing.model,
      thinkingEffort: meta?.thinkingEffort ?? existing.thinkingEffort,
      toolCallCount: count.toolCallCount,
      toolCallCountKnown: count.toolCallCountKnown,
      toolCallCountAuthoritative: true,
    });
  }
  return [...byId.values()];
}

export function sessionAgentForestFromAgentSnapshots(
  snapshots: ReadonlyMap<string, AgentState | AgentTranscriptSnapshot>,
  snapshotSubagents?: readonly SnapshotSubagent[],
  coldAgents?: ReadonlySet<string>,
  rosterCurrentAgents?: ReadonlySet<string>,
): AgentForest {
  const snapshotRoster = rosterFromSnapshotSubagents(snapshotSubagents);
  const live = overlayLiveSourcesWithSnapshotSubagents(
    liveSourcesFromAgentSnapshots(snapshots),
    snapshotSubagents,
    snapshotRoster,
  );
  const tasks: AgentTaskItem[] = [];
  const roster: AgentRosterDescriptor[] = [];
  const liveById = live.length === 0 ? undefined : new Map(live.map((entry) => [entry.subagentId, entry]));
  for (const [agentId, snapshot] of snapshots) {
    const meta = snapshot.meta.agent;
    const count = canonicalToolCallCountFields(snapshot);
    const source = liveById?.get(agentId);
    const status = agentStatusFromMeta({ agent_id: agentId, items: snapshot.items, has_more: false, meta: snapshot.meta });
    roster.push({
      agentId,
      parentAgentId: source?.parentAgentId,
      parentToolCallId: source?.parentToolCallId,
      name: source?.name ?? agentId,
      model: meta?.model,
      thinkingEffort: meta?.thinkingEffort,
      contextTokens: meta?.contextTokens,
      maxContextTokens: meta?.maxContextTokens,
      usage: meta?.usage,
      toolCallCount: count.toolCallCount,
      toolCallCountKnown: count.toolCallCountKnown,
      toolCallCountAuthoritative: true,
      status,
      ...interruptedStatusFields(meta?.phase, status),
      busy: agentBusyFromMeta({
        agent_id: agentId,
        items: snapshot.items,
        has_more: false,
        meta: snapshot.meta,
      }),
    });
    const taskList = Array.isArray(snapshot.tasks) ? snapshot.tasks : [...snapshot.tasks.values()];
    if (taskList.length > 0) tasks.push(...taskItemsFromTranscriptTasks(taskList, agentId));
  }
  for (const entry of snapshotRoster) roster.push(entry);
  const forest = overlayForestDisplayFields(buildAgentForest(live, filterRosterToLiveOrPresent(roster, snapshots), tasks), live);
  const byId = { ...forest.byId };
  const snapshotRows = new Map<string, SnapshotSubagent>();
  const liveIds = new Set<string>();
  for (const row of snapshotSubagents ?? []) {
    const id = snapshotSubagentAgentId(row);
    snapshotRows.set(id, row);
    if (row.live === true) liveIds.add(id);
    const node = byId[id];
    if (node === undefined) continue;
    const nextStatusSource = node.status === (row.activity_status ?? row.status) ? row.status_source : undefined;
    if (node.nameSource !== row.name_source || node.statusSource !== nextStatusSource) {
      byId[id] = { ...node, nameSource: row.name_source, statusSource: nextStatusSource };
    }
  }
  for (const [agentId, snapshot] of snapshots) {
    let node = byId[agentId];
    if (node === undefined) continue;
    const row = snapshotRows.get(agentId);
    const meta = snapshot.meta.agent;
    const preferRoster = coldAgents?.has(agentId) === true || rosterCurrentAgents?.has(agentId) === true;
    const branchFallback = node.isBranch === true || row?.is_branch === true;
    const model = preferRoster ? row?.model ?? meta?.model : meta?.model ?? (branchFallback ? row?.model : undefined);
    const thinking = preferRoster
      ? row?.thinking_effort ?? meta?.thinkingEffort
      : meta?.thinkingEffort ?? (branchFallback ? row?.thinking_effort : undefined);
    if (model !== undefined || thinking !== undefined) {
      node = { ...node, model: model ?? node.model, thinkingEffort: thinking ?? node.thinkingEffort };
      byId[agentId] = node;
    }
    const turn = snapshot.items.findLast((item) => item.kind === 'turn');
    const status = agentStatusFromMeta({ agent_id: agentId, items: snapshot.items, has_more: false, meta: snapshot.meta });
    const activeLive = !preferRoster && (status === 'running' || status === 'suspended');
    if (activeLive && row?.live !== false && (node.status === 'idle' || node.status === 'unknown')) {
      const phase = meta?.phase;
      const activeAt = phase !== undefined && 'since' in phase ? phase.since
        : turn?.kind === 'turn' && turn.state === 'running' ? Date.parse(turn.startedAt ?? '') : NaN;
      const inactiveAt = Date.parse(row?.completed_at ?? row?.started_at ?? '');
      if ((status === 'running' || status === 'suspended') && Number.isFinite(activeAt) &&
          (!Number.isFinite(inactiveAt) || activeAt > inactiveAt)) {
        node = { ...node, status, busy: true, statusSource: 'runtime', endedAt: undefined };
        byId[agentId] = node;
      }
    }
    if (activeLive && (node.status === 'running' || node.status === 'suspended' || node.status === 'background')) liveIds.add(agentId);
    if (turn?.kind !== 'turn') continue;
    const outcome = turnOutcomeFromItem(turn);
    if (outcome === undefined) continue;
    const nodeStartedAt = Date.parse(node.startedAt ?? '');
    const endedAt = Date.parse(outcome.endedAt ?? '');
    if (Number.isFinite(nodeStartedAt) && Number.isFinite(endedAt) && nodeStartedAt > endedAt) continue;
    byId[agentId] = { ...node, turnOutcome: outcome };
  }
  const coldEvidence = new Set(coldAgents);
  for (const agentId of coldAgents ?? []) {
    const snapshot = snapshots.get(agentId);
    if (snapshot === undefined) continue;
    const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [...snapshot.tasks.values()];
    for (const task of tasks) if (task.agentId !== undefined) coldEvidence.add(task.agentId);
  }
  for (const agentId of coldEvidence) {
    const node = byId[agentId];
    if (node === undefined || liveIds.has(agentId)) continue;
    const coldFallback = node.branchSealed === true ? 'completed' : node.isBranch === true ? 'idle' : 'unknown';
    byId[agentId] = {
      ...node,
      busy: false,
      status: node.status === 'running' || node.status === 'suspended' || node.status === 'unknown' ? coldFallback : node.status,
    };
  }
  for (const [agentId, node] of Object.entries(byId)) {
    if (node.status === 'unknown' && (node.branchSealed === true || node.isBranch === true)) {
      byId[agentId] = { ...node, status: node.branchSealed === true ? 'completed' : 'idle' };
    }
  }
  return { byId, roots: forest.roots.map((node) => byId[node.agentId]!) };
}

export class SessionAgentForestQuery {
  private snapshots = new Map<string, AgentState | AgentTranscriptSnapshot>();
  private subagents: readonly SnapshotSubagent[] | undefined;
  private coldAgents = new Set<string>();
  private rosterCurrentAgents = new Set<string>();
  private forest: AgentForest | undefined;
  private validUntil = Infinity;

  read(
    snapshots: ReadonlyMap<string, AgentState | AgentTranscriptSnapshot>,
    subagents?: readonly SnapshotSubagent[],
    coldAgents?: ReadonlySet<string>,
    rosterCurrentAgents?: ReadonlySet<string>,
  ): AgentForest {
    const previousIds = [...this.snapshots.keys()];
    if (this.forest !== undefined && Date.now() < this.validUntil && this.subagents === subagents &&
        this.snapshots.size === snapshots.size && this.coldAgents.size === (coldAgents?.size ?? 0) &&
        [...this.coldAgents].every((id) => coldAgents?.has(id) === true) &&
        this.rosterCurrentAgents.size === (rosterCurrentAgents?.size ?? 0) &&
        [...this.rosterCurrentAgents].every((id) => rosterCurrentAgents?.has(id) === true) &&
        [...snapshots].every(([id, next], index) => {
          const previous = this.snapshots.get(id);
          return previousIds[index] === id && previous !== undefined && previous.items === next.items && previous.tasks === next.tasks &&
            previous.meta === next.meta && previous.toolCallCount === next.toolCallCount &&
            canonicalToolCallCountFields(previous).toolCallCountKnown === canonicalToolCallCountFields(next).toolCallCountKnown;
        })) return this.forest;
    this.forest = stabilizeAgentForest(this.forest, sessionAgentForestFromAgentSnapshots(snapshots, subagents, coldAgents, rosterCurrentAgents));
    this.snapshots = new Map(snapshots);
    this.subagents = subagents;
    this.coldAgents = new Set(coldAgents);
    this.rosterCurrentAgents = new Set(rosterCurrentAgents);
    this.validUntil = Infinity;
    const now = Date.now();
    for (const row of subagents ?? []) {
      if (row.refreshing !== true) continue;
      const until = Date.parse(row.refreshing_until ?? '');
      if (until > now) this.validUntil = Math.min(this.validUntil, until);
    }
    return this.forest;
  }
}

/**
 * Retain failed and cancelled rows as historical facts even before their
 * transcript arrives. Completed ghosts still need current evidence.
 */
function filterRosterToLiveOrPresent(
  roster: readonly AgentRosterDescriptor[],
  snapshots: ReadonlyMap<string, AgentState | AgentTranscriptSnapshot>,
): readonly AgentRosterDescriptor[] {
  if (snapshots.size === 0) return roster;
  const now = Date.now();
  return roster.filter((entry) => entry.statusSource !== undefined || snapshots.has(entry.agentId) ||
    entry.isBranch === true || entry.branchSealed === true ||
    entry.status === 'failed' || entry.status === 'cancelled' || (
    entry.disposedAt === undefined &&
    ((entry.refreshing === true && Date.parse(entry.refreshingUntil ?? '') > now) ||
      entry.status === 'running' || entry.status === 'suspended' || entry.status === 'unknown')
  ));
}
