export type HomeRuntimeErrorCode =
  | 'runtime.identity_mismatch'
  | 'runtime.token_mismatch'
  | 'runtime.protocol_mismatch'
  | 'runtime.epoch_stale'
  | 'runtime.epoch_future'
  | 'runtime.outstanding_overflow'
  | 'runtime.pending_overflow'
  | 'runtime.frame_overflow'
  | 'runtime.connection_failed'
  | 'runtime.connection_fatal'
  | 'runtime.timeout'
  | 'runtime.owner_gone'
  | 'runtime.detached'
  | 'runtime.not_registered'
  | 'runtime.invalid_request'
  | 'runtime.invalid_config'
  | 'runtime.io_failed'
  | 'runtime.aborted'
  | 'runtime.duplicate_request'
  | 'mailbox.legacy_writer_active';

export class HomeRuntimeError extends Error {
  readonly code: HomeRuntimeErrorCode;

  constructor(code: HomeRuntimeErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.name = 'HomeRuntimeError';
  }
}

export function isFatalRuntimeError(error: unknown): boolean {
  return error instanceof HomeRuntimeError && (
    error.code === 'runtime.connection_fatal' ||
    error.code === 'runtime.io_failed' ||
    error.code === 'runtime.identity_mismatch' ||
    error.code === 'runtime.token_mismatch' ||
    error.code === 'runtime.protocol_mismatch'
  );
}

const RUNTIME_ERROR_CODES = new Set<string>([
  'runtime.identity_mismatch',
  'runtime.token_mismatch',
  'runtime.protocol_mismatch',
  'runtime.epoch_stale',
  'runtime.epoch_future',
  'runtime.outstanding_overflow',
  'runtime.pending_overflow',
  'runtime.frame_overflow',
  'runtime.connection_failed',
  'runtime.connection_fatal',
  'runtime.timeout',
  'runtime.owner_gone',
  'runtime.detached',
  'runtime.not_registered',
  'runtime.invalid_request',
  'runtime.invalid_config',
  'runtime.io_failed',
  'runtime.aborted',
  'runtime.duplicate_request',
  'mailbox.legacy_writer_active',
]);

export function fromErrorPayloadCode(code: string): HomeRuntimeErrorCode {
  return RUNTIME_ERROR_CODES.has(code)
    ? code as HomeRuntimeErrorCode
    : 'runtime.connection_failed';
}
