import { resolveSubagentDisplayName } from '@kiki/transcript-live';
import type { AgentTaskInfo } from '@kiki/agent-core-v2';

import type { Event } from './events';
import type { SnapshotSubagent } from '../../../protocol/rest-snapshot';

type SnapshotSubagentPhase = NonNullable<SnapshotSubagent['subagent_phase']>;
type TrackedSubagentStatus = SnapshotSubagent['status'] | 'unknown';
type TrackedSubagentPhase = SnapshotSubagentPhase | 'unknown';
type TrackedSubagent = Omit<SnapshotSubagent, 'status' | 'subagent_phase'> & {
  status: TrackedSubagentStatus;
  subagent_phase?: TrackedSubagentPhase;
};

function projectTaskStatus(status: AgentTaskInfo['status']): {
  readonly status: SnapshotSubagent['status'];
  readonly phase: SnapshotSubagent['subagent_phase'];
  readonly terminal: boolean;
} {
  switch (status) {
    case 'running':
      return { status: 'running', phase: 'working', terminal: false };
    case 'completed':
      return { status: 'completed', phase: 'completed', terminal: true };
    case 'killed':
      return { status: 'cancelled', phase: undefined, terminal: true };
    case 'failed':
    case 'timed_out':
    case 'lost':
      return { status: 'failed', phase: 'failed', terminal: true };
  }
}

function isTerminalStatus(status: TrackedSubagentStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function finiteTime(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function parsedTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function crossesBoundary(value: number | undefined, boundary: number | undefined): boolean {
  if (boundary === undefined) return true;
  if (value === undefined) return false;
  return value > boundary;
}

function isoTime(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

export class SubagentRosterTracker {
  private readonly bySession = new Map<string, Map<string, TrackedSubagent>>();
  private readonly toolCallsBySession = new Map<string, Map<string, Set<string>>>();
  private readonly taskIdsBySession = new Map<string, Map<string, string>>();
  private readonly generationStartedAtBySession = new Map<string, Map<string, number>>();
  private readonly disposedAtBySession = new Map<string, Map<string, number>>();

  apply(sessionId: string, event: Event): void {
    switch (event.type) {
      case 'subagent.spawned': {
        const roster = this.roster(sessionId);
        const existing = roster.get(event.subagentId);
        const taskIds = this.taskIds(sessionId);
        const existingTaskId = taskIds.get(event.subagentId);
        const distinctTaskId =
          event.taskId !== undefined &&
          existingTaskId !== undefined &&
          event.taskId !== existingTaskId;
        const eventAt = finiteTime(event.time);
        const existingStartedAt = parsedTime(existing?.started_at);
        const existingEndedAt = parsedTime(existing?.completed_at);
        const disposedAt = this.disposals(sessionId).get(event.subagentId);
        const afterDisposal = crossesBoundary(eventAt, disposedAt);
        if (existing === undefined && disposedAt !== undefined && !afterDisposal) return;
        const mayStartGeneration = existingTaskId === undefined || distinctTaskId;
        const restartsTerminal =
          existing !== undefined &&
          isTerminalStatus(existing.status) &&
          mayStartGeneration &&
          eventAt !== undefined &&
          crossesBoundary(eventAt, existingEndedAt) &&
          afterDisposal;
        const restartsActive =
          existing !== undefined &&
          !isTerminalStatus(existing.status) &&
          existing.status !== 'unknown' &&
          distinctTaskId &&
          eventAt !== undefined &&
          existingStartedAt !== undefined &&
          eventAt > existingStartedAt;
        const restartsUnknown =
          existing?.status === 'unknown' &&
          mayStartGeneration &&
          eventAt !== undefined &&
          afterDisposal;
        const restarted = restartsTerminal || restartsActive || restartsUnknown;
        const matchingGeneration =
          existingTaskId === undefined ||
          (event.taskId !== undefined && event.taskId === existingTaskId);
        const acceptedRun =
          existing === undefined || restarted || (existing.status !== 'unknown' && matchingGeneration);
        const generationReset =
          restarted && eventAt !== undefined
            ? this.resetGeneration(sessionId, event.subagentId, eventAt)
            : undefined;
        const createdAt = isoTime(eventAt) ?? new Date().toISOString();
        roster.set(event.subagentId, {
          ...existing,
          ...generationReset,
          id: event.subagentId,
          session_id: sessionId,
          kind: 'subagent',
          description: resolveSubagentDisplayName(
            event.userLabel,
            event.subagentName,
            event.subagentId,
          ),
          status: acceptedRun
            ? restarted
              ? 'running'
              : (existing?.status ?? 'running')
            : existing!.status,
          subagent_phase: acceptedRun
            ? restarted
              ? 'queued'
              : (existing?.subagent_phase ?? 'queued')
            : existing!.subagent_phase,
          profile:
            event.subagentName === '' ? existing?.profile : event.subagentName,
          label: event.userLabel ?? existing?.label,
          parent_agent_id: event.parentAgentId ?? existing?.parent_agent_id,
          parent_tool_call_id:
            event.parentToolCallId === ''
              ? existing?.parent_tool_call_id
              : event.parentToolCallId,
          tool_call_count: acceptedRun
            ? restarted
              ? 0
              : (existing?.tool_call_count ?? 0)
            : existing!.tool_call_count,
          swarm_index: event.swarmIndex ?? existing?.swarm_index,
          run_in_background: acceptedRun
            ? restarted
              ? event.runInBackground
              : event.runInBackground || existing?.run_in_background === true
            : existing!.run_in_background,
          model: acceptedRun
            ? restarted
              ? event.model
              : (event.model ?? existing?.model)
            : existing!.model,
          thinking_effort: acceptedRun
            ? restarted
              ? event.thinkingEffort
              : (event.thinkingEffort ?? existing?.thinking_effort)
            : existing!.thinking_effort,
          created_at: acceptedRun
            ? restarted
              ? createdAt
              : (existing?.created_at ?? createdAt)
            : existing!.created_at,
          started_at: acceptedRun
            ? restarted
              ? isoTime(eventAt)
              : existing?.started_at
            : existing!.started_at,
          completed_at: acceptedRun
            ? restarted
              ? undefined
              : existing?.completed_at
            : existing!.completed_at,
          output_preview: acceptedRun
            ? restarted
              ? undefined
              : existing?.output_preview
            : existing!.output_preview,
          suspended_reason: acceptedRun
            ? restarted
              ? undefined
              : existing?.suspended_reason
            : existing!.suspended_reason,
        });
        if (acceptedRun && event.taskId !== undefined) {
          taskIds.set(event.subagentId, event.taskId);
        }
        return;
      }
      case 'subagent.started': {
        const entry = this.bySession.get(sessionId)?.get(event.subagentId);
        if (!entry || isTerminalStatus(entry.status)) return;
        const eventAt = finiteTime(event.time);
        const existingStartedAt = parsedTime(entry.started_at);
        if (entry.status === 'unknown') {
          const disposedAt = this.disposals(sessionId).get(event.subagentId);
          if (eventAt === undefined || !crossesBoundary(eventAt, disposedAt)) return;
          Object.assign(
            entry,
            this.resetGeneration(sessionId, event.subagentId, eventAt),
            { status: 'running', subagent_phase: 'working' },
          );
          return;
        }
        if (
          eventAt !== undefined &&
          existingStartedAt !== undefined &&
          eventAt < existingStartedAt
        ) {
          return;
        }
        entry.status = 'running';
        entry.subagent_phase = 'working';
        entry.suspended_reason = undefined;
        entry.completed_at = undefined;
        entry.started_at ??= isoTime(eventAt) ?? new Date().toISOString();
        return;
      }
      case 'subagent.suspended': {
        const entry = this.bySession.get(sessionId)?.get(event.subagentId);
        if (!entry || isTerminalStatus(entry.status)) return;
        const eventAt = finiteTime(event.time);
        const existingStartedAt = parsedTime(entry.started_at);
        if (entry.status === 'unknown') {
          const disposedAt = this.disposals(sessionId).get(event.subagentId);
          if (eventAt === undefined || !crossesBoundary(eventAt, disposedAt)) return;
          Object.assign(
            entry,
            this.resetGeneration(sessionId, event.subagentId, eventAt),
            {
              status: 'running',
              subagent_phase: 'suspended',
              suspended_reason: event.reason,
            },
          );
          return;
        }
        if (
          eventAt !== undefined &&
          existingStartedAt !== undefined &&
          eventAt < existingStartedAt
        ) {
          return;
        }
        entry.status = 'running';
        entry.subagent_phase = 'suspended';
        entry.suspended_reason = event.reason;
        entry.started_at ??= isoTime(eventAt) ?? new Date().toISOString();
        return;
      }
      case 'subagent.completed': {
        this.finishLifecycle(
          sessionId,
          event.subagentId,
          'completed',
          'completed',
          event.resultSummary,
          event.time,
        );
        return;
      }
      case 'subagent.failed': {
        this.finishLifecycle(
          sessionId,
          event.subagentId,
          event.error === 'terminated' ? 'cancelled' : 'failed',
          event.error === 'terminated' ? undefined : 'failed',
          event.error,
          event.time,
        );
        return;
      }
      case 'agent.disposed': {
        const observedAt = finiteTime(event.time) ?? Date.now();
        const disposals = this.disposals(sessionId);
        const disposedAt = Math.max(disposals.get(event.agentId) ?? Number.NEGATIVE_INFINITY, observedAt);
        disposals.set(event.agentId, disposedAt);
        const entry = this.bySession.get(sessionId)?.get(event.agentId);
        if (!entry || isTerminalStatus(entry.status)) return;
        const activeSince = parsedTime(entry.started_at) ?? parsedTime(entry.created_at);
        if (activeSince !== undefined && activeSince > disposedAt) return;
        entry.status = 'unknown';
        entry.subagent_phase = 'unknown';
        entry.suspended_reason = undefined;
        entry.completed_at = undefined;
        entry.output_preview = undefined;
        return;
      }
      case 'tool.call.started': {
        const entry = this.bySession.get(sessionId)?.get(event.agentId);
        if (!entry || entry.status === 'unknown' || isTerminalStatus(entry.status)) return;
        const eventAt = finiteTime(event.time);
        const existingStartedAt = parsedTime(entry.started_at);
        if (
          eventAt !== undefined &&
          existingStartedAt !== undefined &&
          eventAt < existingStartedAt
        ) {
          return;
        }
        const toolCalls = this.toolCalls(sessionId, event.agentId);
        toolCalls.add(event.toolCallId);
        entry.tool_call_count = toolCalls.size;
        return;
      }
      case 'task.started':
      case 'task.terminated': {
        this.seedTask(sessionId, event.agentId, event.info as AgentTaskInfo, event.time);
        return;
      }
      default:
        return;
    }
  }

  seedTask(
    sessionId: string,
    parentAgentId: string,
    info: AgentTaskInfo,
    eventTime?: number,
  ): void {
    if (info.kind !== 'agent' || info.agentId === undefined || info.agentId === '') return;
    const startedAtValue = finiteTime(info.startedAt);
    if (startedAtValue === undefined) return;
    const projection = projectTaskStatus(info.status);
    const roster = this.roster(sessionId);
    const existing = roster.get(info.agentId);
    const taskIds = this.taskIds(sessionId);
    const existingTaskId = taskIds.get(info.agentId);
    const matchingTaskId = existingTaskId === info.taskId;
    const distinctTaskId = existingTaskId !== undefined && !matchingTaskId;
    const generationStartedAt = this.generationStartedAtBySession
      .get(sessionId)
      ?.get(info.agentId);
    if (
      !matchingTaskId &&
      generationStartedAt !== undefined &&
      startedAtValue < generationStartedAt
    ) {
      return;
    }
    const existingStartedAt = parsedTime(existing?.started_at);
    const existingEndedAt = parsedTime(existing?.completed_at);
    const disposedAt = this.disposals(sessionId).get(info.agentId);
    const endedAtValue = info.endedAt === null ? undefined : finiteTime(info.endedAt);
    const terminalAt = endedAtValue ?? finiteTime(eventTime);
    const startedAt = new Date(startedAtValue).toISOString();
    const endedAt = isoTime(endedAtValue ?? (projection.terminal ? terminalAt : undefined));

    if (projection.terminal) {
      if (
        !matchingTaskId &&
        existing?.status === 'unknown' &&
        !crossesBoundary(startedAtValue, disposedAt)
      ) {
        return;
      }
      if (
        !matchingTaskId &&
        existingStartedAt !== undefined &&
        ((terminalAt !== undefined && terminalAt <= existingStartedAt) ||
          (distinctTaskId && startedAtValue <= existingStartedAt))
      ) {
        return;
      }
      const terminalBoundary = existingEndedAt ?? existingStartedAt;
      const restartsTerminal =
        existing !== undefined &&
        isTerminalStatus(existing.status) &&
        crossesBoundary(startedAtValue, terminalBoundary);
      const restartsActive =
        existing !== undefined &&
        !isTerminalStatus(existing.status) &&
        existing.status !== 'unknown' &&
        existingStartedAt !== undefined &&
        startedAtValue > existingStartedAt;
      const restartsUnknown =
        existing?.status === 'unknown' && crossesBoundary(startedAtValue, disposedAt);
      const restarted = restartsTerminal || restartsActive || restartsUnknown;
      if (
        existing !== undefined &&
        isTerminalStatus(existing.status) &&
        !restarted &&
        existing.status !== projection.status
      ) {
        return;
      }
      const generationReset = restarted
        ? this.resetGeneration(sessionId, info.agentId, startedAtValue)
        : undefined;
      roster.set(info.agentId, {
        ...existing,
        ...generationReset,
        id: info.agentId,
        session_id: sessionId,
        kind: 'subagent',
        description: existing?.description ?? info.description,
        status: projection.status,
        subagent_phase: projection.phase,
        profile: info.profile ?? existing?.profile,
        parent_agent_id: parentAgentId,
        parent_tool_call_id: info.parentToolCallId ?? existing?.parent_tool_call_id,
        tool_call_count: restarted ? 0 : (existing?.tool_call_count ?? 0),
        run_in_background: restarted
          ? info.detached
          : (info.detached ?? existing?.run_in_background),
        model: restarted ? info.model : (info.model ?? existing?.model),
        thinking_effort: restarted
          ? info.thinkingEffort
          : (info.thinkingEffort ?? existing?.thinking_effort),
        created_at: restarted ? startedAt : (existing?.created_at ?? startedAt),
        started_at: restarted ? startedAt : (existing?.started_at ?? startedAt),
        completed_at: restarted ? endedAt : (existing?.completed_at ?? endedAt),
        output_preview:
          projection.status === 'completed'
            ? restarted
              ? undefined
              : existing?.output_preview
            : (info.stopReason ?? (restarted ? undefined : existing?.output_preview)),
        suspended_reason: restarted ? undefined : existing?.suspended_reason,
      });
      taskIds.set(info.agentId, info.taskId);
      return;
    }

    if (disposedAt !== undefined && !crossesBoundary(startedAtValue, disposedAt)) return;
    const terminalBoundary = existingEndedAt ?? existingStartedAt;
    if (
      existing !== undefined &&
      isTerminalStatus(existing.status) &&
      !crossesBoundary(startedAtValue, terminalBoundary)
    ) {
      return;
    }
    if (
      existing !== undefined &&
      !isTerminalStatus(existing.status) &&
      existing.status !== 'unknown' &&
      distinctTaskId &&
      existingStartedAt !== undefined &&
      startedAtValue <= existingStartedAt
    ) {
      return;
    }
    const restarted =
      existing?.status === 'unknown' ||
      (existing !== undefined && isTerminalStatus(existing.status)) ||
      (existing !== undefined &&
        !isTerminalStatus(existing.status) &&
        distinctTaskId &&
        existingStartedAt !== undefined &&
        startedAtValue > existingStartedAt) ||
      (existing === undefined && disposedAt !== undefined);
    const generationReset = restarted
      ? this.resetGeneration(sessionId, info.agentId, startedAtValue)
      : undefined;
    const keepsSuspended = !restarted && existing?.subagent_phase === 'suspended';
    roster.set(info.agentId, {
      ...existing,
      ...generationReset,
      id: info.agentId,
      session_id: sessionId,
      kind: 'subagent',
      description: existing?.description ?? info.description,
      status: 'running',
      subagent_phase: keepsSuspended ? 'suspended' : 'working',
      profile: info.profile ?? existing?.profile,
      parent_agent_id: parentAgentId,
      parent_tool_call_id: info.parentToolCallId ?? existing?.parent_tool_call_id,
      tool_call_count: restarted ? 0 : (existing?.tool_call_count ?? 0),
      run_in_background: restarted
        ? info.detached
        : (info.detached ?? existing?.run_in_background),
      model: restarted ? info.model : (info.model ?? existing?.model),
      thinking_effort: restarted
        ? info.thinkingEffort
        : (info.thinkingEffort ?? existing?.thinking_effort),
      created_at: restarted ? startedAt : (existing?.created_at ?? startedAt),
      started_at: restarted ? startedAt : (existing?.started_at ?? startedAt),
      completed_at: undefined,
      output_preview: undefined,
      suspended_reason: keepsSuspended ? existing?.suspended_reason : undefined,
    });
    taskIds.set(info.agentId, info.taskId);
  }

  get(sessionId: string): SnapshotSubagent[] {
    const roster = this.bySession.get(sessionId);
    if (!roster) return [];
    const result: SnapshotSubagent[] = [];
    for (const entry of roster.values()) {
      const { status, subagent_phase: phase, ...rest } = entry;
      if (status === 'unknown' || phase === 'unknown') continue;
      result.push({ ...rest, status, subagent_phase: phase });
    }
    return result;
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
    this.toolCallsBySession.delete(sessionId);
    this.taskIdsBySession.delete(sessionId);
    this.generationStartedAtBySession.delete(sessionId);
    this.disposedAtBySession.delete(sessionId);
  }

  private resetGeneration(
    sessionId: string,
    agentId: string,
    startedAt: number,
  ): Partial<TrackedSubagent> {
    this.toolCalls(sessionId, agentId).clear();
    this.taskIds(sessionId).delete(agentId);
    this.generationStarts(sessionId).set(agentId, startedAt);
    const timestamp = new Date(startedAt).toISOString();
    return {
      status: 'unknown',
      subagent_phase: 'unknown',
      tool_call_count: 0,
      run_in_background: undefined,
      model: undefined,
      thinking_effort: undefined,
      created_at: timestamp,
      started_at: timestamp,
      completed_at: undefined,
      output_preview: undefined,
      suspended_reason: undefined,
    };
  }

  private finishLifecycle(
    sessionId: string,
    agentId: string,
    status: 'completed' | 'failed' | 'cancelled',
    phase: 'completed' | 'failed' | undefined,
    output: string,
    time: number | undefined,
  ): void {
    const entry = this.bySession.get(sessionId)?.get(agentId);
    if (!entry || isTerminalStatus(entry.status)) return;
    if (
      entry.run_in_background === true &&
      this.taskIdsBySession.get(sessionId)?.has(agentId) === true
    ) {
      return;
    }
    const eventAt = finiteTime(time);
    const existingStartedAt = parsedTime(entry.started_at);
    if (
      eventAt !== undefined &&
      existingStartedAt !== undefined &&
      eventAt < existingStartedAt
    ) {
      return;
    }
    entry.subagent_phase = phase;
    entry.status = status;
    entry.completed_at ??= isoTime(eventAt) ?? new Date().toISOString();
    entry.output_preview = output;
  }

  private roster(sessionId: string): Map<string, TrackedSubagent> {
    let roster = this.bySession.get(sessionId);
    if (roster === undefined) {
      roster = new Map();
      this.bySession.set(sessionId, roster);
    }
    return roster;
  }

  private taskIds(sessionId: string): Map<string, string> {
    let taskIds = this.taskIdsBySession.get(sessionId);
    if (taskIds === undefined) {
      taskIds = new Map();
      this.taskIdsBySession.set(sessionId, taskIds);
    }
    return taskIds;
  }

  private generationStarts(sessionId: string): Map<string, number> {
    let generationStarts = this.generationStartedAtBySession.get(sessionId);
    if (generationStarts === undefined) {
      generationStarts = new Map();
      this.generationStartedAtBySession.set(sessionId, generationStarts);
    }
    return generationStarts;
  }

  private disposals(sessionId: string): Map<string, number> {
    let disposals = this.disposedAtBySession.get(sessionId);
    if (disposals === undefined) {
      disposals = new Map();
      this.disposedAtBySession.set(sessionId, disposals);
    }
    return disposals;
  }

  private toolCalls(sessionId: string, agentId: string): Set<string> {
    let byAgent = this.toolCallsBySession.get(sessionId);
    if (byAgent === undefined) {
      byAgent = new Map();
      this.toolCallsBySession.set(sessionId, byAgent);
    }
    let toolCalls = byAgent.get(agentId);
    if (toolCalls === undefined) {
      toolCalls = new Set();
      byAgent.set(agentId, toolCalls);
    }
    return toolCalls;
  }
}
