import {
  IAgentFullCompactionService,
  IAgentLifecycleService,
  IAgentProfileService,
  IConfigService,
  ISessionAgentProfileCatalog,
  MAIN_AGENT_ID,
  programForSession,
  type Scope,
} from '@kiki/agent-core-v2';
import { IModelService } from '@kiki/agent-core-v2/kosong/model/model';
import { globalPercentFromTokens } from '@kiki/agent-core-v2/agent/fullCompaction/autoCompact';
import type { LoopControl } from '@kiki/agent-core-v2/agent/loop/configSection';
import {
  autoCompactStatusSchema,
  autoCompactWriteSchema,
  autoCompactWriteResultSchema,
} from '@kiki/protocol';
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
const path = '/sessions/{session_id}/agents/{agent_id}/auto-compact';
const errors = {
  [ErrorCode.VALIDATION_FAILED]: {},
  [ErrorCode.SESSION_NOT_FOUND]: {},
  [ErrorCode.MODEL_NOT_FOUND]: {},
  [ErrorCode.AGENT_PROFILE_READ_ONLY]: {},
};

export function registerAutoCompactRoutes(app: RouteHost, core: Scope): void {
  const read = defineRoute({
    method: 'GET', path, params, success: { data: autoCompactStatusSchema }, errors,
    description: 'Read the effective automatic compaction point, source and usable context limit for one agent',
    tags: ['sessions'],
  }, async (req, reply) => {
    await withSessionOperation(core, req.params.session_id, async (session) => {
      if (session === undefined) {
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'Session not found', req.id));
        return;
      }
      const agent = req.params.agent_id === MAIN_AGENT_ID
        ? await ensureMainAgent(session)
        : session.accessor.get(IAgentLifecycleService).get(req.params.agent_id);
      if (agent === undefined) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Agent is not active in this session', req.id));
        return;
      }
      reply.send(okEnvelope(agent.accessor.get(IAgentFullCompactionService).getAutoCompact(), req.id));
    });
  });
  app.get(read.path, read.options, read.handler as Parameters<RouteHost['get']>[2]);

  const write = defineRoute({
    method: 'PATCH', path, params, body: autoCompactWriteSchema,
    success: { data: autoCompactWriteResultSchema }, errors,
    description: 'Change this agent session override, optionally saving the token point as the model, profile or global default',
    tags: ['sessions'],
  }, async (req, reply) => {
    await withSessionOperation(core, req.params.session_id, async (session) => {
      if (session === undefined) {
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'Session not found', req.id));
        return;
      }
      const agent = req.params.agent_id === MAIN_AGENT_ID
        ? await ensureMainAgent(session)
        : session.accessor.get(IAgentLifecycleService).get(req.params.agent_id);
      if (agent === undefined) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Agent is not active in this session', req.id));
        return;
      }
      const compact = agent.accessor.get(IAgentFullCompactionService);
      const profile = agent.accessor.get(IAgentProfileService);
      const tokens = req.body.tokens;
      let savedAs: string | number | undefined;
      if (req.body.save === 'model' && tokens !== null) {
        const id = profile.getModel();
        const models = core.accessor.get(IModelService);
        const model = models.get(id);
        if (model === undefined) {
          reply.send(errEnvelope(ErrorCode.MODEL_NOT_FOUND, `Model ${id} not found`, req.id));
          return;
        }
        await models.set(id, { ...model, autoCompact: tokens });
        savedAs = tokens;
      } else if (req.body.save === 'profile' && tokens !== null) {
        const bound = profile.data().boundProfile;
        const source = bound?.fileDefinition?.source;
        const name = profile.data().profileName;
        const program = await programForSession(core.accessor, req.params.session_id);
        if (name === undefined || program === undefined ||
            (source !== 'user' && source !== 'project' && source !== 'extra')) {
          reply.send(errEnvelope(ErrorCode.AGENT_PROFILE_READ_ONLY, 'The active profile is not an editable file-backed profile', req.id));
          return;
        }
        await program.agentProfileWriter.update({
          name, scope: source, sourcePath: bound?.fileDefinition?.path, autoCompact: tokens,
        });
        await session.accessor.get(ISessionAgentProfileCatalog).reload();
        savedAs = tokens;
      } else if (req.body.save === 'global' && tokens !== null) {
        const config = core.accessor.get(IConfigService);
        const percent = globalPercentFromTokens(tokens, compact.getAutoCompact().effectiveMaxContextTokens);
        await config.replace('loopControl', {
          ...config.get<LoopControl>('loopControl'),
          compactionTriggerRatio: undefined,
          compactionSoftContextSize: undefined,
          autoCompact: percent,
        });
        savedAs = percent;
      }
      compact.setAutoCompactOverride(tokens);
      profile.republishStatus();
      const defaultStatus = compact.getDefaultAutoCompact();
      const effectiveBeforeClear = compact.getAutoCompact();
      const overrideCleared = req.body.save !== undefined &&
        effectiveBeforeClear.source === 'session' && effectiveBeforeClear.tokens === defaultStatus.tokens;
      if (overrideCleared) compact.setAutoCompactOverride(null);
      reply.send(okEnvelope({ effective: compact.getAutoCompact(), default: defaultStatus, overrideCleared, savedAs }, req.id));
    });
  });
  app.patch(write.path, write.options, write.handler as Parameters<RouteHost['patch']>[2]);
}
