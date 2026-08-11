/**
 * Peer-thread REST contracts. References always include host, workspace, and
 * session identity; waits are bounded to eight threads and sixty seconds.
 */

import { z } from 'zod';

import {
  threadActivitySchema,
  threadRefSchema,
  threadSummarySchema,
  threadTurnSchema,
} from '../thread';

export const listThreadsQuerySchema = z.object({
  workspace_id: z.string().trim().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListThreadsQuery = z.infer<typeof listThreadsQuerySchema>;

export const listThreadsResponseSchema = z.object({
  threads: z.array(threadSummarySchema),
  next_cursor: z.string().optional(),
});
export type ListThreadsResponse = z.infer<typeof listThreadsResponseSchema>;

export const readThreadRequestSchema = z.object({
  thread: threadRefSchema,
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type ReadThreadRequest = z.infer<typeof readThreadRequestSchema>;

export const readThreadResponseSchema = z.object({
  thread: threadRefSchema,
  turns: z.array(threadTurnSchema),
  next_cursor: z.string().optional(),
});
export type ReadThreadResponse = z.infer<typeof readThreadResponseSchema>;

export const sendThreadMessageRequestSchema = z
  .object({
    target: threadRefSchema,
    content: z.string().min(1).max(100_000),
    idempotency_key: z.string().min(1).max(256),
  })
  .strict();
export type SendThreadMessageRequest = z.infer<typeof sendThreadMessageRequestSchema>;

export const sendThreadMessageResponseSchema = z.object({
  message_id: z.string().min(1),
  target_seq: z.number().int().nonnegative(),
  accepted_at: z.number().int().nonnegative(),
  deduplicated: z.boolean(),
  delivery: z.enum(['pending', 'delivered', 'undeliverable']),
});
export type SendThreadMessageResponse = z.infer<typeof sendThreadMessageResponseSchema>;

export const waitThreadInputSchema = z.object({
  thread: threadRefSchema,
  cursor: z.string().min(1).optional(),
});

export const waitThreadsRequestSchema = z
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

export const waitThreadsResponseSchema = z.object({
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

export const threadWorkspaceParamSchema = z.object({
  workspace_id: z.string().trim().min(1),
});

export const setThreadWorkspaceOverrideRequestSchema = z.object({ enabled: z.boolean() });

export const threadWorkspaceOverrideResponseSchema = z.object({
  override: z.boolean().nullable(),
  effective_enabled: z.boolean(),
});
export type ThreadWorkspaceOverrideResponse = z.infer<
  typeof threadWorkspaceOverrideResponseSchema
>;
