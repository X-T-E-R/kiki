import type { SnapshotSubagent, Task } from '@kiki/protocol';
import type { AgentState, AgentTranscriptSnapshot } from '@kiki/transcript';

import type { AgentTranscriptAgent, AgentTranscriptResponse, AgentTranscriptTask } from '../../transport';
import {
  MAIN_AGENT_ID,
  buildAgentForest,
  type AgentForest,
  type AgentLiveSource,
  type AgentRosterDescriptor,
  type AgentTaskItem,
} from '../agentTree';
import { agentBusyFromMeta, snapshotSubagentAgentId } from './project';
import { subagentBlocksFromState } from './selectors';
import type { SessionViewState, SubagentBlock } from './types';

export function rosterFromTranscriptAgents(
  agents: readonly AgentTranscriptAgent[] | undefined,
): readonly AgentRosterDescriptor[] {
  if (agents === undefined) return [];
  return agents.map((agent) => {
    const parentFromDelegator = agent.delegator?.kind === 'agent' ? agent.delegator.agentId : undefined;
    return {
      agentId: agent.agentId,
      parentAgentId: agent.parentAgentId ?? parentFromDelegator,
      name: agent.label ?? agent.agentId,
      label: agent.label,
      status: agent.agentId === MAIN_AGENT_ID ? undefined : 'unknown',
      startedAt: agent.createdAt,
      disposedAt: agent.disposedAt,
    };
  });
}

export function agentStatusFromMeta(response: AgentTranscriptResponse | undefined): AgentRosterDescriptor['status'] {
  const phase = response?.meta?.agent?.phase;
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
  const projectedStatus = agentStatusFromMeta(response);
  const statusFields = {
    model: meta.model,
    thinkingEffort: meta.thinkingEffort,
    contextTokens: meta.contextTokens,
    maxContextTokens: meta.maxContextTokens,
    usage: meta.usage,
    status: response.agent_id === MAIN_AGENT_ID && projectedStatus === 'unknown' ? undefined : projectedStatus,
    busy: agentBusyFromMeta(response),
  };
  if (index >= 0) roster[index] = { ...roster[index]!, ...statusFields };
  else roster.push({ agentId: response.agent_id, name: response.agent_id, ...statusFields });
  return roster;
}

export function taskItemsFromTranscriptTasks(
  tasks: readonly AgentTranscriptTask[] | undefined,
): readonly AgentTaskItem[] {
  if (tasks === undefined) return [];
  return tasks.flatMap((task) => {
    if (task.agentId === undefined || task.agentId === '') return [];
    return [
      {
        id: task.taskId,
        agentId: task.agentId,
        kind: task.kind,
        name: task.name ?? task.subagentName,
        description: task.description,
        status: task.state,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        summary: task.resultSummary,
        output_preview: task.outputTail,
        detached: task.detached,
      } satisfies AgentTaskItem,
    ];
  });
}

export function taskItemsFromSessionTasks(tasks: readonly Task[]): readonly AgentTaskItem[] {
  return tasks.flatMap((task) => {
    if (task.kind !== 'subagent' || task.agent_id === undefined || task.agent_id === '') return [];
    return [
      {
        id: task.id,
        agentId: task.agent_id,
        kind: task.kind,
        description: task.description,
        status: task.status,
        model: task.model,
        thinking_effort: task.thinking_effort,
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
    const startedAt = subagent.started_at ?? subagent.created_at;
    return [
      {
        agentId,
        parentAgentId: presentSnapshotText(subagent.parent_agent_id),
        parentToolCallId: presentSnapshotText(subagent.parent_tool_call_id),
        name,
        label,
        model: presentSnapshotText(subagent.model),
        thinkingEffort: presentSnapshotText(subagent.thinking_effort),
        status: subagent.subagent_phase === 'suspended' ? 'suspended' : subagent.status,
        refreshing: subagent.refreshing,
        refreshingUntil: subagent.refreshing_until,
        disposedAt: subagent.live === false ? startedAt : undefined,
        toolCallCount: subagent.tool_call_count,
        toolCallCountKnown: subagent.tool_call_count === undefined ? undefined : true,
        startedAt,
        endedAt: subagent.completed_at,
        description,
        summary: presentSnapshotText(subagent.output_preview),
        error: presentSnapshotText(subagent.stop_reason),
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
): readonly AgentLiveSource[] {
  if (snapshotSubagents === undefined || snapshotSubagents.length === 0) return live;
  const rosterById = new Map(
    rosterFromSnapshotSubagents(snapshotSubagents).map((entry) => [entry.agentId, entry] as const),
  );
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
    return {
      ...source,
      parentAgentId: source.parentAgentId ?? snapshot.parentAgentId,
      parentToolCallId: source.parentToolCallId ?? snapshot.parentToolCallId,
      name: source.name !== source.subagentId ? source.name : snapshot.name ?? source.name,
      label: source.label ?? snapshot.label,
      model: source.model ?? snapshot.model,
      thinkingEffort: source.thinkingEffort ?? snapshot.thinkingEffort,
      status: source.status === 'unknown' ? snapshot.status ?? source.status : source.status,
      disposedAt: source.disposedAt ?? snapshot.disposedAt,
      description: source.description ?? snapshot.description,
      summary: source.summary ?? snapshot.summary,
      error: source.error ?? snapshot.error,
      startedAt: presentSnapshotText(source.startedAt) ?? snapshot.startedAt,
      endedAt: source.endedAt ?? snapshot.endedAt,
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
    const next = {
      ...node,
      name: nextName,
      label: nextLabel,
      model: node.model ?? source.model,
      thinkingEffort: node.thinkingEffort ?? source.thinkingEffort,
      toolCallCount: nextToolCallCount,
      toolCallCountKnown: nextToolCallCountKnown,
      startedAt: presentSnapshotText(node.startedAt) ?? source.startedAt,
      endedAt: node.endedAt ?? source.endedAt,
      description: node.description ?? source.description,
      summary: node.summary ?? source.summary,
      error: node.error ?? source.error,
    };
    if (
      next.model !== node.model ||
      next.thinkingEffort !== node.thinkingEffort ||
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
  const live = overlayLiveSourcesWithSnapshotSubagents(
    liveSourcesFromSubagentBlocks(subagentBlocksFromState(state)),
    state.snapshotSubagents,
  );
  return overlayForestDisplayFields(
    buildAgentForest(live, roster, [...taskItemsFromSessionTasks(state.tasks), ...(extraTasks ?? [])]),
    live,
  );
}

export function sessionAgentForestFromTranscript(
  state: SessionViewState,
  response: AgentTranscriptResponse | undefined,
): AgentForest {
  return sessionAgentForest(state, rosterFromTranscriptResponse(response), taskItemsFromTranscriptTasks(response?.tasks));
}

export function liveSourcesFromAgentSnapshots(
  snapshots: ReadonlyMap<string, AgentState | AgentTranscriptSnapshot>,
): readonly AgentLiveSource[] {
  const byId = new Map<string, AgentLiveSource>();
  for (const [parentAgentId, snapshot] of snapshots) {
    const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [...snapshot.tasks.values()];
    for (const task of tasks) {
      if (task.kind !== 'subagent' || task.agentId === undefined || task.agentId === '') continue;
      const existing = byId.get(task.agentId);
      byId.set(task.agentId, {
        subagentId: task.agentId,
        parentAgentId,
        parentToolCallId: existing?.parentToolCallId,
        name: task.name ?? task.subagentName ?? existing?.name ?? task.agentId,
        status: task.state,
        description: task.description ?? existing?.description,
        summary: task.resultSummary,
        error: task.error,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        toolCallCount: existing?.toolCallCount,
        toolCallCountKnown: existing?.toolCallCountKnown,
        toolCallCountAuthoritative: existing?.toolCallCountAuthoritative,
      });
    }
    for (const item of snapshot.items) {
      if (item.kind !== 'turn') continue;
      for (const step of item.steps) {
        for (const frame of step.frames) {
          if (frame.kind !== 'tool' || frame.agentRefs === undefined) continue;
          for (const ref of frame.agentRefs) {
            const existing = byId.get(ref.agentId);
            byId.set(ref.agentId, {
              subagentId: ref.agentId,
              parentAgentId,
              parentToolCallId: frame.toolCallId,
              name: existing?.name ?? ref.agentId,
              status: existing?.status ?? 'running',
              description: existing?.description,
              summary: existing?.summary,
              error: existing?.error,
              startedAt: existing?.startedAt ?? step.startedAt ?? item.startedAt,
              endedAt: existing?.endedAt,
              toolCallCount: existing?.toolCallCount,
              toolCallCountKnown: existing?.toolCallCountKnown,
              toolCallCountAuthoritative: existing?.toolCallCountAuthoritative,
              model: existing?.model,
              thinkingEffort: existing?.thinkingEffort,
            });
          }
        }
      }
    }
    const meta = snapshot.meta.agent;
    if (meta !== undefined) {
      for (const [agentId, live] of byId) {
        if (agentId === parentAgentId) continue;
        if (live.parentAgentId !== parentAgentId) continue;
      }
      for (const task of tasks) {
        if (task.agentId === undefined) continue;
        const existing = byId.get(task.agentId);
        if (existing === undefined) continue;
        if (parentAgentId === task.agentId) {
          byId.set(task.agentId, {
            ...existing,
            model: meta.model ?? existing.model,
            thinkingEffort: meta.thinkingEffort ?? existing.thinkingEffort,
          });
        }
      }
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
): AgentForest {
  const live = overlayLiveSourcesWithSnapshotSubagents(
    liveSourcesFromAgentSnapshots(snapshots),
    snapshotSubagents,
  );
  const tasks: AgentTaskItem[] = [];
  const roster: AgentRosterDescriptor[] = [];
  for (const [agentId, snapshot] of snapshots) {
    const meta = snapshot.meta.agent;
    const count = canonicalToolCallCountFields(snapshot);
    roster.push({
      agentId,
      parentAgentId: live.find((entry) => entry.subagentId === agentId)?.parentAgentId,
      parentToolCallId: live.find((entry) => entry.subagentId === agentId)?.parentToolCallId,
      name: live.find((entry) => entry.subagentId === agentId)?.name ?? agentId,
      model: meta?.model,
      thinkingEffort: meta?.thinkingEffort,
      contextTokens: meta?.contextTokens,
      maxContextTokens: meta?.maxContextTokens,
      usage: meta?.usage,
      toolCallCount: count.toolCallCount,
      toolCallCountKnown: count.toolCallCountKnown,
      toolCallCountAuthoritative: true,
      status: agentStatusFromMeta({
        agent_id: agentId,
        items: [],
        has_more: false,
        meta: snapshot.meta,
      }),
      busy: agentBusyFromMeta({
        agent_id: agentId,
        items: [],
        has_more: false,
        meta: snapshot.meta,
      }),
    });
    const taskList = Array.isArray(snapshot.tasks) ? snapshot.tasks : [...snapshot.tasks.values()];
    tasks.push(...taskItemsFromTranscriptTasks(taskList));
  }
  roster.push(...rosterFromSnapshotSubagents(snapshotSubagents));
  return overlayForestDisplayFields(buildAgentForest(live, filterRosterToLiveOrPresent(roster, snapshots), tasks), live);
}

/**
 * Keep active, unknown and waking roster rows visible before their new
 * transcript snapshot arrives, while excluding terminal rows without live
 * evidence. Disposed agents remain ghosts even if retained for resume.
 */
function filterRosterToLiveOrPresent(
  roster: readonly AgentRosterDescriptor[],
  snapshots: ReadonlyMap<string, AgentState | AgentTranscriptSnapshot>,
): readonly AgentRosterDescriptor[] {
  if (snapshots.size === 0) return roster;
  const presentIds = new Set<string>(snapshots.keys());
  return roster.filter((entry) => presentIds.has(entry.agentId) || (
    entry.disposedAt === undefined &&
    ((entry.refreshing === true && Date.parse(entry.refreshingUntil ?? '') > Date.now()) ||
      entry.status === 'running' || entry.status === 'suspended' || entry.status === 'unknown')
  ));
}
