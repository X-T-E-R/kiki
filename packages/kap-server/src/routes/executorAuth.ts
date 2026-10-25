import { IAgentLifecycleService, IAgentProfileService, IAtomicDocumentStore, ISessionIndex, ISessionManager, ISessionMetadata, type Scope } from '@kiki/agent-core-v2';
import { agentExecutorBindingFingerprint } from '@kiki/agent-core-v2/app/agentExecutor/agentExecutor';
import type { SessionMeta } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { sessionScopeOf, workspacePersistenceScope } from '@kiki/agent-core-v2/workspace/sessionLifecycle/internal/addressing';
import { executorAuthObservationSchema, type ExecutorAuthObservation } from '@kiki/protocol';

export async function readExecutorAuth(core: Scope, sessionId: string, agentId: string): Promise<ExecutorAuthObservation | undefined> {
  const session = core.accessor.get(ISessionManager).get(sessionId);
  let metadata: SessionMeta | undefined;
  if (session !== undefined) metadata = await session.accessor.get(ISessionMetadata).read();
  else {
    const summary = await core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return undefined;
    const scope = sessionScopeOf(workspacePersistenceScope('sessions', summary.workspaceId), sessionId);
    const documents = core.accessor.get(IAtomicDocumentStore);
    metadata = await documents.get<SessionMeta>(scope, 'state.json') ?? await documents.get<SessionMeta>(`${scope}/session-meta`, 'state.json');
  }
  const agent = metadata?.agents?.[agentId];
  const parsed = executorAuthObservationSchema.safeParse(agent?.executorAuth);
  if (!parsed.success || parsed.data.executor_id !== agent?.executor || parsed.data.execution_generation !== agent.execution?.generation) return undefined;
  const live = session?.accessor.get(IAgentLifecycleService).get(agentId);
  if (live !== undefined && parsed.data.binding_fingerprint !== agentExecutorBindingFingerprint(live.accessor.get(IAgentProfileService).data())) return undefined;
  return parsed.data;
}
