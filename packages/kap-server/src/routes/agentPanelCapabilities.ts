import type { AgentCapabilitiesResponse } from '@kiki/protocol';
import { IAgentProfileService, IAgentToolRegistryService, IAgentToolPolicyService, ISubagentTool, ISessionAgentProfileCatalog, type IAgentScopeHandle } from '@kiki/agent-core-v2';
import { IAgentToolActivationService } from '@kiki/agent-core-v2/agent/toolActivation/toolActivation';
import { ISessionSkillCatalog } from '@kiki/agent-core-v2/session/sessionSkillCatalog/skillCatalog';
import type { SkillDefinition } from '@kiki/agent-core-v2/app/skillCatalog/types';
import { ISessionInteractionService } from '@kiki/agent-core-v2/session/interaction/interaction';

export function panelSkills(
  skills: readonly SkillDefinition[],
  toolActive: boolean,
): NonNullable<AgentCapabilitiesResponse['skills']> {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    source: skill.source,
    scope: skill.source === 'project' || skill.source === 'extra' ? 'workspace' : 'global',
    path: skill.path,
    state: !toolActive || skill.metadata.disableModelInvocation === true ? 'disabled' : 'enabled',
    unavailable_reason: !toolActive ? 'Skill tool is not active for this agent'
      : skill.metadata.disableModelInvocation === true ? 'Model invocation is disabled for this skill' : undefined,
    type: skill.metadata.type,
    disable_model_invocation: skill.metadata.disableModelInvocation,
    prompt_command: skill.metadata.promptCommand,
    argument_hint: skill.metadata.argumentHint,
  }));
}

export const READ_ONLY_DISPLAY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Read',
  'ReadMediaFile',
  'Glob',
  'Grep',
  'WebSearch',
  'FetchURL',
]);

export async function livePanelCapabilities(agent: IAgentScopeHandle): Promise<Pick<AgentCapabilitiesResponse, 'profile' | 'tools' | 'skills'>> {
  const data = agent.accessor.get(IAgentProfileService).data();
  const catalog = agent.accessor.get(ISessionAgentProfileCatalog);
  await catalog.ready;
  const frozen = agent.accessor.get(ISubagentTool).dispatchCatalog().snapshot;
  const definition = data.profileDefinitionId === undefined ? undefined
    : frozen?.sourceDefinitions.get(data.profileDefinitionId)
      ?? [...(frozen?.publicProfiles.values() ?? [])].find((candidate) => candidate.definitionId === data.profileDefinitionId);
  const registry = agent.accessor.get(IAgentToolRegistryService).list();
  const policy = agent.accessor.get(IAgentToolPolicyService);
  const contributions = agent.accessor.get(IAgentToolActivationService).capabilities();
  const tools = new Map<string, NonNullable<AgentCapabilitiesResponse['tools']>[number]>();
  for (const contribution of contributions) {
    const active = policy.isToolActive(contribution.name, contribution.source);
    tools.set(contribution.name, {
      name: contribution.name, source: contribution.source, category: contribution.category,
      state: !active ? 'disabled' : !contribution.runtimeAvailable ? 'disconnected'
        : !contribution.conditionAvailable ? 'disabled' : 'enabled',
      unavailable_reason: !active ? 'Disabled by effective tool policy'
        : !contribution.runtimeAvailable ? 'Required runtime capability is not connected'
          : !contribution.conditionAvailable ? 'Tool activation condition is not satisfied' : undefined,
    });
  }
  for (const tool of registry) {
    const previous = tools.get(tool.name);
    tools.set(tool.name, {
      name: tool.name, description: tool.description, source: tool.source,
      category: previous?.category ?? tool.source,
      state: policy.isToolActive(tool.name, tool.source) ? previous?.state ?? 'enabled' : 'disabled',
      unavailable_reason: policy.isToolActive(tool.name, tool.source) ? previous?.unavailable_reason : 'Disabled by effective tool policy',
      parameters: tool.parameters,
      read_only: (data.executionRestriction === 'research-readonly' || READ_ONLY_DISPLAY_TOOL_NAMES.has(tool.name)) ? true : undefined,
    });
  }
  for (const interaction of agent.accessor.get(ISessionInteractionService).listPending('approval', { agentId: agent.id })) {
    const payload = interaction.payload;
    if (typeof payload !== 'object' || payload === null || !('toolName' in payload) || typeof payload.toolName !== 'string') continue;
    const tool = tools.get(payload.toolName);
    if (tool?.state === 'enabled') tools.set(tool.name, { ...tool, state: 'approval-required',
      unavailable_reason: 'An invocation of this tool is waiting for approval' });
  }
  const skills = agent.accessor.get(ISessionSkillCatalog);
  await skills.ready;
  return {
    profile: {
      name: data.profileName ?? 'unknown', description: definition?.description,
      source: definition?.sourcePath ?? data.profileDefinitionId,
      source_file: definition?.sourcePath, definition_id: data.profileDefinitionId,
      route: data.routeId, model: data.modelAlias, thinking_effort: data.thinkingLevel,
      executor: data.executorId, service_tier: data.serviceTier,
      tools: data.activeToolNames === undefined ? undefined : [...data.activeToolNames],
      disallowed_tools: data.disallowedTools === undefined ? undefined : [...data.disallowedTools],
      execution_restriction: data.executionRestriction,
      locked_model: data.lockedModelAlias, locked_effort: data.lockedThinkingEffort,
      tool_allow_policies: data.toolAllowPolicies?.map((policy) => [...policy]),
      spawn_constraints: data.spawnPolicy === undefined ? undefined : {
        allowed_models: data.spawnPolicy.allowedModels === undefined ? undefined : [...data.spawnPolicy.allowedModels],
        deny_models: data.spawnPolicy.denyModels === undefined ? undefined : [...data.spawnPolicy.denyModels],
        allowed_efforts: data.spawnPolicy.allowedEfforts === undefined ? undefined : [...data.spawnPolicy.allowedEfforts],
        disallowed_tools: data.spawnPolicy.disallowedTools === undefined ? undefined : [...data.spawnPolicy.disallowedTools],
      },
    },
    tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)),
    skills: panelSkills(skills.catalog.listSkills(), policy.isToolActive('Skill')),
  };
}
