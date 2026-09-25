import {
  IAgentExecutorRegistry,
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentStateService,
  IAgentToolPolicyService,
  IConfigService,
  IInstantiationService,
  ILogService,
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
import { withDispatchPolicyDefaults } from '@kiki/agent-core-v2/session/subagent/configSection';
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

interface WorkspaceCatalogEntry {
  readonly catalog: SessionAgentProfileCatalogService;
  readonly dispose: () => void;
  users: number;
}

const workspaceCatalogCaches = new WeakMap<Scope, Map<string, WorkspaceCatalogEntry>>();
const MAX_WORKSPACE_CATALOGS = 32;

function workspaceCatalogCache(core: Scope): Map<string, WorkspaceCatalogEntry> {
  let entries = workspaceCatalogCaches.get(core);
  if (entries !== undefined) return entries;
  entries = new Map();
  workspaceCatalogCaches.set(core, entries);
  const cache = entries;
  const manager = core.accessor.get(IWorkspaceInstanceManager);
  const closeListener = manager.onDidChange(({ workspaceId, instance }) => {
    if (instance !== undefined) return;
    const entry = cache.get(workspaceId);
    if (entry !== undefined) {
      cache.delete(workspaceId);
      entry.dispose();
    }
  });
  core.accessor.get(IInstantiationService).onWillDispose(() => {
    closeListener.dispose();
    for (const entry of cache.values()) entry.dispose();
    cache.clear();
    workspaceCatalogCaches.delete(core);
  });
  return cache;
}

function trimWorkspaceCatalogCache(entries: Map<string, WorkspaceCatalogEntry>): void {
  while (entries.size > MAX_WORKSPACE_CATALOGS) {
    const oldest = [...entries].find(([, entry]) => entry.users === 0);
    if (oldest === undefined) return;
    entries.delete(oldest[0]);
    oldest[1].dispose();
  }
}

export async function acquireWorkspaceProfileCatalog(
  core: Scope,
  query: { workspace_id?: string; cwd?: string },
) {
  const startedAt = Date.now();
  const log = core.accessor.get(ILogService);
  if (query.workspace_id !== undefined && await core.accessor.get(IWorkspaceService).get(query.workspace_id) === undefined) {
    log.info('workspace profile catalog acquisition completed', {
      outcome: 'workspace_not_found', duration_ms: Date.now() - startedAt,
    });
    return undefined;
  }
  let lease: Awaited<ReturnType<IWorkspaceInstanceManager['acquire']>>;
  try {
    lease = await core.accessor.get(IWorkspaceInstanceManager).acquire(
      query.workspace_id !== undefined ? { workspaceId: query.workspace_id } : { root: query.cwd! },
    );
  } catch (error) {
    log.warn('workspace profile catalog acquisition failed', {
      cache_state: 'miss', duration_ms: Date.now() - startedAt,
      error_type: error instanceof Error ? error.name : 'unknown',
    });
    throw error;
  }
  let entry: WorkspaceCatalogEntry | undefined;
  let cacheState: 'hit' | 'miss' = 'miss';
  try {
    await lease.instance.program.ready;
    const workspaceId = lease.instance.id;
    const entries = workspaceCatalogCache(core);
    entry = entries.get(workspaceId);
    if (entry !== undefined) {
      cacheState = 'hit';
      entries.delete(workspaceId);
      entries.set(workspaceId, entry);
    } else {
      const container = core.accessor.get(IInstantiationService).createChild(new ServiceCollection([
        ISessionAgentProfileCatalogSeed,
        { _serviceBrand: undefined, workspaceKey: workspaceId },
      ]));
      try {
        const catalog = container.createInstance(SessionAgentProfileCatalogService);
        entry = { catalog, users: 0, dispose: () => { catalog.dispose(); container.dispose(); } };
        entries.set(workspaceId, entry);
      } catch (error) {
        container.dispose();
        throw error;
      }
    }
    const acquired = entry;
    acquired.users += 1;
    try {
      await acquired.catalog.ready;
    } catch (error) {
      if (entries.get(workspaceId) === acquired) {
        entries.delete(workspaceId);
        acquired.dispose();
      }
      throw error;
    }
    log.info('workspace profile catalog acquisition completed', {
      workspace_id: workspaceId, cache_state: cacheState, outcome: 'ready',
      complete: acquired.catalog.complete, duration_ms: Date.now() - startedAt,
    });
    trimWorkspaceCatalogCache(entries);
    return { workspaceId, catalog: acquired.catalog, skills: lease.instance.program.skills.catalog,
      dispose: () => { acquired.users -= 1; lease.dispose(); trimWorkspaceCatalogCache(entries); } };
  } catch (error) {
    if (entry !== undefined) entry.users -= 1;
    lease.dispose();
    log.warn('workspace profile catalog acquisition failed', {
      cache_state: cacheState, duration_ms: Date.now() - startedAt,
      error_type: error instanceof Error ? error.name : 'unknown',
    });
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
        agentIds: [query.agent_id],
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
        targets: project(session, input, query.agent_id === 'main' ? 'main' : 'sub').map((target) => ({
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
    const targets = project(agent, input, agent.id === 'main' ? 'main' : 'sub').map((target) => {
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
      targets: project(core, input, 'main').map((target) => ({ ...target,
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
        subagent_policy: profile.subagentPolicy ?? withDispatchPolicyDefaults(
          core.accessor.get(IConfigService), profile, 'main').defaultPolicy,
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

function project(core: Pick<Scope, 'accessor'>, input: SubagentCapabilityCatalog,
  position: 'main' | 'sub'): AgentCapabilitiesProducerResponse['targets'] {
  const config = core.accessor.get(IConfigService);
  return projectSubagentCapabilities({ ...input,
    caller: withDispatchPolicyDefaults(config, input.caller, position),
  }, {
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
