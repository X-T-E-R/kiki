import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { okEnvelope, errEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';
import type { NotificationService } from '../services/notifications/notificationService';
import type { NotificationChannel, NotificationGlobalSettings, NotificationInstance, NotificationCredentialSlot } from '@kiki/klient';

const identifier = z.string().regex(/^[a-zA-Z0-9_.:-]{1,120}$/u);
const routeId = (req: FastifyRequest, action?: 'check' | 'test'): string => {
  const params = req.params as Record<string, unknown>;
  const raw = params['id'] ?? (action === undefined ? undefined : params[`id::${action}`]);
  return identifier.parse(action && typeof raw === 'string' && raw.endsWith(`:${action}`) ? raw.slice(0, -action.length - 1) : raw);
};
const globalSettings = z.object({
  enabled: z.boolean(), suppress_viewing_session: z.boolean(),
  min_work_ms: z.number().int().min(0).max(86_400_000),
  work_stable_ms: z.number().int().min(100).max(60_000),
  question_delay_ms: z.number().int().min(100).max(600_000),
  quiet_hours: z.object({ start: z.string(), end: z.string(), time_zone: z.string() }).strict().optional(),
}).strict();
const instanceSchema = z.object({ provider_id: identifier, enabled: z.boolean(), revision: identifier,
  options: z.record(z.string(), z.unknown()), label: z.string().min(1).max(120).optional() }).strict();
const slotSchema = z.object({ provider_id: identifier, provider_instance_id: identifier,
  purpose: identifier, env: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u) }).strict();
const channelSchema = z.object({ provider_instance_id: identifier, enabled: z.boolean(), revision: identifier,
  target: z.record(z.string(), z.unknown()), directions: z.tuple([z.literal('send')]),
  scenes: z.object({ work_complete: z.boolean(), question_pending: z.boolean() }).strict(),
  label: z.string().min(1).max(120).optional() }).strict();

export function registerNotificationRoutes(app: FastifyInstance, service: NotificationService): void {
  const respond = async (req: FastifyRequest, reply: FastifyReply, operation: () => Promise<unknown> | object): Promise<void> => {
    try { reply.send(okEnvelope(await operation(), req.id)); }
    catch (error) {
      if (error instanceof z.ZodError) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; '), req.id));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const validation = /^(?:invalid_|unknown_|channel_unavailable|credential_unavailable)/u.test(message);
      const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
      reply.send(errEnvelope(validation ? ErrorCode.VALIDATION_FAILED : ErrorCode.INTERNAL_ERROR,
        code === undefined ? message : `${code}: ${message}`, req.id));
    }
  };
  app.get('/notifications/completions', (req, reply) => respond(req, reply, () => service.listCompletions()));
  app.get('/notifications/settings', (req, reply) => respond(req, reply, () => service.getSettings()));
  app.put('/notifications/settings', (req, reply) => respond(req, reply, () =>
    service.updateSettings(globalSettings.parse(req.body) as NotificationGlobalSettings)));
  app.get('/notifications/providers', (req, reply) => respond(req, reply, () => service.listProviders()));
  app.put('/notifications/instances/:id', (req, reply) => respond(req, reply, () => {
    const body = z.object({ instance: instanceSchema, slots: z.record(identifier, slotSchema) }).strict().parse(req.body);
    return service.upsertInstance(routeId(req), body.instance as NotificationInstance,
      body.slots as Record<string, Omit<NotificationCredentialSlot, 'configured'>>);
  }));
  app.delete('/notifications/instances/:id', (req, reply) => respond(req, reply, () => service.deleteInstance(routeId(req))));
  app.post('/notifications/instances/:id::check', (req, reply) => respond(req, reply, () => service.checkCredential(routeId(req, 'check'))));
  app.put('/notifications/channels/:id', (req, reply) => respond(req, reply, () =>
    service.upsertChannel(routeId(req), channelSchema.parse(req.body) as NotificationChannel)));
  app.delete('/notifications/channels/:id', (req, reply) => respond(req, reply, () => service.deleteChannel(routeId(req))));
  app.put('/notifications/credentials/:id', (req, reply) => respond(req, reply, () => {
    const { value } = z.object({ value: z.string().min(1).max(8192).nullable() }).strict().parse(req.body);
    return service.setCredential(routeId(req), value);
  }));
  app.post('/notifications/channels/:id::test', (req, reply) => respond(req, reply, () => service.sendTest(routeId(req, 'test'))));
  app.get('/notifications/deliveries', (req, reply) => respond(req, reply, () => {
    const query = z.object({ channel_id: identifier.optional() }).strict().parse(req.query);
    return service.listDeliveries(query.channel_id);
  }));
}
