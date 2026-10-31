import {
  IAgentExecutorRegistry, IAgentLifecycleService, IAgentProfileService, IAgentToolPolicyService,
  IConfigService, IModelCatalog, IModelService, IProtocolAdapterRegistry, ISessionAgentProfileCatalog,
  ISessionContext, ISessionIndex, ISessionManager, type Scope,
} from '@kiki/agent-core-v2';
import { agentRefLink, type AgentReferenceCandidatesQuery, type AgentReferenceCandidatesResponse } from '@kiki/protocol';
import { isNativeTarget } from '@kiki/agent-core-v2/app/agentProfileCatalog/agentProfileCatalog';
import { projectSubagentCapabilities, type SubagentCapabilityCatalog } from '@kiki/agent-core-v2/agent/tools/agent/subagentCapabilities';
import { isToolActiveComposed, type GlobalToolsPolicy } from '@kiki/agent-core-v2/agent/toolPolicy/evaluate';
import { ISessionDispatchService } from '@kiki/agent-core-v2/session/dispatch/dispatch';
import { evaluateDispatchAdmission } from '@kiki/agent-core-v2/session/dispatch/launchPolicy';
import { acquireDraftProfileListCatalog } from './agentProfileCapabilities';
import { PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET, readPersistedAgentProfileSnapshot } from './agentProfileSnapshot';

export async function agentReferenceCandidates(
  core: Scope,
  query: AgentReferenceCandidatesQuery,
  signal?: AbortSignal,
): Promise<AgentReferenceCandidatesResponse> {
  const empty = (reason: string): AgentReferenceCandidatesResponse => ({ items: [], delegation_available: false, unavailable_reason: reason });
  const manager = core.accessor.get(ISessionManager);
  const session = 'session_id' in query ? manager.get(query.session_id) : undefined;
  const agent = 'session_id' in query ? session?.accessor.get(IAgentLifecycleService).get(query.agent_id) : undefined;
  const saved = 'session_id' in query && agent === undefined ? await core.accessor.get(ISessionIndex).get(query.session_id) : undefined;
  const workspaceId = session?.accessor.get(ISessionContext).workspaceId ?? saved?.workspaceId;
  if ('session_id' in query && agent === undefined && workspaceId === undefined) return empty('Session or workspace is unavailable');
  const workspace = agent === undefined ? await acquireDraftProfileListCatalog(core,
    'session_id' in query ? { workspace_id: workspaceId } : query) : undefined;
  try {
    signal?.throwIfAborted();
    const catalog = agent === undefined ? workspace?.catalog : session!.accessor.get(ISessionAgentProfileCatalog);
    if (catalog === undefined) return empty('Workspace profile catalog is unavailable');
    await catalog.ready;
    const persisted = 'session_id' in query && agent === undefined && workspaceId !== undefined
      ? await readPersistedAgentProfileSnapshot(core, workspaceId, query.session_id, query.agent_id, undefined, signal,
          { inlineByteBudget: PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET }) : undefined;
    const live = agent?.accessor.get(IAgentProfileService).data();
    const profile = live?.boundProfile ?? persisted?.boundProfile
      ?? catalog.get('session_id' in query ? live?.profileName ?? persisted?.profileName ?? catalog.getDefault().name : query.profile);
    if (profile === undefined) return empty('The caller profile is unavailable');
    if ('session_id' in query && agent === undefined && persisted === undefined) return empty('Saved caller policy is unavailable');
    const caller: SubagentCapabilityCatalog['caller'] = live?.boundProfile === undefined && persisted?.source !== 'wire'
      ? { profileName: profile.name, profileDefinitionId: profile.definitionId,
          canSpawnSubagents: profile.canSpawnSubagents, allowedSubagents: profile.allowedSubagents,
          denySubagents: profile.denySubagents, preferredSubagents: profile.preferredSubagents,
          subagentLeases: profile.subagentLeases, spawnPolicy: profile.spawnConstraints,
          modelAlias: live?.modelAlias ?? profile.modelAlias, thinkingLevel: live?.thinkingLevel ?? profile.thinkingEffort }
      : live ?? { ...persisted!, profileName: persisted!.profileName ?? profile.name };
    const registry = core.accessor.get(IAgentExecutorRegistry);
    const config = core.accessor.get(IConfigService);
    const policyProfile = persisted?.source === 'wire' ? { ...persisted, tools: persisted.activeToolNames } : profile;
    const external = (live?.executorId ?? persisted?.executorId ?? profile.executor ?? 'native') !== 'native';
    const bridge = live?.allowKikiSubagents ?? persisted?.execution?.effective.allow_kiki_subagents
      ?? profile.allowKikiSubagents ?? false;
    const delegation = (!external || bridge) && (agent === undefined || live?.boundProfile === undefined
      ? isToolActiveComposed({ profile: policyProfile, global: config.get<GlobalToolsPolicy>('tools') }, 'AgentRun')
      : agent.accessor.get(IAgentToolPolicyService).isToolActive('AgentRun'));
    const policy = agent === undefined ? undefined : session!.accessor.get(ISessionDispatchService).readLaunchPolicy(agent.id);
    const input: SubagentCapabilityCatalog = { catalog, caller, profiles: catalog.list(), routes: [], snapshot: catalog.snapshot?.() };
    const targets = projectSubagentCapabilities(input, { models: core.accessor.get(IModelService),
      modelCatalog: core.accessor.get(IModelCatalog), config, executors: registry,
      protocols: core.accessor.get(IProtocolAdapterRegistry) }, true).filter(target => target.dispatchAllowed);
    const items = await Promise.all(targets.map(async target => {
      const scoped = input.snapshot?.scopedBindings.get(caller.profileDefinitionId ?? '')?.get(target.profile);
      const definition = scoped?.profile ?? catalog.get(target.profile);
      const descriptor = registry.get(target.executor);
      const native = definition !== undefined && isNativeTarget({ ...definition, name: target.profile });
      const discovery = target.executor === 'native' || descriptor === undefined ? undefined : await registry.discoverMetadata!(target.executor);
      const admission = policy === undefined ? undefined : evaluateDispatchAdmission(policy, 'spawn', target.executor);
      const reason = target.unavailableReason ?? (discovery?.installed === false ? discovery.reason : undefined)
        ?? (!delegation ? 'AgentRun is not available to the current engine or profile' : undefined)
        ?? admission?.reason;
      return { profile: target.profile, label: native ? descriptor?.label ?? target.executor : target.profile,
        executor: target.executor, engine_label: descriptor?.label ?? (target.executor === 'native' ? 'Kiki' : target.executor),
        reference: agentRefLink(target.profile), configuration: native ? 'native' as const : 'profile' as const,
        group: native ? 'native' as const : definition?.main === true ? 'main' as const : 'profile' as const,
        defaults_available: target.defaultsAvailable,
        available: target.defaultsAvailable && discovery?.installed !== false && delegation && admission?.allowed !== false,
        unavailable_reason: reason,
        unavailable_reason_code: target.unavailableReasonCode ?? (discovery?.installed === false ? 'engine_not_installed' : undefined)
          ?? (!delegation ? 'agent_run_inactive' : undefined) ?? admission?.reasonCode,
        description: target.description };
    }));
    signal?.throwIfAborted();
    return { items, delegation_available: delegation,
      unavailable_reason: delegation ? undefined : 'AgentRun is not available to the current engine or profile' };
  } finally { await workspace?.dispose(); }
}
