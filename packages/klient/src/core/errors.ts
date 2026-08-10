import { Error2, ErrorCodes } from '@moonshot-ai/agent-core-v2/errors';

/**
 * Client-side RPC error surfaced when the wire envelope carries a non-zero
 * `code`. Mirrors the server envelope (`{ code, msg, data, request_id }`) — the
 * numeric `code` is the stable branch key across the wire, not `instanceof`.
 */
export class RPCError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly details?: unknown,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'RPCError';
  }
}

const ENGINE_ERROR_CODES: Readonly<Record<string, number>> = {
  [ErrorCodes.REQUEST_INVALID]: 40001,
  [ErrorCodes.THREAD_NOT_FOUND]: 40418,
  [ErrorCodes.THREAD_ARCHIVED]: 40923,
  [ErrorCodes.THREAD_DISABLED]: 40924,
  [ErrorCodes.THREAD_CROSS_HOST]: 40925,
  [ErrorCodes.THREAD_SELF_SEND]: 40926,
  [ErrorCodes.THREAD_CURSOR_INVALID]: 40927,
  [ErrorCodes.THREAD_IDEMPOTENCY_CONFLICT]: 40928,
  [ErrorCodes.THREAD_LIMIT_EXCEEDED]: 42903,
  [ErrorCodes.THREAD_DELIVERY_FAILED]: 50005,
};

export function toRPCError(error: unknown): unknown {
  if (error instanceof RPCError) return error;
  if (error instanceof Error2) {
    return new RPCError(
      ENGINE_ERROR_CODES[error.code] ?? 50001,
      error.message,
      error.details,
      error.code,
    );
  }
  return error;
}
