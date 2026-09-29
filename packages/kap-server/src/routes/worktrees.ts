import { z } from 'zod';
import { IWorktreeService, type Scope } from '@kiki/agent-core-v2';
import { worktreeInspectionSchema, worktreeRecordSchema, worktreeRemoveRequestSchema, worktreeRemovalOutcomeSchema } from '@kiki/protocol';
import { errEnvelope, okEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from './action-suffix';

interface WorktreeRouteHost {
  get(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: { id: string; query: unknown; params: unknown }, reply: { send(value: unknown): unknown }) => unknown): unknown;
  post(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: (req: { id: string; body: unknown; params: unknown }, reply: { send(value: unknown): unknown }) => unknown): unknown;
}

export function registerWorktreeRoutes(app: WorktreeRouteHost, core: Scope): void {
  const service = core.accessor.get(IWorktreeService);
  const list = defineRoute({ method: 'GET', path: '/worktrees',
    querystring: z.object({ workspace_id: z.string().optional(), state: worktreeRecordSchema.shape.state.optional() }),
    success: { data: z.object({ worktrees: z.array(worktreeRecordSchema) }) },
    errors: {}, description: 'List Kiki-managed worktrees', tags: ['worktrees'],
  }, async (req, reply) => {
    reply.send(okEnvelope({ worktrees: await service.list({ workspaceId: req.query.workspace_id, state: req.query.state }) }, req.id));
  });
  app.get(list.path, list.options, list.handler as Parameters<WorktreeRouteHost['get']>[2]);

  const get = defineRoute({ method: 'GET', path: '/worktrees/{id}', params: z.object({ id: z.string() }),
    success: { data: worktreeRecordSchema }, errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Read a Kiki-managed worktree', tags: ['worktrees'],
  }, async (req, reply) => {
    const record = await service.get(req.params.id);
    reply.send(record === undefined ? errEnvelope(ErrorCode.VALIDATION_FAILED, 'worktree not found', req.id) : okEnvelope(record, req.id));
  });
  app.get(get.path, get.options, get.handler as Parameters<WorktreeRouteHost['get']>[2]);

  const action = defineRoute({ method: 'POST', path: '/worktrees/{tail}', params: z.object({ tail: z.string() }),
    body: z.unknown(), success: { data: z.union([worktreeInspectionSchema, z.object({ outcome: worktreeRemovalOutcomeSchema })]) },
    errors: { [ErrorCode.VALIDATION_FAILED]: {} }, description: 'Inspect or remove a worktree', tags: ['worktrees'],
  }, async (req, reply) => {
    const parsed = parseActionSuffix({ tail: req.params.tail, allowedActions: ['inspect', 'remove'] as const, resourceLabel: 'worktree' });
    if (parsed.kind !== 'action') {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'unsupported worktree action', req.id));
      return;
    }
    try {
      if (parsed.action === 'inspect') {
        reply.send(okEnvelope(await service.inspect(parsed.id), req.id));
      } else {
        const body = worktreeRemoveRequestSchema.parse(req.body ?? {});
        reply.send(okEnvelope(await service.remove(parsed.id, body), req.id));
      }
    } catch (error) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error instanceof Error ? error.message : 'worktree operation failed', req.id));
    }
  });
  app.post(action.path, action.options, action.handler as Parameters<WorktreeRouteHost['post']>[2]);

  const gc = defineRoute({ method: 'POST', path: '/worktrees:gc', body: z.object({ dryRun: z.boolean() }),
    success: { data: z.object({ candidates: z.array(z.object({ id: z.string(), outcome: worktreeRemovalOutcomeSchema })) }) },
    errors: { [ErrorCode.VALIDATION_FAILED]: {} }, description: 'Clean up archived worktrees', tags: ['worktrees'],
  }, async (req, reply) => {
    reply.send(okEnvelope({ candidates: await service.gc(req.body.dryRun) }, req.id));
  });
  app.post(gc.path, gc.options, gc.handler as Parameters<WorktreeRouteHost['post']>[2]);
}
