import { Error2, ErrorCodes, IAgentLifecycleService, ISessionContext, ISessionMetadata, MAIN_AGENT_ID, ensureMainAgent, type IAgentScopeHandle, type ISessionScopeHandle, type Scope } from '@kiki/agent-core-v2';
import { readPersistedAgentProfileSnapshot } from '@kiki/agent-core-v2/session/agentProfileSnapshot';

export async function ensureSessionAgent(core: Scope, session: ISessionScopeHandle, agentId = MAIN_AGENT_ID): Promise<IAgentScopeHandle> {
  if (agentId === MAIN_AGENT_ID) return ensureMainAgent(session);
  const lifecycle = session.accessor.get(IAgentLifecycleService);
  const live = lifecycle.get(agentId);
  if (live !== undefined) return live;
  const meta = (await session.accessor.get(ISessionMetadata).read()).agents?.[agentId];
  if (meta === undefined) throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
  const context = session.accessor.get(ISessionContext);
  const snapshot = await readPersistedAgentProfileSnapshot(core, context.workspaceId, context.sessionId, agentId, meta);
  if (snapshot === undefined) throw new Error2(ErrorCodes.CONFIG_INVALID, `Persisted binding metadata for agent "${agentId}" is unavailable`, { details: { agentId } });
  return lifecycle.create({
    agentId,
    restoreBinding: {
      profileName: snapshot.profileName,
      routeId: snapshot.routeId,
      modelAlias: snapshot.modelAlias,
      thinkingEffort: snapshot.thinkingLevel,
      thinkingEffortExplicit: snapshot.thinkingEffortExplicit,
      executorId: snapshot.executorId,
      executorProtocol: snapshot.executorProtocol,
    },
  });
}
