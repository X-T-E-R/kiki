import { isError2 } from '@kiki/agent-core-v2';
import { ErrorCode } from '@kiki/protocol';

import { errEnvelope } from '../envelope';
import { AdmissionError } from '../services/connections/admission';
import { requestLog } from '../lib/requestLog';

export interface MappedErrorReply {
  code?(status: number): { send(payload: unknown): unknown };
  send(payload: unknown): unknown;
}

export interface MappedErrorFallback {
  readonly logMessage: string;
  readonly httpStatus?: number;
  readonly includeStack?: boolean;
  readonly nonErrorMessage?: 'string' | 'internal';
}

export interface MappedErrorSpec {
  readonly codes?: Readonly<Record<string, number>>;
  readonly detailsCodes?: ReadonlySet<string>;
  readonly includeDetails?: boolean;
  readonly omitStackCodes?: ReadonlySet<string>;
  readonly includeStack?: boolean;
  readonly admission?: boolean;
  readonly custom?: (
    err: unknown,
    requestId: string,
    reply: MappedErrorReply,
    req: { id: string } | undefined,
  ) => boolean;
  readonly fallback?: MappedErrorFallback;
}

export function trySendMappedError(
  reply: MappedErrorReply,
  reqOrId: string | { id: string },
  err: unknown,
  spec: MappedErrorSpec,
): boolean {
  const req = typeof reqOrId === 'string' ? undefined : reqOrId;
  const requestId = typeof reqOrId === 'string' ? reqOrId : reqOrId.id;
  if (spec.admission === true && err instanceof AdmissionError) {
    const payload = errEnvelope(40301, err.reason, requestId);
    if (reply.code !== undefined) reply.code(err.status).send(payload);
    else reply.send(payload);
    return true;
  }
  if (spec.custom?.(err, requestId, reply, req) === true) {
    return true;
  }
  if (spec.codes !== undefined && isError2(err)) {
    const mapped = spec.codes[err.code];
    if (mapped !== undefined) {
      const includeStack = spec.includeStack !== false && !spec.omitStackCodes?.has(err.code);
      const stack = includeStack ? err.stack : undefined;
      if (spec.includeDetails === true || spec.detailsCodes?.has(err.code) === true) {
        reply.send({
          ...errEnvelope(mapped, err.message, requestId, stack),
          details: err.details,
        });
      } else {
        reply.send(errEnvelope(mapped, err.message, requestId, stack));
      }
      return true;
    }
  }
  return false;
}

export function sendMappedError(
  reply: MappedErrorReply,
  reqOrId: string | { id: string },
  err: unknown,
  spec: MappedErrorSpec,
): void {
  if (trySendMappedError(reply, reqOrId, err, spec)) return;
  if (spec.fallback !== undefined) {
    const req = typeof reqOrId === 'string' ? undefined : reqOrId;
    const requestId = typeof reqOrId === 'string' ? reqOrId : reqOrId.id;
    if (req !== undefined) requestLog(req)?.error({ err }, spec.fallback.logMessage);
    const message = err instanceof Error
      ? err.message
      : (spec.fallback.nonErrorMessage === 'internal' ? 'internal error' : String(err));
    const stack = spec.fallback.includeStack !== false && err instanceof Error ? err.stack : undefined;
    const payload = errEnvelope(ErrorCode.INTERNAL_ERROR, message, requestId, stack);
    if (spec.fallback.httpStatus !== undefined && reply.code !== undefined) {
      reply.code(spec.fallback.httpStatus).send(payload);
    } else {
      reply.send(payload);
    }
    return;
  }
  throw err;
}
