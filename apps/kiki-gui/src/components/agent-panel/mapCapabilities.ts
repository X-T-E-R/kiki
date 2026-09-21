import { ErrorCode, type AgentCapabilitiesResponse, type AgentCapabilityTarget, type AgentCapabilityReasonCode } from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';
import { ApiError } from '@kiki/session-core/transport';
import type {
  AgentSkillCapability,
  AgentSubagentTarget,
  AgentToolCapability,
} from './types';

type Translate = (key: I18nKey) => string;

export const CAPABILITY_REASON_LABEL_KEYS: Readonly<Record<AgentCapabilityReasonCode, I18nKey>> = {
  skill_tool_inactive: 'capabilityReason.skill_tool_inactive',
  skill_model_invocation_disabled: 'capabilityReason.skill_model_invocation_disabled',
  snapshot_inventory_only: 'capabilityReason.snapshot_inventory_only',
  tool_policy_disabled: 'capabilityReason.tool_policy_disabled',
  runtime_not_connected: 'capabilityReason.runtime_not_connected',
  activation_condition_unmet: 'capabilityReason.activation_condition_unmet',
  approval_pending: 'capabilityReason.approval_pending',
  session_or_agent_not_live: 'capabilityReason.session_or_agent_not_live',
  persisted_metadata_unavailable: 'capabilityReason.persisted_metadata_unavailable',
  persisted_profile_unavailable: 'capabilityReason.persisted_profile_unavailable',
  snapshot_launch_unavailable: 'capabilityReason.snapshot_launch_unavailable',
  agent_run_inactive: 'capabilityReason.agent_run_inactive',
  agent_run_draft_disabled: 'capabilityReason.agent_run_draft_disabled',
  draft_inventory_only: 'capabilityReason.draft_inventory_only',
  draft_policy_disabled: 'capabilityReason.draft_policy_disabled',
  strict_subagent_policy_blocked: 'capabilityReason.strict_subagent_policy_blocked',
  executor_binding_unavailable: 'capabilityReason.executor_binding_unavailable',
  executor_route_binding_unavailable: 'capabilityReason.executor_route_binding_unavailable',
  model_not_configured: 'capabilityReason.model_not_configured',
  scoped_profile_unavailable: 'capabilityReason.scoped_profile_unavailable',
  binding_constraints_unsatisfied: 'capabilityReason.binding_constraints_unsatisfied',
  default_binding_unavailable: 'capabilityReason.default_binding_unavailable',
  research_readonly_dispatch_forbidden: 'capabilityReason.research_readonly_dispatch_forbidden',
  plan_resume_forbidden: 'capabilityReason.plan_resume_forbidden',
  native_executor_required: 'capabilityReason.native_executor_required',
};

const AGENT_CAPABILITIES_ERROR_KEYS: Readonly<Record<number, I18nKey>> = {
  [ErrorCode.VALIDATION_FAILED]: 'agentPanel.error.validationFailed',
  [ErrorCode.WORKSPACE_NOT_FOUND]: 'agentPanel.error.workspaceNotFound',
  [ErrorCode.AGENT_PROFILE_NOT_FOUND]: 'agentPanel.error.agentProfileNotFound',
};

/** Resolve a capability reason code to localized copy, retaining legacy raw copy as a fallback. */
export function capabilityReasonText(
  t: Translate,
  code: string | undefined,
  rawReason: string | undefined,
): string | undefined {
  const key = code === undefined
    ? undefined
    : CAPABILITY_REASON_LABEL_KEYS[code as AgentCapabilityReasonCode];
  return key === undefined ? rawReason : t(key);
}

/** Localize the capability query's known API errors while preserving unknown messages. */
export function agentCapabilitiesErrorText(error: unknown, t: Translate): string {
  const code = error instanceof ApiError
    ? error.code
    : error instanceof Error
      ? (() => {
          const candidate = error as Error & { readonly code?: unknown };
          return typeof candidate.code === 'number' ? candidate.code : undefined;
        })()
      : undefined;
  const key = code === undefined ? undefined : AGENT_CAPABILITIES_ERROR_KEYS[code];
  if (key !== undefined) return t(key);
  return error instanceof Error ? error.message : String(error);
}

export function mapPanelSubagentTargets(
  targets: readonly AgentCapabilityTarget[] | undefined,
): AgentSubagentTarget[] {
  if (!targets) return [];
  return targets.map((target) => ({
    profile: target.profile,
    route: target.route,
    executor: target.executor,
    modelAlias: target.model_alias,
    thinkingEffort: target.thinking_effort,
    defaultsAvailable: target.defaults_available,
    unavailableReason: target.unavailable_reason,
    unavailableReasonCode: target.unavailable_reason_code,
    launchAllowed: target.launch_allowed,
    launchUnavailableReason: target.launch_unavailable_reason ?? target.unavailable_reason,
    launchUnavailableReasonCode: target.launch_unavailable_reason_code ?? target.unavailable_reason_code,
    executionRestriction: target.execution_restriction,
  }));
}

export function mapPanelSkills(
  skills: AgentCapabilitiesResponse['skills'],
): AgentSkillCapability[] {
  if (!skills) return [];
  return skills.map((skill) => ({
    ...skill,
    id: `${skill.source}:${skill.path}`,
    unavailableReason: skill.unavailable_reason,
    unavailableReasonCode: skill.unavailable_reason_code,
    argumentHint: skill.argument_hint,
    type: skill.type,
    disableModelInvocation: skill.disable_model_invocation,
    promptCommand: skill.prompt_command,
  }));
}

export function mapPanelTools(
  tools: AgentCapabilitiesResponse['tools'],
): AgentToolCapability[] {
  if (!tools) return [];
  return tools.map((tool) => ({
    ...tool,
    unavailableReason: tool.unavailable_reason,
    unavailableReasonCode: tool.unavailable_reason_code,
    parametersSchema: tool.parameters ? JSON.stringify(tool.parameters, null, 2) : undefined,
    readOnly: tool.read_only,
  }));
}
