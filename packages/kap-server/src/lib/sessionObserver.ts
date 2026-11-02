import { IAgentLifecycleService, ISessionIndex, ISessionManager, type Scope } from '@kiki/agent-core-v2';
import { readColdSessionMeta } from '../services/snapshot/coldSessionMeta';

export async function readSessionObserver(core: Scope, sessionId: string) {
  const live = core.accessor.get(ISessionManager).get(sessionId);
  if (live !== undefined) return { live };
  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) return undefined;
  const metadata = await readColdSessionMeta(core, summary.workspaceId, sessionId);
  return { summary, metadata };
}

export async function readAgentObserver(core: Scope, sessionId: string, agentId: string) {
  const session = await readSessionObserver(core, sessionId);
  if (session === undefined) return undefined;
  if (session.live !== undefined) return { session, agent: session.live.accessor.get(IAgentLifecycleService).get(agentId) };
  return { session, metadata: session.metadata?.agents?.[agentId] };
}
