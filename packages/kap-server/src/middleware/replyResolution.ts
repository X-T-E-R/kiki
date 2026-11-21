import type { FastifyInstance, FastifyReply, RouteOptions } from 'fastify';

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function';

/**
 * Settle every promise-returning route handler with the reply once it has sent one.
 *
 * Fastify resends `undefined` when an async handler resolves without a value while
 * asynchronous `onSend` hooks are still finishing the first send, which surfaces as
 * `FST_ERR_REP_ALREADY_SENT`. Install before any route or `onSend` hook is registered.
 */
export function installReplyResolution(app: FastifyInstance): void {
  const sending = new WeakSet<FastifyReply>();
  app.addHook('onSend', (_request, reply, payload, done) => {
    sending.add(reply);
    done(null, payload);
  });
  app.addHook('onRoute', (route: RouteOptions) => {
    const handler = route.handler;
    route.handler = function (this: FastifyInstance, request, reply) {
      const result: unknown = handler.call(this, request, reply);
      if (!isPromiseLike(result)) return result;
      return Promise.resolve(result).then((value) => (value === undefined && sending.has(reply) ? reply : value));
    };
  });
}
