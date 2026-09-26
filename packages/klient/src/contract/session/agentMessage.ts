import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const agentCollaborationMessagingContract = {
  sendUserMessage: {
    input: z.tuple([z.object({
      targetAgentId: z.string().min(1),
      content: z.string().min(1).max(100_000),
      idempotencyKey: z.string().min(1).max(256),
    }).strict()]),
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
} satisfies ServiceContract;
