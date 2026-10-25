import type { AgentMeta } from '@kiki/agent-core-v2';
import type { SessionAgentCounts, SnapshotSubagent } from '@kiki/protocol';

export function sessionAgentCounts(
  agents: Readonly<Record<string, AgentMeta>> | undefined,
  roster: readonly SnapshotSubagent[],
): SessionAgentCounts {
  const statuses = new Map<string, AgentMeta['status'] | 'active' | 'idle'>();
  for (const [id, meta] of Object.entries(agents ?? {})) {
    if (id !== 'main') statuses.set(id, meta.status);
  }
  for (const row of roster) {
    const id = row.agent_id ?? row.id;
    if (id === 'main') continue;
    const status = row.activity_status ?? row.status;
    if (status === 'completed' || status === 'failed' || status === 'cancelled') statuses.set(id, status);
    else if (status === 'lost') statuses.set(id, 'failed');
    else if (status === 'idle') statuses.set(id, 'idle');
    else statuses.set(id, status !== 'unknown' && row.live !== false && row.refreshing !== true ? 'active' : undefined);
  }
  const counts: SessionAgentCounts = {
    total: statuses.size + 1, subagents: statuses.size,
    completed: 0, failed: 0, cancelled: 0, active: 0, idle: 0, unknown: 0,
  };
  for (const status of statuses.values()) {
    if (status === 'idle') counts.idle = (counts.idle ?? 0) + 1;
    else counts[status ?? 'unknown'] += 1;
  }
  return counts;
}
