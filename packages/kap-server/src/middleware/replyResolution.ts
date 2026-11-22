import type { FastifyInstance, FastifyReply, RouteOptions } from 'fastify';

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function';

/**
 * Settle every promise-returning route handler with the reply once it has started sending.
 *
 * Fastify still sends a handler's resolved value after the handler called `reply.send`
 * while asynchronous hooks are finishing the first send, which surfaces as
 * `FST_ERR_REP_ALREADY_SENT`. A rejection before the first send keeps the normal error
 * path; one after it is logged because the response is already committed.
 * Install before any route is registered.
 */
export function installReplyResolution(app: FastifyInstance): void {
  const started = new WeakSet<FastifyReply>();
  app.addHook('onRequest', (_request, reply, done) => {
    const send = reply.send.bind(reply);
    reply.send = (payload?: unknown) => {
      started.add(reply);
      return send(payload);
    };
    done();
  });
  app.addHook('onRoute', (route: RouteOptions) => {
    const handler = route.handler;
    route.handler = function (this: FastifyInstance, request, reply) {
      const result: unknown = handler.call(this, request, reply);
      if (!isPromiseLike(result)) return result;
      return Promise.resolve(result).then(
        (value) => (started.has(reply) ? reply : value),
        (error: unknown) => {
          if (!started.has(reply)) throw error;
          request.log.error({ err: error }, 'route handler failed after its reply started');
          return reply;
        },
      );
    };
  });
}
