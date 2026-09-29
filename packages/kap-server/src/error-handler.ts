import { ErrorCodes, isError2 } from '@kiki/agent-core-v2';

import { errEnvelope } from './envelope';
import { ErrorCode } from './protocol/error-codes';
import type { FastifyError } from 'fastify';

interface ErrorHandlerHost {
  setErrorHandler(
    handler: (
      err: FastifyError,
      req: { id: string; log: { error: (obj: object | string, msg?: string) => void } },
      reply: { status(code: number): { send(payload: unknown): void } },
    ) => void,
  ): unknown;
}

/** Installs the catch-all REST error handler. Provider failures keep their wire code but add the
 *  engine's stable `error_kind` classification to `details`; their remaining details (upstream
 *  text, request ids) stay server-side. */
export function installErrorHandler(app: ErrorHandlerHost): void {
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      reply
        .status(413)
        .send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'request body exceeds the allowed size limit', requestId));
      return;
    }
    if (isError2(err) && err.code === ErrorCodes.CONFIG_INVALID) {
      reply
        .status(200)
        .send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack));
      return;
    }
    if (isError2(err) && err.code === ErrorCodes.STORAGE_LOCKED) {
      reply.status(200).send(errEnvelope(ErrorCode.SESSION_LOCKED, err.message, requestId, err.stack));
      return;
    }
    if (isError2(err) && err.code === ErrorCodes.SESSION_INDEX_BUILDING) {
      reply
        .status(200)
        .send(errEnvelope(ErrorCode.SESSION_INDEX_BUILDING, err.message, requestId, err.stack));
      return;
    }
    req.log.error({ error_type: err.code ?? err.name, request_id: requestId }, 'unhandled error');
    const errorKind = isError2(err) ? providerErrorKindOf(err.details) : undefined;
    reply.status(200).send({
      ...errEnvelope(
        ErrorCode.INTERNAL_ERROR,
        err.message !== undefined && err.message !== '' ? err.message : 'internal error',
        requestId,
        err.stack,
      ),
      ...(errorKind === undefined ? {} : { details: { error_kind: errorKind } }),
    });
  });
}

function providerErrorKindOf(details: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const kind = details?.['error_kind'];
  return typeof kind === 'string' && kind.length > 0 ? kind : undefined;
}
