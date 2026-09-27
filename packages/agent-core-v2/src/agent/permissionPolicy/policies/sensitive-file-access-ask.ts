import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { isSensitiveFile } from '#/tool/path-access';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { fileAccesses } from './path-utils';

export class SensitiveFileAccessAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'sensitive-file-access-ask';

  constructor(@IAgentPermissionModeService private readonly mode: IAgentPermissionModeService) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    const access = fileAccesses(context).find((fileAccess) => isSensitiveFile(fileAccess.path));
    if (access === undefined) return undefined;
    if (this.mode.mode === 'yolo') return { kind: 'approve' };
    return { kind: 'ask' };
  }
}
