import type { AgentActivityState, SessionMeta } from '@kiki/agent-core-v2';
import type { SnapshotSubagent } from '@kiki/protocol';
import { resolveSubagentDisplayName, subagentParentAgentId, subagentUserLabel } from '@kiki/transcript-live';

function terminalStatus(status: string | undefined): SnapshotSubagent['status'] | undefined {
  if (status === 'completed' || status === 'failed' || status === 'cancelled') return status;
  return undefined;
}

function lastTurnOutcome(activity: AgentActivityState | undefined, trackedStart: number | undefined): SnapshotSubagent['status'] | undefined {
  const lastTurn = activity?.lastTurn;
  if (lastTurn === undefined || (trackedStart !== undefined && lastTurn.at < trackedStart)) return undefined;
  switch (lastTurn.reason) {
    case 'completed': return 'completed';
    case 'cancelled': return 'cancelled';
    case 'failed': return 'failed';
    default: return undefined;
  }
}

export function sessionAgentRoster(
  sessionId: string,
  meta: SessionMeta,
  tracked: readonly SnapshotSubagent[] = [],
  runtime: ReadonlyMap<string, AgentActivityState & { readonly model?: string }> = new Map(),
): SnapshotSubagent[] {
  const rows = new Map(tracked.map((row) => [row.agent_id ?? row.id, row]));
  const ids = new Set([...Object.keys(meta.agents ?? {}), ...rows.keys(), ...runtime.keys()]);
  const candidates = [...ids].filter((id): id is string => {
    if (id === 'main' || id === undefined) return false;
    const registration = meta.agents?.[id];
    const row = rows.get(id);
    const registrationOutcome = registration?.status !== undefined && registration.completedAt !== undefined;
    const staleTracked = row?.live === false && row.status === 'running' && row.subagent_phase === undefined &&
      row.started_at === undefined && row.completed_at === undefined && !registrationOutcome;
    return row === undefined || !staleTracked;
  });
  return candidates.map((id) => {
    const registration = meta.agents?.[id];
    const row = rows.get(id);
    const activity = runtime.get(id);
    const label = subagentUserLabel(registration) ?? row?.label;
    const profile = registration?.displayName ?? row?.profile;
    const nameSource: SnapshotSubagent['name_source'] = registration?.userLabel ? 'user_label'
      : registration?.labels?.['collaborationTaskName'] ? 'collaboration_task'
      : profile ? 'profile' : row?.description && row.description !== id ? 'task' : 'unreported';
    const isBranch = registration?.labels?.['branch'] === 'true' ? true : row?.is_branch;
    const branchSealed = registration?.labels?.['branch'] === 'true'
      ? registration.labels['branchSealed'] === 'true'
      : row?.branch_sealed;
    const outcomeAt = registration?.completedAt;
    const trackedStart = Date.parse(row?.started_at ?? '');
    const newerRun = Number.isFinite(trackedStart) && outcomeAt !== undefined && trackedStart > outcomeAt;
    const outcome = !newerRun ? terminalStatus(registration?.status) : undefined;
    const trackedOutcome = terminalStatus(row?.status);
    const activityOutcome = lastTurnOutcome(activity, Number.isFinite(trackedStart) ? trackedStart : undefined);
    const activityTerminalAt = activityOutcome === undefined ? undefined : activity?.lastTurn?.at;
    const terminalOutcome = outcome ?? trackedOutcome ?? activityOutcome ?? (branchSealed === true ? 'completed' : undefined);
    const current = activity?.lifecycle === 'ready';
    const phaseOpen = row?.subagent_phase === 'working' || row?.subagent_phase === 'queued' || row?.subagent_phase === 'suspended';
    const taskOpen = row?.status === 'running';
    const trackedActive = row?.live === true && row?.refreshing !== true && terminalOutcome === undefined && (phaseOpen || taskOpen);
    const loopOpen = activity?.turn !== undefined || (activity?.background.length ?? 0) > 0;
    const status = terminalOutcome ?? row?.status ?? 'running';
    const persistenceFailure = current ? activity.persistenceFailure : undefined;
    const activityStatus: SnapshotSubagent['activity_status'] = persistenceFailure !== undefined ? 'failed'
      : current && activity?.turn !== undefined
      ? activity.turn.pendingApprovals.length > 0 ? 'suspended' : 'running'
      : current && loopOpen ? 'running'
      : trackedActive ? row?.subagent_phase === 'suspended' ? 'suspended' : 'running'
      : current ? (branchSealed === true && (terminalOutcome === undefined || terminalOutcome === 'completed') ? 'completed' : terminalOutcome ?? 'idle')
      : terminalOutcome ?? (phaseOpen && row?.live === true ? row?.subagent_phase === 'suspended' ? 'suspended' : 'running' : isBranch === true ? 'idle' : 'unknown');
    const terminal = activityStatus === 'completed' || activityStatus === 'failed' || activityStatus === 'cancelled';
    return {
      ...row,
      id, agent_id: id, session_id: sessionId, kind: 'subagent',
      description: resolveSubagentDisplayName(label, profile, row?.description ?? id),
      label, profile, name_source: nameSource,
      status: persistenceFailure !== undefined ? 'failed' : activityStatus === 'running' || activityStatus === 'suspended' ? 'running' : status,
      activity_status: activityStatus,
      status_source: current && activity.turn !== undefined || outcome === undefined && (current || trackedActive) ? 'runtime' : 'metadata',
      live: current || trackedActive && outcome === undefined,
      created_at: registration?.createdAt === undefined ? undefined : new Date(registration.createdAt).toISOString(),
      started_at: current && activity.turn !== undefined && (row?.started_at === undefined || outcomeAt !== undefined && trackedStart <= outcomeAt)
        ? new Date(activity.turn.since).toISOString() : row?.started_at,
      completed_at: persistenceFailure !== undefined || activityStatus === 'running' || activityStatus === 'suspended' ? undefined
        : terminal && (outcomeAt !== undefined || activityTerminalAt !== undefined)
          ? new Date(outcomeAt ?? activityTerminalAt!).toISOString()
          : row?.completed_at,
      parent_agent_id: subagentParentAgentId(registration) ?? row?.parent_agent_id,
      is_branch: isBranch,
      branch_seed: (registration?.labels?.['branchSeed'] as SnapshotSubagent['branch_seed']) ?? row?.branch_seed,
      branch_initiator: (registration?.labels?.['branchInitiator'] as SnapshotSubagent['branch_initiator']) ?? row?.branch_initiator,
      tools_locked: registration?.labels?.['branch'] === 'true'
        ? registration.labels['toolsLocked'] === 'true'
        : row?.tools_locked,
      branch_sealed: branchSealed,
      model: (current ? activity.model : undefined) ?? registration?.model ?? row?.model,
      thinking_effort: registration?.thinkingEffort ?? row?.thinking_effort,
      thinking_effort_explicit: registration?.thinkingEffort !== undefined ? registration.thinkingEffortExplicit : row?.thinking_effort_explicit,
      executor_id: registration?.executor ?? row?.executor_id,
      executor_protocol: registration?.executor !== undefined ? registration.executorProtocol : row?.executor_protocol,
      output_preview: row?.output_preview ?? registration?.resultSummary?.slice(0, 2048),
      stop_reason: persistenceFailure?.message ?? row?.stop_reason ?? registration?.error?.slice(0, 2048),
      tool_call_count: row?.tool_call_count ?? registration?.toolCallCount,
    };
  });
}
