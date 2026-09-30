import type { FastifyInstance } from 'fastify';
import type { Scope } from '@kiki/agent-core-v2';
import { okEnvelope, errEnvelope } from '../protocol/envelope';
import type { SeatKlientDelegationAuth } from './http';
import { ContextProcedureHost } from './contextHost';
import { withReplyCloseSignal } from './requestSignal';

export function registerContextRoutes(app: FastifyInstance, core: Scope, auth: SeatKlientDelegationAuth): void {
  const host = new ContextProcedureHost(core);
  for (const action of ['catalog', 'call', 'hook'] as const) {
    app.post(`/api/klient/delegation/context/${action}`, { schema: { hide: true } }, async (req, reply) => {
      try {
        const seat = auth.seat(req);
        const data = action === 'catalog' ? await host.catalog(seat) : action === 'hook' ? await host.hook(seat, req.body) :
          await withReplyCloseSignal(reply, (signal) => host.call(seat, req.body, signal));
        return await reply.send(okEnvelope(data, req.id));
      } catch {
        return reply.send(errEnvelope(40001, 'Kiki context request is not admitted or its arguments are invalid.', req.id));
      }
    });
  }
}
