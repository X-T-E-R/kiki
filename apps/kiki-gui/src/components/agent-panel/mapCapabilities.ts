import type {
  AgentCapabilitiesResponse,
  AgentCapabilityTarget,
} from '@kiki/protocol';
import type {
  AgentSkillCapability,
  AgentSubagentTarget,
  AgentToolCapability,
} from './types';

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
    launchAllowed: target.launch_allowed,
    launchUnavailableReason: target.launch_unavailable_reason ?? target.unavailable_reason,
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
    parametersSchema: tool.parameters ? JSON.stringify(tool.parameters, null, 2) : undefined,
    readOnly: tool.read_only,
  }));
}
