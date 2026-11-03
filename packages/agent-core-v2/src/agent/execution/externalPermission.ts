import type { AgentExecutorContext } from '#/app/agentExecutor/agentExecutor';
import { declaredExternalToolPolicy } from '#/agent/profile/toolBinding';
import { constrainPermissionMode, IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { Error2, ErrorCodes } from '#/errors';

export function externalPermissionOverride(context: AgentExecutorContext):
  { readonly mode: PermissionMode; readonly source: 'runtime' | 'session' | 'profile' | 'harness-settings' | 'ceiling' } | undefined {
  const service = context.agent.accessor.get(IAgentPermissionModeService);
  const execution = context.binding.execution;
  const source = execution?.sources['permission_mode'];
  const configured = service.externalOverride !== undefined ? { mode: service.externalOverride, source: 'runtime' as const }
    : execution?.effective.permission_mode !== undefined && source !== undefined && source !== 'harness-default'
      ? { mode: execution.effective.permission_mode, source }
      : execution === undefined && context.binding.permissionMode !== undefined
        ? { mode: context.binding.permissionMode, source: context.binding.boundProfile?.permissionModeSource ?? 'profile' as const } : undefined;
  if (service.modeCeiling !== undefined && service.modeCeiling !== 'yolo') {
    return { mode: constrainPermissionMode(configured?.mode ?? 'yolo', service.modeCeiling),
      source: configured?.source ?? 'ceiling' };
  }
  return configured;
}

export function externalPermissionMode(context: AgentExecutorContext) {
  return externalPermissionOverride(context)?.mode;
}

export function assertExternalPermissionSupport(context: AgentExecutorContext): void {
  const policy = declaredExternalToolPolicy(context.binding);
  const unsupported: string[] = [];
  if (externalPermissionMode(context) === 'review') unsupported.push('review permission mode (Kiki reviewer)');
  if (context.worktree !== undefined) unsupported.push('Kiki worktree write isolation');
  if (context.binding.executionRestriction !== undefined) unsupported.push(`execution restriction ${context.binding.executionRestriction}`);
  if ((policy.disallowedTools?.length ?? 0) > 0) unsupported.push('disallowed_tools');
  if ((policy.tools !== undefined && !policy.tools.includes('*')) ||
      (policy.toolAllowPolicies?.some((tools) => !tools.includes('*')) ?? false)) unsupported.push('tools allowlist');
  const rules = context.agent.accessor.get(IAgentPermissionRulesService).rules.filter((rule) => rule.decision !== 'allow');
  if (rules.length > 0) unsupported.push(`permission.rules (${[...new Set(rules.map((rule) => rule.scope))].join(', ')})`);
  if (unsupported.length > 0) throw new Error2(ErrorCodes.CONFIG_INVALID,
    `Executor "${context.descriptor.id}" cannot enforce ${unsupported.join('; ')} on vendor-native tools. Use the native Kiki executor for these restrictions, or configure the external engine's own permissions.`,
    { details: { executorId: context.descriptor.id, unsupported } });
}

export function externalPermissionMeta(context: AgentExecutorContext) {
  return { version: 2, override: externalPermissionOverride(context) };
}
