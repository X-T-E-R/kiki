import { posix, win32 } from 'node:path';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type { PermissionPolicy, PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import { IWorktreeService } from '#/app/git/worktreeModel';
import { IBashParserService, type BashSyntaxNode } from '#/app/bashParser/bashParser';
import { IAgentRuntimeService, inspectAgentWorkspaceRoots } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { runtimeShellPathBridge } from '#/runtime/runtimeWorkspaceView';
import { isWithinDirectory, realPathOrMissingChild } from '#/tool/path-access';
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

function literal(node: BashSyntaxNode): string | undefined {
  if (/[$`*?[\]~]/.test(node.text)) return undefined;
  if (node.type === 'word' || node.type === 'number' || node.type === 'command_name') return node.text;
  if (node.type === 'string' || node.type === 'raw_string') return node.text.slice(1, -1);
  return undefined;
}

function readOnlyCommand(node: BashSyntaxNode): boolean {
  const words = node.children.filter((child) => child.isNamed).map(literal);
  if (words.some((word) => word === undefined)) return false;
  if (words[0] === 'cd') return words.length === 2;
  if (words[0] !== 'git') return false;
  let index = 1;
  while (words[index] === '-C' || words[index] === '--git-dir' || words[index] === '--work-tree') index += 2;
  while (words[index]?.startsWith('--git-dir=') || words[index]?.startsWith('--work-tree=')) index += 1;
  return ['log', 'status', 'show', 'diff', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file', 'show-ref'].includes(words[index] ?? '') &&
    !words.some((word) => /^(?:--output(?:=|$)|--ext-diff$|--textconv$)/.test(word ?? ''));
}

function collect(node: BashSyntaxNode, commands: BashSyntaxNode[], redirects: BashSyntaxNode[]): void {
  if (node.type === 'command') commands.push(node);
  if (node.type === 'file_redirect') redirects.push(node);
  for (const child of node.children) collect(child, commands, redirects);
}

export class WorktreeIsolationDenyPermissionPolicyService implements PermissionPolicy {
  readonly name = 'worktree-isolation-deny';

  constructor(
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @IWorktreeService private readonly worktrees: IWorktreeService,
    @IBashParserService private readonly parser: IBashParserService,
  ) {}

  async evaluate(context: ResolvedToolExecutionHookContext): Promise<PermissionPolicyResult | undefined> {
    const bound = (await this.metadata.read()).worktree;
    if (bound === undefined) return undefined;
    const runtime = this.runtime.inspect();
    const pathClass = runtime.environment.pathClass;
    const path = pathClass === 'win32' ? win32 : posix;
    const other = (await this.worktrees.list()).filter((item) => item.state !== 'removed' && item.id !== bound.worktreeId).map((item) => item.path);
    const protectedPaths = [bound.sourceRoot, ...other];
    const protectedTarget = (target: string): boolean => protectedPaths.some((root) => isWithinDirectory(target, root, pathClass));
    const deny = { kind: 'deny' as const, message: 'This is an isolated worktree session; the source checkout and other Kiki worktrees are read-only here.' };
    if (writeFileAccesses(context).some((access) => protectedTarget(access.path))) return deny;
    if (context.toolCall.name !== 'Bash' || context.args === null || typeof context.args !== 'object') return undefined;
    if (context.execution.shellContext?.runtimeId.startsWith('ssh:')) return undefined;
    const args = context.args as { readonly command?: unknown; readonly cwd?: unknown };
    if (typeof args.command !== 'string') return undefined;
    const bridge = runtimeShellPathBridge(runtime);
    const workDir = inspectAgentWorkspaceRoots(this.runtime, this.workspace).workDir;
    const cwd = context.execution.shellContext?.cwd ?? path.resolve(workDir, typeof args.cwd === 'string' ? bridge.fromShellPath(args.cwd) : '.');
    const canonical = async (target: string, base = cwd): Promise<string> => {
      const resolved = path.resolve(base, bridge.fromShellPath(target));
      return runtime.fs === undefined ? resolved : realPathOrMissingChild(runtime.fs, resolved);
    };
    const parsed = this.parser.parse(args.command, { timeoutMs: 500, maxNodes: 10_000 });
    const commands: BashSyntaxNode[] = [];
    const redirects: BashSyntaxNode[] = [];
    if (parsed.ok && !parsed.hasError) collect(parsed.root, commands, redirects);
    let writesProtectedPath = false;
    const inspectWrites = async (node: BashSyntaxNode, base: string): Promise<string> => {
      if (node.type === 'file_redirect' && node.children.some((child) => ['>', '>>', '>|', '&>', '&>>', '<>'].includes(child.type))) {
        const target = node.children.findLast((child) => child.isNamed);
        const targetPath = target === undefined ? undefined : literal(target);
        if (targetPath !== undefined && protectedTarget(await canonical(targetPath, base))) writesProtectedPath = true;
      }
      let current = base;
      const children = node.type === 'redirected_statement'
        ? [...node.children.filter((child) => child.type === 'file_redirect'), ...node.children.filter((child) => child.type !== 'file_redirect')]
        : node.children;
      for (const child of children) current = await inspectWrites(child, current);
      if (node.type === 'command') {
        const words = node.children.filter((child) => child.isNamed).map(literal);
        if (words[0] === 'cd' && words[1] !== undefined) current = await canonical(words[1], base);
      }
      return ['subshell', 'command_substitution', 'pipeline'].includes(node.type) ? base : current;
    };
    if (parsed.ok && !parsed.hasError) await inspectWrites(parsed.root, cwd);
    if (writesProtectedPath) return deny;
    const readOnly = parsed.ok && !parsed.hasError && commands.length > 0 && commands.every(readOnlyCommand) &&
      redirects.every((redirect) => {
        const target = redirect.children.findLast((child) => child.isNamed);
        return target !== undefined && literal(target) !== undefined;
      });
    if (readOnly) return undefined;
    if (protectedTarget(await canonical(cwd))) return deny;
    for (const target of commandPaths(args.command)) {
      if (protectedTarget(await canonical(target))) return deny;
    }
    return undefined;
  }
}
