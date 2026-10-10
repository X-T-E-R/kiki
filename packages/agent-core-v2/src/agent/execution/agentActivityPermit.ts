import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentProfileService } from '#/agent/profile/profile';
import { resolveDelegationPosition } from '#/agent/profile/delegationContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { IRequestGovernance, type AgentActivityPhase } from '#/app/requestGovernance/requestGovernance';
import { IModelCatalog } from '#/kosong/model/catalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import type { RequestPermit } from '#/kosong/model/requestAdmission';

export async function acquireAgentActivityPermit(accessor: ServicesAccessor, signal: AbortSignal, readPhase: () => AgentActivityPhase): Promise<RequestPermit> {
  const scope = accessor.get(IAgentScopeContext);
  const session = accessor.get(ISessionContext);
  const metadata = accessor.get(ISessionMetadata);
  const profile = accessor.get(IAgentProfileService);
  const catalog = accessor.get(IModelCatalog);
  const governance = accessor.get(IRequestGovernance);
  const activity = accessor.get(IAgentActivityView);
  const meta = await metadata.read();
  signal.throwIfAborted();
  const binding = profile.data();
  const executorId = binding.executorId ?? 'native';
  const model = executorId === 'native' && binding.modelAlias !== undefined ? catalog.get(binding.modelAlias) : undefined;
  const position = resolveDelegationPosition(scope.agentId, meta.agents?.[scope.agentId]?.delegator);
  const ancestorAgentIds: string[] = [];
  let parent = scope.parentAgentId;
  while (parent !== undefined && !ancestorAgentIds.includes(parent)) {
    ancestorAgentIds.push(parent);
    const parentMeta = meta.agents?.[parent];
    parent = parentMeta?.delegator?.kind === 'agent' ? parentMeta.delegator.agentId : parentMeta?.parentAgentId ?? undefined;
  }
  return governance.acquireAgent({
    sessionId: session.sessionId, agentId: scope.agentId, parentAgentId: scope.parentAgentId,
    ancestorAgentIds, executorId, profileId: binding.profileName,
    modelId: executorId === 'native' ? model?.id ?? binding.modelAlias : binding.modelAlias,
    providerId: model?.providerName,
    role: position === 'sub' ? 'subagent' : position,
    readPhase: () => {
      const phase = readPhase();
      if (phase !== 'running') return phase;
      const turn = activity.state().turn;
      if (turn?.pendingApprovals.length) return 'suspended';
      return turn?.activeToolCalls.length || turn?.phase === 'tool_call' ? 'tool_waiting' : 'running';
    },
  }, signal);
}
