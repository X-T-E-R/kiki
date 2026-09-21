import type { AgentCapabilitiesResponse, AgentPanelProfile } from '@kiki/protocol';
import {
  IAgentProfileService,
  IAgentToolRegistryService,
  IAgentToolPolicyService,
  IConfigService,
  IModelCatalog,
  IModelService,
  ISubagentTool,
  ISessionAgentProfileCatalog,
  ISessionToolPolicy,
  type IAgentScopeHandle,
  type ProfileData,
  type Scope,
} from '@kiki/agent-core-v2';
import { spawnConstraintOrigin } from '@kiki/agent-core-v2/app/agentProfileCatalog/applySubagentLease';
import type { SkillDefinition } from '@kiki/agent-core-v2/app/skillCatalog/types';
import { IAgentToolActivationService } from '@kiki/agent-core-v2/agent/toolActivation/toolActivation';
import { isToolActiveComposed, type GlobalToolsPolicy } from '@kiki/agent-core-v2/agent/toolPolicy/evaluate';
import { isAgentNotifyAvailable } from '@kiki/agent-core-v2/agent/tools/agent-notify/agent-notify';
import { getAgentToolContributions } from '@kiki/agent-core-v2/agent/toolRegistry/toolContribution';
import { toolGroupForName } from '@kiki/agent-core-v2/agent/toolRegistry/toolGroups';
import type { ThinkingConfig } from '@kiki/agent-core-v2/kosong/model/thinking';
import {
  AGENTS_SECTION,
  isParentNotifyEnabled,
  type AgentsConfig,
} from '@kiki/agent-core-v2/session/agentCollaboration/configSection';
import { ISessionInteractionService } from '@kiki/agent-core-v2/session/interaction/interaction';
import { ISessionSkillCatalog } from '@kiki/agent-core-v2/session/sessionSkillCatalog/skillCatalog';
import { ISessionToolPolicyGate } from '@kiki/agent-core-v2/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { resolveRoleThinkingDefault, roleConstraintsFromProfile } from '@kiki/agent-core-v2/session/subagent/modelConstraints';
import {
  resolveBoundPanelProfile,
  type PanelProfileDefinition,
  type PanelProfileResolution,
} from './agentPanelProfileResolution';
import type { PersistedAgentProfileSnapshot } from './agentProfileSnapshot';
import { projectPersistedAgentThinking } from './agentProfileThinking';

type PanelBindingData = Partial<Pick<ProfileData,
  'modelAlias' | 'profileName' | 'profileDefinitionId' | 'routeId' |
  'lockedModelAlias' | 'lockedThinkingEffort' | 'thinkingLevel' |
  'effectiveThinkingLevel' | 'thinkingEffortSource' | 'routeDetached' |
  'profileSource' | 'executorId' | 'serviceTier' | 'activeToolNames' |
  'toolAllowPolicies' | 'disallowedTools' | 'disabledToolGroups' |
  'subagentPolicy' | 'executionRestriction' | 'allowParentNotify' | 'spawnPolicy' | 'appliedLease' |
  'boundProfile'>> & { readonly thinkingEffortAdjusted?: boolean };

export function panelSkills(
  skills: readonly SkillDefinition[],
  toolActive: boolean,
): NonNullable<AgentCapabilitiesResponse['skills']> {
  return skills.map((skill) => {
    const unavailableReason = !toolActive ? 'Skill tool is not active for this agent'
      : skill.metadata.disableModelInvocation === true ? 'Model invocation is disabled for this skill' : undefined;
    const unavailableReasonCode = !toolActive ? 'skill_tool_inactive'
      : skill.metadata.disableModelInvocation === true ? 'skill_model_invocation_disabled' : undefined;
    return {
      name: skill.name,
      description: skill.description,
      source: skill.source,
      scope: skill.source === 'project' || skill.source === 'extra' ? 'workspace' : 'global',
      path: skill.path,
      state: !toolActive || skill.metadata.disableModelInvocation === true ? 'disabled' : 'enabled',
      unavailable_reason: unavailableReason,
      unavailable_reason_code: unavailableReasonCode,
      type: skill.metadata.type,
      disable_model_invocation: skill.metadata.disableModelInvocation,
      prompt_command: skill.metadata.promptCommand,
      argument_hint: skill.metadata.argumentHint,
    };
  });
}

export const READ_ONLY_DISPLAY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Read',
  'ReadMediaFile',
  'Glob',
  'Grep',
  'WebSearch',
  'FetchURL',
]);

export function resolvePanelProfile(
  catalog: ISessionAgentProfileCatalog,
  profileName: string | undefined,
  definitionId: string | undefined,
  options: Parameters<typeof resolveBoundPanelProfile>[3] = {},
): PanelProfileResolution {
  return resolveBoundPanelProfile(catalog, profileName, definitionId, options);
}

export async function snapshotPanelCapabilities(
  session: Pick<Scope, 'accessor'>,
  snapshot: PersistedAgentProfileSnapshot,
  resolution: PanelProfileResolution & { readonly profile: PanelProfileDefinition },
  hasParent: boolean,
): Promise<Pick<AgentCapabilitiesResponse, 'profile' | 'tools' | 'skills'>> {
  const definition = resolution.profile;
  const persisted = snapshot.source === 'wire';
  const activeToolNames = snapshot.activeToolsKnown ? snapshot.activeToolNames : definition.tools;
  const binding: PanelBindingData = {
    ...snapshot,
    ...projectPersistedAgentThinking(session, snapshot, definition),
    activeToolNames,
    toolAllowPolicies: persisted ? snapshot.toolAllowPolicies : snapshot.toolAllowPolicies ?? definition.toolAllowPolicies,
    disallowedTools: persisted ? snapshot.disallowedTools : snapshot.disallowedTools ?? definition.disallowedTools,
    disabledToolGroups: persisted ? snapshot.disabledToolGroups : snapshot.disabledToolGroups ?? definition.disabledToolGroups,
    allowParentNotify: persisted ? snapshot.allowParentNotify : snapshot.allowParentNotify ?? definition.allowParentNotify,
    subagentPolicy: snapshot.subagentPolicy ?? definition.subagentPolicy,
    serviceTier: snapshot.serviceTier ?? definition.serviceTier,
    profileSource: snapshot.boundProfile?.fileSources === undefined ? 'registered' : 'profile-file',
  };
  const sessionPolicy = session.accessor.get(ISessionToolPolicy);
  const skills = session.accessor.get(ISessionSkillCatalog);
  const config = session.accessor.get(IConfigService);
  await Promise.all([sessionPolicy.ready, skills.ready]);
  const policy = {
    profile: {
      executionRestriction: binding.executionRestriction,
      tools: binding.activeToolNames,
      toolAllowPolicies: binding.toolAllowPolicies,
      disallowedTools: binding.disallowedTools,
      disabledToolGroups: binding.disabledToolGroups,
    },
    global: config.get<GlobalToolsPolicy>('tools'),
    workspaceDisabledTools: session.accessor.get(ISessionToolPolicyGate).disabledTools,
    sessionDisabledTools: sessionPolicy.disabledTools(),
  };
  const parentNotifyConfigEnabled = isParentNotifyEnabled(
    config.get<AgentsConfig>(AGENTS_SECTION),
  );
  const unavailableReason = 'Snapshot inventory only; agent runtime and invocation approval are unavailable';
  const unavailableReasonCode = 'snapshot_inventory_only';
  const tools: NonNullable<AgentCapabilitiesResponse['tools']> = getAgentToolContributions().map(({ options }) => {
    const active = isToolActiveComposed(policy, options.name, options.source);
    const conditionAvailable = options.name !== 'AgentNotify' || isAgentNotifyAvailable({
      hasParent,
      allowParentNotify: binding.allowParentNotify,
      configEnabled: parentNotifyConfigEnabled,
      toolPolicyEnabled: active,
    });
    const available = active && conditionAvailable;
    const state: NonNullable<AgentCapabilitiesResponse['tools']>[number]['state'] = available ? 'unknown' : 'disabled';
    const toolUnavailableReason = !active ? 'Disabled by effective tool policy'
      : !conditionAvailable ? 'Tool activation condition is not satisfied' : unavailableReason;
    const toolUnavailableReasonCode = !active ? 'tool_policy_disabled'
      : !conditionAvailable ? 'activation_condition_unmet' : unavailableReasonCode;
    return {
      name: options.name,
      source: options.source ?? 'builtin',
      category: options.domain ?? 'other',
      group: toolGroupForName(options.name),
      state,
      unavailable_reason: toolUnavailableReason,
      unavailable_reason_code: toolUnavailableReasonCode,
      read_only: binding.executionRestriction === 'research-readonly' || READ_ONLY_DISPLAY_TOOL_NAMES.has(options.name)
        ? true : undefined,
    };
  });
  return {
    profile: panelProfile(session, binding, resolution),
    tools: tools.toSorted((a, b) => a.name.localeCompare(b.name)),
    skills: panelSkills(skills.catalog.listSkills(), isToolActiveComposed(policy, 'Skill')).map((skill) => ({
      ...skill,
      state: skill.state === 'enabled' ? 'unknown' : skill.state,
      unavailable_reason: skill.unavailable_reason ?? unavailableReason,
      unavailable_reason_code: skill.unavailable_reason_code ?? unavailableReasonCode,
    })),
  };
}

export async function livePanelCapabilities(agent: IAgentScopeHandle): Promise<Pick<AgentCapabilitiesResponse, 'profile' | 'tools' | 'skills'>> {
  const data = agent.accessor.get(IAgentProfileService).data();
  const catalog = agent.accessor.get(ISessionAgentProfileCatalog);
  await catalog.ready;
  const frozen = agent.accessor.get(ISubagentTool).dispatchCatalog().snapshot;
  const resolution = resolvePanelProfile(catalog, data.profileName, data.profileDefinitionId, {
    frozen,
    bound: data.boundProfile,
  });
  const registry = agent.accessor.get(IAgentToolRegistryService).list();
  const policy = agent.accessor.get(IAgentToolPolicyService);
  const contributions = agent.accessor.get(IAgentToolActivationService).capabilities();
  const tools = new Map<string, NonNullable<AgentCapabilitiesResponse['tools']>[number]>();
  for (const contribution of contributions) {
    const active = policy.isToolActive(contribution.name, contribution.source);
    const unavailableReason = !active ? 'Disabled by effective tool policy'
      : !contribution.runtimeAvailable ? 'Required runtime capability is not connected'
        : !contribution.conditionAvailable ? 'Tool activation condition is not satisfied' : undefined;
    const unavailableReasonCode = !active ? 'tool_policy_disabled'
      : !contribution.runtimeAvailable ? 'runtime_not_connected'
        : !contribution.conditionAvailable ? 'activation_condition_unmet' : undefined;
    tools.set(contribution.name, {
      name: contribution.name, source: contribution.source, category: contribution.category,
      group: contribution.group,
      state: !active ? 'disabled' : !contribution.runtimeAvailable ? 'disconnected'
        : !contribution.conditionAvailable ? 'disabled' : 'enabled',
      unavailable_reason: unavailableReason,
      unavailable_reason_code: unavailableReasonCode,
    });
  }
  for (const tool of registry) {
    const previous = tools.get(tool.name);
    const active = policy.isToolActive(tool.name, tool.source);
    tools.set(tool.name, {
      name: tool.name, description: tool.description, source: tool.source,
      category: previous?.category ?? tool.source,
      group: previous?.group ?? toolGroupForName(tool.name),
      state: active ? previous?.state ?? 'enabled' : 'disabled',
      unavailable_reason: active ? previous?.unavailable_reason : 'Disabled by effective tool policy',
      unavailable_reason_code: active ? previous?.unavailable_reason_code : 'tool_policy_disabled',
      parameters: tool.parameters,
      read_only: (data.executionRestriction === 'research-readonly' || READ_ONLY_DISPLAY_TOOL_NAMES.has(tool.name)) ? true : undefined,
    });
  }
  for (const interaction of agent.accessor.get(ISessionInteractionService).listPending('approval', { agentId: agent.id })) {
    const payload = interaction.payload;
    if (typeof payload !== 'object' || payload === null || !('toolName' in payload) || typeof payload.toolName !== 'string') continue;
    const tool = tools.get(payload.toolName);
    if (tool?.state === 'enabled') tools.set(tool.name, { ...tool, state: 'approval-required',
      unavailable_reason: 'An invocation of this tool is waiting for approval',
      unavailable_reason_code: 'approval_pending' });
  }
  const skills = agent.accessor.get(ISessionSkillCatalog);
  await skills.ready;
  return {
    profile: panelProfile(agent, data, resolution),
    tools: [...tools.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
    skills: panelSkills(skills.catalog.listSkills(), policy.isToolActive('Skill')),
  };
}

function panelProfile(
  scope: Pick<Scope, 'accessor'>,
  data: PanelBindingData,
  resolution: PanelProfileResolution,
): AgentPanelProfile {
  const definition = resolution.profile ?? data.boundProfile;
  const routeDetached = data.routeDetached === true || inferRouteDetached(scope, data) ? true : undefined;
  const thinkingEffort = data.effectiveThinkingLevel ?? data.thinkingLevel;
  return {
    name: data.profileName ?? definition?.name ?? 'unknown',
    description: definition?.description,
    source: resolution.sourceId,
    source_file: definition?.sourcePath,
    definition_id: data.profileDefinitionId ?? definition?.definitionId,
    route: data.routeId,
    model: data.modelAlias,
    model_source: data.modelAlias === undefined ? undefined
      : data.appliedLease?.modelAlias !== undefined ? 'caller-lease'
        : data.lockedModelAlias !== undefined && routeDetached !== true ? 'route' : 'profile',
    thinking_effort: thinkingEffort,
    effort_source: panelEffortSource(scope, data, definition, thinkingEffort, routeDetached),
    thinking_effort_source: data.thinkingEffortSource,
    route_detached: routeDetached,
    profile_source: data.profileSource,
    executor: data.executorId,
    service_tier: data.serviceTier ?? definition?.serviceTier,
    tools: data.activeToolNames === undefined ? undefined : [...data.activeToolNames],
    disallowed_tools: data.disallowedTools === undefined ? undefined : [...data.disallowedTools],
    disabled_tool_groups: data.disabledToolGroups === undefined ? undefined : [...data.disabledToolGroups],
    subagent_policy: data.subagentPolicy ?? definition?.subagentPolicy ?? 'advisory',
    execution_restriction: data.executionRestriction,
    locked_model: data.lockedModelAlias,
    locked_effort: data.lockedThinkingEffort,
    tool_allow_policies: data.toolAllowPolicies?.map((entry) => [...entry]),
    spawn_constraints: data.spawnPolicy === undefined ? undefined : {
      allowed_models: data.spawnPolicy.allowedModels === undefined ? undefined : [...data.spawnPolicy.allowedModels],
      deny_models: data.spawnPolicy.denyModels === undefined ? undefined : [...data.spawnPolicy.denyModels],
      allowed_efforts: data.spawnPolicy.allowedEfforts === undefined ? undefined : [...data.spawnPolicy.allowedEfforts],
      disallowed_tools: data.spawnPolicy.disallowedTools === undefined ? undefined : [...data.spawnPolicy.disallowedTools],
    },
  };
}

function panelEffortSource(
  scope: Pick<Scope, 'accessor'>,
  data: PanelBindingData,
  definition: PanelProfileDefinition | undefined,
  effort: string | undefined,
  routeDetached: boolean | undefined,
): AgentPanelProfile['effort_source'] {
  if (effort === undefined) return undefined;
  if (data.appliedLease?.thinkingEffort !== undefined) return 'caller-lease';
  if (data.lockedThinkingEffort !== undefined && routeDetached !== true) return 'route';
  if (definition !== undefined && data.modelAlias !== undefined) {
    const constraints = roleConstraintsFromProfile(
      definition,
      spawnConstraintOrigin(data.appliedLease, data.spawnPolicy),
    );
    if (resolveRoleThinkingDefault(constraints, data.modelAlias, scope.accessor.get(IModelService)) !== undefined) {
      return 'model-profile';
    }
  }
  if (definition?.thinkingEffort !== undefined) return 'profile';
  if (data.executorId !== undefined && data.executorId !== 'native') return 'executor';
  const thinking = scope.accessor.get(IConfigService).get<ThinkingConfig>('thinking');
  if (data.modelAlias !== undefined) {
    try {
      const modelId = scope.accessor.get(IModelService).resolveId(data.modelAlias) ?? data.modelAlias;
      const model = scope.accessor.get(IModelCatalog).get(modelId);
      if (model.overrides?.defaultEffort !== undefined) return 'model';
    } catch {}
  }
  return thinking?.effort !== undefined || thinking?.enabled !== undefined ? 'config' : 'model';
}

function inferRouteDetached(scope: Pick<Scope, 'accessor'>, data: PanelBindingData): boolean {
  if (data.routeId === undefined) return false;
  const modelDetached = data.lockedModelAlias !== undefined && data.modelAlias !== undefined
    && modelIdentity(scope, data.lockedModelAlias) !== modelIdentity(scope, data.modelAlias);
  const effectiveThinking = data.effectiveThinkingLevel ?? data.thinkingLevel;
  const effortDetached = data.lockedThinkingEffort !== undefined && effectiveThinking !== undefined
    && normalizedEffort(data.lockedThinkingEffort) !== normalizedEffort(effectiveThinking);
  return modelDetached || effortDetached;
}

function modelIdentity(scope: Pick<Scope, 'accessor'>, alias: string): string {
  try {
    return scope.accessor.get(IModelService).resolveId(alias) ?? alias;
  } catch {
    return alias;
  }
}

function normalizedEffort(effort: string): string {
  return effort.trim().toLowerCase();
}
