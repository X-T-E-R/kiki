import {
  delegationProcedureTable,
  type DelegationProcedureName,
} from '@moonshot-ai/klient/procedures';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { errEnvelope, okEnvelope } from '../protocol/envelope';
import { ErrorCode } from '../protocol/error-codes';
import type { SeatResolver } from '../mcp/seatResolver';
import {
  externalDelegationFailureCode,
  externalDelegationPublicFailure,
} from './errors';
import { ExternalDelegationProcedureHost } from './externalDelegationHost';

export const SEAT_KLIENT_DELEGATION_PREFIX = '/api/klient/delegation';

export function registerSeatKlientDelegationRoutes(
  app: FastifyInstance,
  host: ExternalDelegationProcedureHost,
  seatResolver: SeatResolver,
): void {
  for (const procedure of delegationProcedureTable) {
    app.post(`${SEAT_KLIENT_DELEGATION_PREFIX}/${procedure.name}`, { schema: { hide: true } }, async (req, reply) => {
      const bearer = readBearer(req);
      if (req.headers.authorization !== undefined) req.headers.authorization = '[redacted]';
      const seat = bearer === undefined ? null : await seatResolver.resolve(bearer);
      if (seat === null) {
        return reply.code(401).send(errEnvelope(40101, 'Unauthorized', req.id));
      }
      try {
        const input = procedure.inputSchema.parse(req.body ?? {});
        const { delegationToken: _delegationToken, ...authoritySeat } = seat;
        const data = await host.call(authoritySeat, procedure.name as DelegationProcedureName, input as never);
        return reply.send(okEnvelope(data, req.id));
      } catch (error) {
        const failureCode = externalDelegationFailureCode(error);
        const log = {
          request_id: req.id,
          action: procedure.name,
          error_message: error instanceof Error ? error.message : String(error),
          error_stack: error instanceof Error ? error.stack : undefined,
          failure_code: failureCode,
        };
        if (failureCode === undefined) req.log.warn(log, 'external delegation request failed');
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

function readBearer(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (header === undefined || Array.isArray(header) || !header.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length);
  return token.length === 0 ? undefined : token;
}
