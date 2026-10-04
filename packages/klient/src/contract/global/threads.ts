/** App-scoped peer-thread communication contract mirrored from agent-core-v2. */

import { z } from 'zod';
import { contentRefSchema, contentSegmentSchema, transcriptResponseSchema } from '@kiki/transcript';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const threadRefSchema = z.object({
  hostId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  bridgeId: z.string().uuid().optional(),
  connectionId: z.string().uuid().optional(),
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
  origin: z.enum(['user', 'peer', 'bridged_peer']),
  bridgedPeer: z.object({ source: threadRefSchema, sourceHomeId: z.string().uuid(), targetHomeId: z.string().uuid(), bridgeId: z.string().uuid(),
    revision: z.number().int().positive(), location: z.enum(['local', 'network']), createdAt: z.number(), expiresAt: z.number(), sourceSeq: z.number(),
    causeId: z.string(), hop: z.number(), messageId: z.string() }).optional(),
  peer: z
    .object({ source: threadRefSchema, messageId: z.string().min(1) })
    .optional(),
  input: z.string(),
  output: z.string(),
});

export const readThreadInputSchema = z.object({
  thread: threadRefSchema,
  contentRef: contentRefSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

type PageTurn = Extract<z.infer<typeof transcriptResponseSchema>['items'][number], { kind: 'turn' }>;
type WirePageTurn = Omit<PageTurn, 'execution'> & { execution?: Omit<NonNullable<PageTurn['execution']>, 'losses'> & { losses: string[] } };
const wirePageTurn = (item: PageTurn): WirePageTurn => ({
  ...item, execution: item.execution === undefined ? undefined : { ...item.execution, losses: [...item.execution.losses] },
});
const threadTranscriptPageSchema = transcriptResponseSchema.transform((page) => ({
  ...page, items: page.items.map((item) => item.kind === 'turn' ? wirePageTurn(item) : item),
}));
export const readThreadResultSchema = z.object({
  thread: threadRefSchema,
  turns: z.array(threadTurnSchema),
  nextCursor: z.string().optional(),
  view: z.object({ transcript: threadTranscriptPageSchema.optional(), segment: contentSegmentSchema.optional() }).optional(),
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

export const threadMessageEndpointSchema = z.object({
  ref: threadRefSchema, title: z.string().optional(), deleted: z.boolean(), archived: z.boolean(),
});
export const threadCommunicationMessageSchema = z.object({
  messageId: z.string().describe('Stable recipient main-agent prompt id and user-message id, including steered delivery and retries; navigate only delivered records.'),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('thread'), thread: threadMessageEndpointSchema }),
    z.object({ kind: z.literal('room'), roomId: z.string() }),
  ]),
  target: threadMessageEndpointSchema, content: z.string(), acceptedAt: z.number(), targetSeq: z.number(),
  delivery: z.enum(['pending', 'delivered', 'undeliverable']), reason: z.string().optional(),
  reasonCode: z.enum([
    'thread_not_found', 'thread_archived', 'communication_disabled', 'cross_host',
    'prompt_rejected', 'session_unavailable', 'workspace_unavailable', 'executor_unavailable',
    'cancelled', 'delivery_failed',
  ]).optional(),
  reasonDetail: z.string().optional(),
});
export const listThreadMessagesInputSchema = z.object({
  workspaceId: z.string().trim().min(1).optional(), sessionId: z.string().trim().min(1).optional(),
  peerSessionId: z.string().trim().min(1).optional(), cursor: z.string().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict().refine((input) => input.peerSessionId === undefined || input.sessionId !== undefined);
export const listThreadMessagesResultSchema = z.object({
  items: z.array(threadCommunicationMessageSchema), nextCursor: z.string().optional(),
  incomplete: z.enum(['scan_budget', 'history_preparing']).optional(),
  history: z.object({
    generation: z.string(), state: z.enum(['complete', 'preparing', 'error']),
    processedMessages: z.number().int().nonnegative(), completedShards: z.number().int().nonnegative(),
    totalShards: z.number().int().positive(), pending: z.enum(['room', 'all']).optional(), error: z.string().optional(),
  }).optional(),
});

export const threadsContract = {
  listMessages: { input: z.tuple([listThreadMessagesInputSchema.optional()]), output: listThreadMessagesResultSchema },
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
