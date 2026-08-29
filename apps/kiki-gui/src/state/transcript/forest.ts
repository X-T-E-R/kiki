import type { Task } from '@moonshot-ai/protocol';
import type { AgentState, AgentTranscriptSnapshot } from '@moonshot-ai/transcript';

import type { AgentTranscriptAgent, AgentTranscriptResponse, AgentTranscriptTask } from '../../lib/client';
import {
  MAIN_AGENT_ID,
  buildAgentForest,
  type AgentForest,
  type AgentLiveSource,
  type AgentRosterDescriptor,
  type AgentTaskItem,
} from '../agentTree';
import { agentBusyFromMeta } from './project';
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
    summary: block.summary,
    error: block.error,
    startedAt: block.startedAt,
    endedAt: block.endedAt,
    toolCallCount: block.toolCallCount,
  }));
}

export function sessionAgentForest(
  state: SessionViewState,
  roster?: readonly AgentRosterDescriptor[],
  extraTasks?: readonly AgentTaskItem[],
): AgentForest {
  return buildAgentForest(
    liveSourcesFromSubagentBlocks(subagentBlocksFromState(state)),
    roster,
    [...taskItemsFromSessionTasks(state.tasks), ...(extraTasks ?? [])],
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
      byId.set(task.agentId, {
        subagentId: task.agentId,
        parentAgentId,
        parentToolCallId: byId.get(task.agentId)?.parentToolCallId,
        name: byId.get(task.agentId)?.name ?? task.description ?? task.agentId,
        status: task.state,
        summary: task.resultSummary,
        error: task.error,
        startedAt: task.startedAt,
        endedAt: task.endedAt,
      });
    }
    for (const item of snapshot.items) {
      if (item.kind !== 'turn') continue;
      for (const step of item.steps) {
        for (const frame of step.frames) {
          if (frame.kind !== 'tool' || frame.agentRefs === undefined) continue;
          for (const ref of frame.agentRefs) {
            const existing = byId.get(ref.agentId);
            const input = frame.input as {
              profile?: unknown;
              subagent_type?: unknown;
              subagentType?: unknown;
              description?: unknown;
            } | undefined;
            const named =
              typeof input?.profile === 'string' && input.profile !== ''
                ? input.profile
                : typeof input?.subagent_type === 'string' && input.subagent_type !== ''
                  ? input.subagent_type
                  : typeof input?.subagentType === 'string' && input.subagentType !== ''
                    ? input.subagentType
                    : typeof input?.description === 'string' && input.description !== ''
                      ? input.description
                      : undefined;
            byId.set(ref.agentId, {
              subagentId: ref.agentId,
              parentAgentId,
              parentToolCallId: frame.toolCallId,
              name: named ?? existing?.name ?? ref.agentId,
              status: existing?.status ?? 'running',
              summary: existing?.summary,
              error: existing?.error,
              startedAt: existing?.startedAt ?? step.startedAt ?? item.startedAt,
              endedAt: existing?.endedAt,
              toolCallCount: existing?.toolCallCount,
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
    if (meta === undefined) continue;
    const existing = byId.get(agentId);
    if (existing === undefined) continue;
    byId.set(agentId, {
      ...existing,
      model: meta.model ?? existing.model,
      thinkingEffort: meta.thinkingEffort ?? existing.thinkingEffort,
    });
  }
  return [...byId.values()];
}

export function sessionAgentForestFromAgentSnapshots(
  snapshots: ReadonlyMap<string, AgentState | AgentTranscriptSnapshot>,
): AgentForest {
  const live = liveSourcesFromAgentSnapshots(snapshots);
  const tasks: AgentTaskItem[] = [];
  const roster: AgentRosterDescriptor[] = [];
  for (const [agentId, snapshot] of snapshots) {
    const meta = snapshot.meta.agent;
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
  return buildAgentForest(live, roster, tasks);
}
