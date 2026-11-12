import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IGitService } from '#/app/git/git';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { PermissionPolicy, PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import { gitControlFileAccesses } from './path-utils';

export class GitControlPathAccessAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'git-control-path-access-ask';

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IGitService private readonly git: IGitService,
  ) {}

  async evaluate(context: ResolvedToolExecutionHookContext): Promise<PermissionPolicyResult | undefined> {
    const targets = await gitControlFileAccesses(context, this.runtime, this.workspace, this.git);
    return targets.length === 0 ? undefined : { kind: 'ask' };
  }
}
