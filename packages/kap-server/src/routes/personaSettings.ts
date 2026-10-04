import { IAgentLifecycleService, IAgentProfileService, ISessionIndex, MAIN_AGENT_ID, getLiveSessionById, type Scope } from '@kiki/agent-core-v2';
import { IPersonaStore } from '@kiki/agent-core-v2/app/persona/personaStore';
import { readPersistedAgentProfileSnapshot } from '@kiki/agent-core-v2/session/agentProfileSnapshot';
import { applyPersonaSettingsRequestSchema, sessionPersonaSettingsSchema } from '@kiki/protocol';
import { z } from 'zod';
import { errEnvelope, okEnvelope } from '../envelope';
import { withSessionOperation } from '../lib/sessionOperationLease';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { ensureMainAgent } from '../transport/mainAgent';
import { mapError } from '../transport/errors';

interface RouteHost {
  get(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: { id: string; params: unknown }, reply: { send(payload: unknown): unknown }) => Promise<void>): unknown;
  post(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: { id: string; params: unknown; body: unknown }, reply: { send(payload: unknown): unknown }) => Promise<void>): unknown;
}

export function registerPersonaSettingsRoutes(app: RouteHost, core: Scope): void {
  const params = z.object({ session_id: z.string().min(1) });
  const read = async (sessionId: string) => {
    const live = getLiveSessionById(core.accessor, sessionId);
    const summary = live === undefined ? await core.accessor.get(ISessionIndex).get(sessionId) : undefined;
    if (live === undefined && summary === undefined) return undefined;
    const profile = live?.accessor.get(IAgentLifecycleService).get(MAIN_AGENT_ID)?.accessor.get(IAgentProfileService).data()
      ?? (summary === undefined ? undefined : await readPersistedAgentProfileSnapshot(core, summary.workspaceId, sessionId, MAIN_AGENT_ID, undefined));
    const personaId = profile?.personaId ?? summary?.personaId;
    const latest = personaId === undefined ? undefined : await core.accessor.get(IPersonaStore).get(personaId);
    return {
      personaId, boundRevision: profile?.personaRevision, latestRevision: latest?.revision,
      hasUpdate: latest !== undefined && latest.revision !== profile?.personaRevision,
      overrides: profile?.personaOverrides,
    };
  };
  const get = defineRoute({
    method: 'GET', path: '/sessions/{session_id}/persona-settings', params,
    success: { data: sessionPersonaSettingsSchema }, errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
    description: 'Read frozen and current persona settings without resuming a conversation', tags: ['sessions'],
  }, async (req, reply) => {
    const data = await read(req.params.session_id);
    reply.send(data === undefined ? errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'Session not found', req.id) : okEnvelope(data, req.id));
  });
  app.get(get.path, get.options, get.handler as Parameters<RouteHost['get']>[2]);
  const apply = defineRoute({
    method: 'POST', path: '/sessions/{session_id}/persona-settings', params, body: applyPersonaSettingsRequestSchema,
    success: { data: sessionPersonaSettingsSchema }, errors: { [ErrorCode.SESSION_NOT_FOUND]: {}, [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Explicitly apply current persona settings at an idle boundary', tags: ['sessions'],
  }, async (req, reply) => {
    try {
      await withSessionOperation(core, req.params.session_id, async (session) => {
        if (session === undefined) { reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, 'Session not found', req.id)); return; }
        const agent = await ensureMainAgent(session);
        await agent.accessor.get(IAgentProfileService).applyPersonaSettings(req.body.restoreDefaults);
        reply.send(okEnvelope(await read(req.params.session_id), req.id));
      });
    } catch (error) {
      reply.send(mapError(error, req.id));
    }
  });
  app.post(apply.path, apply.options, apply.handler as Parameters<RouteHost['post']>[2]);
}
