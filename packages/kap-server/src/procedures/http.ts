import {
  delegationProcedureTable,
  type DelegationProcedureName,
} from '@moonshot-ai/klient/procedures';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { McpSeat, SeatResolver } from '../mcp/seatResolver';
import { errEnvelope, okEnvelope } from '../protocol/envelope';
import { ErrorCode } from '../protocol/error-codes';
import {
  externalDelegationLogFailure,
  externalDelegationPublicFailure,
} from './errors';
import { ExternalDelegationProcedureHost } from './externalDelegationHost';
import { withReplyCloseSignal } from './requestSignal';

export const SEAT_KLIENT_DELEGATION_PREFIX = '/api/klient/delegation';

export interface SeatKlientDelegationAuth {
  onRequest(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void>;
  seat(req: FastifyRequest): McpSeat;
}

export function createSeatKlientDelegationAuth(
  resolveSeatResolver: () => SeatResolver,
): SeatKlientDelegationAuth {
  const seats = new WeakMap<FastifyRequest, McpSeat>();
  return {
    async onRequest(req, reply) {
      if (!isSeatDelegationPath(req.url)) return;
      const bearer = readBearer(req.headers.authorization);
      delete req.headers.authorization;
      const seat = bearer === undefined ? null : await resolveSeatResolver().resolve(bearer);
      if (seat === null) {
        return reply.code(401).send(errEnvelope(40101, 'Unauthorized', req.id));
      }
      seats.set(req, seat);
    },
    seat(req) {
      return seats.get(req)!;
    },
  };
}

export function registerSeatKlientDelegationRoutes(
  app: FastifyInstance,
  host: ExternalDelegationProcedureHost,
  auth: SeatKlientDelegationAuth,
): void {
  for (const procedure of delegationProcedureTable) {
    app.post(`${SEAT_KLIENT_DELEGATION_PREFIX}/${procedure.name}`, { schema: { hide: true } }, async (req, reply) => {
      const { delegationToken: _delegationToken, ...authoritySeat } = auth.seat(req);
      try {
        const input = procedure.inputSchema.parse(req.body ?? {});
        const data = procedure.name === 'wait'
          ? await withReplyCloseSignal(reply, (signal) =>
              host.call(authoritySeat, procedure.name, input as never, signal),
            )
          : await host.call(authoritySeat, procedure.name as DelegationProcedureName, input as never);
        return reply.send(okEnvelope(data, req.id));
      } catch (error) {
        const logFailure = externalDelegationLogFailure(error);
        const log = {
          request_id: req.id,
          action: procedure.name,
          ...logFailure,
        };
        if (logFailure.failure_code === undefined) req.log.warn(log, 'external delegation request failed');
        else req.log.info(log, 'external delegation request failed');
        const failure = externalDelegationPublicFailure(error);
        return reply.send({
          ...errEnvelope(ErrorCode.VALIDATION_FAILED, failure.message, req.id),
          details: failure.details,
        });
      }
    });
  }
}

function isSeatDelegationPath(rawUrl: string): boolean {
  const rawPath = rawUrl.split('?', 1)[0] ?? rawUrl;
  try {
    return decodeURIComponent(rawPath).startsWith(`${SEAT_KLIENT_DELEGATION_PREFIX}/`);
  } catch {
    return false;
  }
}

function readBearer(header: string | string[] | undefined): string | undefined {
  if (header === undefined || Array.isArray(header) || !header.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length);
  return token.length === 0 ? undefined : token;
}
