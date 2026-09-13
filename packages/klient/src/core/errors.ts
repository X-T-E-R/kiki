import { Error2, ErrorCodes } from '@kiki/agent-core-v2/errors';

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
    readonly requestId?: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RPCError';
  }
}

/**
 * Engine error code → wire number, mirroring what kap-server's REST mappers
 * send for the same `Error2`. Anything absent collapses to 50001, which is why
 * a locked session or a missing session read as "internal error" over IPC while
 * REST named them: the two client surfaces of one product must agree.
 */
const ENGINE_ERROR_CODES: Readonly<Record<string, number>> = {
  [ErrorCodes.REQUEST_INVALID]: 40001,
  // MCP management plane: mirror the `/api/v2/mcp` wire codes so memory and
  // ipc surface the same numbers as REST.
  [ErrorCodes.CONFIG_INVALID]: 40001,
  [ErrorCodes.SESSION_NOT_FOUND]: 40401,
  [ErrorCodes.AGENT_NOT_FOUND]: 40401,
  [ErrorCodes.PROMPT_NOT_FOUND]: 40402,
  [ErrorCodes.MCP_SERVER_NOT_FOUND]: 40408,
  [ErrorCodes.WORKSPACE_NOT_FOUND]: 40410,
  [ErrorCodes.TERMINAL_NOT_FOUND]: 40414,
  [ErrorCodes.SKILL_NOT_FOUND]: 40415,
  [ErrorCodes.MCP_OAUTH_FAILED]: 40940,
  [ErrorCodes.SESSION_BUSY]: 40901,
  [ErrorCodes.COMPACTION_UNABLE]: 40910,
  [ErrorCodes.STORAGE_LOCKED]: 40933,
  [ErrorCodes.SESSION_INDEX_BUILDING]: 40939,
  [ErrorCodes.THREAD_NOT_FOUND]: 40421,
  [ErrorCodes.THREAD_ARCHIVED]: 40927,
  [ErrorCodes.THREAD_DISABLED]: 40928,
  [ErrorCodes.THREAD_CROSS_HOST]: 40929,
  [ErrorCodes.THREAD_SELF_SEND]: 40930,
  [ErrorCodes.THREAD_CURSOR_INVALID]: 40931,
  [ErrorCodes.THREAD_IDEMPOTENCY_CONFLICT]: 40932,
  [ErrorCodes.PROMPT_ID_CONFLICT]: 40938,
  [ErrorCodes.THREAD_LIMIT_EXCEEDED]: 42903,
  'dispatch.limit_exceeded': 42904,
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
