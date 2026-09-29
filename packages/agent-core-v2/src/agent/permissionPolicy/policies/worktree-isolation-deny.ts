import { resolve } from 'node:path';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type { PermissionPolicy, PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import { IWorktreeService } from '#/app/git/worktreeModel';
import { insidePath } from '#/persistence/backends/node-fs/worktreeFiles';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { writeFileAccesses } from './path-utils';

function commandPaths(command: string): string[] {
  const paths: string[] = [];
  const token = '(?:"([^"]+)"|\'([^\']+)\'|([^\\s;&|]+))';
  for (const pattern of [
    new RegExp(`(?:^|\\s)git\\s+-C\\s+${token}`, 'gi'),
    new RegExp(`(?:--git-dir|--work-tree|GIT_DIR|GIT_WORK_TREE)(?:=|\\s+)${token}`, 'gi'),
    new RegExp(`^\\s*cd\\s+${token}\\s*&&`, 'gi'),
  ]) {
    for (const match of command.matchAll(pattern)) paths.push(match[1] ?? match[2] ?? match[3]!);
  }
  return paths;
}

export class WorktreeIsolationDenyPermissionPolicyService implements PermissionPolicy {
  readonly name = 'worktree-isolation-deny';

  constructor(
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IWorktreeService private readonly worktrees: IWorktreeService,
  ) {}

  async evaluate(context: ResolvedToolExecutionHookContext): Promise<PermissionPolicyResult | undefined> {
    const bound = (await this.metadata.read()).worktree;
    if (bound === undefined) return undefined;
    const other = (await this.worktrees.list()).filter((item) => item.state !== 'removed' && item.id !== bound.worktreeId).map((item) => item.path);
    const protectedPaths = [bound.sourceRoot, ...other];
    const target = writeFileAccesses(context).find((access) => protectedPaths.some((root) => insidePath(access.path, root)));
    if (target !== undefined) return { kind: 'deny', message: 'This is an isolated worktree session; the source checkout and other Kiki worktrees are read-only here.' };
    if (context.toolCall.name !== 'Bash' || context.args === null || typeof context.args !== 'object') return undefined;
    const args = context.args as { readonly command?: unknown; readonly cwd?: unknown };
    const bashCwd = args.cwd;
    if (typeof bashCwd === 'string' && protectedPaths.some((root) => insidePath(resolve(this.workspace.workDir, bashCwd), root))) {
      return { kind: 'deny', message: 'Bash cannot run in the source checkout or another Kiki worktree from this session.' };
    }
    if (typeof args.command === 'string' && commandPaths(args.command).some((path) =>
      protectedPaths.some((root) => insidePath(resolve(this.workspace.workDir, path), root)))) {
      return { kind: 'deny', message: 'Git and shell redirection into the source checkout or another Kiki worktree is denied.' };
    }
    return undefined;
  }
}
