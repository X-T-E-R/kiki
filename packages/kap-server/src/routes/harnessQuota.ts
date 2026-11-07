import type { Scope } from '@kiki/agent-core-v2';
import { IHarnessQuotaService } from '@kiki/agent-core-v2';
import { harnessQuotaCacheResponseSchema, harnessQuotaReadRequestSchema } from '@kiki/protocol';

import { errEnvelope, okEnvelope } from '../envelope';
import { withReplyCloseSignal } from '../procedures/requestSignal';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';

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
      req: { id: string; body: { source: string } },
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
        const message = error instanceof Error ? error.message : 'Harness quota source is unavailable';
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
        return;
      }
      const cached = await quota.cached();
      reply.send(okEnvelope({ sources: cached.sources.filter((source) => source.id === req.body.source) }, req.id));
    });
  });
  app.post(readRoute.path, readRoute.options, readRoute.handler as unknown as Parameters<HarnessQuotaRouteHost['post']>[2]);
}
