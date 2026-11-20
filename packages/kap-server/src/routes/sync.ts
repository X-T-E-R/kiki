import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  syncBundleExportInputSchema,
  syncBundleSchema,
  syncCredentialMergeInputSchema,
  syncCredentialSealInputSchema,
  syncPeerTransferInputSchema,
  syncProjectIdentityResolveInputSchema,
} from '@kiki/protocol';

import { errEnvelope, okEnvelope } from '../envelope';
import type { SyncService } from '../services/sync/syncService';

/** Registers REST endpoints for device X25519 keys, per-entry credential envelopes, project identity resolution, portable config/memory/skill bundles, and peer push/pull sync. */
export function registerSyncRoutes(app: FastifyInstance, sync: SyncService): void {
  const handle = async <T>(
    requestId: string,
    reply: { code(status: number): unknown; send(value: unknown): unknown },
    work: () => Promise<T>,
  ) => {
    try {
      return reply.send(okEnvelope(await work(), requestId));
    } catch (error) {
      if (error instanceof z.ZodError) {
        reply.code(400);
        return reply.send(errEnvelope(40001, error.message, requestId));
      }
      if (error instanceof Error && error.message.includes('not found')) {
        reply.code(404);
        return reply.send(errEnvelope(40401, error.message, requestId));
      }
      throw error;
    }
  };

  app.get('/api/sync/device-key', async (req, reply) =>
    handle(req.id, reply, () => sync.getDevicePublicKey()),
  );

  app.post('/api/sync/credentials/seal', { bodyLimit: 32_768 }, async (req, reply) =>
    handle(req.id, reply, () =>
      sync.sealSyncedCredentials(syncCredentialSealInputSchema.parse(req.body)),
    ),
  );

  app.post('/api/sync/credentials/merge', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) =>
    handle(req.id, reply, () => {
      const input = syncCredentialMergeInputSchema.parse(req.body);
      return sync.mergeIncomingCredentials(input.envelopes);
    }),
  );

  app.post('/api/sync/project-identity/resolve', { bodyLimit: 8_192 }, async (req, reply) =>
    handle(req.id, reply, () => {
      const input = syncProjectIdentityResolveInputSchema.parse(req.body);
      return sync.resolveProjectIdentity(input.cwd, input.bind);
    }),
  );

  app.get('/api/sync/config/portable', async (req, reply) =>
    handle(req.id, reply, () => sync.exportPortableConfig()),
  );

  app.get('/api/sync/skills/plan', async (req, reply) =>
    handle(req.id, reply, () => {
      const query = req.query as { work_dir?: unknown };
      const workDir = typeof query.work_dir === 'string' && query.work_dir.trim().length > 0
        ? query.work_dir.trim()
        : undefined;
      return sync.planSkillsSync(workDir);
    }),
  );

  app.post('/api/sync/bundle/export', { bodyLimit: 65_536 }, async (req, reply) =>
    handle(req.id, reply, () =>
      sync.exportSyncBundle(syncBundleExportInputSchema.parse(req.body ?? {})),
    ),
  );

  app.post('/api/sync/bundle/import', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) =>
    handle(req.id, reply, () =>
      sync.importSyncBundle(syncBundleSchema.parse(req.body)),
    ),
  );

  app.post('/api/sync/peers/:peerId/push', { bodyLimit: 65_536 }, async (req, reply) =>
    handle(req.id, reply, () =>
      sync.pushToPeer(
        (req.params as { peerId: string }).peerId,
        syncPeerTransferInputSchema.parse(req.body ?? {}),
      ),
    ),
  );

  app.post('/api/sync/peers/:peerId/pull', { bodyLimit: 65_536 }, async (req, reply) =>
    handle(req.id, reply, () =>
      sync.pullFromPeer(
        (req.params as { peerId: string }).peerId,
        syncPeerTransferInputSchema.parse(req.body ?? {}),
      ),
    ),
  );
}
