import type { AgentActivityState } from '@kiki/agent-core-v2';
import type { AgentPhase } from '@kiki/protocol';

/**
 * Map the native v2 `AgentActivityState` to the legacy v1 `AgentPhase`
 * (`agent.status.updated` payload). Pure function — kept at the transcript live
 * edge so the core engine stays free of v1 wire-compatibility concerns.
 *
 * Returns `undefined` for `disposing` / `disposed`, which have no v1
 * concept (emitting `idle` would mislead the UI).
 *
 * Three deliberate v1 divergences from the naive mapping (see status-refactor
 * plan 04 §3): a parallel approval resolve keeps `awaiting_approval` while any
 * approval is still pending (no premature `running`); `interrupted` carries the
 * `endingReason`; `disposing`/`disposed` emit nothing.
 */
export function toLegacyPhase(state: AgentActivityState): AgentPhase | undefined {
  const { lifecycle, turn, lastTurn } = state;

  if (turn === undefined && lifecycle === 'ready') {
    if (lastTurn !== undefined && lifecycle === 'ready') {
      return {
        kind: 'ended',
        turnId: lastTurn.turnId,
        reason: lastTurn.reason,
        durationMs: lastTurn.durationMs,
        at: lastTurn.at,
      };
    }
    return { kind: 'idle' };
  }

  if (lifecycle === 'ready' && turn !== undefined) {
    if (turn.pendingApprovals.length > 0) {
      const latest = turn.pendingApprovals[turn.pendingApprovals.length - 1]!;
      return {
        kind: 'awaiting_approval',
        turnId: turn.turnId,
        step: turn.step || undefined,
        approval: { approvalId: latest.approvalId, toolCallId: latest.toolCallId },
        since: latest.since,
      };
    }
    if (turn.ending && turn.endingReason !== undefined) {
      return {
        kind: 'interrupted',
        turnId: turn.turnId,
        step: turn.step,
        reason: turn.endingReason,
        at: turn.since,
      };
    }
    switch (turn.phase) {
      case 'running':
        return {
          kind: 'running',
          turnId: turn.turnId,
          step: turn.step,
          stepId: '',
          since: turn.since,
        };
      case 'streaming':
        return {
          kind: 'streaming',
          turnId: turn.turnId,
          step: turn.step,
          stepId: '',
          stream: turn.stream ?? 'assistant',
          since: turn.since,
        };
      case 'retrying':
        return {
          kind: 'retrying',
          turnId: turn.turnId,
          step: turn.step,
          stepId: '',
          failedAttempt: turn.retry?.failedAttempt ?? 0,
          nextAttempt: turn.retry?.nextAttempt ?? 0,
          maxAttempts: turn.retry?.maxAttempts ?? 0,
          delayMs: turn.retry?.delayMs ?? 0,
          errorName: turn.retry?.errorName,
          statusCode: turn.retry?.statusCode,
          since: turn.since,
        };
      case 'tool_call': {
        const latest = turn.activeToolCalls[turn.activeToolCalls.length - 1];
        return {
          kind: 'tool_call',
          turnId: turn.turnId,
          step: turn.step,
          toolCallId: latest?.toolCallId ?? '',
          name: latest?.name ?? '',
          since: latest?.since ?? turn.since,
        };
      }
    }
  }

  return undefined;
}

export type { AgentPhase } from '@kiki/protocol';
