import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  portableSpaceApplyInputSchema, portableSpaceDeltaInputSchema, portableSpaceExportInputSchema,
  portableSpaceForkInputSchema, portableSpaceInspectInputSchema, portableSpaceMutateInputSchema,
  portableSpacePackUnpackInputSchema, portableSpacePreviewInputSchema, portableSpaceRegisterSourceInputSchema,
  portableSpaceRekeyInputSchema, portableSpaceSubscribeInputSchema, portableSpaceSubscriptionSyncInputSchema,
} from '@kiki/protocol';
import { errEnvelope, okEnvelope } from '../envelope';
import { authenticatedAuthorization } from '../middleware/auth';
import { matchesLocalOwner } from '../services/auth/localOwner';
import type { PortableSpaceService } from '../services/portableSpace/portableSpaceService';

const ROOT = '/api/spaces/portable';
const recipientSchema = z.object({ recipient: z.string().regex(/^age1[a-z0-9]+$/), label: z.string().min(1).max(128).optional() }).strict();

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
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return reply.code(404).send(errEnvelope(40401, 'Portable Space endpoint not found', request.id));
      if (error instanceof z.ZodError) {
        const issue = error.issues[0];
        const detail = issue ? `${issue.path.join('.') || 'root'}: ${issue.message}` : '';
        return reply.code(400).send(errEnvelope(40001, detail ? `Invalid Portable Space input or document (${detail})` : 'Invalid Portable Space input or document', request.id));
      }
      const message = typeof code === 'number' ? 'Portable Space Git operation failed' : error instanceof Error ? error.message.split('\n', 1)[0] : 'Portable Space operation failed';
      return reply.code(400).send(errEnvelope(40001, message ?? 'Portable Space operation failed', request.id));
    }
  };
  const post = <S extends z.ZodType>(path: string, schema: S, run: (body: z.output<S>) => Promise<unknown>, bodyLimit = 128 * 1024) =>
    app.post(`${ROOT}/${path}`, { bodyLimit }, (req, reply) => handle(req, reply, () => run(schema.parse(req.body))));

  app.get(`${ROOT}/sources`, (req, reply) => handle(req, reply, () => service.list()));
  post('sources', portableSpaceRegisterSourceInputSchema, (input) => service.register(input));
  post('subscribe', portableSpaceSubscribeInputSchema, (input) => service.subscribe(input));
  app.post<{ Params: { id: string } }>(`${ROOT}/sources/:id/sync`, { bodyLimit: 128 * 1024 }, (req, reply) =>
    handle(req, reply, () => service.syncSubscription(req.params.id, portableSpaceSubscriptionSyncInputSchema.parse(req.body ?? {}))),
  );
  app.delete<{ Params: { id: string } }>(`${ROOT}/sources/:id`, (req, reply) => handle(req, reply, () => service.remove(req.params.id)));
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
  post('recipients', recipientSchema, ({ recipient, label }) => service.addRecipient(recipient, label));
}
