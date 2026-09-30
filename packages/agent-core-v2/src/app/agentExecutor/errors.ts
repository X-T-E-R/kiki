import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const ExecutorErrors = {
  codes: {
    EXECUTOR_BUSY: 'executor.busy',
    EXECUTOR_CANCELLED: 'executor.cancelled',
    EXECUTOR_CLOSED: 'executor.closed',
    EXECUTOR_DISCONNECTED: 'executor.disconnected',
    EXECUTOR_INVALID_SESSION_REF: 'executor.invalid_session_ref',
    EXECUTOR_PROTOCOL_ERROR: 'executor.protocol_error',
    EXECUTOR_SESSION_OPEN_FAILED: 'executor.session_open_failed',
    EXECUTOR_SESSION_FAILED: 'executor.session_failed',
    EXECUTOR_AUTHENTICATION_REQUIRED: 'executor.authentication_required',
    EXECUTOR_SPAWN_FAILED: 'executor.spawn_failed',
    EXECUTOR_STARTUP_TIMEOUT: 'executor.startup_timeout',
  },
  retryable: ['executor.disconnected', 'executor.startup_timeout'],
  info: {
    'executor.session_failed': { title: 'External session failed', retryable: false, public: true,
      action: 'Use the recovery actions reported by the external harness; do not replay the prompt automatically.' },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ExecutorErrors);
