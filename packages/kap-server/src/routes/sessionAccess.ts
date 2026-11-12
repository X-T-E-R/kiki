import { ISessionIndex, ISessionManager, type Scope } from '@kiki/agent-core-v2';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { errEnvelope, okEnvelope } from '../envelope';
import { sessionAccessClientSchema, sessionAccessScopesSchema, type SessionAccessStore } from '../services/sessionAccess/store';

const issueSchema = z.object({
  session_id: z.string().min(1),
  scopes: sessionAccessScopesSchema,
  client: sessionAccessClientSchema,
  ttl_seconds: z.number().int().min(60).max(86_400).default(3600),
}).strict();

export function registerSessionAccessRoutes(app: FastifyInstance, core: Scope, store: SessionAccessStore, server_id: string, server_version: string): void {
  const path = '/api/session-access';
  app.get(path, (request, reply) => {
    const { enabled, terminalHandoff } = store.config();
    return reply.send(okEnvelope({ version: 1, enabled, terminal_handoff: terminalHandoff, server_id, tokens: store.list() }, request.id));
  });
  app.post(`${path}/tokens`, async (request, reply) => {
    if (!store.config().enabled) return reply.code(403).send(errEnvelope(40101, 'session_access_disabled', request.id));
    const parsed = issueSchema.safeParse(request.body);
    if (!parsed.success) return reply.send(errEnvelope(40001, parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), request.id));
    const { session_id } = parsed.data;
    if (core.accessor.get(ISessionManager).get(session_id) === undefined && await core.accessor.get(ISessionIndex).get(session_id) === undefined) {
      return reply.send(errEnvelope(40401, `session ${session_id} does not exist`, request.id));
    }
    if (!store.config().enabled) return reply.code(403).send(errEnvelope(40101, 'session_access_disabled', request.id));
    const { token, record } = store.issue({ ...parsed.data, channel: 'owner' });
    const { expires_at, scopes } = record;
    return reply.send(okEnvelope({ token, expires_at, session_id, scopes, server_id, server_version, session_access: 1 }, request.id));
  });
  app.delete<{ Params: { token_id: string } }>(`${path}/tokens/:token_id`, (request, reply) => {
    if (!store.config().enabled) return reply.code(403).send(errEnvelope(40101, 'session_access_disabled', request.id));
    return reply.send(okEnvelope({ revoked: store.revoke(request.params.token_id) }, request.id));
  });
  app.delete(`${path}/tokens`, (request, reply) => {
    if (!store.config().enabled) return reply.code(403).send(errEnvelope(40101, 'session_access_disabled', request.id));
    return reply.send(okEnvelope({ revoked: store.revokeAll() }, request.id));
  });
}
