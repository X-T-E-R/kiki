/** App-scoped peer-thread communication contract mirrored from agent-core-v2. */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const threadRefSchema = z.object({
  hostId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
});

export const threadSummarySchema = z.object({
  ref: threadRefSchema,
  title: z.string().optional(),
  updatedAt: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  state: z.enum(['cold', 'idle', 'running']),
});

export const listThreadsInputSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const listThreadsResultSchema = z.object({
  threads: z.array(threadSummarySchema),
  nextCursor: z.string().optional(),
});

export const threadTurnSchema = z.object({
  turnId: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative(),
  reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
  origin: z.enum(['user', 'peer']),
  peer: z
    .object({ source: threadRefSchema, messageId: z.string().min(1) })
    .optional(),
  input: z.string(),
  output: z.string(),
});

export const readThreadInputSchema = z.object({
  thread: threadRefSchema,
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const readThreadResultSchema = z.object({
  thread: threadRefSchema,
  turns: z.array(threadTurnSchema),
  nextCursor: z.string().optional(),
});

export const sendThreadMessageInputSchema = z
  .object({
    target: threadRefSchema,
    content: z.string().min(1).max(100_000),
    idempotencyKey: z.string().min(1).max(256),
  })
  .strict();

export const sendThreadMessageResultSchema = z.object({
  messageId: z.string().min(1),
  targetSeq: z.number().int().nonnegative(),
  acceptedAt: z.number().int().nonnegative(),
  deduplicated: z.boolean(),
  delivery: z.enum(['pending', 'delivered', 'undeliverable']),
});

export const threadActivitySchema = z.object({
  ref: threadRefSchema,
  seq: z.number().int().nonnegative(),
  kind: z.enum(['terminal', 'attention', 'lifecycle', 'message_undeliverable']),
  at: z.number().int().nonnegative(),
  reason: z.string(),
  turnId: z.number().int().nonnegative().optional(),
  messageId: z.string().min(1).optional(),
});

export const waitThreadInputSchema = z.object({
  thread: threadRefSchema,
  cursor: z.string().min(1).optional(),
});

export const waitThreadsInputSchema = z
  .object({
    threads: z.array(waitThreadInputSchema).min(1).max(8),
    timeoutMs: z.number().int().min(0).max(60_000).optional(),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.threads.forEach((item, index) => {
      const { hostId, workspaceId, sessionId } = item.thread;
      const key = `${hostId}\u0000${workspaceId}\u0000${sessionId}`;
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

export const waitThreadResultSchema = z.object({
  thread: threadRefSchema,
  cursor: z.string().min(1),
  activities: z.array(threadActivitySchema),
});

export const waitThreadsResultSchema = z.object({
  threads: z.array(waitThreadResultSchema),
  timedOut: z.boolean(),
});

export const threadsContract = {
  hostId: { input: z.tuple([]), output: z.string().min(1) },
  listThreads: {
    input: z.tuple([listThreadsInputSchema.optional()]),
    output: listThreadsResultSchema,
  },
  readThread: { input: z.tuple([readThreadInputSchema]), output: readThreadResultSchema },
  sendMessage: {
    input: z.tuple([sendThreadMessageInputSchema]),
    output: sendThreadMessageResultSchema,
  },
  waitThreads: { input: z.tuple([waitThreadsInputSchema]), output: waitThreadsResultSchema },
  getWorkspaceOverride: {
    input: z.tuple([z.string().trim().min(1)]),
    output: maybe(z.boolean()),
  },
  setWorkspaceOverride: {
    input: z.tuple([z.string().trim().min(1), z.boolean()]),
    output: noResult,
  },
  clearWorkspaceOverride: { input: z.tuple([z.string().trim().min(1)]), output: noResult },
  isWorkspaceEnabled: { input: z.tuple([z.string().trim().min(1)]), output: z.boolean() },
} satisfies ServiceContract;
