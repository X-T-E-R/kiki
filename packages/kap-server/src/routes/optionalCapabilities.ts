import { ErrorCodes, ISessionOptionalCapabilityService, isError2, isOptionalCapabilityId, type CapabilityChoice } from '@kiki/agent-core-v2';
import { optionalCapabilitySessionRequestSchema, optionalCapabilitySessionResponseSchema } from '@kiki/protocol';
import { z } from 'zod';

import { withSessionOperation } from '../lib/sessionOperationLease';
import { defineRoute } from '../middleware/defineRoute';
import { errEnvelope, okEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';

interface Host {
  get(path: string, options: { schema?: Record<string, unknown> }, handler: (...args: never[]) => unknown): unknown;
  post(path: string, options: { schema?: Record<string, unknown> }, handler: (...args: never[]) => unknown): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

export function registerOptionalCapabilityRoutes(app: Host, core: Parameters<typeof withSessionOperation>[0]): void {
  const errors = { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.CAPABILITY_UNSUPPORTED]: {} };
  const read = defineRoute({
    method: 'GET',
    path: '/sessions/{session_id}/optional-capabilities',
    params: sessionIdParamSchema,
    success: { data: optionalCapabilitySessionResponseSchema },
    errors,
    description: 'Read this conversation’s optional capability choices',
    tags: ['sessions'],
  }, async (req, reply) => {
    const result = await withSessionOperation(core, req.params.session_id, async (session) => session?.accessor.get(ISessionOptionalCapabilityService).read());
    if (result === undefined) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Session was not found', req.id));
      return;
    }
    reply.send(okEnvelope(wire(result), req.id));
  });
  app.get(read.path, read.options, read.handler as never);
  const set = defineRoute({
    method: 'POST',
    path: '/sessions/{session_id}/optional-capabilities',
    params: sessionIdParamSchema,
    body: optionalCapabilitySessionRequestSchema,
    success: { data: optionalCapabilitySessionResponseSchema },
    errors,
    description: 'Set this conversation’s optional capability choice',
    tags: ['sessions'],
  }, async (req, reply) => {
    if (!isOptionalCapabilityId(req.body.id)) {
      reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Unknown optional capability', req.id));
      return;
    }
    try {
      const result = await withSessionOperation(core, req.params.session_id, async (session) => session?.accessor.get(ISessionOptionalCapabilityService).set(req.body.id, req.body.choice as CapabilityChoice));
      if (result === undefined) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'Session was not found', req.id));
        return;
      }
      reply.send(okEnvelope(wire(result), req.id));
    } catch (error) {
      if (isError2(error) && error.code === ErrorCodes.REQUEST_INVALID) {
        reply.send({ ...errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, req.id), details: error.details });
        return;
      }
      throw error;
    }
  });
  app.post(set.path, set.options, set.handler as never);
}

function wire(view: { revision: number; hostId: string; rows: readonly { id: string; choice: string; effective: boolean; source: string; reason: string; allowed: boolean; hostLocked: boolean; defaultOn: boolean; unresolved: boolean; applies: string }[] }) {
  return {
    revision: view.revision,
    host_id: view.hostId,
    rows: view.rows.map((row) => ({
      id: row.id,
      choice: row.choice,
      effective: row.effective,
      source: row.source,
      reason: row.reason,
      allowed: row.allowed,
      host_locked: row.hostLocked,
      default_on: row.defaultOn,
      unresolved: row.unresolved,
      applies: row.applies,
    })),
  };
}
