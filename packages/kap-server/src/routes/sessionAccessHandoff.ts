import { ISessionIndex, ISessionManager, type Scope } from '@kiki/agent-core-v2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { errEnvelope, okEnvelope } from '../envelope';
import type { SessionAccessHandoff } from '../services/sessionAccess/handoff';
import { sessionAccessClientSchema, type SessionAccessStore } from '../services/sessionAccess/store';

const holderId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const sessionId = z.string().min(1);
const challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const verifier = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
const ticketSchema = z.object({ session_id: sessionId, challenge, holder_id: holderId }).strict();
const releaseSchema = z.object({ holder_id: holderId, session_id: sessionId.optional() }).strict();
const exchangeSchema = z.object({ ticket: challenge, verifier, client: sessionAccessClientSchema }).strict();

function invalidTicket(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(401).send(errEnvelope(40101, 'invalid_ticket', request.id));
}

function invalidBody(error: z.ZodError, request: FastifyRequest, reply: FastifyReply) {
  return reply.send(errEnvelope(40001, error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), request.id));
}

function disabled(request: FastifyRequest, reply: FastifyReply) {
  return reply.code(403).send(errEnvelope(40101, 'session_access_disabled', request.id));
}

export function registerSessionAccessHandoffRoutes(app: FastifyInstance, deps: {
  core: Scope; store: SessionAccessStore; handoff: SessionAccessHandoff;
  server_id: string; server_version: string; canExchange: (request: IncomingMessage) => boolean;
}): void {
  const { core, store, handoff, server_id, server_version, canExchange } = deps;
  const path = '/api/session-access';
  const enabled = () => { const config = store.config(); return config.enabled && config.terminalHandoff; };
  app.post(`${path}/tickets`, async (request, reply) => {
    if (!enabled()) return disabled(request, reply);
    const parsed = ticketSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(parsed.error, request, reply);
    const { session_id, challenge, holder_id } = parsed.data;
    if (!handoff.present(holder_id)) return reply.code(409).send(errEnvelope(40901, 'holder_not_present', request.id));
    if (core.accessor.get(ISessionManager).get(session_id) === undefined && await core.accessor.get(ISessionIndex).get(session_id) === undefined) {
      return reply.send(errEnvelope(40401, `session ${session_id} does not exist`, request.id));
    }
    if (!enabled()) return disabled(request, reply);
    if (!handoff.present(holder_id)) return reply.code(409).send(errEnvelope(40901, 'holder_not_present', request.id));
    return reply.send(okEnvelope(handoff.issue(session_id, challenge, holder_id), request.id));
  });
  app.get<{ Params: { holder_id: string } }>(`${path}/holders/:holder_id/presence`, (request, reply) => {
    if (!store.config().enabled) return disabled(request, reply);
    const parsed = holderId.safeParse(request.params.holder_id);
    if (!parsed.success) return reply.send(errEnvelope(40001, 'Invalid holder_id', request.id));
    reply.hijack();
    reply.raw.once('close', handoff.attach(parsed.data, () => reply.raw.end()));
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    reply.raw.write('event: ready\ndata: {}\n\n');
  });
  app.post(`${path}/release`, (request, reply) => {
    if (!store.config().enabled) return disabled(request, reply);
    const parsed = releaseSchema.safeParse(request.body);
    if (!parsed.success) return invalidBody(parsed.error, request, reply);
    return reply.send(okEnvelope({ revoked: handoff.release(parsed.data.holder_id, parsed.data.session_id) }, request.id));
  });
  app.post(`${path}/exchange`, { errorHandler: (_error, request, reply) => { void invalidTicket(request, reply); } }, (request, reply) => {
    const named = (request.body as { ticket?: unknown } | null | undefined)?.ticket;
    const ticket = typeof named === 'string' ? handoff.consume(named) : undefined;
    const parsed = exchangeSchema.safeParse(request.body);
    if (!parsed.success || !enabled() || !canExchange(request.raw)) return invalidTicket(request, reply);
    const issued = handoff.exchange(ticket, parsed.data.verifier, parsed.data.client);
    if (issued === undefined) return invalidTicket(request, reply);
    const { token, record: { expires_at, session_id, scopes } } = issued;
    return reply.send(okEnvelope({ token, expires_at, session_id, scopes, server_id, server_version, session_access: 1 }, request.id));
  });
}
