import type { Scope } from '@kiki/agent-core-v2';
import { Error2, ErrorCodes, IHarnessQuotaService, ILogService } from '@kiki/agent-core-v2';
import {
  HARNESS_QUOTA_UNAVAILABLE_MESSAGE,
  harnessQuotaActionRequestSchema,
  harnessQuotaActionResponseSchema,
  harnessQuotaCacheResponseSchema,
  harnessQuotaReadRequestSchema,
  ErrorCode,
} from '@kiki/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { withReplyCloseSignal } from '../procedures/requestSignal';
import { defineRoute } from '../middleware/defineRoute';

interface HarnessQuotaRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (req: { id: string }, reply: { send(payload: unknown): unknown }) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params?: unknown },
      reply: { send(payload: unknown): unknown; raw: { on(event: string, listener: () => void): void } },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerHarnessQuotaRoutes(app: HarnessQuotaRouteHost, core: Scope): void {
  const cachedRoute = defineRoute({
    method: 'GET', path: '/harness-quota', success: { data: harnessQuotaCacheResponseSchema },
    description: 'Read registered harness quota sources and the current cache without contacting a source', tags: ['plugins'],
  }, async (req, reply) => {
    const cached = await core.accessor.get(IHarnessQuotaService).cached();
    reply.send(okEnvelope(cached, req.id));
  });
  app.get(cachedRoute.path, cachedRoute.options, cachedRoute.handler as unknown as Parameters<HarnessQuotaRouteHost['get']>[2]);

  const readRoute = defineRoute({
    method: 'POST', path: '/harness-quota/read', body: harnessQuotaReadRequestSchema,
    success: { data: harnessQuotaCacheResponseSchema },
    errors: { [ErrorCode.VALIDATION_FAILED]: {} },
    description: 'Demand one harness quota source, still subject to its refresh interval and single in-flight read', tags: ['plugins'],
  }, async (req, reply) => {
    await withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], async (signal) => {
      const quota = core.accessor.get(IHarnessQuotaService);
      try {
        await quota.read(req.body.source, signal);
      } catch (error) {
        if (signal.aborted) return;
        const message = error instanceof Error ? error.message : HARNESS_QUOTA_UNAVAILABLE_MESSAGE;
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
        return;
      }
      if (signal.aborted) return;
      const cached = await quota.cached();
      reply.send(okEnvelope({ sources: cached.sources.filter((source) => source.id === req.body.source) }, req.id));
    }, req);
  });
  app.post(readRoute.path, readRoute.options, readRoute.handler as unknown as Parameters<HarnessQuotaRouteHost['post']>[2]);

  const actionRoute = defineRoute({
    method: 'POST',
    path: '/harness-quota/:sourceId/action',
    params: z.object({
      sourceId: z.string().regex(/^plugin:[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/),
    }),
    body: harnessQuotaActionRequestSchema,
    success: { data: harnessQuotaActionResponseSchema },
    errors: {
      [ErrorCode.VALIDATION_FAILED]: {},
      [ErrorCode.PLUGIN_NOT_FOUND]: {},
      [ErrorCode.INTERNAL_ERROR]: {},
    },
    description: 'Invoke a bounded declarative action declared by a registered harness quota plugin source',
    tags: ['plugins'],
  }, async (req, reply) => {
    await withReplyCloseSignal(reply as unknown as Parameters<typeof withReplyCloseSignal>[0], async (signal) => {
      const quota = core.accessor.get(IHarnessQuotaService);
      if (typeof quota.performAction !== 'function') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Harness quota actions are not supported', req.id));
        return;
      }
      try {
        const result = await quota.performAction(req.params.sourceId, req.body.action, req.body.account_id, signal);
        if (signal.aborted) return;
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof Error2 && error.code === ErrorCodes.PLUGIN_NOT_FOUND) {
          reply.send(errEnvelope(ErrorCode.PLUGIN_NOT_FOUND, error.message, req.id));
          return;
        }
        if (error instanceof Error2 && error.code === ErrorCodes.REQUEST_INVALID) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id));
          return;
        }
        try {
          core.accessor.get(ILogService)?.warn('harness quota action failed', {
            sourceId: req.params.sourceId,
            action: req.body.action,
            failureKind: error instanceof Error ? error.name : 'unknown_error',
          });
        } catch {
          void 0;
        }
        reply.send(errEnvelope(ErrorCode.INTERNAL_ERROR, HARNESS_QUOTA_UNAVAILABLE_MESSAGE, req.id));
      }
    }, req);
  });
  app.post(actionRoute.path, actionRoute.options, actionRoute.handler as unknown as Parameters<HarnessQuotaRouteHost['post']>[2]);
}
