import { createDecorator } from '#/_base/di/instantiation';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type { ToolFileAccess } from '#/tool/toolContract';

import { IAgentPlanService } from './plan';

export interface IPlanFileWriteApprovePolicy extends PermissionPolicy {
  readonly _serviceBrand: undefined;
}

export const IPlanFileWriteApprovePolicy =
  createDecorator<IPlanFileWriteApprovePolicy>('planFileWriteApprovePolicy');

export class PlanFileWriteApprovePolicy implements IPlanFileWriteApprovePolicy {
  declare readonly _serviceBrand: undefined;
  readonly name = 'plan-file-write-approve';

  constructor(@IAgentPlanService private readonly plan: IAgentPlanService) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    if (context.toolCall.name !== 'Write' && context.toolCall.name !== 'Edit') {
      return undefined;
    }
    const plan = await this.plan.status();
    if (plan === null || !writesOnlyPlanFile(context, plan.path)) return undefined;
    return { kind: 'approve' };
  }
}

export function writesOnlyPlanFile(
  context: ResolvedToolExecutionHookContext,
  planFilePath: string,
): boolean {
  const writeAccesses = (context.execution.accesses ?? []).filter(
    (access): access is ToolFileAccess =>
      access.kind === 'file' &&
      (access.operation === 'write' || access.operation === 'readwrite'),
  );
  if (writeAccesses.length === 0) return false;
  return writeAccesses.every((access) => access.path === planFilePath);
}
