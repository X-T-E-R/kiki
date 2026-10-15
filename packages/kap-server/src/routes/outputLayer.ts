import { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { IOutputLayerService, type Scope } from '@kiki/agent-core-v2';
import { outputLayerConfigurationSchema, outputLayerRequestSchema } from '@kiki/protocol';
import { defineRoute } from '../middleware/defineRoute';
import { okEnvelope } from '../envelope';

type RouteHandler = (req: { id: string; body: unknown }, reply: { send(payload: unknown): unknown }) => Promise<void> | void;
interface OutputLayerRouteHost {
  get(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: RouteHandler): unknown;
  put(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: RouteHandler): unknown;
  post(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: RouteHandler): unknown;
}

export function registerOutputLayerRoutes(app: OutputLayerRouteHost, core: Scope): void {
  const configuration = defineRoute({
    method: 'GET', path: '/output-layer/configuration', querystring: z.object({ session_id: z.string().min(1).optional() }),
    success: { data: outputLayerConfigurationSchema }, errors: {},
    description: 'Read enabled output-layer plugin presets and display settings', tags: ['plugins'],
  }, async (req, reply) => {
    reply.send(okEnvelope(await core.accessor.get(IOutputLayerService).configuration(req.query.session_id), req.id));
  });
  app.get(configuration.path, configuration.options, configuration.handler as RouteHandler);

  const configure = defineRoute({
    method: 'PUT', path: '/output-layer/configuration',
    body: outputLayerConfigurationSchema.pick({ presets: true, settings: true }),
    success: { data: outputLayerConfigurationSchema }, errors: {},
    description: 'Save output-layer plugin presets and display settings', tags: ['plugins'],
  }, async (req, reply) => {
    reply.send(okEnvelope(await core.accessor.get(IOutputLayerService).configure(req.body), req.id));
  });
  app.put(configure.path, configure.options, configure.handler as RouteHandler);

  const stream = defineRoute({
    method: 'POST', path: '/output-layer/stream', body: outputLayerRequestSchema,
    success: { data: z.unknown() }, errors: {},
    description: 'Transform only supplied Assistant-visible text in an independent NDJSON stream', tags: ['plugins'],
  }, async (req, response) => {
    const reply = response as FastifyReply;
    const controller = new AbortController();
    const onClose = () => controller.abort();
    reply.raw.once('close', onClose);
    const source = core.accessor.get(IOutputLayerService).stream(req.body, controller.signal);
    async function* encode() {
      try { for await (const event of source) yield `${JSON.stringify(event)}\n`; }
      finally { reply.raw.off('close', onClose); }
    }
    reply.header('content-type', 'application/x-ndjson; charset=utf-8');
    reply.header('cache-control', 'no-store');
    reply.send(Readable.from(encode()));
  });
  app.post(stream.path, stream.options, stream.handler as RouteHandler);
}
