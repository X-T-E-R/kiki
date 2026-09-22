import {
  IAgentExecutorRegistry,
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentStateService,
  IAgentToolPolicyService,
  IConfigService,
  IInstantiationService,
  IModelCatalog,
  IModelService,
  IProtocolAdapterRegistry,
  ISessionAgentProfileCatalog,
  ISessionAgentProfileCatalogSeed,
  ISessionContext,
  ISessionIndex,
  ISessionManager,
  ISessionMetadata,
  ISubagentTool,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  ServiceCollection,
  SessionAgentProfileCatalogService,
  type Scope,
} from '@kiki/agent-core-v2';
import { projectSubagentCapabilities, type SubagentCapabilityCatalog } from '@kiki/agent-core-v2/agent/tools/agent/subagentCapabilities';
import { isToolActiveComposed, type GlobalToolsPolicy } from '@kiki/agent-core-v2/agent/toolPolicy/evaluate';
import { ISessionDispatchService } from '@kiki/agent-core-v2/session/dispatch/dispatch';
import { evaluateDispatchAdmission } from '@kiki/agent-core-v2/session/dispatch/launchPolicy';
import { subagentParentAgentId } from '@kiki/agent-core-v2/session/agentLifecycle/subagentMetadata';
import type { AgentCapabilitiesQuery, AgentCapabilitiesProducerResponse, AgentPanelMetrics } from '@kiki/protocol';
import {
  livePanelCapabilities,
  panelSkills,
  projectBindingAdvisories,
  READ_ONLY_DISPLAY_TOOL_NAMES,
  resolvePanelProfile,
  snapshotPanelCapabilities,
} from './agentPanelCapabilities';
import { readAgentPanelMetrics, readPersistedAgentPanelMetrics } from './agentPanelMetrics';
import { readPersistedAgentProfileSnapshot } from './agentProfileSnapshot';
import { IModelPricingService } from '../pricing/modelPricingService';
import { getAgentToolContributions } from '@kiki/agent-core-v2/agent/toolRegistry/toolContribution';
import { toolGroupForName } from '@kiki/agent-core-v2/agent/toolRegistry/toolGroups';
import { panelAccountingKey } from '@kiki/agent-core-v2/agent/usage/panelAccounting';

export async function acquireWorkspaceProfileCatalog(
  core: Scope,
  query: { workspace_id?: string; cwd?: string },
) {
  if (query.workspace_id !== undefined && await core.accessor.get(IWorkspaceService).get(query.workspace_id) === undefined) return undefined;
  const lease = await core.accessor.get(IWorkspaceInstanceManager).acquire(
    query.workspace_id !== undefined ? { workspaceId: query.workspace_id } : { root: query.cwd! },
  );
  let disposeCatalog: (() => void) | undefined;
  try {
    await lease.instance.program.ready;
    const workspaceId = lease.instance.id;
    const container = core.accessor.get(IInstantiationService).createChild(new ServiceCollection([
      ISessionAgentProfileCatalogSeed,
      { _serviceBrand: undefined, workspaceKey: workspaceId },
    ]));
    disposeCatalog = () => container.dispose();
    const catalog = container.createInstance(SessionAgentProfileCatalogService);
    disposeCatalog = () => { catalog.dispose(); container.dispose(); };
    await catalog.ready;
    return { workspaceId, catalog, skills: lease.instance.program.skills.catalog,
      dispose: () => { disposeCatalog?.(); lease.dispose(); } };
  } catch (error) {
    disposeCatalog?.();
    lease.dispose();
    throw error;
  }
}

export async function agentCapabilities(
  core: Scope,
  query: AgentCapabilitiesQuery,
  signal?: AbortSignal,
): Promise<AgentCapabilitiesProducerResponse | 'workspace-not-found' | 'profile-not-found'> {
  if ('session_id' in query) {
    const session = core.accessor.get(ISessionManager).get(query.session_id);
    const workspaceId = session?.accessor.get(ISessionContext).workspaceId
      ?? (await core.accessor.get(ISessionIndex).get(query.session_id))?.workspaceId;
    const lifecycle = session?.accessor.get(IAgentLifecycleService);
    const agent = lifecycle?.get(query.agent_id);
    const pricing = core.accessor.get(IModelPricingService);
    const skipAgentIds: string[] = [];
    const mutableAgentIds: string[] = [];
    for (const handle of lifecycle?.list() ?? []) {
      const accounting = handle.accessor.get(IAgentStateService).get(panelAccountingKey);
      if (accounting.incomplete) mutableAgentIds.push(handle.id);
      else skipAgentIds.push(handle.id);
    }
    const persisted = workspaceId === undefined ? {} : await readPersistedAgentPanelMetrics(
      core,
      workspaceId,
      query.session_id,
      pricing,
      {
        signal,
        agentIds: query.agent_id === 'main' ? undefined : [query.agent_id],
        skipAgentIds,
        mutableAgentIds,
      },
    );
    if (agent === undefined) {
      if (session === undefined || workspaceId === undefined) return {
        context: 'live', live: false, owner: { agent_id: query.agent_id }, available: false,
        unavailable_reason: 'Session or agent is not live; dispatch capabilities are unavailable',
        unavailable_reason_code: 'session_or_agent_not_live', targets: [],
        metrics: persisted,
      };
      const metadata = (await session.accessor.get(ISessionMetadata).read()).agents?.[query.agent_id];
      const snapshot = await readPersistedAgentProfileSnapshot(
        core,
        workspaceId,
        query.session_id,
        query.agent_id,
        metadata,
        signal,
      );
      if (snapshot === undefined) return {
        context: 'live', live: false, owner: { agent_id: query.agent_id }, available: false,
        unavailable_reason: 'Persisted agent capability metadata is unavailable',
        unavailable_reason_code: 'persisted_metadata_unavailable', targets: [],
        metrics: persisted,
      };
      const catalog = session.accessor.get(ISessionAgentProfileCatalog);
      await catalog.ready;
      const resolution = resolvePanelProfile(catalog, snapshot.profileName, snapshot.profileDefinitionId, {
        bound: snapshot.boundProfile,
      });
      if (resolution.profile === undefined) return {
        context: 'live', live: false,
        owner: { profile: snapshot.profileName, agent_id: query.agent_id },
        available: false,
        unavailable_reason: 'Persisted agent profile is unavailable in the live session catalog',
        unavailable_reason_code: 'persisted_profile_unavailable',
        targets: [],
        metrics: persisted,
      };
      const panel = await snapshotPanelCapabilities(session, snapshot, {
        profile: resolution.profile,
        sourceId: resolution.sourceId,
      }, subagentParentAgentId(metadata) !== undefined);
      const persistedBinding = snapshot.source === 'wire';
      const input: SubagentCapabilityCatalog = {
        catalog,
        caller: {
          profileName: snapshot.profileName ?? resolution.profile.name,
          profileDefinitionId: snapshot.profileDefinitionId ?? resolution.profile.definitionId,
          subagentPolicy: persistedBinding ? snapshot.subagentPolicy
            : snapshot.subagentPolicy ?? resolution.profile.subagentPolicy,
          subagentDeclaration: persistedBinding ? snapshot.subagentDeclaration
            : snapshot.subagentDeclaration ?? resolution.profile.subagentDeclaration,
          subagents: persistedBinding ? snapshot.subagents
            : snapshot.subagents ?? resolution.profile.subagents,
          subagentLeases: persistedBinding ? snapshot.subagentLeases
            : snapshot.subagentLeases ?? resolution.profile.subagentLeases,
          spawnPolicy: persistedBinding ? snapshot.spawnPolicy
            : snapshot.spawnPolicy ?? resolution.profile.spawnConstraints,
        },
        profiles: catalog.list().filter((candidate) => candidate.main !== true),
        routes: catalog.listRoutes(),
        snapshot: catalog.snapshot?.(),
      };
      return {
        context: 'live',
        live: false,
        owner: { profile: snapshot.profileName ?? resolution.profile.name, agent_id: query.agent_id },
        available: true,
        targets: project(session, input).map((target) => ({
          ...target,
          launch_allowed: false,
          launch_unavailable_reason: 'Agent is not live; snapshot capabilities cannot launch subagents',
          launch_unavailable_reason_code: 'snapshot_launch_unavailable',
        })),
        ...panel,
        metrics: persisted,
      };
    }
    const owner = { profile: agent.accessor.get(IAgentProfileService).data().profileName, agent_id: agent.id };
    const panel = await livePanelCapabilities(agent);
    const available = agent.accessor.get(IAgentToolPolicyService).isToolActive('AgentRun');
    const policy = session!.accessor.get(ISessionDispatchService).readLaunchPolicy(agent.id);
    const baseAdmission = evaluateDispatchAdmission(policy, 'spawn');
    const unavailable_reason = available ? undefined
      : baseAdmission.reason ?? 'AgentRun is not active for this agent';
    const unavailable_reason_code = available ? undefined
      : baseAdmission.reasonCode ?? 'agent_run_inactive';
    const input = agent.accessor.get(ISubagentTool).dispatchCatalog();
    const targets = project(agent, input).map((target) => {
      const admission = evaluateDispatchAdmission(policy, 'spawn', target.executor);
      const launchUnavailableReason = target.launch_unavailable_reason ?? unavailable_reason ?? admission.reason;
      const launchUnavailableReasonCode = target.launch_unavailable_reason_code
        ?? unavailable_reason_code ?? admission.reasonCode;
      return {
        ...target,
        launch_allowed: target.launch_allowed !== false && available && admission.allowed,
        launch_unavailable_reason: launchUnavailableReason,
        launch_unavailable_reason_code: launchUnavailableReasonCode,
        execution_restriction: admission.executionRestriction,
      };
    });
    const liveMetrics = Object.fromEntries(session!.accessor.get(IAgentLifecycleService).list()
      .filter((handle) => agent.id === 'main' || handle.id === agent.id)
      .map((handle) => [handle.id, readAgentPanelMetrics(handle, pricing)]));
    const metrics = { ...persisted };
    for (const [id, value] of Object.entries(liveMetrics)) {
      metrics[id] = mergeAgentPanelMetrics(persisted[id], value);
    }
    return {
      context: 'live', live: true, owner, available, unavailable_reason, unavailable_reason_code,
      targets, ...panel, metrics,
    };
  }
  const workspace = await acquireWorkspaceProfileCatalog(core, query);
  if (workspace === undefined) return 'workspace-not-found';
  try {
    const defaultProfile = workspace.catalog.snapshot().defaultProfile;
    const profile = workspace.catalog.get(query.profile)
      ?? (defaultProfile?.name === query.profile ? defaultProfile : undefined);
    if (profile === undefined || profile.main !== true) return 'profile-not-found';
    const policy = { profile, global: core.accessor.get(IConfigService).get<GlobalToolsPolicy>('tools') };
    const available = isToolActiveComposed(policy, 'AgentRun');
    const unavailable_reason = available ? undefined : 'AgentRun is disabled by the draft profile or global tool policy';
    const unavailable_reason_code = available ? undefined : 'agent_run_draft_disabled';
    const input: SubagentCapabilityCatalog = {
      catalog: workspace.catalog,
      caller: { profileName: profile.name, profileDefinitionId: profile.definitionId,
        subagentPolicy: profile.subagentPolicy, subagentDeclaration: profile.subagentDeclaration,
        subagents: profile.subagents, subagentLeases: profile.subagentLeases,
        spawnPolicy: profile.spawnConstraints },
      profiles: workspace.catalog.list().filter((candidate) => candidate.main !== true),
      routes: workspace.catalog.listRoutes(),
      snapshot: workspace.catalog.snapshot(),
    };
    return {
      context: 'draft', owner: { profile: profile.name }, available, unavailable_reason, unavailable_reason_code,
      targets: project(core, input).map((target) => ({ ...target,
        launch_allowed: target.launch_allowed === false || !available ? false : undefined,
        launch_unavailable_reason: target.launch_unavailable_reason ?? unavailable_reason,
        launch_unavailable_reason_code: target.launch_unavailable_reason_code
          ?? unavailable_reason_code })),
      profile: {
        name: profile.name, description: profile.description,
        source: workspace.catalog.inspect(profile.name)?.sourceId,
        source_file: profile.sourcePath, definition_id: profile.definitionId,
        model: profile.modelAlias, model_source: profile.modelAlias === undefined ? undefined : 'profile',
        thinking_effort: profile.thinkingEffort,
        effort_source: profile.thinkingEffort === undefined ? undefined : 'profile', executor: profile.executor,
        service_tier: profile.serviceTier,
        tools: profile.tools === undefined ? undefined : [...profile.tools],
        disallowed_tools: profile.disallowedTools === undefined ? undefined : [...profile.disallowedTools],
        disabled_tool_groups: profile.disabledToolGroups === undefined ? undefined : [...profile.disabledToolGroups],
        subagent_policy: profile.subagentPolicy ?? 'advisory',
      },
      tools: getAgentToolContributions().map(({ options }) => {
        const active = isToolActiveComposed(policy, options.name, options.source);
        return { name: options.name, source: options.source ?? 'builtin', category: options.domain ?? 'other',
          group: toolGroupForName(options.name),
          state: active ? 'unknown' : 'disabled', unavailable_reason: active
            ? 'Draft inventory only; runtime connection and invocation approval are not evaluated'
            : 'Disabled by draft profile or global tool policy',
          unavailable_reason_code: active ? 'draft_inventory_only' : 'draft_policy_disabled',
          read_only: READ_ONLY_DISPLAY_TOOL_NAMES.has(options.name) ? true : undefined };
      }),
      skills: panelSkills(workspace.skills.listSkills(), isToolActiveComposed(policy, 'Skill')),
    };
  } finally {
    workspace.dispose();
  }
}

function mergeAgentPanelMetrics(
  persisted: AgentPanelMetrics | undefined,
  live: AgentPanelMetrics,
): AgentPanelMetrics {
  if (persisted === undefined) return live;
  const usePersistedUsage = live.totalTokens === null && persisted.totalTokens !== null;
  const usePersistedCost = live.totalCostUsd === null && persisted.totalCostUsd !== null;
  return {
    ...live,
    inputTokens: usePersistedUsage ? persisted.inputTokens : live.inputTokens,
    outputTokens: usePersistedUsage ? persisted.outputTokens : live.outputTokens,
    cacheReadTokens: usePersistedUsage ? persisted.cacheReadTokens : live.cacheReadTokens,
    cacheWriteTokens: usePersistedUsage ? persisted.cacheWriteTokens : live.cacheWriteTokens,
    totalTokens: usePersistedUsage ? persisted.totalTokens : live.totalTokens,
    totalCostUsd: usePersistedCost ? persisted.totalCostUsd : live.totalCostUsd,
    usagePartial: usePersistedUsage ? live.usagePartial || persisted.usagePartial : live.usagePartial,
    costPartial: usePersistedCost ? live.costPartial || persisted.costPartial : live.costPartial,
    usageSource: usePersistedUsage || usePersistedCost ? 'persisted' : live.usageSource,
  };
}

function project(core: Pick<Scope, 'accessor'>, input: SubagentCapabilityCatalog): AgentCapabilitiesProducerResponse['targets'] {
  return projectSubagentCapabilities(input, {
    models: core.accessor.get(IModelService), modelCatalog: core.accessor.get(IModelCatalog),
    config: core.accessor.get(IConfigService), executors: core.accessor.get(IAgentExecutorRegistry),
    protocols: core.accessor.get(IProtocolAdapterRegistry),
  }).map((target) => ({
    profile: target.profile, route: target.route, description: target.description, executor: target.executor,
    model_alias: target.modelAlias, model_source: target.modelSource,
    thinking_effort: target.thinkingEffort, effort_source: target.effortSource,
    dispatch_policy: target.dispatchPolicy, recommendation_status: target.recommendationStatus,
    advisory_deviation: target.advisoryDeviation,
    defaults_available: target.defaultsAvailable,
    binding_advisories: projectBindingAdvisories(target.bindingAdvisories),
    unavailable_reason: target.unavailableReason,
    unavailable_reason_code: target.unavailableReasonCode,
    launch_allowed: target.dispatchAllowed,
    launch_unavailable_reason: target.dispatchAllowed ? undefined : 'Blocked by strict subagent policy',
    launch_unavailable_reason_code: target.dispatchAllowed ? undefined : 'strict_subagent_policy_blocked',
  }));
}
