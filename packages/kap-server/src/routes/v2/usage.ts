import type { Scope } from '@moonshot-ai/agent-core-v2';
import { usageQuerySchema, usageResponseSchema } from '@moonshot-ai/protocol';
import { z } from 'zod';

import { defineRoute } from '../../middleware/defineRoute';
import { errEnvelope, okEnvelope } from '../../protocol/envelope';
import { ErrorCode } from '../../protocol/error-codes';
import {
  UsageAggregationService,
  UsagePageTokenMismatchError,
} from '../../usage/usageAggregationService';

interface V2UsageRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerV2UsageRoutes(app: V2UsageRouteHost, core: Scope): void {
  const service = new UsageAggregationService(core);
  const route = defineRoute(
    {
      method: 'GET',
      path: '/usage',
      querystring: usageQuerySchema,
      success: { data: usageResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.PAGE_TOKEN_MISMATCH]: {},
      },
      operationId: 'getUsage',
      tags: ['usage'],
    },
    async (req, reply) => {
      try {
        reply.send(okEnvelope(await service.query(req.query), req.id));
      } catch (error) {
        if (error instanceof UsagePageTokenMismatchError) {
          reply.send(errEnvelope(ErrorCode.PAGE_TOKEN_MISMATCH, error.message, req.id));
          return;
        }
        throw error;
      }
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<V2UsageRouteHost['get']>[2]);
}
