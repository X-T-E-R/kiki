import * as posixPath from 'node:path/posix';
import * as win32Path from 'node:path/win32';

import type { IGitService } from '#/app/git/git';
import { inspectAgentWorkspaceRoots, type IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { ToolFileAccess } from '#/tool/toolContract';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import {
  isWithinDirectory,
  realPathOrMissingChild,
  type PathClass,
} from '#/tool/path-access';

export function fileAccesses(context: ResolvedToolExecutionHookContext): ToolFileAccess[] {
  return (
    context.execution.accesses?.filter((access): access is ToolFileAccess => access.kind === 'file') ??
    []
  );
}

export function writeFileAccesses(context: ResolvedToolExecutionHookContext): ToolFileAccess[] {
  return fileAccesses(context).filter(
    (access) => access.operation === 'write' || access.operation === 'readwrite',
  );
}

const gitControlAccessesByCall = new WeakMap<ResolvedToolExecutionHookContext, Promise<readonly ToolFileAccess[]>>();

export function gitControlFileAccesses(
  context: ResolvedToolExecutionHookContext,
  runtime: IAgentRuntimeService,
  workspace: ISessionWorkspaceContext,
  git: IGitService,
): Promise<readonly ToolFileAccess[]> {
  let targets = gitControlAccessesByCall.get(context);
  if (targets === undefined) {
    targets = resolveGitControlFileAccesses(context, runtime, workspace, git);
    gitControlAccessesByCall.set(context, targets);
  }
  return targets;
}

async function resolveGitControlFileAccesses(
  context: ResolvedToolExecutionHookContext,
  runtime: IAgentRuntimeService,
  workspace: ISessionWorkspaceContext,
  git: IGitService,
): Promise<readonly ToolFileAccess[]> {
  const accesses = fileAccesses(context);
  if (accesses.length === 0) return [];
  const cwd = inspectAgentWorkspaceRoots(runtime, workspace).workDir;
  if (cwd.length === 0) return [];
  const { environment: { pathClass } } = runtime.inspect();
  const path = pathMod(pathClass);
  let controlRoots: readonly string[] | undefined;
  const targets: ToolFileAccess[] = [];
  for (const access of accesses) {
    const target = path.resolve(cwd, access.path);
    const parts = target.toLowerCase().split(path.sep);
    let protectedTarget = parts.some((part, index) => part === '.git' && needsGitApproval(access, parts.slice(index + 1)));
    if (!protectedTarget) {
      if (controlRoots === undefined) {
        const marker = await git.findWorkTree(cwd);
        controlRoots = [];
        if (marker !== null) {
          const lease = runtime.acquire(['fs']);
          try {
            controlRoots = await Promise.all([marker.dotGitPath, marker.controlDirPath].map((root) => realPathOrMissingChild(lease.runtime.fs!, root)));
          } finally { lease.dispose(); }
        }
      }
      protectedTarget = controlRoots.some((root) =>
        isWithinDirectory(target, root, pathClass) && needsGitApproval(access, path.relative(root, target).toLowerCase().split(path.sep).filter(Boolean)));
    }
    if (protectedTarget) {
      targets.push({ ...access, path: pathClass === 'win32' ? target.replaceAll('\\', '/').toLowerCase() : target });
    }
  }
  return targets;
}

function needsGitApproval(access: ToolFileAccess, parts: readonly string[]): boolean {
  return access.operation === 'write' || access.operation === 'readwrite' ||
    access.operation === 'search' || access.recursive === true ||
    parts.some((part) => part === 'config' || part === 'config.worktree' || part === 'credentials' || part === 'hooks');
}

export function defaultPathClass(): PathClass {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

function pathMod(pathClass: PathClass): typeof posixPath {
  return pathClass === 'win32' ? win32Path : posixPath;
}
