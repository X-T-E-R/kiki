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
    if (this.mode.mode === 'auto') {
      const requested = (context.args as { path?: unknown }).path;
      const rawPath = typeof requested === 'string' ? requested : access.path;
      return {
        kind: 'deny',
        message: `[external_target_approval] Path "${rawPath}" resolves to external target "${access.path}". Switch to manual mode to approve access to the target, or address the actual target directly instead of following the link.`,
      };
    }
    return { kind: 'ask' };
  }
}
