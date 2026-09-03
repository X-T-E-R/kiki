import { z } from 'zod';

import { defineRoute } from '../../middleware/defineRoute';
import { errEnvelope, okEnvelope } from '../../protocol/envelope';
import { ErrorCode } from '../../protocol/error-codes';
import type { ExternalDelegationState } from '../../protocol/rest-meta';
import type { ExternalDelegationSeatManager } from '../../mcp/externalDelegationSeats';

interface SeatRouteHost {
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: RouteRequest, reply: RouteReply) => Promise<void> | void,
  ): unknown;
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: RouteRequest, reply: RouteReply) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: RouteRequest, reply: RouteReply) => Promise<void> | void,
  ): unknown;
}

interface RouteRequest {
  readonly id: string;
  readonly body: unknown;
  readonly params: unknown;
}

interface RouteReply {
  send(payload: unknown): void;
}

const modeSchema = z.enum(['manual', 'auto', 'yolo']);
const seatCreateSchema = z.object({
  workspace: z.string().min(1),
  principal: z.string().min(1),
  mode: modeSchema.optional(),
  model: z.string().min(1).optional(),
  thinking: z.string().min(1).optional(),
}).strict();
const seatParamsSchema = z.object({ seat_id: z.string().min(1) });
const seatViewSchema = z.object({
  seatId: z.string().min(1),
  sessionId: z.string().min(1),
  principal: z.string().min(1),
  workspace: z.string().min(1),
  mode: modeSchema,
  model: z.string().min(1).optional(),
  thinking: z.string().min(1).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
const seatCreateResponseSchema = seatViewSchema.extend({ delegationToken: z.string().min(1) });

export function registerV2ExternalDelegationSeatRoutes(
  app: SeatRouteHost,
  manager: ExternalDelegationSeatManager,
  state: ExternalDelegationState,
): void {
  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/external-delegation/seats',
      body: seatCreateSchema,
      success: { data: seatCreateResponseSchema },
      description: 'Create or reuse an external delegation seat',
      tags: ['v2-sessions'],
    },
    async (req, reply) => {
      if (sendDisabled(reply, req.id, state)) return;
      const seat = await manager.create(req.body);
      reply.send(okEnvelope(seat, req.id));
    },
  );
  app.post(createRoute.path, createRoute.options, createRoute.handler as never);

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/external-delegation/seats',
      success: { data: z.array(seatViewSchema) },
      description: 'List external delegation seats',
      tags: ['v2-sessions'],
    },
    async (req, reply) => {
      if (sendDisabled(reply, req.id, state)) return;
      reply.send(okEnvelope(await manager.list(), req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as never);

  const revokeRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/external-delegation/seats/{seat_id}',
      params: seatParamsSchema,
      success: { data: seatViewSchema },
      description: 'Revoke an external delegation seat',
      tags: ['v2-sessions'],
    },
    async (req, reply) => {
      if (sendDisabled(reply, req.id, state)) return;
      const seat = await manager.revoke(req.params.seat_id);
      if (seat === undefined) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'External delegation seat does not exist.', req.id));
        return;
      }
      reply.send(okEnvelope(seat, req.id));
    },
  );
  app.delete(revokeRoute.path, revokeRoute.options, revokeRoute.handler as never);
}

function sendDisabled(
  reply: RouteReply,
  requestId: string,
  state: ExternalDelegationState,
): boolean {
  if (state.state !== 'disabled') return false;
  reply.send(errEnvelope(
    ErrorCode.REQUEST_MALFORMED,
    `External delegation is disabled: ${state.reason}.`,
    requestId,
  ));
  return true;
}
