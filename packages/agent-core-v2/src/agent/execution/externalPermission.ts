import { createHash } from 'node:crypto';
import type { AgentExecutorContext } from '#/app/agentExecutor/agentExecutor';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { constrainPermissionMode, IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { runtimeShellPathBridge } from '#/runtime/runtimeWorkspaceView';
import { resolveRealPathAccess } from '#/tool/path-access';
import { matchesBashRuleSubject } from '#/tool/bash-rule-match';
import { matchesPathRuleSubject } from '#/tool/rule-match';
import type { RunnableToolExecution, ToolAccesses } from '#/tool/toolContract';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

export interface ExternalToolPermission {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
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

export function externalPermissionHostGate(context: AgentExecutorContext): boolean {
  return externalPermissionOverride(context) !== undefined ||
    context.agent.accessor.get(IAgentPermissionRulesService).rules.length > 0 ||
    context.binding.executionRestriction !== undefined || (context.binding.disallowedTools?.length ?? 0) > 0 ||
    (context.binding.toolAllowPolicies?.length ?? 0) > 0;
}

export function externalPermissionMeta(context: AgentExecutorContext, cwd: string, additionalDirectories?: readonly string[]) {
  const rules = context.agent.accessor.get(IAgentPermissionRulesService).rules;
  return { version: 1, override: externalPermissionOverride(context), hostGate: externalPermissionHostGate(context),
    policyIdentity: createHash('sha256').update(JSON.stringify({ rules,
      disallowedTools: context.binding.disallowedTools, toolAllowPolicies: context.binding.toolAllowPolicies,
      restriction: context.binding.executionRestriction })).digest('hex'),
    workspace: { cwd, additionalDirectories: additionalDirectories ?? [] },
    restriction: context.binding.executionRestriction };
}

export function externalToolPermission(value: unknown): ExternalToolPermission | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const tool = value as Record<string, unknown>;
  if (typeof tool['name'] !== 'string' || tool['name'].length === 0 || tool['input'] === null ||
      typeof tool['input'] !== 'object' || Array.isArray(tool['input'])) return undefined;
  const input = tool['input'] as Record<string, unknown>;
  const names: Readonly<Record<string, string>> = { RunCommand: 'Bash', run_command: 'Bash', view_file: 'Read',
    read_file: 'Read', write_to_file: 'Write', replace_file_content: 'Edit', multi_replace_file_content: 'Edit',
    list_directory: 'Glob', find_by_name: 'Glob', grep_search: 'Grep' };
  const name = names[tool['name']] ?? tool['name'];
  return { name, input: { ...input, command: input['command'] ?? input['CommandLine'],
    cwd: input['cwd'] ?? input['Cwd'], path: input['path'] ?? input['AbsolutePath'] ?? input['TargetFile'] ?? input['DirectoryPath'] } };
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
  if (!externalPermissionHostGate(context)) return 'inherit';
  const override = externalPermissionOverride(context);
  if (override !== undefined) context.agent.accessor.get(IAgentPermissionModeService).setMode(override.mode, 'ambient');
  const execution = await resolveExternalExecution(context, tool, display);
  if (execution === undefined) return 'deny';
  const resolved: ResolvedToolExecutionHookContext = { turnId, signal,
    permissionAuthority: override === undefined ? 'external-inherit' : undefined,
    toolCall: { type: 'function', id: toolCallId, name: tool.name, arguments: JSON.stringify(tool.input) },
    toolCalls: [], args: tool.input, execution };
  const decision = await context.agent.accessor.get(IAgentPermissionGate).authorize(resolved);
  return signal.aborted || decision?.permissionDecision === 'cancelled' ? 'cancelled'
    : decision?.veto !== undefined ? 'deny'
      : override === undefined && decision?.permissionDecision !== 'approved' ? 'inherit' : 'allow';
}

async function resolveExternalExecution(context: AgentExecutorContext, tool: ExternalToolPermission,
  display: ToolInputDisplay): Promise<RunnableToolExecution | undefined> {
  const { name, input } = tool;
  if (context.binding.disallowedTools?.includes(name) ||
      context.binding.toolAllowPolicies?.some((names) => !names.includes(name))) return undefined;
  const command = input['command'];
  if (name === 'Bash') {
    if (typeof command !== 'string' || command.length === 0) return undefined;
    return { approvalRule: `Bash(${command})`, matchesRule: (rule, mode) => matchesBashRuleSubject(rule, command, mode),
      display, description: command, execute: unreachable };
  }
  const operation = name === 'Write' || name === 'Edit' ? 'write' : name === 'Glob' || name === 'Grep' ? 'search' : 'read';
  if (!['Read', 'ReadMediaFile', 'Write', 'Edit', 'Glob', 'Grep'].includes(name)) {
    return { approvalRule: name, display, execute: unreachable };
  }
  const rawPath = input['path'];
  if (typeof rawPath !== 'string' || rawPath.length === 0) return undefined;
  const runtime = context.agent.accessor.get(IAgentRuntimeService);
  const workspace = context.agent.accessor.get(ISessionWorkspaceContext);
  const lease = runtime.acquire(['fs']);
  try {
    if (lease.runtime.fs === undefined) return undefined;
    const roots = lease.runtime.workspace.mapRoots({ workDir: workspace.workDir, additionalDirs: workspace.additionalDirs });
    const env = lease.runtime.environment;
    const access = await resolveRealPathAccess(rawPath, { env, operation,
      workspace: { workspaceDir: roots.workDir, additionalDirs: roots.additionalDirs ?? [] },
      shellPathBridge: runtimeShellPathBridge(lease.runtime) }, lease.runtime.fs);
    const accesses: ToolAccesses = [{ kind: 'file', operation, path: access.path, implicitExternal: access.implicitExternal }];
    return { accesses, approvalRule: `${name}(${access.path})`,
      matchesRule: (rule) => matchesPathRuleSubject(rule, access.path,
        { cwd: roots.workDir, pathClass: env.pathClass, homeDir: env.homeDir }), display, execute: unreachable };
  } finally {
    lease.dispose();
  }
}

async function unreachable(): Promise<never> {
  throw new Error('External permission projection does not execute a native tool');
}
