import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  syncBundleExportInputSchema,
  syncBundleImportInputSchema,
  syncCredentialMergeInputSchema,
  syncCredentialSealInputSchema,
  syncFilesExportInputSchema,
  syncFilesImportInputSchema,
  syncPeerFilesPullInputSchema,
  syncPeerFilesPushInputSchema,
  syncPeerTransferInputSchema,
  syncProjectIdentityResolveInputSchema,
} from '@kiki/protocol';

import { errEnvelope, okEnvelope } from '../envelope';
import { AdmissionError } from '../services/connections/admission';
import { peerAudience } from '../services/connections/audience';
import {
  SyncArchiveInvalidError,
  SyncPathForbiddenError,
  SyncPathNotFoundError,
} from '../services/sync/fileSync';
import type { SyncService } from '../services/sync/syncService';

const SYNC_FILES_BODY_LIMIT_BYTES = 96 * 1024 * 1024;

function requireTrustedFileSyncPeer(req: FastifyRequest): void {
  const peer = peerAudience(req);
  if (peer === undefined) return;
  if (peer.trustTier !== 'trusted_personal' || peer.meshCapabilities?.includes('file_sync') !== true) {
    throw new AdmissionError(403, 'mesh_capability_denied');
  }
}

/** Registers REST endpoints for device X25519 keys, per-entry credential envelopes, project identity resolution, portable config/memory/skill bundles, peer push/pull sync, and bounded file/directory transfer. */
export function registerSyncRoutes(app: FastifyInstance, sync: SyncService): void {
  const handle = async <T>(
    requestId: string,
    reply: { code(status: number): unknown; send(value: unknown): unknown },
    work: () => Promise<T>,
  ) => {
    try {
      return reply.send(okEnvelope(await work(), requestId));
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyncArchiveInvalidError) {
        reply.code(400);
        return reply.send(errEnvelope(40001, error.message, requestId));
      }
      if (error instanceof SyncPathForbiddenError) {
        reply.code(403);
        return reply.send(errEnvelope(40301, error.message, requestId));
      }
      if (error instanceof AdmissionError) {
        reply.code(error.status);
        return reply.send(errEnvelope(error.reason === 'mesh_capability_denied' ? 40302 : 40101, error.reason, requestId));
      }
      if (error instanceof SyncPathNotFoundError || (error instanceof Error && error.message.includes('not found'))) {
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

  app.post('/api/sync/bundle/import', { bodyLimit: 64 * 1024 * 1024 }, async (req, reply) =>
    handle(req.id, reply, () =>
      sync.importSyncBundle(syncBundleImportInputSchema.parse(req.body)),
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

  app.post('/api/sync/files::export', { bodyLimit: 16_384 }, async (req, reply) =>
    handle(req.id, reply, async () => {
      requireTrustedFileSyncPeer(req);
      return sync.exportFiles(syncFilesExportInputSchema.parse(req.body));
    }),
  );

  app.post('/api/sync/files::import', { bodyLimit: SYNC_FILES_BODY_LIMIT_BYTES }, async (req, reply) =>
    handle(req.id, reply, async () => {
      requireTrustedFileSyncPeer(req);
      return sync.importFiles(syncFilesImportInputSchema.parse(req.body));
    }),
  );

  app.post('/api/sync/peers/:peerId/files::pull', { bodyLimit: 16_384 }, async (req, reply) =>
    handle(req.id, reply, () =>
      sync.pullFilesFromPeer(
        (req.params as { peerId: string }).peerId,
        syncPeerFilesPullInputSchema.parse(req.body),
      ),
    ),
  );

  app.post('/api/sync/peers/:peerId/files::push', { bodyLimit: 16_384 }, async (req, reply) =>
    handle(req.id, reply, () =>
      sync.pushFilesToPeer(
        (req.params as { peerId: string }).peerId,
        syncPeerFilesPushInputSchema.parse(req.body),
      ),
    ),
  );
}
