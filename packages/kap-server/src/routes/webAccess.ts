import type { FastifyInstance } from 'fastify';
import { webAccessEnableInputSchema, webAccessExchangeInputSchema, webAccessSharedConnectionsInputSchema } from '@kiki/protocol';
import { okEnvelope, errEnvelope } from '../envelope';
import { AdmissionError } from '../services/connections/admission';
import type { WebAccess } from '../services/webAccess';

export function registerWebAccessRoutes(app: FastifyInstance, web: WebAccess): void {
  const respond = async (requestId: string, reply: { header(key: string, value: string): unknown; code(status: number): unknown; send(value: unknown): unknown }, work: () => unknown) => {
    reply.header('cache-control', 'no-store');
    try { return reply.send(okEnvelope(await work(), requestId)); }
    catch (error) { if (!(error instanceof AdmissionError)) throw error; reply.code(error.status); return reply.send(errEnvelope(40101, error.reason, requestId)); }
  };
  app.register(async (scope) => {
    scope.setErrorHandler((err, req, reply) => {
      reply.header('cache-control', 'no-store');
      if (err instanceof AdmissionError) return reply.code(err.status).send(errEnvelope(40101, err.reason, req.id));
      if (typeof (err as { statusCode?: unknown }).statusCode === 'number' && (err as { statusCode: number }).statusCode >= 400 && (err as { statusCode: number }).statusCode < 500) {
        return reply.code(400).send(errEnvelope(40101, 'invalid_web_access_input', req.id));
      }
      throw err;
    });
    scope.get('/api/web-access', async (req, reply) => respond(req.id, reply, () => web.status()));
    scope.put('/api/web-access', async (req, reply) => respond(req.id, reply, () => {
      const parsed = webAccessEnableInputSchema.safeParse(req.body);
      if (!parsed.success) throw new AdmissionError(400, 'invalid_web_access_input');
      return web.enable(parsed.data);
    }));
    scope.delete('/api/web-access', async (req, reply) => respond(req.id, reply, () => web.disable()));
    scope.put('/api/web-access/shared-connections', async (req, reply) => respond(req.id, reply, () => {
      const parsed = webAccessSharedConnectionsInputSchema.safeParse(req.body);
      if (!parsed.success) throw new AdmissionError(400, 'invalid_web_access_input');
      return web.setSharedConnections(parsed.data.connectionIds);
    }));
    scope.post('/api/web-access/links', async (req, reply) => respond(req.id, reply, () => web.issueLink()));
    scope.post('/api/web-access/revoke', async (req, reply) => respond(req.id, reply, () => {
      const id = (req.body as { sessionId?: unknown })?.sessionId;
      if (id !== undefined && (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))) throw new AdmissionError(400, 'invalid_web_session_id');
      return web.revoke(id as string | undefined);
    }));
    scope.get('/api/web-access/session', async (req, reply) => respond(req.id, reply, () => { const session = web.current(req.raw); return { authenticated: session !== null, session }; }));
    scope.post('/api/web-access/exchange', { bodyLimit: 2048 }, async (req, reply) => respond(req.id, reply, async () => {
      const parsed = webAccessExchangeInputSchema.safeParse(req.body);
      if (!parsed.success) throw new AdmissionError(400, 'invalid_web_access_exchange_input');
      const result = await web.exchange(parsed.data.code, req.raw, parsed.data.label);
      reply.header('set-cookie', result.cookie); return { authenticated: true, session: result.session };
    }));
    scope.post('/api/web-access/logout', async (req, reply) => respond(req.id, reply, async () => {
      const cookie = web.clearCookie(req.raw); await web.logout(req.raw); reply.header('set-cookie', cookie); return { authenticated: false, session: null };
    }));
  });
}
