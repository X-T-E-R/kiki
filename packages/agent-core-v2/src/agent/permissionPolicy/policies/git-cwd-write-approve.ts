import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { isWithinWorkspace } from '#/tool/path-access';
import { IGitService } from '#/app/git/git';
import type { IGitService as GitService } from '#/app/git/git';
import { IAgentRuntimeService, inspectAgentWorkspaceRoots } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ISessionWorkspaceContext as WorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { writeFileAccesses } from './path-utils';

export class GitCwdWriteApprovePermissionPolicyService implements PermissionPolicy {
  readonly name = 'git-cwd-write-approve';

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspace: WorkspaceContext,
    @IGitService private readonly git: GitService,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    const toolName = context.toolCall.name;
    if (toolName !== 'Write' && toolName !== 'Edit') return undefined;
    const lease = this.runtime.acquire();
    const pathClass = lease.runtime.environment.pathClass;
    lease.dispose();

    const roots = inspectAgentWorkspaceRoots(this.runtime, this.workspace);
    const cwd = roots.workDir;
    if (cwd.length === 0) return undefined;

    const writeAccesses = writeFileAccesses(context);
    if (writeAccesses.length === 0) return undefined;
    if (
      !writeAccesses.every((access) =>
        isWithinWorkspace(
          access.path,
          { workspaceDir: cwd, additionalDirs: roots.additionalDirs ?? [] },
          pathClass,
        ),
      )
    ) {
      return undefined;
    }

    return (await this.git.findWorkTree(cwd)) === null
      ? undefined
      : { kind: 'approve' };
  }
}
