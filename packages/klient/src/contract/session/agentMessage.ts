import { z } from 'zod';

import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

/** Both user-authored mailbox methods accept exactly this payload. */
const sendUserMessageInput = /* @__PURE__ */ z.tuple([z.object({
  targetAgentId: z.string().min(1),
  content: z.string().min(1),
  idempotencyKey: z.string().min(1).max(256),
}).strict()]);

export const agentCollaborationMessagingContract = {
  sendUserMessage: /* @__PURE__ */ lazyContract(() => ({
    input: sendUserMessageInput,
    output: /* @__PURE__ */ z.object({
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
  }), 'input', 'output'),
  /** The same acceptance without `message.content`, so a long body never crosses the response budget. */
  sendUserMessageReceipt: /* @__PURE__ */ lazyContract(() => ({
    input: sendUserMessageInput,
    output: /* @__PURE__ */ z.object({
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
  }), 'input', 'output'),
} satisfies ServiceContract;
