import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { defineRoute } from '../src/middleware/defineRoute';

it('finishes an imperative async route once after asynchronous response hooks', async () => {
  const app = Fastify();
  let sends = 0;
  app.addHook('onSend', async (_req, reply, payload) => {
    sends++;
    reply.header('x-content-type-options', 'nosniff');
    return payload;
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('referrer-policy', 'no-referrer');
    return payload;
  });
  const route = defineRoute({ method: 'GET', path: '/fixture' }, async (_req, reply) => {
    await Promise.resolve();
    reply.send({ code: 0, data: 'result' });
  });
  app.get(route.path, route.handler);
  try {
    const response = await app.inject('/fixture');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ code: 0, data: 'result' });
    expect(response.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    expect(sends).toBe(1);
  } finally {
    await app.close();
  }
});
