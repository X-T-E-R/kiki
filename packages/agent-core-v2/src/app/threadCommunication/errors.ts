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
    MAILBOX_LEGACY_WRITER_ACTIVE: 'mailbox.legacy_writer_active',
  },
  retryable: ['thread.delivery_failed', 'mailbox.legacy_writer_active'],
} as const satisfies ErrorDomain;

registerErrorDomain(ThreadCommunicationErrors);
