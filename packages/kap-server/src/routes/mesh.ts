import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  humanTakeoverAcquireInputSchema,
  meshInboundExecuteInputSchema,
  meshLeasePinInputSchema,
  meshLeaseRenewInputSchema,
  meshLeaseUnpinInputSchema,
  meshPortTunnelOpenInputSchema,
  meshResolveQuestionInputSchema,
  meshTargetDispatchInputSchema,
  meshWorkspaceCopyApplyInputSchema,
  meshWorkspaceCopyCreateInputSchema,
} from '@kiki/protocol';
import {
  HumanControllingError,
  StaleEpochError,
  WorkspaceSourceModifiedError,
} from '@kiki/agent-core-v2';

import { errEnvelope, okEnvelope } from '../envelope';
import {
  MeshApprovalRejectedError,
  MeshCapabilityDeniedError,
  MeshPeerUnavailableError,
  type MeshService,
} from '../services/mesh/meshService';

const HUMAN_CONTROLLING_CODE = 40942;
const STALE_EPOCH_CODE = 40943;
const SOURCE_MODIFIED_CODE = 40944;
const MESH_CAPABILITY_DENIED_CODE = 40302;

const gitWipDeltaApplySchema = z.object({
  wipId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/),
  bundleBase64: z.string().min(1),
}).strict();

/** Registers REST endpoints for session mesh leases, COW workspace copies, loopback port tunnels, human takeover locks, and peer execution. */
export function registerMeshRoutes(app: FastifyInstance, mesh: MeshService): void {
  const handle = async <T>(
    requestId: string,
    reply: { code(status: number): unknown; send(value: unknown): unknown },
    work: () => Promise<T>,
  ) => {
    try {
      return reply.send(okEnvelope(await work(), requestId));
    } catch (error) {
      if (error instanceof HumanControllingError) {
        reply.code(409);
        return reply.send({
          code: HUMAN_CONTROLLING_CODE,
          msg: error.code,
          data: error.toConflictPayload(),
          request_id: requestId,
        });
      }
      if (error instanceof StaleEpochError) {
        reply.code(409);
        return reply.send({
          code: STALE_EPOCH_CODE,
          msg: error.code,
          data: error.toConflictPayload(),
          request_id: requestId,
        });
      }
      if (error instanceof WorkspaceSourceModifiedError) {
        reply.code(409);
        return reply.send({
          code: SOURCE_MODIFIED_CODE,
          msg: error.code,
          data: {
            error: error.code,
            copyId: error.copyId,
            conflictingFiles: error.conflictingFiles,
          },
          request_id: requestId,
        });
      }
      if (error instanceof MeshCapabilityDeniedError) {
        reply.code(403);
        return reply.send({
          code: MESH_CAPABILITY_DENIED_CODE,
          msg: error.code,
          data: {
            error: error.code,
            targetId: error.targetId,
            trustTier: error.trustTier,
            requiredCapability: error.requiredCapability,
          },
          request_id: requestId,
        });
      }
      if (error instanceof MeshApprovalRejectedError) {
        reply.code(403);
        return reply.send(errEnvelope(40301, error.message, requestId));
      }
      if (error instanceof MeshPeerUnavailableError) {
        reply.code(error.status);
        return reply.send(errEnvelope(error.status === 404 ? 40402 : 50301, error.code, requestId));
      }
      if (error instanceof z.ZodError) {
        reply.code(400);
        return reply.send(errEnvelope(40001, error.message, requestId));
      }
      if (error instanceof Error && error.message.includes('not found')) {
        reply.code(404);
        return reply.send(errEnvelope(40401, error.message, requestId));
      }
      if (error instanceof Error && (error.message.includes('rejected') || error.message.includes('not allowed') || error.message.includes('does not match'))) {
        reply.code(403);
        return reply.send(errEnvelope(40301, error.message, requestId));
      }
      throw error;
    }
  };

  app.get('/api/mesh/sessions/:sessionId/leases', async (req, reply) =>
    handle(req.id, reply, () =>
      mesh.getSessionLease((req.params as { sessionId: string }).sessionId),
    ),
  );

  app.post('/api/mesh/sessions/:sessionId/leases/pin', { bodyLimit: 16_384 }, async (req, reply) =>
    handle(req.id, reply, () =>
      mesh.pinResource(
        (req.params as { sessionId: string }).sessionId,
        meshLeasePinInputSchema.parse(req.body),
      ),
    ),
  );

  app.post('/api/mesh/sessions/:sessionId/leases/unpin', { bodyLimit: 8_192 }, async (req, reply) =>
    handle(req.id, reply, () => {
      const body = meshLeaseUnpinInputSchema.parse(req.body);
      return mesh.unpinResource(
        (req.params as { sessionId: string }).sessionId,
        body.kind,
        body.id,
        body.expectedEpoch,
      );
    }),
  );

  app.post('/api/mesh/sessions/:sessionId/leases/renew', { bodyLimit: 8_192 }, async (req, reply) =>
    handle(req.id, reply, () => {
      const body = meshLeaseRenewInputSchema.parse(req.body ?? {});
      return mesh.renewSessionLease(
        (req.params as { sessionId: string }).sessionId,
        body.ttlMs,
        body.expectedEpoch,
      );
    }),
  );

  app.get('/api/mesh/workspace-copies', async (req, reply) =>
    handle(req.id, reply, () => mesh.listWorkspaceCopies()),
  );

  app.post('/api/mesh/workspace-copies', { bodyLimit: 16_384 }, async (req, reply) =>
    handle(req.id, reply, () =>
      mesh.createWorkspaceCopy(meshWorkspaceCopyCreateInputSchema.parse(req.body)),
    ),
  );

  app.get('/api/mesh/workspace-copies/:copyId/status', async (req, reply) =>
    handle(req.id, reply, () =>
      mesh.workspaceCopyStatus((req.params as { copyId: string }).copyId),
    ),
  );

  app.get('/api/mesh/workspace-copies/:copyId/diff', async (req, reply) =>
    handle(req.id, reply, async () => ({
      copyId: (req.params as { copyId: string }).copyId,
      diff: await mesh.workspaceCopyDiff((req.params as { copyId: string }).copyId),
    })),
  );

  app.post('/api/mesh/workspace-copies/:copyId/snapshot', { bodyLimit: 8_192 }, async (req, reply) =>
    handle(req.id, reply, () => {
      const body = z.object({ label: z.string().max(128).optional() }).strict().parse(req.body ?? {});
      return mesh.workspaceCopySnapshot((req.params as { copyId: string }).copyId, body.label);
    }),
  );

  app.post('/api/mesh/workspace-copies/:copyId/delta/export', async (req, reply) =>
    handle(req.id, reply, () =>
      mesh.exportWorkspaceCopyDelta((req.params as { copyId: string }).copyId),
    ),
  );

  app.post('/api/mesh/workspace-copies/:copyId/delta/apply', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) =>
    handle(req.id, reply, () => {
      const input = gitWipDeltaApplySchema.parse(req.body);
      return mesh.applyWorkspaceCopyDelta((req.params as { copyId: string }).copyId, input);
    }),
  );

  app.post('/api/mesh/workspace-copies/:copyId/apply', { bodyLimit: 8_192 }, async (req, reply) =>
    handle(req.id, reply, () =>
      mesh.applyWorkspaceCopy(
        (req.params as { copyId: string }).copyId,
        meshWorkspaceCopyApplyInputSchema.parse(req.body ?? {}),
      ),
    ),
  );

  app.delete('/api/mesh/workspace-copies/:copyId', async (req, reply) =>
    handle(req.id, reply, async () => ({
      removed: await mesh.removeWorkspaceCopy((req.params as { copyId: string }).copyId),
    })),
  );

  app.get('/api/mesh/tunnels', async (req, reply) =>
    handle(req.id, reply, async () => mesh.listTunnels()),
  );

  app.post('/api/mesh/tunnels', { bodyLimit: 8_192 }, async (req, reply) =>
    handle(req.id, reply, () =>
      mesh.openTunnel(meshPortTunnelOpenInputSchema.parse(req.body)),
    ),
  );

  app.delete('/api/mesh/tunnels/:tunnelId', async (req, reply) =>
    handle(req.id, reply, async () => ({
      closed: await mesh.closeTunnel((req.params as { tunnelId: string }).tunnelId),
    })),
  );

  app.get('/api/mesh/takeover/:targetId', async (req, reply) =>
    handle(req.id, reply, async () => ({
      lease: mesh.inspectTakeover((req.params as { targetId: string }).targetId) ?? null,
      epoch: mesh.takeover.currentEpoch((req.params as { targetId: string }).targetId),
    })),
  );

  app.post('/api/mesh/takeover/:targetId/acquire', { bodyLimit: 8_192 }, async (req, reply) =>
    handle(req.id, reply, async () => {
      const input = humanTakeoverAcquireInputSchema.parse(req.body);
      return mesh.acquireTakeover(
        (req.params as { targetId: string }).targetId,
        input.holder,
        input.ttlMs,
        input.reason,
        {
          expectedEpoch: input.expectedEpoch,
          overrideHumanLease: input.overrideHumanLease,
        },
      );
    }),
  );

  app.post('/api/mesh/takeover/:targetId/renew', { bodyLimit: 8_192 }, async (req, reply) =>
    handle(req.id, reply, async () => {
      const input = z.object({
        holder: z.enum(['human', 'orchestrator']),
        ttlMs: z.number().int().min(1000).max(86_400_000).default(300_000),
        expectedEpoch: z.number().int().nonnegative().optional(),
      }).strict().parse(req.body);
      const renewed = mesh.renewTakeover(
        (req.params as { targetId: string }).targetId,
        input.holder,
        input.ttlMs,
        input.expectedEpoch,
      );
      if (renewed === undefined) throw new Error('Takeover lease not found');
      return renewed;
    }),
  );

  app.post('/api/mesh/takeover/:targetId/release', { bodyLimit: 8_192 }, async (req, reply) =>
    handle(req.id, reply, async () => {
      const input = z.object({
        holder: z.enum(['human', 'orchestrator']).optional(),
        expectedEpoch: z.number().int().nonnegative().optional(),
      }).strict().parse(req.body ?? {});
      return {
        released: mesh.releaseTakeover(
          (req.params as { targetId: string }).targetId,
          input.holder,
          input.expectedEpoch,
        ),
        epoch: mesh.takeover.currentEpoch((req.params as { targetId: string }).targetId),
      };
    }),
  );

  app.post('/api/mesh/targets/:targetId/dispatch', { bodyLimit: 16_384 }, async (req, reply) =>
    handle(req.id, reply, () =>
      mesh.dispatchTargetAction(
        (req.params as { targetId: string }).targetId,
        meshTargetDispatchInputSchema.parse(req.body),
      ),
    ),
  );

  app.post('/api/mesh/targets/:targetId/resolve-question', { bodyLimit: 16_384 }, async (req, reply) =>
    handle(req.id, reply, () =>
      mesh.resolveQuestion(
        (req.params as { targetId: string }).targetId,
        meshResolveQuestionInputSchema.parse(req.body),
      ),
    ),
  );

  app.post('/api/mesh/inbound/execute', { bodyLimit: 65_536 }, async (req, reply) =>
    handle(req.id, reply, () =>
      mesh.executeInboundAction(meshInboundExecuteInputSchema.parse(req.body)),
    ),
  );
}
