import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ErrorCode,
  portableSpaceAddRecipientInputSchema,
  portableSpaceApplyInputSchema,
  portableSpaceCenterDirectSyncInputSchema,
  portableSpaceCenterSubscribeInputSchema,
  portableSpaceCenterTokenSyncInputSchema,
  portableSpaceDeltaInputSchema,
  portableSpaceExportInputSchema,
  portableSpaceForkInputSchema,
  portableSpaceInspectInputSchema,
  portableSpaceMutateInputSchema,
  portableSpacePackUnpackInputSchema,
  portableSpacePatchSourceInputSchema,
  portableSpacePreviewInputSchema,
  portableSpaceRegisterSourceInputSchema,
  portableSpaceRekeyInputSchema,
  portableSpaceRemoveReviewedInputSchema,
  portableSpaceReorderSourcesInputSchema,
  portableSpaceSourcePreviewInputSchema,
  portableSpaceSubscribeInputSchema,
  portableSpaceSubscribePreviewInputSchema,
  portableSpaceSubscriptionSyncInputSchema,
} from '@kiki/protocol';
import { errEnvelope, okEnvelope } from '../envelope';
import { authenticatedAuthorization } from '../middleware/auth';
import { matchesLocalOwner } from '../services/auth/localOwner';
import type { PortableSpaceService } from '../services/portableSpace/portableSpaceService';
import { PortableSpaceError, portableValidationError } from '../services/portableSpace/subscriptionErrors';

const ROOT = '/api/spaces/portable';
const CENTER_BODY_LIMIT = 3 * 1024 * 1024;
const SMALL_BODY_LIMIT = 128 * 1024;

function readViewQuery(request: FastifyRequest): 'center-v1' | undefined {
  const query = request.query as { readonly view?: unknown } | undefined;
  const view = query?.view;
  if (view === undefined || view === '') return undefined;
  if (view === 'center-v1') return 'center-v1';
  throw portableValidationError('Unsupported view query parameter');
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Registers host-local Portable Space operations under the local owner credential. */
export function registerPortableSpaceRoutes(app: FastifyInstance, service: PortableSpaceService, ownerToken: string): void {
  const handle = async <T>(request: FastifyRequest, reply: FastifyReply, run: () => Promise<T>) => {
    const match = /^Bearer (.+)$/.exec(authenticatedAuthorization(request) ?? '');
    reply.header('cache-control', 'no-store');
    if (!match || !matchesLocalOwner(match[1]!, ownerToken)) return reply.code(403).send(errEnvelope(40301, 'Local owner required for Portable Spaces', request.id));
    try {
      const data = await run();
      return await Promise.resolve(reply.send(okEnvelope(data, request.id)));
    } catch (error) {
      if (error instanceof PortableSpaceError) {
        return reply.code(error.httpStatus).send(errEnvelope(error.code, error.message, request.id));
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return reply.code(404).send(errEnvelope(ErrorCode.PORTABLE_NOT_FOUND, 'Portable Space endpoint not found', request.id));
      }
      if (error instanceof z.ZodError) {
        const issue = error.issues[0];
        const detail = issue ? `${issue.path.join('.') || 'root'}: ${issue.message}` : '';
        return reply.code(400).send(errEnvelope(40001, detail ? `Invalid Portable Space input or document (${detail})` : 'Invalid Portable Space input or document', request.id));
      }
      const message = typeof code === 'number' ? 'Portable Space Git operation failed' : error instanceof Error ? error.message.split('\n', 1)[0] : 'Portable Space operation failed';
      return reply.code(400).send(errEnvelope(40001, message ?? 'Portable Space operation failed', request.id));
    }
  };
  const post = <S extends z.ZodType>(path: string, schema: S, run: (body: z.output<S>) => Promise<unknown>, bodyLimit = SMALL_BODY_LIMIT) =>
    app.post(`${ROOT}/${path}`, { bodyLimit }, (req, reply) => handle(req, reply, () => run(schema.parse(req.body))));

  app.get(`${ROOT}/sources`, (req, reply) => handle<unknown>(req, reply, () => (
    readViewQuery(req) === 'center-v1' ? service.listCenter() : service.list()
  )));
  post('sources', portableSpaceRegisterSourceInputSchema, (input) => service.register(input));
  post('subscribe/preview', portableSpaceSubscribePreviewInputSchema, (input) => service.previewSubscribe(input));
  app.post(`${ROOT}/subscribe`, { bodyLimit: CENTER_BODY_LIMIT }, (req, reply) => handle<unknown>(req, reply, () => {
    if (isObjectRecord(req.body) && 'previewToken' in req.body) {
      return service.subscribeCenter(portableSpaceCenterSubscribeInputSchema.parse(req.body));
    }
    return service.subscribe(portableSpaceSubscribeInputSchema.parse(req.body));
  }));
  app.post<{ Params: { id: string } }>(`${ROOT}/sources/:id/preview`, { bodyLimit: CENTER_BODY_LIMIT }, (req, reply) => handle<unknown>(req, reply, () => (
    service.previewSource(req.params.id, portableSpaceSourcePreviewInputSchema.parse(req.body ?? {}))
  )));
  app.post<{ Params: { id: string } }>(`${ROOT}/sources/:id/sync`, { bodyLimit: CENTER_BODY_LIMIT }, (req, reply) => handle<unknown>(req, reply, () => {
    const view = readViewQuery(req);
    if (isObjectRecord(req.body) && 'previewToken' in req.body) {
      return service.syncSubscriptionCenter(req.params.id, portableSpaceCenterTokenSyncInputSchema.parse(req.body));
    }
    if (view === 'center-v1') {
      return service.syncSubscriptionCenter(req.params.id, portableSpaceCenterDirectSyncInputSchema.parse(req.body ?? {}));
    }
    return service.syncSubscription(req.params.id, portableSpaceSubscriptionSyncInputSchema.parse(req.body ?? {}));
  }));
  app.patch<{ Params: { id: string } }>(`${ROOT}/sources/:id`, { bodyLimit: CENTER_BODY_LIMIT }, (req, reply) => handle<unknown>(req, reply, () => (
    service.patchSource(req.params.id, portableSpacePatchSourceInputSchema.parse(req.body))
  )));
  post('sources/reorder', portableSpaceReorderSourcesInputSchema, (input) => service.reorderSources(input));
  app.post<{ Params: { id: string } }>(`${ROOT}/sources/:id/remove-preview`, { bodyLimit: SMALL_BODY_LIMIT }, (req, reply) => handle<unknown>(req, reply, () => (
    service.previewRemoveSource(req.params.id)
  )));
  app.delete<{ Params: { id: string } }>(`${ROOT}/sources/:id`, { bodyLimit: SMALL_BODY_LIMIT }, (req, reply) => handle<unknown>(req, reply, () => {
    if (req.body === undefined || req.body === null || (typeof req.body === 'string' && req.body.trim().length === 0)) {
      return service.remove(req.params.id);
    }
    return service.removeReviewedSource(req.params.id, portableSpaceRemoveReviewedInputSchema.parse(req.body));
  }));
  post('inspect', portableSpaceInspectInputSchema, (input) => service.inspect(input));
  post('export', portableSpaceExportInputSchema, (input) => service.export(input));
  post('preview', portableSpacePreviewInputSchema, (input) => service.preview(input));
  post('apply', portableSpaceApplyInputSchema, (input) => service.apply(input));
  post('pack', portableSpacePackUnpackInputSchema, (input) => service.pack({ ...input, action: 'pack' }));
  post('unpack', portableSpacePackUnpackInputSchema, (input) => service.pack({ ...input, action: 'unpack' }));
  post('fork', portableSpaceForkInputSchema, (input) => service.fork(input));
  post('delta', portableSpaceDeltaInputSchema, (input) => service.delta(input));
  post('mutate', portableSpaceMutateInputSchema, (input) => service.mutate(input), 8 * 1024 * 1024);
  post('rekey', portableSpaceRekeyInputSchema, (input) => service.rekey(input));
  post('recipients', portableSpaceAddRecipientInputSchema, ({ recipient, label }) => service.addRecipient(recipient, label));
}
