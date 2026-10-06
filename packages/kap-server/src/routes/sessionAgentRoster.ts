import type { AgentActivityState, SessionMeta } from '@kiki/agent-core-v2';
import type { SnapshotSubagent } from '@kiki/protocol';
import { resolveSubagentDisplayName, subagentParentAgentId, subagentUserLabel } from '@kiki/transcript-live';

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
  runtime: ReadonlyMap<string, AgentActivityState> = new Map(),
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
    const outcomeAt = registration?.completedAt;
    const trackedStart = Date.parse(row?.started_at ?? row?.created_at ?? '');
    const newerRun = Number.isFinite(trackedStart) && outcomeAt !== undefined && trackedStart > outcomeAt;
    const outcome = registration?.status !== undefined && !newerRun ? registration.status : undefined;
    const trackedOutcome = row?.status === 'completed' || row?.status === 'failed' || row?.status === 'cancelled' ? row.status : undefined;
    const activityOutcome = lastTurnOutcome(activity, Number.isFinite(trackedStart) ? trackedStart : undefined);
    const activityTerminalAt = activityOutcome === undefined ? undefined : activity?.lastTurn?.at;
    const terminalOutcome = outcome ?? trackedOutcome ?? activityOutcome;
    const current = activity?.lifecycle === 'ready';
    const trackedActive = row?.live !== false && row?.refreshing !== true &&
      (row?.subagent_phase === 'working' || row?.subagent_phase === 'queued' || row?.subagent_phase === 'suspended');
    const status = terminalOutcome ?? row?.status ?? 'running';
    const activityStatus: SnapshotSubagent['activity_status'] = current
      ? activity.turn === undefined
        ? trackedActive || activity.background.length > 0 ? 'running' : terminalOutcome ?? 'idle'
        : activity.turn.pendingApprovals.length > 0 ? 'suspended' : 'running'
      : terminalOutcome ?? (trackedActive ? row?.subagent_phase === 'suspended' ? 'suspended' : 'running' : 'unknown');
    const terminal = activityStatus === 'completed' || activityStatus === 'failed' || activityStatus === 'cancelled';
    return {
      ...row,
      id, agent_id: id, session_id: sessionId, kind: 'subagent',
      description: resolveSubagentDisplayName(label, profile, row?.description ?? id),
      label, profile, name_source: nameSource,
      status: activityStatus === 'running' || activityStatus === 'suspended' ? 'running' : status,
      activity_status: activityStatus,
      status_source: current && activity.turn !== undefined || outcome === undefined && (current || trackedActive) ? 'runtime' : 'metadata',
      live: current || trackedActive && outcome === undefined,
      created_at: row?.created_at ?? new Date(meta.createdAt).toISOString(),
      started_at: current && activity.turn !== undefined && (row?.started_at === undefined || outcomeAt !== undefined && trackedStart <= outcomeAt)
        ? new Date(activity.turn.since).toISOString() : row?.started_at,
      completed_at: activityStatus === 'running' || activityStatus === 'suspended' ? undefined
        : terminal && (outcomeAt !== undefined || activityTerminalAt !== undefined)
          ? new Date(outcomeAt ?? activityTerminalAt!).toISOString()
          : row?.completed_at,
      parent_agent_id: subagentParentAgentId(registration) ?? row?.parent_agent_id,
      model: row?.model ?? registration?.model, thinking_effort: row?.thinking_effort ?? registration?.thinkingEffort,
      output_preview: row?.output_preview ?? registration?.resultSummary?.slice(0, 2048),
      stop_reason: row?.stop_reason ?? registration?.error?.slice(0, 2048),
      tool_call_count: row?.tool_call_count ?? registration?.toolCallCount,
    };
  });
}
