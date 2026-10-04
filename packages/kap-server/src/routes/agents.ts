import { IAgentLifecycleService, MAIN_AGENT_ID, type Scope } from '@kiki/agent-core-v2';
import { IAgentHookRules } from '@kiki/agent-core-v2/features/externalHooks/agent/hookRules';
import { agentHooksInspectSchema } from '@kiki/protocol';
import { z } from 'zod';
import { errEnvelope, okEnvelope } from '../envelope';
import { withSessionOperation } from '../lib/sessionOperationLease';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { ensureMainAgent } from '../transport/mainAgent';

interface RouteHost {
  get(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: { id: string; params: unknown }, reply: { send(payload: unknown): unknown }) => Promise<void>): unknown;
}

export function registerAgentHooksRoutes(app: RouteHost, core: Scope): void {
  const route = defineRoute({ method: 'GET', path: '/sessions/{session_id}/agents/{agent_id}/hooks',
    params: z.object({ session_id: z.string().min(1), agent_id: z.string().min(1) }),
    success: { data: agentHooksInspectSchema },
    errors: { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.SESSION_NOT_FOUND]: {} },
    description: 'Inspect effective hook rules, sources and cadence for an agent', tags: ['sessions'],
  }, async (req, reply) => {
    await withSessionOperation(core, req.params.session_id, async (session) => {
      if (session === undefined) { reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'Session not found', req.id)); return; }
      const agent = req.params.agent_id === MAIN_AGENT_ID ? await ensureMainAgent(session) : session.accessor.get(IAgentLifecycleService).get(req.params.agent_id);
      if (agent === undefined) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Agent is not active in this session', req.id)); return; }
      reply.send(okEnvelope(await agent.accessor.get(IAgentHookRules).inspect(), req.id));
    });
  });
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
