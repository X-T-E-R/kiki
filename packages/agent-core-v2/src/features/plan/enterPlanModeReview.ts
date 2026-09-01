import { randomUUID } from 'node:crypto';

import { createDeadlineAbortSignal } from '#/_base/utils/abort';
import type {
  ApprovalResponse,
  PermissionPolicyResolution,
} from '#/agent/permissionPolicy/types';
import type { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import type { ISessionApprovalService } from '#/session/approval/approval';

export interface PlanEnterApprovalMetadata {
  readonly planEnterApproved: true;
}

export class EnterPlanModeReview {
  constructor(
    private readonly toolApproval: IAgentToolApprovalService,
    private readonly approval: ISessionApprovalService,
    private readonly timeoutMs: number,
  ) {}

  async requestApproval(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    if (context.execution.display?.kind !== 'plan_enter') return undefined;
    const approvalId = `approval_${randomUUID()}`;
    const deadline = createDeadlineAbortSignal(context.signal, this.timeoutMs);
    try {
      return await this.toolApproval.requestToolApproval(
        { ...context, signal: deadline.signal },
        {
          kind: 'ask',
          resolveApproval: (result) => this.approvalResult(result),
          resolveError: () =>
            deadline.timedOut()
              ? {
                  kind: 'result',
                  result: {
                    isError: true,
                    output: `Plan mode was not entered because approval timed out after ${this.timeoutMs} ms.`,
                  },
                }
              : undefined,
        },
        'enter-plan-mode-review-ask',
        approvalId,
      );
    } finally {
      if (deadline.signal.aborted) {
        this.approval.decide(approvalId, { decision: 'cancelled' });
      }
      deadline.clear();
    }
  }

  private approvalResult(result: ApprovalResponse): PermissionPolicyResolution | undefined {
    if (result.decision === 'approved') {
      return {
        kind: 'approve',
        executionMetadata: { planEnterApproved: true } satisfies PlanEnterApprovalMetadata,
      };
    }
    const feedback =
      result.feedback !== undefined && result.feedback.length > 0
        ? ` Reason: ${result.feedback}`
        : '';
    return {
      kind: 'result',
      result: {
        isError: true,
        output:
          result.decision === 'cancelled'
            ? `Plan mode was not entered because the approval request was cancelled.${feedback}`
            : `Plan mode was not entered because the user rejected the approval request.${feedback}`,
      },
    };
  }
}

export function isPlanEnterApprovalMetadata(value: unknown): value is PlanEnterApprovalMetadata {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as Partial<PlanEnterApprovalMetadata>).planEnterApproved === true
  );
}
