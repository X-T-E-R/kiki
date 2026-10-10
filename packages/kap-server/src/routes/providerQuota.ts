import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { providerQuotaEnableSchema, providerQuotaSelectSchema, providerQuotaSnapshotSchema } from '@kiki/protocol';
import { okEnvelope, errEnvelope } from '../envelope';
import type { ProviderQuotaService } from '../usage/quota/service';

export function registerProviderQuotaRoutes(app: FastifyInstance, service: ProviderQuotaService): void {
  const respond = async (id: string, reply: { header(name: string, value: string): unknown; send(value: unknown): unknown }, work: () => Promise<unknown>) => {
    reply.header('cache-control', 'no-store');
    try { return reply.send(okEnvelope(providerQuotaSnapshotSchema.parse(await work()), id)); }
    catch (error) {
      const reason = error instanceof z.ZodError ? 'invalid-quota-input' : error instanceof Error && error.message === 'quota_source_not_found' ? 'quota-source-not-found' : 'quota-operation-failed';
      return reply.send(errEnvelope(reason === 'quota-source-not-found' ? 40401 : 40001, reason, id));
    }
  };
  app.get('/api/usage/provider-quotas', (req, reply) => respond(req.id, reply, () => service.snapshot()));
  app.post('/api/usage/provider-quotas/refresh', { bodyLimit: 2048 }, (req, reply) => respond(req.id, reply, () => service.refresh(providerQuotaSelectSchema.parse(req.body).source_id)));
  app.put('/api/usage/provider-quotas/enabled', { bodyLimit: 2048 }, (req, reply) => respond(req.id, reply, () => {
    const input = providerQuotaEnableSchema.parse(req.body);
    return service.setEnabled(input.source_id, input.enabled);
  }));
}
