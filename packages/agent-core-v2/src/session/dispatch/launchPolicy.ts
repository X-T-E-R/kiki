import type { AgentCapabilityReasonCode } from '@kiki/protocol';

import type { ExecutionRestriction } from '#/agent/profile/executionRestriction';

export interface DispatchLaunchPolicy {
  readonly planActive: boolean;
  readonly callerRestriction?: ExecutionRestriction;
}

export interface DispatchAdmission {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly reasonCode?: AgentCapabilityReasonCode;
  readonly executionRestriction?: ExecutionRestriction;
}

export function tightenDispatchLaunchPolicy(
  current: DispatchLaunchPolicy,
  captured?: DispatchLaunchPolicy,
): DispatchLaunchPolicy {
  return Object.freeze({
    planActive: current.planActive || captured?.planActive === true,
    callerRestriction: current.callerRestriction ?? captured?.callerRestriction,
  });
}

export function evaluateDispatchAdmission(
  policy: DispatchLaunchPolicy,
  operation: 'spawn' | 'resume',
  executorId = 'native',
): DispatchAdmission {
  const executionRestriction = policy.planActive ? 'research-readonly' : undefined;
  const reason = policy.callerRestriction === 'research-readonly'
    ? 'Research-readonly agents cannot dispatch subagents.'
    : policy.planActive && operation === 'resume'
      ? 'AgentRun cannot resume existing children in plan mode. Call ExitPlanMode first.'
      : policy.planActive && executorId !== 'native'
        ? 'Research-readonly dispatch requires the native executor.'
        : undefined;
  const reasonCode = policy.callerRestriction === 'research-readonly'
    ? 'research_readonly_dispatch_forbidden'
    : policy.planActive && operation === 'resume'
      ? 'plan_resume_forbidden'
      : policy.planActive && executorId !== 'native'
        ? 'native_executor_required'
        : undefined;
  return { allowed: reason === undefined, reason, reasonCode, executionRestriction };
}
