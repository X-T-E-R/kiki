/**
 * `threadCommunication` domain — coded peer-thread failures.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const ThreadCommunicationErrors = {
  codes: {
    THREAD_NOT_FOUND: 'thread.not_found',
    THREAD_ARCHIVED: 'thread.archived',
    THREAD_DISABLED: 'thread.disabled',
    THREAD_CROSS_HOST: 'thread.cross_host',
    THREAD_SELF_SEND: 'thread.self_send',
    THREAD_CURSOR_INVALID: 'thread.cursor_invalid',
    THREAD_IDEMPOTENCY_CONFLICT: 'thread.idempotency_conflict',
    THREAD_LIMIT_EXCEEDED: 'thread.limit_exceeded',
    THREAD_DELIVERY_FAILED: 'thread.delivery_failed',
  },
  retryable: ['thread.delivery_failed'],
} as const satisfies ErrorDomain;

registerErrorDomain(ThreadCommunicationErrors);
