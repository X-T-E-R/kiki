import { ErrorCodes, isError2 } from '#/errors';

import type { ThreadDeliveryReasonCode } from './threadCommunication';

export function threadDeliveryReasonCode(error: unknown): ThreadDeliveryReasonCode {
  if (!isError2(error)) return 'delivery_failed';
  switch (error.code) {
    case ErrorCodes.THREAD_NOT_FOUND: return 'thread_not_found';
    case ErrorCodes.THREAD_ARCHIVED: return 'thread_archived';
    case ErrorCodes.THREAD_DISABLED: return 'communication_disabled';
    case ErrorCodes.THREAD_CROSS_HOST: return 'cross_host';
    case ErrorCodes.EXECUTOR_CANCELLED: return 'cancelled';
  }
  if (error.code.startsWith('prompt.') || error.code.startsWith('request.')) return 'prompt_rejected';
  if (error.code.startsWith('session.')) return 'session_unavailable';
  if (error.code.startsWith('workspace.')) return 'workspace_unavailable';
  if (error.code.startsWith('executor.')) return 'executor_unavailable';
  return 'delivery_failed';
}
