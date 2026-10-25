import { posix, win32 } from 'node:path';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IGitService } from '#/app/git/git';
import type { IGitService as GitService } from '#/app/git/git';
import { IAgentRuntimeService, inspectAgentWorkspaceRoots } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ISessionWorkspaceContext as WorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { PermissionPolicy, PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import type { ToolFileAccess } from '#/tool/toolContract';
import { fileAccesses, hasGitPathComponent, isGitControlPath } from './path-utils';

function needsApproval(access: ToolFileAccess, relative: string): boolean {
  if (access.operation === 'write' || access.operation === 'readwrite') return true;
  const parts = relative.toLowerCase().split(/[\\/]+/).filter(Boolean);
  return parts.some((part) => part === 'config' || part === 'config.worktree' || part === 'credentials' || part === 'hooks') ||
    (parts.length === 0 && (access.recursive === true || access.operation === 'search'));
}

export class GitControlPathAccessAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'git-control-path-access-ask';

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspace: WorkspaceContext,
    @IGitService private readonly git: GitService,
  ) {}

  async evaluate(context: ResolvedToolExecutionHookContext): Promise<PermissionPolicyResult | undefined> {
    const cwd = inspectAgentWorkspaceRoots(this.runtime, this.workspace).workDir;
    if (cwd.length === 0) return undefined;
    const lease = this.runtime.acquire();
    const pathClass = lease.runtime.environment.pathClass;
    lease.dispose();
    const accesses = fileAccesses(context);
    if (accesses.length === 0) return undefined;
    const path = pathClass === 'win32' ? win32 : posix;
    const direct = accesses.find((access) => {
      if (!hasGitPathComponent(access.path, cwd, pathClass)) return false;
      const parts = path.relative(cwd, access.path).split(/[\\/]+/);
      return needsApproval(access, parts.slice(parts.findIndex((part) => part.toLowerCase() === '.git') + 1).join('/'));
    });
    if (direct !== undefined) return { kind: 'ask' };
    const marker = await this.git.findWorkTree(cwd);
    if (marker === null) return undefined;
    const access = accesses.find((access) => isGitControlPath(access.path, marker, pathClass) &&
      [marker.dotGitPath, marker.controlDirPath].some((root) => needsApproval(access, path.relative(root, access.path))));
    return access === undefined ? undefined : { kind: 'ask' };
  }
}
