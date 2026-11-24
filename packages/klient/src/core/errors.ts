/**
 * Client-side RPC error surfaced when the wire envelope carries a non-zero
 * `code`. Mirrors the server envelope (`{ code, msg, data, request_id }`) — the
 * numeric `code` is the stable branch key across the wire, not `instanceof`.
 */
export type RPCErrorSource = 'transport';

export class RPCError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly details?: unknown,
    readonly reason?: string,
    readonly requestId?: string,
    readonly data?: unknown,
    readonly source?: RPCErrorSource,
  ) {
    super(message);
    this.name = 'RPCError';
  }
}

/**
 * Engine error code → wire number, mirroring what kap-server's REST mappers
 * send for the same `Error2`. Kept as pure string literals so `@kiki/klient/http`
 * carries zero runtime dependency on `@kiki/agent-core-v2`.
 */
const ENGINE_ERROR_CODES: Readonly<Record<string, number>> = {
  'request.invalid': 40001,
  'config.invalid': 40001,
  'session.not_found': 40401,
  'agent.not_found': 40401,
  'prompt.not_found': 40402,
  'mcp.server_not_found': 40408,
  'workspace.not_found': 40410,
  'terminal.not_found': 40414,
  'skill.not_found': 40415,
  'provider.not_found': 40412,
  'model.not_found': 40413,
  'provider.already_exists': 40921,
  'model.already_exists': 40942,
  'model_catalog.revision_conflict': 40941,
  'mcp.oauth_failed': 40940,
  'session.busy': 40901,
  'compaction.unable': 40910,
  'storage.locked': 40933,
  'session.index_building': 40939,
  'thread.not_found': 40421,
  'thread.archived': 40927,
  'thread.disabled': 40928,
  'thread.cross_host': 40929,
  'thread.self_send': 40930,
  'thread.cursor_invalid': 40931,
  'thread.idempotency_conflict': 40932,
  'prompt.id_conflict': 40938,
  'work.admission_fenced': 40950,
  'thread.limit_exceeded': 42903,
  'dispatch.limit_exceeded': 42904,
  'thread.delivery_failed': 50005,
};

function isEngineErrorLike(error: unknown): error is Error & { readonly code: string; readonly details?: unknown } {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && (code.includes('.') || error.name === 'Error2');
}

export function toRPCError(error: unknown): unknown {
  if (error instanceof RPCError) return error;
  if (isEngineErrorLike(error)) {
    return new RPCError(
      ENGINE_ERROR_CODES[error.code] ?? 50001,
      error.message,
      error.details,
      error.code,
    );
  }
  return error;
}
