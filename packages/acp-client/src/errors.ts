export const AcpClientErrorCode = {
  Busy: 'executor.busy',
  Cancelled: 'executor.cancelled',
  Closed: 'executor.closed',
  Disconnected: 'executor.disconnected',
  InvalidSessionRef: 'executor.invalid_session_ref',
  ProtocolError: 'executor.protocol_error',
  SessionOpenFailed: 'executor.session_open_failed',
  SpawnFailed: 'executor.spawn_failed',
  StartupTimeout: 'executor.startup_timeout',
} as const;

export type AcpClientErrorCode =
  (typeof AcpClientErrorCode)[keyof typeof AcpClientErrorCode];

export class AcpClientError extends Error {
  readonly code: AcpClientErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: AcpClientErrorCode,
    message: string,
    options: {
      readonly cause?: unknown;
      readonly details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AcpClientError';
    this.code = code;
    this.details = options.details;
  }
}

export class AcpProtocolError extends AcpClientError {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(AcpClientErrorCode.ProtocolError, message, options);
    this.name = 'AcpProtocolError';
  }
}
