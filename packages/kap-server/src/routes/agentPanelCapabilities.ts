import type { AgentBindingAdvisory, AgentCapabilitiesProducerResponse, AgentPanelProfile } from '@kiki/protocol';
import {
  IAgentProfileService,
  IAgentToolRegistryService,
  IAgentToolPolicyService,
  IConfigService,
  IModelCatalog,
  IModelService,
  IPluginHostService,
  IPluginUsageService,
  ISubagentTool,
  ISessionAgentProfileCatalog,
  ISessionContext,
  ISessionToolPolicy,
  type IAgentScopeHandle,
  type PluginToolRegistration,
  type ProfileData,
  type Scope,
} from '@kiki/agent-core-v2';
import { spawnConstraintOrigin } from '@kiki/agent-core-v2/app/agentProfileCatalog/applySubagentLease';
import type { SkillDefinition } from '@kiki/agent-core-v2/app/skillCatalog/types';
import { IAgentToolActivationService } from '@kiki/agent-core-v2/agent/toolActivation/toolActivation';
import { IAgentMcpService } from '@kiki/agent-core-v2/agent/mcp/mcp';
import { qualifyMcpToolName } from '@kiki/agent-core-v2/mcpCore/tool-naming';
import { IAgentToolSelectService } from '@kiki/agent-core-v2/agent/toolSelect/toolSelect';
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
import { SUBAGENT_SECTION, type SubagentConfig } from '@kiki/agent-core-v2/session/subagent/configSection';
import {
  resolveBoundPanelProfile,
  type PanelProfileDefinition,
  type PanelProfileResolution,
} from './agentPanelProfileResolution';
import type { PersistedAgentProfileSnapshot } from './agentProfileSnapshot';
import { projectPersistedAgentThinking } from './agentProfileThinking';
import { projectAgentModelMenu } from './agentModelMenu';

type BindingAdvisory = NonNullable<ProfileData['bindingAdvisories']>[number];

type PanelBindingData = Partial<Pick<ProfileData,
  'modelAlias' | 'profileName' | 'profileDefinitionId' | 'routeId' |
  'lockedModelAlias' | 'lockedThinkingEffort' | 'thinkingLevel' |
  'effectiveThinkingLevel' | 'thinkingEffortSource' | 'thinkingEffortExplicit' | 'routeDetached' |
  'profileSource' | 'bindingAdvisories' | 'executorId' | 'serviceTier' | 'activeToolNames' |
  'toolAllowPolicies' | 'disallowedTools' | 'disabledToolGroups' |
  'canSpawnSubagents' | 'allowedSubagents' | 'preferredSubagents' | 'denySubagents' | 'executionRestriction' |
  'allowParentNotify' | 'spawnPolicy' | 'appliedLease' |
  'boundProfile'>> & { readonly thinkingEffortAdjusted?: boolean };

export function panelSkills(
  skills: readonly SkillDefinition[],
  toolActive: boolean,
): NonNullable<AgentCapabilitiesProducerResponse['skills']> {
  return skills.map((skill) => {
    const unavailableReason = !toolActive ? 'Skill tool is not active for this agent'
      : skill.metadata.disableModelInvocation === true ? 'Model invocation is disabled for this skill' : undefined;
    const unavailableReasonCode = !toolActive ? 'skill_tool_inactive'
      : skill.metadata.disableModelInvocation === true ? 'skill_model_invocation_disabled' : undefined;
    return {
      name: skill.name,
      description: skill.description,
      source: skill.source,
      source_kind: skill.plugin === undefined ? skill.source : 'plugin',
      source_root: skill.sourceRoot,
      scope: skill.source === 'project' ? 'workspace' : 'global',
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
): Promise<Pick<AgentCapabilitiesProducerResponse, 'profile' | 'tools' | 'skills'>> {
  const definition = resolution.profile;
  const persisted = snapshot.source === 'wire';
  const activeToolNames = snapshot.activeToolsKnown ? snapshot.activeToolNames : definition.tools;
  const profileToolSource = snapshot.boundProfile ?? definition;
  const explicitProfileTools = profileToolSource.tools === undefined ? undefined : [...profileToolSource.tools];
  const binding: PanelBindingData = {
    ...snapshot,
    ...projectPersistedAgentThinking(session, snapshot, definition),
    activeToolNames,
    toolAllowPolicies: persisted ? snapshot.toolAllowPolicies : snapshot.toolAllowPolicies ?? definition.toolAllowPolicies,
    disallowedTools: persisted ? snapshot.disallowedTools : snapshot.disallowedTools ?? definition.disallowedTools,
    disabledToolGroups: persisted ? snapshot.disabledToolGroups : snapshot.disabledToolGroups ?? definition.disabledToolGroups,
    allowParentNotify: persisted ? snapshot.allowParentNotify : snapshot.allowParentNotify ?? definition.allowParentNotify,
    canSpawnSubagents: persisted ? snapshot.canSpawnSubagents : snapshot.canSpawnSubagents ?? definition.canSpawnSubagents,
    allowedSubagents: persisted ? snapshot.allowedSubagents : snapshot.allowedSubagents ?? definition.allowedSubagents,
    preferredSubagents: persisted ? snapshot.preferredSubagents : snapshot.preferredSubagents ?? definition.preferredSubagents,
    denySubagents: persisted ? snapshot.denySubagents : snapshot.denySubagents ?? definition.denySubagents,
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
    subagent: hasParent ? {
      allowedTools: config.get<SubagentConfig>(SUBAGENT_SECTION)?.allowedTools,
      explicitProfileTools,
    } : undefined,
  };
  const parentNotifyConfigEnabled = isParentNotifyEnabled(
    config.get<AgentsConfig>(AGENTS_SECTION),
  );
  const unavailableReason = 'Snapshot inventory only; agent runtime and invocation approval are unavailable';
  const unavailableReasonCode = 'snapshot_inventory_only';
  const tools: NonNullable<AgentCapabilitiesProducerResponse['tools']> = getAgentToolContributions().map(({ options }) => {
    const source = options.source ?? 'builtin';
    const active = isToolActiveComposed(policy, options.name, source);
    const conditionAvailable = options.name !== 'AgentNotify' || isAgentNotifyAvailable({
      hasParent,
      allowParentNotify: binding.allowParentNotify,
      configEnabled: parentNotifyConfigEnabled,
      toolPolicyEnabled: active,
    });
    const available = active && conditionAvailable;
    const state: NonNullable<AgentCapabilitiesProducerResponse['tools']>[number]['state'] = available ? 'unknown' : 'disabled';
    const toolUnavailableReason = !active ? 'Disabled by effective tool policy'
      : !conditionAvailable ? 'Tool activation condition is not satisfied' : unavailableReason;
    const toolUnavailableReasonCode = !active ? 'tool_policy_disabled'
      : !conditionAvailable ? 'activation_condition_unmet' : unavailableReasonCode;
    return {
      name: options.name,
      source,
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
    profile: panelProfile(session, binding, resolution, hasParent ? 'sub' : 'main'),
    tools: tools.toSorted((a, b) => a.name.localeCompare(b.name)),
    skills: panelSkills(skills.catalog.listSkills(), isToolActiveComposed(policy, 'Skill')).map((skill) => ({
      ...skill,
      state: skill.state === 'enabled' ? 'unknown' : skill.state,
      unavailable_reason: skill.unavailable_reason ?? unavailableReason,
      unavailable_reason_code: skill.unavailable_reason_code ?? unavailableReasonCode,
    })),
  };
}

export async function livePanelCapabilities(agent: IAgentScopeHandle): Promise<Pick<AgentCapabilitiesProducerResponse, 'profile' | 'tools' | 'skills'>> {
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
  const toolSelect = agent.accessor.get(IAgentToolSelectService);
  const requestTools = safeShapeTools(toolSelect, registry);
  const requestToolNames = new Set(requestTools?.map((tool) => tool.name) ?? []);
  const loadableNames = safeLoadableNames(toolSelect);
  const contributions = agent.accessor.get(IAgentToolActivationService).capabilities();
  const contributionByName = new Map(contributions.map((contribution) => [contribution.name, contribution]));
  const mcp = agent.accessor.get(IAgentMcpService);
  const connectedMcpTools = new Set(mcp.list().filter((server) => server.status === 'connected').flatMap((server) =>
    (mcp.resolved(server.name)?.tools ?? []).map((tool) => qualifyMcpToolName(server.name, tool.name))));
  const pluginHost = agent.accessor.get(IPluginHostService);
  const pluginUsage = agent.accessor.get(IPluginUsageService);
  const sessionContext = agent.accessor.get(ISessionContext);
  let pluginCatalogFailed = false;
  let pluginDefinitions: readonly PluginToolRegistration[] = [];
  try { pluginDefinitions = await pluginHost.list(); } catch { pluginCatalogFailed = true; }
  const pluginUsageStates = new Map<string, 'allowed' | 'disabled' | 'unavailable'>();
  for (const pluginId of new Set(pluginDefinitions.map((entry) => entry.pluginId))) {
    try {
      if (!pluginUsage.enabled()) {
        pluginUsageStates.set(pluginId, 'allowed');
        continue;
      }
      const allowed = await pluginUsage.allows(sessionContext.workspaceId, pluginId, sessionContext.sessionId);
      pluginUsageStates.set(pluginId, allowed ? 'allowed' : 'disabled');
    } catch {
      pluginUsageStates.set(pluginId, 'unavailable');
    }
  }
  const pluginByToolName = new Map(pluginDefinitions.map((entry) => [pluginToolName(entry.pluginId, entry.definition.name), entry]));
  const tools = new Map<string, NonNullable<AgentCapabilitiesProducerResponse['tools']>[number]>();
  for (const contribution of contributions) {
    const policyAllowed = policy.isToolActive(contribution.name, contribution.source);
    const plugin = pluginByToolName.get(contribution.name);
    const usageState = plugin === undefined
      ? contribution.source === 'plugin' && pluginCatalogFailed ? 'catalog-failed' : 'allowed'
      : pluginUsageStates.get(plugin.pluginId) ?? (pluginCatalogFailed ? 'catalog-failed' : 'allowed');
    const registered = registry.some((tool) => tool.name === contribution.name);
    const availability = panelToolAvailability({
      policyAllowed,
      runtimeAvailable: contribution.runtimeAvailable,
      conditionAvailable: contribution.conditionAvailable,
      registered,
      usageState,
    });
    tools.set(contribution.name, {
      name: contribution.name, source: contribution.source, category: contribution.category,
      group: contribution.group,
      policy_allowed: policyAllowed,
      request_state: panelRequestState({
        policyAllowed,
        registered,
        currentRequest: requestToolNames.has(contribution.name),
        loadable: loadableNames.has(contribution.name),
        usable: availability.state === 'enabled' || availability.state === 'approval-required',
        requestShapeReady: requestTools !== undefined,
      }),
      state: availability.state,
      unavailable_reason: availability.reason,
      unavailable_reason_code: availability.reasonCode,
    });
  }
  for (const tool of registry) {
    const previous = tools.get(tool.name);
    const contribution = contributionByName.get(tool.name);
    const policyAllowed = policy.isToolActive(tool.name, tool.source);
    const plugin = pluginByToolName.get(tool.name);
    const usageState = plugin === undefined
      ? tool.source === 'plugin' && pluginCatalogFailed ? 'catalog-failed' : 'allowed'
      : pluginUsageStates.get(plugin.pluginId) ?? (pluginCatalogFailed ? 'catalog-failed' : 'allowed');
    const availability = panelToolAvailability({
      policyAllowed,
      runtimeAvailable: tool.source === 'mcp' ? connectedMcpTools.has(tool.name) : contribution?.runtimeAvailable ?? true,
      conditionAvailable: contribution?.conditionAvailable ?? true,
      registered: true,
      usageState,
    });
    tools.set(tool.name, {
      name: tool.name, description: tool.description, source: tool.source,
      category: previous?.category ?? tool.source,
      group: previous?.group ?? toolGroupForName(tool.name),
      policy_allowed: policyAllowed,
      request_state: panelRequestState({
        policyAllowed,
        registered: true,
        currentRequest: requestToolNames.has(tool.name),
        loadable: loadableNames.has(tool.name),
        usable: availability.state === 'enabled' || availability.state === 'approval-required',
        requestShapeReady: requestTools !== undefined,
      }),
      state: availability.state,
      unavailable_reason: availability.reason,
      unavailable_reason_code: availability.reasonCode,
      parameters: tool.parameters,
      read_only: (data.executionRestriction === 'research-readonly' || READ_ONLY_DISPLAY_TOOL_NAMES.has(tool.name)) ? true : undefined,
    });
  }
  for (const entry of pluginDefinitions) {
    const name = pluginToolName(entry.pluginId, entry.definition.name);
    if (tools.has(name)) continue;
    const policyAllowed = policy.isToolActive(name, 'plugin');
    const usageState = pluginUsageStates.get(entry.pluginId) ?? (pluginCatalogFailed ? 'unavailable' : 'allowed');
    const availability = panelToolAvailability({
      policyAllowed,
      runtimeAvailable: true,
      conditionAvailable: true,
      registered: false,
      usageState,
    });
    tools.set(name, {
      name,
      description: entry.definition.description,
      source: 'plugin',
      category: 'plugin',
      group: toolGroupForName(name),
      policy_allowed: policyAllowed,
      request_state: panelRequestState({
        policyAllowed,
        registered: false,
        currentRequest: false,
        loadable: false,
        usable: false,
        requestShapeReady: requestTools !== undefined,
      }),
      state: availability.state,
      unavailable_reason: availability.reason,
      unavailable_reason_code: availability.reasonCode,
      parameters: entry.definition.parameters,
      read_only: data.executionRestriction === 'research-readonly' ? true : undefined,
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
    profile: panelProfile(agent, data, resolution, agent.id === 'main' ? 'main' : 'sub'),
    tools: [...tools.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
    skills: panelSkills(skills.catalog.listSkills(), policy.isToolActive('Skill')),
  };
}

export function pluginToolName(pluginId: string, name: string): string {
  return `plugin__${pluginId.replaceAll('-', '_')}__${name}`;
}

type RegisteredToolInfo = ReturnType<IAgentToolRegistryService['list']>[number];

function safeShapeTools(
  toolSelect: IAgentToolSelectService,
  entries: readonly RegisteredToolInfo[],
): readonly RegisteredToolInfo[] | undefined {
  try { return toolSelect.shapeTools(entries); } catch { return undefined; }
}

function safeLoadableNames(toolSelect: IAgentToolSelectService | undefined): ReadonlySet<string> {
  if (toolSelect === undefined) return new Set();
  try { return toolSelect.loadableNames(); } catch { return new Set(); }
}

export function panelRequestState(input: {
  readonly policyAllowed: boolean;
  readonly registered: boolean;
  readonly currentRequest: boolean;
  readonly loadable: boolean;
  readonly usable: boolean;
  readonly requestShapeReady: boolean;
}): 'available' | 'loadable' | 'unavailable' {
  if (!input.policyAllowed || !input.registered || !input.usable || !input.requestShapeReady) return 'unavailable';
  if (input.currentRequest) return 'available';
  if (input.loadable) return 'loadable';
  return 'unavailable';
}

export function panelToolAvailability(input: {
  readonly policyAllowed: boolean;
  readonly runtimeAvailable: boolean;
  readonly conditionAvailable: boolean;
  readonly registered: boolean;
  readonly usageState: 'allowed' | 'disabled' | 'unavailable' | 'catalog-failed';
}): {
  readonly state: NonNullable<AgentCapabilitiesProducerResponse['tools']>[number]['state'];
  readonly reason?: string;
  readonly reasonCode?: NonNullable<AgentCapabilitiesProducerResponse['tools']>[number]['unavailable_reason_code'];
} {
  if (!input.policyAllowed) return { state: 'disabled', reason: 'Disabled by effective tool policy', reasonCode: 'tool_policy_disabled' };
  if (input.usageState === 'disabled') return { state: 'disabled', reason: 'This plugin is not enabled for the current session or workspace', reasonCode: 'plugin_usage_disabled' };
  if (input.usageState === 'unavailable') return { state: 'unknown', reason: 'The plugin session usage could not be checked', reasonCode: 'plugin_usage_unavailable' };
  if (input.usageState === 'catalog-failed') return { state: 'unknown', reason: 'The installed plugin tool manifest could not be loaded', reasonCode: 'plugin_catalog_failed' };
  if (!input.runtimeAvailable) return { state: 'disconnected', reason: 'Required runtime capability is not connected', reasonCode: 'runtime_not_connected' };
  if (!input.conditionAvailable) return { state: 'disabled', reason: 'Tool activation condition is not satisfied', reasonCode: 'activation_condition_unmet' };
  if (!input.registered) return { state: 'unknown', reason: 'This tool is allowed by the current policy, but its executable schema is not registered yet', reasonCode: 'tool_not_registered' };
  return { state: 'enabled' };
}

export function frozenPanelModelProfile(
  scope: Pick<Scope, 'accessor'>,
  data: PanelBindingData,
  position: 'main' | 'sub',
): AgentPanelProfile {
  const profile = data.boundProfile ?? {
    name: data.profileName ?? 'unknown',
    modelAlias: data.modelAlias,
    executor: data.executorId,
    restrictModelsToMenu: false,
  };
  return {
    name: data.profileName ?? profile.name,
    model: data.modelAlias,
    executor: data.executorId ?? profile.executor,
    definition_id: data.profileDefinitionId,
    ...projectAgentModelMenu(scope, profile, position, true),
  };
}

function panelProfile(
  scope: Pick<Scope, 'accessor'>,
  data: PanelBindingData,
  resolution: PanelProfileResolution,
  position: 'main' | 'sub',
): AgentPanelProfile {
  const definition = resolution.profile ?? data.boundProfile;
  const caller = {
    canSpawnSubagents: data.canSpawnSubagents,
    allowedSubagents: data.allowedSubagents,
    preferredSubagents: data.preferredSubagents,
    denySubagents: data.denySubagents,
  };
  const routeDetached = data.routeDetached === true || inferRouteDetached(scope, data) ? true : undefined;
  const thinkingEffort = data.effectiveThinkingLevel ?? data.thinkingLevel;
  return {
    ...frozenPanelModelProfile(scope, data, position),
    name: data.profileName ?? definition?.name ?? 'unknown',
    description: definition?.description,
    source: resolution.sourceId,
    source_file: definition?.sourcePath,
    definition_id: data.profileDefinitionId ?? definition?.definitionId,
    route: data.routeId,
    model_source: data.modelAlias === undefined ? undefined
      : data.appliedLease?.modelAlias !== undefined ? 'caller-lease'
        : data.lockedModelAlias !== undefined && routeDetached !== true ? 'route' : 'profile',
    thinking_effort: thinkingEffort,
    thinking_effort_explicit: data.thinkingEffortExplicit,
    effort_source: panelEffortSource(scope, data, definition, thinkingEffort, routeDetached),
    thinking_effort_source: data.thinkingEffortSource,
    route_detached: routeDetached,
    profile_source: data.profileSource,
    binding_advisories: projectBindingAdvisories(data.bindingAdvisories),
    executor: data.executorId,
    service_tier: data.serviceTier ?? definition?.serviceTier,
    tools: data.activeToolNames === undefined ? undefined : [...data.activeToolNames],
    disallowed_tools: data.disallowedTools === undefined ? undefined : [...data.disallowedTools],
    disabled_tool_groups: data.disabledToolGroups === undefined ? undefined : [...data.disabledToolGroups],
    can_spawn_subagents: caller.canSpawnSubagents,
    allowed_subagents: caller.allowedSubagents === undefined ? undefined : [...caller.allowedSubagents],
    preferred_subagents: caller.preferredSubagents === undefined ? undefined : [...caller.preferredSubagents],
    deny_subagents: caller.denySubagents === undefined ? undefined : [...caller.denySubagents],
    execution_restriction: data.executionRestriction,
    locked_model: data.lockedModelAlias,
    locked_effort: data.lockedThinkingEffort,
    tool_allow_policies: data.toolAllowPolicies?.map((entry) => [...entry]),
    spawn_constraints: data.spawnPolicy === undefined ? undefined : {
      allowed_models: data.spawnPolicy.allowedModels === undefined ? undefined : [...data.spawnPolicy.allowedModels],
      deny_models: data.spawnPolicy.denyModels === undefined ? undefined : [...data.spawnPolicy.denyModels],
      allowed_efforts: data.spawnPolicy.allowedEfforts === undefined ? undefined : [...data.spawnPolicy.allowedEfforts],
      preferred_models: data.spawnPolicy.preferredModels === undefined ? undefined : [...data.spawnPolicy.preferredModels],
      discouraged_models: data.spawnPolicy.discouragedModels === undefined ? undefined : [...data.spawnPolicy.discouragedModels],
      preferred_efforts: data.spawnPolicy.preferredEfforts === undefined ? undefined : [...data.spawnPolicy.preferredEfforts],
      disallowed_tools: data.spawnPolicy.disallowedTools === undefined ? undefined : [...data.spawnPolicy.disallowedTools],
    },
  };
}

export function projectBindingAdvisories(
  advisories: readonly BindingAdvisory[] | undefined,
): AgentBindingAdvisory[] | undefined {
  if (advisories === undefined || advisories.length === 0) return undefined;
  return advisories.map((advisory) => ({
    version: advisory.version,
    code: advisory.code,
    dimension: advisory.dimension,
    rule_source: advisory.ruleSource,
    rule_value: advisory.ruleValue,
    rule_values: advisory.ruleValues === undefined ? undefined : [...advisory.ruleValues],
    requested_value: advisory.requestedValue,
    effective_value: advisory.effectiveValue,
    value_source: advisory.valueSource,
    model: advisory.model,
    message: advisory.message,
  }));
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
