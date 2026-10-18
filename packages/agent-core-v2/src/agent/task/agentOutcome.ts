import { event2FromRecord } from '#/app/event/event2';
import { SubagentCompleted, SubagentFailed } from '#/session/subagent/mirrorAgentRun';
import type { WireRecord } from '#/wire/record';
import type { IWireService } from '#/wire/wire';

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
  wire: Pick<IWireService, 'readJournal'>,
): Promise<AgentRunOutcomeRead> {
  const outcomes = new Map<string, CommittedAgentRunOutcome>();
  try {
    for await (const record of wire.readJournal()) {
      const outcome = outcomeFromRecord(record);
      if (outcome !== undefined) outcomes.set(outcome.taskId, outcome);
    }
    return { ok: true, outcomes };
  } catch (error) {
    return { ok: false, error };
  }
}

function outcomeFromRecord(record: WireRecord): CommittedAgentRunOutcome | undefined {
  if (record.type === SubagentCompleted.type) {
    const event = event2FromRecord(SubagentCompleted, record);
    if (!(event instanceof SubagentCompleted) || event.taskId === undefined) return undefined;
    const endedAt = finiteTime(record.time);
    if (event.resultSummary.trim().length > 0) {
      return {
        taskId: event.taskId,
        subagentId: event.subagentId,
        status: 'completed',
        finalOutput: event.resultSummary,
        endedAt,
      };
    }
    return {
      taskId: event.taskId,
      subagentId: event.subagentId,
      status: 'failed',
      stopReason: EMPTY_AGENT_RECEIPT_REASON,
      endedAt,
    };
  }
  if (record.type === SubagentFailed.type) {
    const event = event2FromRecord(SubagentFailed, record);
    if (!(event instanceof SubagentFailed) || event.taskId === undefined) return undefined;
    const endedAt = finiteTime(record.time);
    if (event.error === 'terminated') {
      return {
        taskId: event.taskId,
        subagentId: event.subagentId,
        status: 'killed',
        endedAt,
      };
    }
    return {
      taskId: event.taskId,
      subagentId: event.subagentId,
      status: 'failed',
      stopReason: event.error,
      endedAt,
    };
  }
  return undefined;
}

function finiteTime(time: number | undefined): number | undefined {
  return typeof time === 'number' && Number.isFinite(time) ? time : undefined;
}
