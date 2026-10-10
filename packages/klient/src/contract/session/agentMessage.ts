import { z } from 'zod';

import type { ServiceContract } from '../types.js';

/** Both user-authored mailbox methods accept exactly this payload. */
const sendUserMessageInput = z.tuple([z.object({
  targetAgentId: z.string().min(1),
  content: z.string().min(1),
  idempotencyKey: z.string().min(1).max(256),
}).strict()]);

export const agentCollaborationMessagingContract = {
  sendUserMessage: {
    input: sendUserMessageInput,
    output: z.object({
      message: z.object({
        messageId: z.string(),
        sessionId: z.string(),
        sourceAgentId: z.string(),
        sourceTaskName: z.string(),
        senderKind: z.literal('user').optional(),
        targetAgentId: z.string(),
        targetTaskName: z.string(),
        content: z.string(),
        acceptedAt: z.number(),
        targetSeq: z.number(),
      }),
      deduplicated: z.boolean(),
      delivery: z.enum(['queued', 'delivered']),
      payloadConflict: z.boolean(),
      resumed: z.boolean().optional(),
    }),
  },
  /** The same acceptance without `message.content`, so a long body never crosses the response budget. */
  sendUserMessageReceipt: {
    input: sendUserMessageInput,
    output: z.object({
      message: z.object({
        messageId: z.string(),
        sessionId: z.string(),
        sourceAgentId: z.string(),
        sourceTaskName: z.string(),
        senderKind: z.literal('user').optional(),
        targetAgentId: z.string(),
        targetTaskName: z.string(),
        acceptedAt: z.number(),
        targetSeq: z.number(),
      }),
      deduplicated: z.boolean(),
      delivery: z.enum(['queued', 'delivered']),
      payloadConflict: z.boolean(),
      resumed: z.boolean().optional(),
    }),
  },
} satisfies ServiceContract;
