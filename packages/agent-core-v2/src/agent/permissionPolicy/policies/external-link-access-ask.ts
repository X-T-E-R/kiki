import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionPolicy, PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import { fileAccesses } from './path-utils';

export class ExternalLinkAccessAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'external-link-access-ask';

  constructor(@IAgentPermissionModeService private readonly mode: IAgentPermissionModeService) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    const access = fileAccesses(context).find((item) => item.implicitExternal === true);
    if (access === undefined || this.mode.mode === 'yolo') return undefined;
    return { kind: 'ask' };
  }
}
