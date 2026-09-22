import { ulid } from 'ulid';

import type { PromptOrigin } from './types';

export type MessageDeliveryOrigin = 'user' | 'queue' | 'mailbox' | 'recovery' | 'injection';

export interface MessageDelivery {
  readonly deliveryId: string;
  readonly messageId: string;
  readonly turnId?: number;
  readonly stepId?: string;
  readonly step?: number;
  readonly deliveredAt: string;
  readonly origin: MessageDeliveryOrigin;
}

export function newDeliveryId(): string {
  return `dlv_${ulid()}`;
}

export function isDeliveryVisibleMessage(message: { readonly role: string }): boolean {
  return message.role === 'user';
}

export function deliveryOriginOf(origin: PromptOrigin | undefined): MessageDeliveryOrigin {
  if (origin === undefined) return 'user';
  switch (origin.kind) {
    case 'user':
    case 'skill_activation':
    case 'plugin_command':
      return 'user';
    case 'injection':
      return 'injection';
    case 'agent_message':
    case 'peer_thread':
      return 'mailbox';
    case 'retry':
      return 'recovery';
    case 'system_trigger':
    case 'task':
    case 'cron_job':
    case 'cron_missed':
    case 'shell_command':
    case 'hook_result':
    case 'compaction_summary':
      return 'queue';
  }
}
