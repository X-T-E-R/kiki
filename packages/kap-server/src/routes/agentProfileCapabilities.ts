import {
  IAgentExecutorRegistry,
  IAgentLifecycleService,
  IAgentProfileService,
  IAgentToolPolicyService,
  IConfigService,
  IInstantiationService,
  IModelCatalog,
  IModelService,
  IProtocolAdapterRegistry,
  ISessionAgentProfileCatalog,
  ISessionAgentProfileCatalogSeed,
  ISessionManager,
  ISubagentTool,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  ServiceCollection,
  SessionAgentProfileCatalogService,
  type Scope,
} from '@kiki/agent-core-v2';
import { resumeSessionById } from '@kiki/agent-core-v2/app/sessionManager/sessionLookup';
import { projectSubagentCapabilities, type SubagentCapabilityCatalog } from '@kiki/agent-core-v2/agent/tools/agent/subagentCapabilities';
import { isToolActiveComposed, type GlobalToolsPolicy } from '@kiki/agent-core-v2/agent/toolPolicy/evaluate';
import { ISessionDispatchService } from '@kiki/agent-core-v2/session/dispatch/dispatch';
import { evaluateDispatchAdmission } from '@kiki/agent-core-v2/session/dispatch/launchPolicy';
import type { AgentCapabilitiesQuery, AgentCapabilitiesResponse } from '@kiki/protocol';

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
    return { workspaceId, catalog, dispose: () => { disposeCatalog?.(); lease.dispose(); } };
  } catch (error) {
    disposeCatalog?.();
    lease.dispose();
    throw error;
  }
}

export async function agentCapabilities(
  core: Scope,
  query: AgentCapabilitiesQuery,
): Promise<AgentCapabilitiesResponse | 'workspace-not-found' | 'profile-not-found'> {
  if ('session_id' in query) {
    const session = core.accessor.get(ISessionManager).get(query.session_id)
      ?? await resumeSessionById(core.accessor, query.session_id);
    const lifecycle = session?.accessor.get(IAgentLifecycleService);
    const agent = lifecycle?.get(query.agent_id);
    if (agent === undefined) return {
      context: 'live', owner: { agent_id: query.agent_id }, available: false,
      unavailable_reason: 'Session or agent is not live; dispatch capabilities are unavailable', targets: [],
    };
    const owner = { profile: agent.accessor.get(IAgentProfileService).data().profileName, agent_id: agent.id };
    const available = agent.accessor.get(IAgentToolPolicyService).isToolActive('AgentRun');
    const policy = session!.accessor.get(ISessionDispatchService).readLaunchPolicy(agent.id);
    const unavailableReason = available
      ? undefined
      : evaluateDispatchAdmission(policy, 'spawn').reason ?? 'AgentRun is not active for this agent';
    const input = agent.accessor.get(ISubagentTool).dispatchCatalog();
    const targets = project(agent, input).map((target) => {
      const admission = evaluateDispatchAdmission(policy, 'spawn', target.executor);
      return {
        ...target,
        launch_allowed: available && admission.allowed,
        launch_unavailable_reason: unavailableReason ?? admission.reason,
        execution_restriction: admission.executionRestriction,
      };
    });
    return { context: 'live', owner, available, unavailable_reason: unavailableReason, targets };
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
    const unavailableReason = available ? undefined : 'AgentRun is disabled by the draft profile or global tool policy';
    const input: SubagentCapabilityCatalog = {
      catalog: workspace.catalog,
      caller: {
        profileName: profile.name,
        profileDefinitionId: profile.definitionId,
        subagents: profile.subagents,
        subagentLeases: profile.subagentLeases,
        spawnPolicy: profile.spawnConstraints,
      },
      profiles: workspace.catalog.list().filter((candidate) => candidate.main !== true),
      routes: workspace.catalog.listRoutes(),
      snapshot: workspace.catalog.snapshot(),
    };
    return {
      context: 'draft', owner: { profile: profile.name }, available,
      unavailable_reason: unavailableReason,
      targets: project(core, input).map((target) => ({
        ...target,
        launch_allowed: available ? undefined : false,
        launch_unavailable_reason: unavailableReason,
      })),
    };
  } finally {
    workspace.dispose();
  }
}

function project(core: Pick<Scope, 'accessor'>, input: SubagentCapabilityCatalog): AgentCapabilitiesResponse['targets'] {
  return projectSubagentCapabilities(input, {
    models: core.accessor.get(IModelService),
    modelCatalog: core.accessor.get(IModelCatalog),
    config: core.accessor.get(IConfigService),
    executors: core.accessor.get(IAgentExecutorRegistry),
    protocols: core.accessor.get(IProtocolAdapterRegistry),
  }).map((target) => ({
    profile: target.profile,
    route: target.route,
    description: target.description,
    executor: target.executor,
    model_alias: target.modelAlias,
    model_source: target.modelSource,
    thinking_effort: target.thinkingEffort,
    effort_source: target.effortSource,
    defaults_available: target.defaultsAvailable,
    unavailable_reason: target.unavailableReason,
  }));
}
