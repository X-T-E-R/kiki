import type { FastifyInstance } from 'fastify';
import { webAccessEnableInputSchema, webAccessExchangeInputSchema } from '@kiki/protocol';
import { okEnvelope, errEnvelope } from '../envelope';
import { AdmissionError } from '../services/connections/admission';
import type { WebAccess } from '../services/webAccess';

export function registerWebAccessRoutes(app: FastifyInstance, web: WebAccess): void {
  const respond = async (requestId: string, reply: { header(key: string, value: string): unknown; code(status: number): unknown; send(value: unknown): unknown }, work: () => unknown) => {
    reply.header('cache-control', 'no-store');
    try { return reply.send(okEnvelope(await work(), requestId)); }
    catch (error) { if (!(error instanceof AdmissionError)) throw error; reply.code(error.status); return reply.send(errEnvelope(40101, error.reason, requestId)); }
  };
  app.get('/api/web-access', async (req, reply) => respond(req.id, reply, () => web.status()));
  app.put('/api/web-access', async (req, reply) => respond(req.id, reply, () => web.enable(webAccessEnableInputSchema.parse(req.body))));
  app.delete('/api/web-access', async (req, reply) => respond(req.id, reply, () => web.disable()));
  app.post('/api/web-access/links', async (req, reply) => respond(req.id, reply, () => web.issueLink()));
  app.post('/api/web-access/revoke', async (req, reply) => respond(req.id, reply, () => {
    const id = (req.body as { sessionId?: unknown })?.sessionId;
    if (id !== undefined && (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))) throw new AdmissionError(400, 'invalid_web_session_id');
    return web.revoke(id as string | undefined);
  }));
  app.get('/api/web-access/session', async (req, reply) => respond(req.id, reply, () => { const session = web.current(req.raw); return { authenticated: session !== null, session }; }));
  app.post('/api/web-access/exchange', { bodyLimit: 2048 }, async (req, reply) => respond(req.id, reply, async () => {
    const input = webAccessExchangeInputSchema.parse(req.body);
    const result = await web.exchange(input.code, req.raw, input.label);
    reply.header('set-cookie', result.cookie); return { authenticated: true, session: result.session };
  }));
  app.post('/api/web-access/logout', async (req, reply) => respond(req.id, reply, async () => {
    const cookie = web.clearCookie(req.raw); await web.logout(req.raw); reply.header('set-cookie', cookie); return { authenticated: false, session: null };
  }));
}
