import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  humanTakeoverAcquireInputSchema,
  meshLeasePinInputSchema,
  meshLeaseUnpinInputSchema,
  meshPortTunnelOpenInputSchema,
  meshTargetDispatchInputSchema,
  meshWorkspaceCopyApplyInputSchema,
  meshWorkspaceCopyCreateInputSchema,
} from '@kiki/protocol';
import { HumanControllingError } from '@kiki/agent-core-v2';

import { errEnvelope, okEnvelope } from '../envelope';
import type { MeshService } from '../services/mesh/meshService';

const HUMAN_CONTROLLING_CODE = 40942;

/** Registers REST endpoints for session mesh leases, COW workspace copies, loopback port tunnels, and human takeover locks. */
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
      if (error instanceof z.ZodError) {
        reply.code(400);
        return reply.send(errEnvelope(40001, error.message, requestId));
      }
      if (error instanceof Error && error.message.includes('not found')) {
        reply.code(404);
        return reply.send(errEnvelope(40401, error.message, requestId));
      }
      if (error instanceof Error && error.message.includes('rejected')) {
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
      );
    }),
  );

  app.post('/api/mesh/takeover/:targetId/release', { bodyLimit: 8_192 }, async (req, reply) =>
    handle(req.id, reply, async () => {
      const input = z.object({ holder: z.enum(['human', 'orchestrator']).optional() }).strict().parse(req.body ?? {});
      return {
        released: mesh.releaseTakeover((req.params as { targetId: string }).targetId, input.holder),
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
}
