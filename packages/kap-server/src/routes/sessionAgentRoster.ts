import type { AgentActivityState, SessionMeta } from '@kiki/agent-core-v2';
import type { SnapshotSubagent } from '@kiki/protocol';
import { resolveSubagentDisplayName, subagentParentAgentId, subagentUserLabel } from '@kiki/transcript-live';
import { detachSlicedString } from '../lib/detachString';

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
    case 'failed':
    case 'blocked': return 'failed';
    default: return undefined;
  }
}

export function sessionAgentRoster(
  sessionId: string,
  meta: SessionMeta,
  tracked: readonly SnapshotSubagent[] = [],
  runtime: ReadonlyMap<string, AgentActivityState & { readonly model?: string }> = new Map(),
): SnapshotSubagent[] {
  const agents = meta.agents;
  const rows = tracked.length === 0 ? undefined : new Map(tracked.map((row) => [row.agent_id ?? row.id, row]));
  const hasRuntime = runtime.size > 0;
  let candidateIds: Iterable<string>;
  if (rows === undefined && !hasRuntime) {
    candidateIds = agents === undefined ? [] : Object.keys(agents);
  } else {
    const ids = new Set<string>();
    if (agents !== undefined) {
      for (const id of Object.keys(agents)) ids.add(id);
    }
    if (rows !== undefined) {
      for (const id of rows.keys()) ids.add(id);
    }
    if (hasRuntime) {
      for (const id of runtime.keys()) ids.add(id);
    }
    candidateIds = ids;
  }
  const result: SnapshotSubagent[] = [];
  for (const id of candidateIds) {
    if (id === 'main' || id === undefined) continue;
    const registration = agents?.[id];
    const row = rows?.get(id);
    if (row !== undefined) {
      const registrationOutcome = registration?.status !== undefined && registration.completedAt !== undefined;
      const staleTracked = row.live === false && row.status === 'running' && row.subagent_phase === undefined &&
        row.started_at === undefined && row.completed_at === undefined && !registrationOutcome;
      if (staleTracked) continue;
    }
    const activity = hasRuntime ? runtime.get(id) : undefined;
    const label = subagentUserLabel(registration) ?? row?.label;
    const profile = registration?.displayName ?? row?.profile;
    const labels = registration?.labels;
    const nameSource: SnapshotSubagent['name_source'] = registration?.userLabel ? 'user_label'
      : labels?.['collaborationTaskName'] ? 'collaboration_task'
      : profile ? 'profile' : row?.description && row.description !== id ? 'task' : 'unreported';
    const isBranchLabel = labels?.['branch'] === 'true';
    const isBranch = isBranchLabel ? true : row?.is_branch;
    const branchSealed = isBranchLabel
      ? labels['branchSealed'] === 'true'
      : row?.branch_sealed;
    const outcomeAt = registration?.completedAt;
    const trackedStart = row?.started_at !== undefined ? Date.parse(row.started_at) : Number.NaN;
    const hasTrackedStart = Number.isFinite(trackedStart);
    const newerRun = hasTrackedStart && outcomeAt !== undefined && trackedStart > outcomeAt;
    const outcome = !newerRun ? terminalStatus(registration?.status) : undefined;
    const trackedOutcome = row === undefined ? undefined : terminalStatus(row.status);
    const activityOutcome = activity === undefined ? undefined : lastTurnOutcome(activity, hasTrackedStart ? trackedStart : undefined);
    const activityTerminalAt = activityOutcome === undefined ? undefined : activity?.lastTurn?.at;
    const terminalOutcome = outcome ?? trackedOutcome ?? activityOutcome ?? (branchSealed === true ? 'completed' : undefined);
    const current = activity?.lifecycle === 'ready';
    const phaseOpen = row !== undefined && (row.subagent_phase === 'working' || row.subagent_phase === 'queued' || row.subagent_phase === 'suspended');
    const taskOpen = row?.status === 'running';
    const trackedActive = row !== undefined && row.live === true && row.refreshing !== true && terminalOutcome === undefined && (phaseOpen || taskOpen);
    const loopOpen = activity !== undefined && (activity.turn !== undefined || activity.background.length > 0);
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
    const branchBaseTurnIdRaw = labels?.['branchBaseTurnId'];
    const branchBaseMessageIdRaw = labels?.['branchBaseMessageId'];
    const projected: SnapshotSubagent = {
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
      branch_seed: (labels?.['branchSeed'] as SnapshotSubagent['branch_seed']) ?? row?.branch_seed,
      branch_initiator: (labels?.['branchInitiator'] as SnapshotSubagent['branch_initiator']) ?? row?.branch_initiator,
      tools_locked: isBranchLabel
        ? labels['toolsLocked'] === 'true'
        : row?.tools_locked,
      branch_sealed: branchSealed,
      branch_base_turn_id:
        branchBaseTurnIdRaw !== undefined && /^\d+$/.test(branchBaseTurnIdRaw)
          ? Number(branchBaseTurnIdRaw)
          : row?.branch_base_turn_id,
      branch_base_message_id:
        branchBaseMessageIdRaw !== undefined && branchBaseMessageIdRaw.length > 0
          ? branchBaseMessageIdRaw
          : row?.branch_base_message_id,
      model: (current ? activity.model : undefined) ?? registration?.model ?? row?.model,
      thinking_effort: registration?.thinkingEffort ?? row?.thinking_effort,
      thinking_effort_explicit: registration?.thinkingEffort !== undefined ? registration.thinkingEffortExplicit : row?.thinking_effort_explicit,
      executor_id: registration?.executor ?? row?.executor_id,
      executor_protocol: registration?.executor !== undefined ? registration.executorProtocol : row?.executor_protocol,
      output_preview: row?.output_preview ?? (registration?.resultSummary !== undefined ? detachSlicedString(registration.resultSummary.slice(0, 2048)) : undefined),
      stop_reason: persistenceFailure?.message ?? row?.stop_reason ?? (registration?.error !== undefined ? detachSlicedString(registration.error.slice(0, 2048)) : undefined),
      tool_call_count: row?.tool_call_count ?? registration?.toolCallCount,
    };
    result.push(projected);
  }
  return result;
}
