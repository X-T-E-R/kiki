/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import type { AgentMessageDeliveredEvent } from '@kiki/protocol';
import { z } from 'zod';

import { Event2, registerEvent2Class } from '#/app/event/event2';

const agentMessageDeliveredSchema = z.object({
  messageId: z.string().min(1),
  targetAgentId: z.string().min(1),
  status: z.literal('delivered'),
  deliveredAt: z.string().datetime(),
}) satisfies z.ZodType<Omit<AgentMessageDeliveredEvent, 'type'>>;

export class AgentMessageDelivered extends Event2<Omit<AgentMessageDeliveredEvent, 'type'>> {
  static override readonly type = 'agent_message.delivered';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = agentMessageDeliveredSchema;
}
export interface AgentMessageDelivered extends Omit<AgentMessageDeliveredEvent, 'type'> {}

registerEvent2Class(AgentMessageDelivered);
