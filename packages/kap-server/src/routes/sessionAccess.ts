import { ISessionIndex, ISessionManager, type Scope } from '@kiki/agent-core-v2';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { errEnvelope, okEnvelope } from '../envelope';
import {
  sessionAccessBudgetSchema,
  sessionAccessClientSchema,
  sessionAccessScopesSchema,
  type SessionAccessStore,
} from '../services/sessionAccess/store';

const issueSchema = z.object({
  session_id: z.string().min(1).optional(),
  scopes: sessionAccessScopesSchema,
  client: sessionAccessClientSchema,
  ttl_seconds: z.number().int().min(60).max(31_536_000).default(3600),
  budget: sessionAccessBudgetSchema.optional(),
  persistent: z.boolean().optional(),
}).strict();

export function registerSessionAccessRoutes(app: FastifyInstance, core: Scope, store: SessionAccessStore, server_id: string, server_version: string): void {
  const path = '/api/session-access';
  app.get(path, async (request, reply) => {
    await store.ready;
    const { enabled, terminalHandoff, terminalControl } = store.config();
    return reply.send(okEnvelope({
      version: 2,
      enabled,
      terminal_handoff: terminalHandoff,
      terminal_control: terminalControl,
      server_id,
      tokens: store.list(),
    }, request.id));
  });
  app.post(`${path}/tokens`, async (request, reply) => {
    await store.ready;
    if (!store.config().enabled) return reply.code(403).send(errEnvelope(40101, 'session_access_disabled', request.id));
    const parsed = issueSchema.safeParse(request.body);
    if (!parsed.success) return reply.send(errEnvelope(40001, parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), request.id));
    const { session_id } = parsed.data;
    if (session_id === undefined && parsed.data.persistent !== true && !parsed.data.scopes.includes('llm')) {
      return reply.send(errEnvelope(40001, 'session_id: Required unless persistent or llm scope is requested', request.id));
    }
    if (session_id !== undefined && core.accessor.get(ISessionManager).get(session_id) === undefined && await core.accessor.get(ISessionIndex).get(session_id) === undefined) {
      return reply.send(errEnvelope(40401, `session ${session_id} does not exist`, request.id));
    }
    if (!store.config().enabled) return reply.code(403).send(errEnvelope(40101, 'session_access_disabled', request.id));
    const { token, record } = store.issue({ ...parsed.data, channel: 'owner' });
    if (record.persistent === true) await store.flushPersisted();
    const { expires_at, scopes, id, budget, persistent } = record;
    return reply.send(okEnvelope({
      id,
      token,
      expires_at,
      ...(session_id === undefined ? {} : { session_id }),
      scopes,
      ...(budget === undefined ? {} : { budget }),
      ...(persistent === true ? { persistent: true } : {}),
      server_id,
      server_version,
      session_access: 2,
    }, request.id));
  });
  app.delete<{ Params: { token_id: string } }>(`${path}/tokens/:token_id`, async (request, reply) => {
    await store.ready;
    if (!store.config().enabled) return reply.code(403).send(errEnvelope(40101, 'session_access_disabled', request.id));
    const revoked = store.revoke(request.params.token_id);
    await store.flushPersisted();
    return reply.send(okEnvelope({ revoked }, request.id));
  });
  app.delete(`${path}/tokens`, async (request, reply) => {
    await store.ready;
    if (!store.config().enabled) return reply.code(403).send(errEnvelope(40101, 'session_access_disabled', request.id));
    const revoked = store.revokeAll();
    await store.flushPersisted();
    return reply.send(okEnvelope({ revoked }, request.id));
  });
}
