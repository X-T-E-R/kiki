import { createHash } from 'node:crypto';
import { isToolActive, type ToolActivationPolicy } from '@kiki/agent-profiles/toolPolicy';
import { canonicalFetchUrl, fetchInputSchema } from '@nb-corp/nb-search';
import type { AgentExecutorContext } from '#/app/agentExecutor/agentExecutor';
import { declaredExternalToolPolicy } from '#/agent/profile/toolBinding';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { constrainPermissionMode, IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentRuntimeService, inspectAgentWorkspaceRoots } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { runtimeShellPathBridge } from '#/runtime/runtimeWorkspaceView';
import { resolveRealPathAccess } from '#/tool/path-access';
import { matchesBashRuleSubject } from '#/tool/bash-rule-match';
import { literalRulePattern, matchesPathRuleSubject, matchesStringRuleSubject } from '#/tool/rule-match';
import type { RunnableToolExecution, ToolAccesses } from '#/tool/toolContract';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

export interface ExternalToolPermission {
  readonly name: string;
  readonly nativeName?: string;
  readonly input: Readonly<Record<string, unknown>>;
}

function nativeTaskReadName(input: Readonly<Record<string, unknown>>): string | undefined {
  if (Object.keys(input).some((key) => !['Action', 'TaskId', 'Input'].includes(key)) ||
      ['TaskId', 'Input'].some((key) => input[key] !== undefined && typeof input[key] !== 'string')) return undefined;
  if (input['Action'] === 'list') return 'TaskList';
  if (input['Action'] === 'status' && typeof input['TaskId'] === 'string' && input['TaskId'].length > 0) return 'TaskOutput';
  return undefined;
}

function fetchUrlSubject(input: Readonly<Record<string, unknown>>): string | undefined {
  try {
    const parsed = fetchInputSchema.safeParse(input);
    if (!parsed.success || parsed.data.action !== 'run' || parsed.data.source.kind !== 'url') return undefined;
    const value = parsed.data.source.url;
    if (!/^https?:\/\//iu.test(value) || /[\s\\\u0000-\u001F\u007F]/u.test(value)) return undefined;
    const url = canonicalFetchUrl(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname !== '' && url.username === '' && url.password === '' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function nativeReadName(name: string, input: Readonly<Record<string, unknown>>): string | undefined {
  if (name === 'manage_task') return nativeTaskReadName(input);
  if (name === 'read_url_content' && Object.keys(input).every((key) => key === 'url') && fetchUrlSubject(input) !== undefined) return 'FetchURL';
  return undefined;
}

export function externalPermissionOverride(context: AgentExecutorContext):
  { readonly mode: PermissionMode; readonly source: 'runtime' | 'session' | 'profile' | 'harness-settings' | 'ceiling' } | undefined {
  const service = context.agent.accessor.get(IAgentPermissionModeService);
  const execution = context.binding.execution;
  const source = execution?.sources['permission_mode'];
  const configured = service.externalOverride !== undefined ? { mode: service.externalOverride, source: 'runtime' as const }
    : execution?.effective.permission_mode !== undefined && source !== undefined && source !== 'harness-default'
      ? { mode: execution.effective.permission_mode, source }
      : execution === undefined && context.binding.permissionMode !== undefined
        ? { mode: context.binding.permissionMode, source: 'profile' as const } : undefined;
  if (service.modeCeiling !== undefined && service.modeCeiling !== 'yolo') {
    return { mode: constrainPermissionMode(configured?.mode ?? 'yolo', service.modeCeiling),
      source: configured?.source ?? 'ceiling' };
  }
  return configured;
}

export function externalPermissionMode(context: AgentExecutorContext) {
  return externalPermissionOverride(context)?.mode;
}

export function externalToolPolicy(context: AgentExecutorContext): ToolActivationPolicy {
  return declaredExternalToolPolicy(context.binding);
}

export function externalPermissionConstraints(context: AgentExecutorContext): boolean {
  const policy = externalToolPolicy(context);
  return context.worktree !== undefined || context.agent.accessor.get(IAgentPermissionRulesService).rules.some((rule) => rule.decision !== 'allow') ||
    context.binding.executionRestriction !== undefined || (policy.disallowedTools?.length ?? 0) > 0 ||
    (policy.tools !== undefined && !policy.tools.includes('*')) ||
    (policy.toolAllowPolicies?.some((tools) => !tools.includes('*')) ?? false);
}

export function externalPermissionHostGate(context: AgentExecutorContext): boolean {
  return externalPermissionOverride(context) !== undefined || externalPermissionConstraints(context) ||
    context.agent.accessor.get(IAgentPermissionRulesService).rules.length > 0;
}

export function externalPermissionMeta(context: AgentExecutorContext, cwd: string, additionalDirectories?: readonly string[]) {
  const rules = context.agent.accessor.get(IAgentPermissionRulesService).rules;
  return { version: 1, override: externalPermissionOverride(context), hostGate: externalPermissionHostGate(context),
    policyIdentity: createHash('sha256').update(JSON.stringify({ rules,
      toolPolicy: externalToolPolicy(context),
      restriction: context.binding.executionRestriction, worktree: context.worktree })).digest('hex'),
    workspace: { cwd, additionalDirectories: additionalDirectories ?? [] },
    restriction: context.binding.executionRestriction };
}

export function externalToolPermission(value: unknown): ExternalToolPermission | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const tool = value as Record<string, unknown>;
  if (typeof tool['name'] !== 'string' || tool['name'].length === 0 || tool['input'] === null ||
      typeof tool['input'] !== 'object' || Array.isArray(tool['input'])) return undefined;
  const input = tool['input'] as Record<string, unknown>;
  if (tool['nativeName'] !== undefined) {
    if (typeof tool['nativeName'] !== 'string' || tool['name'] !== nativeReadName(tool['nativeName'], input)) return undefined;
    return { name: tool['name'], nativeName: tool['nativeName'], input };
  }
  if (tool['name'] === 'read_url_content') {
    const urlInput = { url: input['Url'] };
    if (Object.keys(input).some((key) => key !== 'Url') || fetchUrlSubject(urlInput) === undefined) return undefined;
    return { name: 'FetchURL', nativeName: 'read_url_content', input: urlInput };
  }
  if (tool['name'] === 'FetchURL') return fetchUrlSubject(input) === undefined ? undefined : { name: 'FetchURL', input };
  const taskRead = tool['name'] === 'manage_task' ? nativeTaskReadName(input) : undefined;
  if (taskRead !== undefined) return { name: taskRead, nativeName: 'manage_task', input };
  const names: Readonly<Record<string, string>> = { RunCommand: 'Bash', run_command: 'Bash', view_file: 'Read',
    read_file: 'Read', write_to_file: 'Write', replace_file_content: 'Edit', multi_replace_file_content: 'Edit',
    list_directory: 'Glob', find_by_name: 'Glob', grep_search: 'Grep' };
  const name = names[tool['name']] ?? tool['name'];
  return { name, input: { ...input, command: input['command'] ?? input['CommandLine'],
    cwd: input['cwd'] ?? input['Cwd'], path: input['path'] ?? input['file_path'] ?? input['AbsolutePath'] ?? input['TargetFile'] ?? input['DirectoryPath'] } };
}

export async function authorizeExternalTool(
  context: AgentExecutorContext,
  tool: ExternalToolPermission,
  turnId: number,
  toolCallId: string,
  signal: AbortSignal,
  display: ToolInputDisplay,
): Promise<'allow' | 'deny' | 'inherit' | 'cancelled'> {
  signal.throwIfAborted();
  if (tool.nativeName !== undefined && tool.name !== nativeReadName(tool.nativeName, tool.input)) return 'deny';
  if (tool.name === 'FetchURL' && fetchUrlSubject(tool.input) === undefined) return 'deny';
  if (!externalPermissionHostGate(context)) return 'inherit';
  const override = externalPermissionOverride(context);
  if (override !== undefined) context.agent.accessor.get(IAgentPermissionModeService).setMode(override.mode, 'ambient');
  const execution = await resolveExternalExecution(context, tool, display);
  if (execution === undefined) return 'deny';
  const resolved: ResolvedToolExecutionHookContext = { turnId, signal,
    permissionAuthority: override === undefined ? 'external-inherit' : undefined,
    toolCall: { type: 'function', id: toolCallId, name: tool.name, arguments: JSON.stringify(tool.input) },
    toolCalls: [], args: tool.input, execution };
  const gate = context.agent.accessor.get(IAgentPermissionGate);
  let nativeApproved = false;
  if (tool.nativeName !== undefined) {
    const nativeDecision = await gate.authorize({ ...resolved, permissionAuthority: 'external-inherit',
      toolCall: { ...resolved.toolCall, name: tool.nativeName }, execution: { ...execution, approvalRule: tool.nativeName } });
    if (signal.aborted || nativeDecision?.permissionDecision === 'cancelled') return 'cancelled';
    if (nativeDecision?.veto !== undefined) return 'deny';
    nativeApproved = nativeDecision?.permissionDecision === 'approved';
  }
  const decision = await gate.authorize(resolved);
  return signal.aborted || decision?.permissionDecision === 'cancelled' ? 'cancelled'
    : decision?.veto !== undefined ? 'deny'
      : override === undefined && decision?.permissionDecision !== 'approved' && !nativeApproved ? 'inherit' : 'allow';
}

async function resolveExternalExecution(context: AgentExecutorContext, tool: ExternalToolPermission,
  display: ToolInputDisplay): Promise<RunnableToolExecution | undefined> {
  const { name, input, nativeName } = tool;
  const policy = externalToolPolicy(context);
  if (nativeName === undefined) {
    if (!isToolActive(policy, name, name.startsWith('mcp__') ? 'mcp' : 'builtin')) return undefined;
  } else {
    if ([policy.tools, ...policy.toolAllowPolicies ?? []].some((tools) => tools !== undefined &&
        !isToolActive({ tools }, name) && !isToolActive({ tools }, nativeName))) return undefined;
    const exclusions = { disallowedTools: policy.disallowedTools };
    if (!isToolActive(exclusions, name) || !isToolActive(exclusions, nativeName)) return undefined;
  }
  const command = input['command'];
  if (name === 'Bash') {
    if (typeof command !== 'string' || command.length === 0) return undefined;
    return { approvalRule: `Bash(${command})`, matchesRule: (rule, mode) => matchesBashRuleSubject(rule, command, mode),
      display, description: command, execute: unreachable };
  }
  if (name === 'FetchURL') {
    const subject = fetchUrlSubject(input);
    if (subject === undefined) return undefined;
    return { accesses: [], approvalRule: literalRulePattern(name, subject),
      matchesRule: (rule) => matchesStringRuleSubject(rule, subject), display, description: `Fetch: ${subject.slice(0, 100)}`, execute: unreachable };
  }
  const operation = name === 'Write' || name === 'Edit' ? 'write' : name === 'Glob' || name === 'Grep' ? 'search' : 'read';
  if (!['Read', 'ReadMediaFile', 'Write', 'Edit', 'Glob', 'Grep'].includes(name)) {
    return { approvalRule: name, display, execute: unreachable };
  }
  const rawPaths = input['paths'] ?? [input['path']];
  if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.some((path) => typeof path !== 'string' || path.length === 0)) return undefined;
  const runtime = context.agent.accessor.get(IAgentRuntimeService);
  const workspace = context.agent.accessor.get(ISessionWorkspaceContext);
  const lease = runtime.acquire(['fs']);
  try {
    if (lease.runtime.fs === undefined) return undefined;
    const roots = lease.runtime.workspace.mapRoots(inspectAgentWorkspaceRoots(runtime, workspace));
    const env = lease.runtime.environment;
    const paths = await Promise.all(rawPaths.map((path) => resolveRealPathAccess(path as string, { env, operation,
      workspace: { workspaceDir: roots.workDir, additionalDirs: roots.additionalDirs ?? [] },
      shellPathBridge: runtimeShellPathBridge(lease.runtime) }, lease.runtime.fs!)));
    const accesses: ToolAccesses = paths.map((access) => ({ kind: 'file', operation, path: access.path, implicitExternal: access.implicitExternal }));
    return { accesses, approvalRule: `${name}(${paths.map((access) => access.path).join(', ')})`,
      matchesRule: (rule, mode = 'all') => {
        const matched = paths.map((access) => matchesPathRuleSubject(rule, access.path,
          { cwd: roots.workDir, pathClass: env.pathClass, homeDir: env.homeDir }));
        return mode === 'any' ? matched.some(Boolean) : matched.every(Boolean);
      }, display, execute: unreachable };
  } finally {
    lease.dispose();
  }
}

async function unreachable(): Promise<never> {
  throw new Error('External permission projection does not execute a native tool');
}
