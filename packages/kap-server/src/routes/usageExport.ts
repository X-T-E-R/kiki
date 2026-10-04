import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { usageExportConsentSchema, usageExportHandoffArmSchema, usageExportSaveSchema, usageExportScopeSchema } from '@kiki/protocol';
import { okEnvelope, errEnvelope } from '../envelope';
import type { UsageExportService } from '../usage/export/service';

export function registerUsageExportRoutes(app: FastifyInstance, service: UsageExportService): void {
  const prefix = '/api/usage-export';
  const id = (params: unknown): string => z.object({ id: z.string().uuid() }).parse(params).id;
  const respond = async (requestId: string, reply: { code(status: number): unknown; header(name: string, value: string): unknown; send(value: unknown): unknown }, work: () => unknown) => {
    reply.header('cache-control', 'no-store');
    try { return reply.send(okEnvelope(await work(), requestId)); }
    catch (error) {
      const allowed = new Set(['destination-not-found', 'consent-preview-changed', 'adapter-unavailable', 'private-file-storage-requires-consent', 'identity-change-requires-new-destination', 'destination-cannot-delete', 'clear-queue-requires-consent', 'withdraw-requires-consent', 'export-writer-unavailable', 'export-queue-full', 'invalid-queue-capacity', 'unsafe_endpoint', 'endpoint-query-not-allowed', 'bearer-requires-https', 'remove-requires-queue-consent', 'credential-unavailable', 'keyring-unavailable', 'handoff-use-arm', 'handoff-scope-crosses-cutoff', 'handoff-consent-changed', 'handoff-requires-new-vibe-draft', 'handoff-source-home-unavailable', 'handoff-not-found', 'handoff-rollback-requires-consent', 'handoff-missed-unarmed-cutoff', 'handoff-rollback-boundary-unproven', 'collector-proof-too-large', 'collector-identity-cutoff-unproven', 'collector-receipt-identity-unproven', 'handoff_future_boundary_required', 'handoff_readiness_unproven', 'handoff_legacy_cutoff_unproven', 'handoff_native_receipt_unconfirmed', 'handoff_rollback_new_boundary_required', 'handoff_scope_empty']);
      const category = error instanceof z.ZodError ? 'invalid-usage-export-input' : error instanceof Error && allowed.has(error.message) ? error.message : 'usage-export-operation-failed';
      reply.code(category === 'destination-not-found' ? 404 : category === 'export-writer-unavailable' ? 409 : 400); return reply.send(errEnvelope(40001, category, requestId));
    }
  };
  app.get(prefix, (req, reply) => respond(req.id, reply, () => service.status()));
  app.get(prefix + '/diagnostics', (req, reply) => respond(req.id, reply, () => service.diagnostics()));
  app.post(prefix + '/destinations', { bodyLimit: 65536 }, (req, reply) => respond(req.id, reply, () => service.saveDraft(usageExportSaveSchema.parse(req.body))));
  app.get(prefix + '/destinations/:id/preview', (req, reply) => respond(req.id, reply, () => service.preview(id(req.params))));
  app.post(prefix + '/destinations/:id/test', (req, reply) => respond(req.id, reply, () => service.testProtocol(id(req.params))));
  app.post(prefix + '/destinations/:id/enable', (req, reply) => respond(req.id, reply, () => service.enable(id(req.params), usageExportConsentSchema.parse(req.body))));
  app.post(prefix + '/destinations/:id/disable', (req, reply) => respond(req.id, reply, () => service.disable(id(req.params))));
  app.post(prefix + '/destinations/:id/remove', (req, reply) => respond(req.id, reply, () => service.remove(id(req.params), z.object({ discard_pending: z.boolean() }).strict().parse(req.body).discard_pending)));
  app.post(prefix + '/destinations/:id/sync', (req, reply) => respond(req.id, reply, () => service.syncNow(id(req.params))));
  app.post(prefix + '/destinations/:id/backfill', (req, reply) => respond(req.id, reply, () => service.backfill(id(req.params), usageExportScopeSchema.parse(req.body))));
  app.post(prefix + '/destinations/:id/retry', (req, reply) => respond(req.id, reply, () => service.retry(id(req.params))));
  app.get(prefix + '/destinations/:id/export', (req, reply) => respond(req.id, reply, () => service.exportLocal(id(req.params))));
  app.put(prefix + '/queue-capacity', (req, reply) => respond(req.id, reply, () => service.setQueueCapacity(z.object({ bytes: z.number().int().positive() }).strict().parse(req.body).bytes)));
  app.post(prefix + '/destinations/:id/clear-queue', (req, reply) => respond(req.id, reply, () => service.clearQueue(id(req.params), z.object({ acknowledge: z.literal(true) }).strict().parse(req.body).acknowledge)));
  app.post(prefix + '/destinations/:id/withdraw', (req, reply) => respond(req.id, reply, () => service.withdraw(id(req.params), z.object({ acknowledge: z.literal(true) }).strict().parse(req.body).acknowledge)));
  app.get(prefix + '/destinations/:id/handoff', (req, reply) => respond(req.id, reply, () => service.handoff(id(req.params))));
  app.post(prefix + '/destinations/:id/handoff/plan', (req, reply) => respond(req.id, reply, () => service.planHandoff(id(req.params), z.object({ cutoff_at: z.number().int().optional() }).strict().parse(req.body).cutoff_at)));
  app.post(prefix + '/destinations/:id/handoff/arm', (req, reply) => respond(req.id, reply, () => service.armHandoff(id(req.params), usageExportHandoffArmSchema.parse(req.body))));
  app.post(prefix + '/destinations/:id/handoff/refresh', (req, reply) => respond(req.id, reply, () => service.refreshHandoff(id(req.params))));
  app.post(prefix + '/destinations/:id/handoff/rollback', (req, reply) => respond(req.id, reply, () => { const input = z.object({ cutoff_at: z.number().int(), acknowledge: z.literal(true) }).strict().parse(req.body); return service.rollbackHandoff(id(req.params), input.cutoff_at, input.acknowledge); }));
  app.post(prefix + '/rebuild', (req, reply) => respond(req.id, reply, async () => { await service.scan(z.object({ force: z.boolean() }).strict().parse(req.body).force); return service.status(); }));
}
