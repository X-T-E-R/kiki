import type { AgentMeta, ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { EMPTY_AGENT_RECEIPT_REASON } from '#/agent/tools/agent/subagent-task';

export interface CommittedAgentRunOutcome {
  readonly taskId: string;
  readonly subagentId: string;
  readonly status: 'completed' | 'failed' | 'killed';
  readonly stopReason?: string;
  readonly finalOutput?: string;
  readonly endedAt?: number;
}

export type AgentRunOutcomeRead =
  | { readonly ok: true; readonly outcomes: ReadonlyMap<string, CommittedAgentRunOutcome> }
  | { readonly ok: false; readonly error: unknown };

export async function readCommittedAgentRunOutcomes(
  metadata: Pick<ISessionMetadata, 'read'> | undefined,
): Promise<AgentRunOutcomeRead> {
  if (metadata === undefined) return { ok: true, outcomes: new Map() };
  try {
    const data = await metadata.read();
    return { ok: true, outcomes: outcomesFromAgentRegistry(data.agents) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function outcomesFromAgentRegistry(
  agents: Readonly<Record<string, AgentMeta>> | undefined,
): ReadonlyMap<string, CommittedAgentRunOutcome> {
  const outcomes = new Map<string, CommittedAgentRunOutcome>();
  if (agents === undefined) return outcomes;
  for (const [agentId, meta] of Object.entries(agents)) {
    const outcome = outcomeFromAgent(agentId, meta);
    if (outcome !== undefined) outcomes.set(outcome.taskId, outcome);
  }
  return outcomes;
}

function outcomeFromAgent(agentId: string, meta: AgentMeta): CommittedAgentRunOutcome | undefined {
  if (typeof meta.taskId !== 'string' || meta.taskId.length === 0) return undefined;
  const endedAt = finiteTime(meta.completedAt);
  if (meta.status === 'completed') {
    const summary = meta.resultSummary ?? '';
    if (summary.trim().length > 0) {
      return {
        taskId: meta.taskId,
        subagentId: agentId,
        status: 'completed',
        finalOutput: summary,
        endedAt,
      };
    }
    return {
      taskId: meta.taskId,
      subagentId: agentId,
      status: 'failed',
      stopReason: EMPTY_AGENT_RECEIPT_REASON,
      endedAt,
    };
  }
  if (meta.status === 'cancelled' || (meta.status === 'failed' && meta.error === 'terminated')) {
    return {
      taskId: meta.taskId,
      subagentId: agentId,
      status: 'killed',
      endedAt,
    };
  }
  if (meta.status === 'failed') {
    return {
      taskId: meta.taskId,
      subagentId: agentId,
      status: 'failed',
      stopReason: meta.error,
      endedAt,
    };
  }
  return undefined;
}

function finiteTime(time: number | undefined): number | undefined {
  return typeof time === 'number' && Number.isFinite(time) ? time : undefined;
}
