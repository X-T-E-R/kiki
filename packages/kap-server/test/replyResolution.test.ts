import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import pino from 'pino';
import { afterEach, expect, it } from 'vitest';
import { createWireCompressionHook } from '../src/middleware/wireCompression';
import { installReplyResolution } from '../src/middleware/replyResolution';
import { registerNotificationRoutes } from '../src/routes/notifications';
import { registerImSessionRoutes } from '../src/routes/imSessions';
import type { NotificationService } from '../src/services/notifications/notificationService';
import type { ImSessionBridge } from '../src/services/imSession/bridge';

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function serve(register: (instance: FastifyInstance) => void) {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk: Buffer, _encoding, callback) { lines.push(chunk.toString()); callback(); } });
  const instance = Fastify({ loggerInstance: pino({ level: 'warn' }, stream) }) as unknown as FastifyInstance;
  installReplyResolution(instance);
  instance.addHook('onSend', async (_request, reply, payload) => { reply.header('x-content-type-options', 'nosniff'); return payload; });
  instance.addHook('onSend', createWireCompressionHook({ mode: 'always', thresholdBytes: 1 }));
  register(instance);
  await instance.listen({ port: 0, host: '127.0.0.1' });
  app = instance;
  const address = instance.server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  return { lines, get: async (path: string) => {
    const response = await fetch(base + path);
    const body = await response.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { status: response.status, body };
  } };
}

it('answers polled notification and IM channel routes exactly once', async () => {
  const service = { listCompletions: async () => ({ items: [] }) } as unknown as NotificationService;
  const bridge = { channelViews: async () => [] } as unknown as ImSessionBridge;
  const server = await serve((instance) => {
    registerNotificationRoutes(instance, service);
    registerImSessionRoutes(instance, bridge);
  });
  for (let index = 0; index < 3; index++) {
    expect((await server.get('/notifications/completions')).status).toBe(200);
    expect(JSON.parse((await server.get('/im/sessions/targets/session_a/channels')).body).code).toBe(0);
  }
  expect(server.lines.join('')).not.toMatch(/FST_ERR_REP_ALREADY_SENT|ERR_HTTP_HEADERS_SENT|already sent/u);
});

it('settles handlers that send from nested callbacks or helpers without resending', async () => {
  const sendLater = async (reply: FastifyReply, payload: unknown) => { await Promise.resolve(); reply.send(payload); };
  const server = await serve((instance) => {
    instance.get('/nested', async (_request, reply) => {
      await (async (send: (payload: unknown) => void) => { await Promise.resolve(); send({ ok: 'nested' }); })((payload) => { reply.send(payload); });
    });
    instance.get('/helper', async (_request, reply) => { await sendLater(reply, { ok: 'helper' }); });
    instance.get('/value', async () => ({ ok: 'value' }));
  });
  expect(JSON.parse((await server.get('/nested')).body)).toEqual({ ok: 'nested' });
  expect(JSON.parse((await server.get('/helper')).body)).toEqual({ ok: 'helper' });
  expect(JSON.parse((await server.get('/value')).body)).toEqual({ ok: 'value' });
  expect(server.lines.join('')).not.toMatch(/FST_ERR_REP_ALREADY_SENT|ERR_HTTP_HEADERS_SENT|already sent/u);
});
