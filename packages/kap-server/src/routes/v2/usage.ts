import { IRequestGovernance, type Scope } from '@kiki/agent-core-v2';
import { agentActivitySnapshotSchema, requestGovernanceSnapshotSchema, usageQuerySchema, usageResponseSchema, usagePricingQuerySchema, usagePricingResponseSchema, usagePricingUpdateSchema, usageRescanStatusSchema } from '@kiki/protocol';

import { IModelPricingService } from '../../pricing/modelPricingService';
import { z } from 'zod';

import { defineRoute } from '../../middleware/defineRoute';
import { errEnvelope, okEnvelope } from '../../protocol/envelope';
import { ErrorCode } from '../../protocol/error-codes';
import {
  UsageAggregationService,
  UsagePageTokenMismatchError,
} from '../../usage/usageAggregationService';

interface V2UsageRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  put(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
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
  const realtime = defineRoute({
    method: 'GET', path: '/usage/realtime', success: { data: requestGovernanceSnapshotSchema },
    operationId: 'getRequestGovernance', tags: ['usage'],
  }, (req, reply) => {
    reply.send(okEnvelope(core.accessor.get(IRequestGovernance).snapshot(), req.id));
  });
  app.get(realtime.path, realtime.options, realtime.handler as Parameters<V2UsageRouteHost['get']>[2]);
  const agents = defineRoute({
    method: 'GET', path: '/usage/realtime/agents', success: { data: agentActivitySnapshotSchema },
    operationId: 'getAgentActivity', tags: ['usage'],
  }, (req, reply) => {
    reply.send(okEnvelope(core.accessor.get(IRequestGovernance).agentSnapshot(), req.id));
  });
  app.get(agents.path, agents.options, agents.handler as Parameters<V2UsageRouteHost['get']>[2]);
  const service = new UsageAggregationService(core);
  const rescanStatus = defineRoute({
    method: 'GET', path: '/usage/rescan', success: { data: usageRescanStatusSchema },
    operationId: 'getUsageRescan', tags: ['usage'],
  }, (req, reply) => {
    reply.send(okEnvelope(service.rescanStatus(), req.id));
  });
  app.get(rescanStatus.path, rescanStatus.options, rescanStatus.handler as Parameters<V2UsageRouteHost['get']>[2]);
  const rescanStart = defineRoute({
    method: 'POST', path: '/usage/rescan', success: { data: usageRescanStatusSchema },
    operationId: 'startUsageRescan', tags: ['usage'],
  }, (req, reply) => {
    reply.send(okEnvelope(service.startFullRescan(), req.id));
  });
  app.post(rescanStart.path, rescanStart.options, rescanStart.handler as Parameters<V2UsageRouteHost['post']>[2]);
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
  const getPricing = defineRoute({
    method: 'GET', path: '/usage/pricing', querystring: usagePricingQuerySchema,
    success: { data: usagePricingResponseSchema },
    errors: { [ErrorCode.VALIDATION_FAILED]: { detailsSchema } },
    operationId: 'getUsagePricing', tags: ['usage'],
  }, async (req, reply) => {
    const requested = req.query.model;
    const models = typeof requested === 'string' ? [requested] : requested;
    reply.send(okEnvelope(await core.accessor.get(IModelPricingService).getPricing(models), req.id));
  });
  app.get(getPricing.path, getPricing.options, getPricing.handler as Parameters<V2UsageRouteHost['get']>[2]);
  const setPricing = defineRoute({
    method: 'PUT', path: '/usage/pricing', body: usagePricingUpdateSchema,
    success: { data: usagePricingResponseSchema },
    errors: { [ErrorCode.VALIDATION_FAILED]: { detailsSchema } },
    operationId: 'setUsagePricing', tags: ['usage'],
  }, async (req, reply) => {
    reply.send(okEnvelope(await core.accessor.get(IModelPricingService).setPricing(req.body), req.id));
  });
  app.put(setPricing.path, setPricing.options, setPricing.handler as Parameters<V2UsageRouteHost['put']>[2]);
}
