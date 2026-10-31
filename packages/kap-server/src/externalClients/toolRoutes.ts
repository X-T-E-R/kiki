import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from '../routes/action-suffix';
import { withReplyCloseSignal } from '../procedures/requestSignal';
import { ExternalClientError } from './contracts';
import type { ExternalClientHost } from './host';
import type { ExternalClientGrant } from '../mcp/externalClientTransport/host';

const grants = new WeakMap<object, ExternalClientGrant>();
const base = '/external-clients';
const callSchema = z
  .object({
    arguments: z.record(z.string(), z.unknown()),
    session_ref: z.string().optional(),
    idempotency_key: z.string().min(1).max(256).optional(),
  })
  .strict();
const rangeSchema = z
  .object({
    part: z.coerce.number().int().min(0).optional(),
    artifact: z.coerce.number().int().min(0).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(256_000).optional(),
  })
  .strict();

export function isExternalClientToolRequest(method: string, path: string): boolean {
  return (
    (method === 'GET' &&
      (path === `/api${base}/tools` || /^\/api\/external-clients\/jobs\/[^/]+(?:\/result)?$/.test(path))) ||
    (method === 'POST' && /^\/api\/external-clients\/tools\/[^/]+:call$/.test(path))
  );
}

export async function authorizeExternalClientToolRequest(
  host: ExternalClientHost,
  token: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const address = request.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
    await reply.code(403).send(errEnvelope(40101, 'Connection credentials require a loopback request.', request.id));
    return false;
  }
  const grant = await host.resolveBearer(token);
  if (grant === null) {
    await reply.code(401).send(errEnvelope(40101, 'External connection credential is unavailable or expired.', request.id));
    return false;
  }
  grants.set(request, grant);
  return true;
}

export function registerExternalClientToolRoutes(
  app: FastifyInstance,
  host: ExternalClientHost,
  enabled: () => boolean,
): void {
  const invoke =
    (
      work: (
        grant: ExternalClientGrant,
        request: FastifyRequest,
        signal: AbortSignal,
      ) => Promise<unknown>,
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('cache-control', 'no-store');
      try {
        if (!enabled()) {
          throw new ExternalClientError('external_clients_disabled', 'External clients are disabled.');
        }
        const authenticated = grants.get(request);
        const grant = authenticated === undefined ? null : await host.resolveGrant(authenticated.id);
        if (grant === null) {
          return await reply.code(401).send(errEnvelope(40101, 'External connection is unavailable.', request.id));
        }
        const result = await withReplyCloseSignal(reply, (signal) => work(grant, request, signal), request);
        return await reply.send(okEnvelope(result, request.id));
      } catch (error) {
        if (!(error instanceof ExternalClientError) && !(error instanceof z.ZodError)) {
          throw error;
        }
        return reply.send({
          ...errEnvelope(40001, error.message, request.id),
          details: {
            code: error instanceof ExternalClientError ? error.code : 'invalid_input',
          },
        });
      }
    };
  const call = async (
    grant: ExternalClientGrant,
    name: string,
    args: Record<string, unknown>,
    request: FastifyRequest,
    signal: AbortSignal,
  ) => {
    const descriptor = (await host.catalog(grant)).find((tool) => tool.name === name);
    if (descriptor === undefined) {
      throw new ExternalClientError('tool_unavailable', 'Tool is not shared with this connection.');
    }
    return host.call(grant, descriptor.name, args, { requestId: request.id }, signal);
  };
  const tools = defineRoute(
    {
      method: 'GET',
      path: `${base}/tools`,
      tags: ['external-clients'],
      description: 'List the current connection tool grant',
    },
    () => {},
  );
  app.get(
    tools.path,
    tools.options as RouteShorthandOptions,
    invoke(async (grant) => ({ tools: await host.catalog(grant) })),
  );
  const submit = defineRoute(
    {
      method: 'POST',
      path: `${base}/tools/{name_action}`,
      params: z.object({ name_action: z.string().min(1) }),
      body: callSchema,
      tags: ['external-clients'],
      description:
        'Call a tool at tools/{name}:call using an external connection credential and stable idempotency key',
    },
    () => {},
  );
  app.post(
    submit.path,
    submit.options as RouteShorthandOptions,
    invoke(async (grant, request, signal) => {
      const { name_action: tail } = z.object({ name_action: z.string() }).parse(request.params);
      const parsed = parseActionSuffix({ tail, allowedActions: ['call'], resourceLabel: 'tool' });
      if (parsed.kind !== 'action') {
        throw new ExternalClientError(
          'invalid_action',
          parsed.kind === 'invalid' ? parsed.reason : 'Use the :call action.',
        );
      }
      const body = callSchema.parse(request.body);
      if (body.arguments['_kiki'] !== undefined) {
        throw new ExternalClientError('invalid_bridge', 'Use the top-level session_ref and idempotency_key fields.');
      }
      return call(
        grant,
        parsed.id,
        {
          ...body.arguments,
          _kiki: {
            session_ref: body.session_ref,
            idempotency_key: body.idempotency_key,
          },
        },
        request,
        signal,
      );
    }),
  );
  const job = defineRoute(
    {
      method: 'GET',
      path: `${base}/jobs/{id}`,
      params: z.object({ id: z.string().min(1) }),
      tags: ['external-clients'],
      description: 'Read an accepted operation without resubmission',
    },
    () => {},
  );
  app.get(
    job.path,
    job.options as RouteShorthandOptions,
    invoke((grant, request, signal) =>
      call(
        grant,
        'kiki_operation',
        { operation_id: z.object({ id: z.string() }).parse(request.params).id },
        request,
        signal,
      ),
    ),
  );
  const result = defineRoute(
    {
      method: 'GET',
      path: `${base}/jobs/{id}/result`,
      params: z.object({ id: z.string().min(1) }),
      querystring: rangeSchema,
      tags: ['external-clients'],
      description: 'Page saved text, historical media or a generated artifact',
    },
    () => {},
  );
  app.get(
    result.path,
    result.options as RouteShorthandOptions,
    invoke((grant, request, signal) =>
      call(
        grant,
        'kiki_operation',
        {
          operation_id: z.object({ id: z.string() }).parse(request.params).id,
          action: 'read',
          ...rangeSchema.parse(request.query),
        },
        request,
        signal,
      ),
    ),
  );
}
