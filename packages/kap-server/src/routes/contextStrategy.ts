import { IAgentFullCompactionService, IAgentLifecycleService, IConfigService, MAIN_AGENT_ID, type Scope } from '@kiki/agent-core-v2';
import { contextStrategyStatusSchema, contextStrategyWriteSchema } from '@kiki/protocol';
import { z } from 'zod';
import { errEnvelope, okEnvelope } from '../envelope';
import { withSessionOperation } from '../lib/sessionOperationLease';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { ensureMainAgent } from '../transport/mainAgent';

interface RouteHost {
  get(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: { id: string; params: unknown }, reply: { send(payload: unknown): unknown }) => Promise<void>): unknown;
  patch(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: { id: string; params: unknown; body: unknown }, reply: { send(payload: unknown): unknown }) => Promise<void>): unknown;
}

const params = z.object({ session_id: z.string().min(1), agent_id: z.string().min(1) });
const path = '/sessions/{session_id}/agents/{agent_id}/context-strategy';
const errors = { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.SESSION_NOT_FOUND]: {} };

export function registerContextStrategyRoutes(app: RouteHost, core: Scope): void {
  const read = defineRoute({ method: 'GET', path, params, success: { data: contextStrategyStatusSchema }, errors,
    description: 'Read the effective context-window strategy and its source', tags: ['sessions'] }, async (req, reply) => {
    await withSessionOperation(core, req.params.session_id, async (session) => {
      if (session === undefined) { reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'Session not found', req.id)); return; }
      const agent = req.params.agent_id === MAIN_AGENT_ID ? await ensureMainAgent(session) : session.accessor.get(IAgentLifecycleService).get(req.params.agent_id);
      if (agent === undefined) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Agent is not active in this session', req.id)); return; }
      reply.send(okEnvelope(agent.accessor.get(IAgentFullCompactionService).getContextStrategy(), req.id));
    });
  });
  app.get(read.path, read.options, read.handler as Parameters<RouteHost['get']>[2]);
  const write = defineRoute({ method: 'PATCH', path, params, body: contextStrategyWriteSchema,
    success: { data: contextStrategyStatusSchema }, errors,
    description: 'Set a session context strategy, or sync the selection to the global default', tags: ['sessions'] }, async (req, reply) => {
    await withSessionOperation(core, req.params.session_id, async (session) => {
      if (session === undefined) { reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'Session not found', req.id)); return; }
      if (req.params.agent_id !== MAIN_AGENT_ID) { reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Session strategy override belongs to the main agent', req.id)); return; }
      const agent = await ensureMainAgent(session);
      const compact = agent.accessor.get(IAgentFullCompactionService);
      if (req.body.save === 'global') {
        const config = core.accessor.get(IConfigService);
        await config.set('loopControl', { contextStrategy: req.body.strategy ?? compact.getContextStrategy().strategy });
        compact.setContextStrategyOverride(null);
      } else compact.setContextStrategyOverride(req.body.strategy);
      reply.send(okEnvelope(compact.getContextStrategy(), req.id));
    });
  });
  app.patch(write.path, write.options, write.handler as Parameters<RouteHost['patch']>[2]);
}
