/**
 * Peer-thread REST contracts. References always include host, workspace, and
 * session identity; waits are bounded to eight threads and sixty seconds.
 */

import { contentRefSchema } from '@kiki/transcript';
import { z } from 'zod';

import { bridgeReadViewSchema } from './thread-bridge';
import {
  threadActivitySchema,
  threadRefSchema,
  threadSummarySchema,
  threadTurnSchema,
} from '../thread';

export const listThreadsQuerySchema = /* @__PURE__ */ z.object({
  workspace_id: z.string().trim().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListThreadsQuery = z.infer<typeof listThreadsQuerySchema>;

export const listThreadsResponseSchema = /* @__PURE__ */ z.object({
  threads: z.array(threadSummarySchema),
  next_cursor: z.string().optional(),
});
export type ListThreadsResponse = z.infer<typeof listThreadsResponseSchema>;

export const readThreadRequestSchema = /* @__PURE__ */ z.object({
  thread: threadRefSchema,
  content_ref: contentRefSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type ReadThreadRequest = z.infer<typeof readThreadRequestSchema>;

export const readThreadResponseSchema = /* @__PURE__ */ z.object({
  thread: threadRefSchema,
  turns: z.array(threadTurnSchema),
  next_cursor: z.string().optional(),
  incomplete: z.literal('history_preparing').optional(),
  view: bridgeReadViewSchema.optional(),
});
export type ReadThreadResponse = z.infer<typeof readThreadResponseSchema>;

export const sendThreadMessageRequestSchema = /* @__PURE__ */ z
  .object({
    target: threadRefSchema,
    content: z.string().min(1).max(100_000),
    idempotency_key: z.string().min(1).max(256),
  })
  .strict();
export type SendThreadMessageRequest = z.infer<typeof sendThreadMessageRequestSchema>;

export const sendThreadMessageResponseSchema = /* @__PURE__ */ z.object({
  message_id: z.string().min(1),
  target_seq: z.number().int().nonnegative(),
  accepted_at: z.number().int().nonnegative(),
  deduplicated: z.boolean(),
  delivery: z.enum(['pending', 'delivered', 'undeliverable']),
});
export type SendThreadMessageResponse = z.infer<typeof sendThreadMessageResponseSchema>;

export const waitThreadInputSchema = /* @__PURE__ */ z.object({
  thread: threadRefSchema,
  cursor: z.string().min(1).optional(),
});

export const waitThreadsRequestSchema = /* @__PURE__ */ z
  .object({
    threads: z.array(waitThreadInputSchema).min(1).max(8),
    timeout_ms: z.number().int().min(0).max(60_000).optional(),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.threads.forEach((item, index) => {
      const key = `${item.thread.host_id}\u0000${item.thread.workspace_id}\u0000${item.thread.session_id}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['threads', index],
          message: 'duplicate thread reference',
        });
      }
      seen.add(key);
    });
  });
export type WaitThreadsRequest = z.infer<typeof waitThreadsRequestSchema>;

export const waitThreadsResponseSchema = /* @__PURE__ */ z.object({
  threads: z.array(
    z.object({
      thread: threadRefSchema,
      cursor: z.string().min(1),
      activities: z.array(threadActivitySchema),
    }),
  ),
  timed_out: z.boolean(),
});
export type WaitThreadsResponse = z.infer<typeof waitThreadsResponseSchema>;

export const threadWorkspaceParamSchema = /* @__PURE__ */ z.object({
  workspace_id: z.string().trim().min(1),
});

export const setThreadWorkspaceOverrideRequestSchema = /* @__PURE__ */ z.object({ enabled: z.boolean() });

export const threadWorkspaceOverrideResponseSchema = /* @__PURE__ */ z.object({
  override: z.boolean().nullable(),
  effective_enabled: z.boolean(),
});
export type ThreadWorkspaceOverrideResponse = z.infer<
  typeof threadWorkspaceOverrideResponseSchema
>;

export const threadMessageEndpointSchema = /* @__PURE__ */ z.object({
  ref: threadRefSchema,
  title: z.string().optional(),
  deleted: z.boolean(),
  archived: z.boolean(),
});

export const threadDeliveryReasonCodeSchema = /* @__PURE__ */ z.enum([
  'thread_not_found', 'thread_archived', 'communication_disabled', 'cross_host',
  'prompt_rejected', 'session_unavailable', 'workspace_unavailable', 'executor_unavailable',
  'cancelled', 'delivery_failed',
]);

export const threadCommunicationMessageSchema = /* @__PURE__ */ z.object({
  message_id: z.string().describe('Stable recipient main-agent prompt id and user-message id, including steered delivery and retries; navigate only delivered records.'),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('thread'), thread: threadMessageEndpointSchema }),
    z.object({ kind: z.literal('room'), room_id: z.string() }),
  ]),
  target: threadMessageEndpointSchema,
  content: z.string(),
  accepted_at: z.number(),
  target_seq: z.number().int().nonnegative(),
  delivery: z.enum(['pending', 'delivered', 'undeliverable']),
  reason_code: threadDeliveryReasonCodeSchema.optional(),
  reason_detail: z.string().optional(),
  reason: z.string().optional(),
});

export const listThreadMessagesQuerySchema = /* @__PURE__ */ z.object({
  workspace_id: z.string().trim().min(1).optional(),
  session_id: z.string().trim().min(1).optional(),
  peer_session_id: z.string().trim().min(1).optional(),
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict().refine((input) => input.peer_session_id === undefined || input.session_id !== undefined, {
  message: 'peer_session_id requires session_id',
});
export type ListThreadMessagesQuery = z.infer<typeof listThreadMessagesQuerySchema>;

export const listThreadMessagesResponseSchema = /* @__PURE__ */ z.object({
  items: z.array(threadCommunicationMessageSchema),
  next_cursor: z.string().optional(),
  incomplete: z.enum(['scan_budget', 'history_preparing']).optional(),
  history: z.object({
    generation: z.string(), state: z.enum(['complete', 'preparing', 'error']),
    processedMessages: z.number().int().nonnegative(), completedShards: z.number().int().nonnegative(),
    totalShards: z.number().int().positive(), pending: z.enum(['room', 'all']).optional(), error: z.string().optional(),
  }).optional(),
});
export type ListThreadMessagesResponse = z.infer<typeof listThreadMessagesResponseSchema>;
