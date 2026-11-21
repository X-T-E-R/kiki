/** App-scoped peer-thread communication contract mirrored from agent-core-v2. */

import { z } from 'zod';
import {
  agentRefSchema,
  attachmentSchema,
  contentRefSchema,
  contentSegmentSchema,
  interactionSchema,
  noticeFrameSchema,
  thinkingFrameSchema,
  textFrameSchema,
  todoSchema,
  toolCallFrameSchema,
  transcriptMarkerSchema,
  transcriptMetaSchema,
  transcriptPromptSchema,
  transcriptResponseSchema,
  transcriptStepSchema,
  transcriptTaskSchema,
  transcriptTaskRefSchema,
  transcriptTurnExecutionSchema,
  transcriptTurnSchema,
} from '@kiki/transcript';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const threadRefSchema = /* @__PURE__ */ z.object({
  hostId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  personaId: z.string().optional(),
  name: z.string().optional(),
  bridgeId: z.string().uuid().optional(),
  connectionId: z.string().uuid().optional(),
});

export const threadSummarySchema = /* @__PURE__ */ z.object({
  ref: threadRefSchema,
  title: z.string().optional(),
  updatedAt: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  state: z.enum(['cold', 'idle', 'running', 'cleanup_pending', 'unknown']),
});

export const listThreadsInputSchema = /* @__PURE__ */ z.object({
  workspaceId: z.string().trim().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const listThreadsResultSchema = /* @__PURE__ */ z.object({
  threads: z.array(threadSummarySchema),
  nextCursor: z.string().optional(),
});

export const threadTurnSchema = /* @__PURE__ */ z.object({
  turnId: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative(),
  reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
  origin: z.enum(['user', 'peer', 'bridged_peer', 'external', 'mixed', 'unknown', 'thread_created']),
  bridgedPeer: z.object({ source: threadRefSchema, sourceHomeId: z.string().uuid(), targetHomeId: z.string().uuid(), bridgeId: z.string().uuid(),
    revision: z.number().int().positive(), location: z.enum(['local', 'network']), createdAt: z.number(), expiresAt: z.number(), sourceSeq: z.number(),
    causeId: z.string(), hop: z.number(), messageId: z.string() }).optional(),
  peer: z
    .object({ source: threadRefSchema, messageId: z.string().min(1) })
    .optional(),
  input: z.string(),
  output: z.string(),
  contentRefs: z.array(contentRefSchema).optional(),
});

export const readThreadInputSchema = /* @__PURE__ */ z.object({
  thread: threadRefSchema,
  contentRef: contentRefSchema.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const wireContentRefsSchema = /* @__PURE__ */ z.array(contentRefSchema).optional();
const wireTextFrameSchema = /* @__PURE__ */ textFrameSchema.extend({
  contentRefs: wireContentRefsSchema,
  attachmentIds: z.array(z.string()).optional(),
});
const wireThinkingFrameSchema = /* @__PURE__ */ thinkingFrameSchema.extend({ contentRefs: wireContentRefsSchema });
const wireToolCallFrameSchema = /* @__PURE__ */ toolCallFrameSchema.extend({
  contentRefs: wireContentRefsSchema,
  agentRefs: z.array(agentRefSchema).optional(),
});
const wireNoticeFrameSchema = /* @__PURE__ */ noticeFrameSchema.extend({ contentRefs: wireContentRefsSchema });
const wireTranscriptFrameSchema = /* @__PURE__ */ z.discriminatedUnion('kind', [
  wireTextFrameSchema,
  wireThinkingFrameSchema,
  wireToolCallFrameSchema,
  wireNoticeFrameSchema,
]);
const wireTranscriptStepSchema = /* @__PURE__ */ transcriptStepSchema.extend({ frames: z.array(wireTranscriptFrameSchema) });
const wireTranscriptTurnSchema = /* @__PURE__ */ transcriptTurnSchema.extend({
  contentRefs: wireContentRefsSchema,
  attachmentIds: z.array(z.string()).optional(),
  steps: z.array(wireTranscriptStepSchema),
  execution: transcriptTurnExecutionSchema.extend({ losses: z.array(z.string()) }).optional(),
});
const wireTranscriptItemSchema = /* @__PURE__ */ z.discriminatedUnion('kind', [
  wireTranscriptTurnSchema,
  transcriptMarkerSchema.extend({ contentRefs: wireContentRefsSchema }),
  transcriptTaskRefSchema,
]);
const wireTranscriptPageSchema = /* @__PURE__ */ transcriptResponseSchema.extend({
  items: z.array(wireTranscriptItemSchema),
  tasks: z.array(transcriptTaskSchema.extend({ contentRefs: wireContentRefsSchema })),
  interactions: z.array(interactionSchema.extend({ contentRefs: wireContentRefsSchema })).default([]),
  attachments: z.array(attachmentSchema.extend({ contentRefs: wireContentRefsSchema })).default([]),
  todos: z.array(todoSchema.extend({ contentRefs: wireContentRefsSchema })).default([]),
  prompts: z.array(transcriptPromptSchema.extend({ contentRefs: wireContentRefsSchema })).default([]),
  meta: transcriptMetaSchema.extend({ contentRefs: wireContentRefsSchema }),
});
export const readThreadResultSchema = /* @__PURE__ */ z.object({
  thread: threadRefSchema,
  turns: z.array(threadTurnSchema),
  nextCursor: z.string().optional(),
  incomplete: z.literal('history_preparing').optional(),
  view: z.object({ transcript: wireTranscriptPageSchema.optional(), segment: contentSegmentSchema.optional() }).optional(),
});

export const sendThreadMessageInputSchema = /* @__PURE__ */ z
  .object({
    target: threadRefSchema,
    content: z.string().min(1).max(100_000),
    idempotencyKey: z.string().min(1).max(256),
  })
  .strict();

export const sendThreadMessageResultSchema = /* @__PURE__ */ z.object({
  messageId: z.string().min(1),
  targetSeq: z.number().int().nonnegative(),
  acceptedAt: z.number().int().nonnegative(),
  deduplicated: z.boolean(),
  delivery: z.enum(['pending', 'delivered', 'undeliverable']),
});

export const threadActivitySchema = /* @__PURE__ */ z.object({
  ref: threadRefSchema,
  seq: z.number().int().nonnegative(),
  kind: z.enum(['terminal', 'attention', 'lifecycle', 'message_undeliverable']),
  at: z.number().int().nonnegative(),
  reason: z.string(),
  turnId: z.number().int().nonnegative().optional(),
  messageId: z.string().min(1).optional(),
});

export const waitThreadInputSchema = /* @__PURE__ */ z.object({
  thread: threadRefSchema,
  cursor: z.string().min(1).optional(),
});

export const waitThreadsInputSchema = /* @__PURE__ */ z
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

export const waitThreadResultSchema = /* @__PURE__ */ z.object({
  thread: threadRefSchema,
  cursor: z.string().min(1),
  activities: z.array(threadActivitySchema),
});

export const waitThreadsResultSchema = /* @__PURE__ */ z.object({
  threads: z.array(waitThreadResultSchema),
  timedOut: z.boolean(),
});

export const threadMessageEndpointSchema = /* @__PURE__ */ z.object({
  ref: threadRefSchema, title: z.string().optional(), deleted: z.boolean(), archived: z.boolean(),
});
export const threadCommunicationMessageSchema = /* @__PURE__ */ z.object({
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
export const listThreadMessagesInputSchema = /* @__PURE__ */ z.object({
  workspaceId: z.string().trim().min(1).optional(), sessionId: z.string().trim().min(1).optional(),
  peerSessionId: z.string().trim().min(1).optional(), cursor: z.string().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict().refine((input) => input.peerSessionId === undefined || input.sessionId !== undefined);
export const listThreadMessagesResultSchema = /* @__PURE__ */ z.object({
  items: z.array(threadCommunicationMessageSchema), nextCursor: z.string().optional(),
  incomplete: z.enum(['scan_budget', 'history_preparing']).optional(),
  history: z.object({
    generation: z.string(), state: z.enum(['complete', 'preparing', 'error']),
    processedMessages: z.number().int().nonnegative(), completedShards: z.number().int().nonnegative(),
    totalShards: z.number().int().positive(), pending: z.enum(['room', 'all']).optional(), error: z.string().optional(),
  }).optional(),
});

export const threadsContract = {
  listMessages: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([listThreadMessagesInputSchema.optional()]), output: listThreadMessagesResultSchema }), 'input', 'output'),
  hostId: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.string().min(1) }), 'input', 'output'),
  listThreads: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([listThreadsInputSchema.optional()]),
    output: listThreadsResultSchema,
  }), 'input', 'output'),
  readThread: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([readThreadInputSchema]), output: readThreadResultSchema }), 'input', 'output'),
  sendMessage: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([sendThreadMessageInputSchema]),
    output: sendThreadMessageResultSchema,
  }), 'input', 'output'),
  waitThreads: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([waitThreadsInputSchema]), output: waitThreadsResultSchema }), 'input', 'output'),
  getWorkspaceOverride: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string().trim().min(1)]),
    output: /* @__PURE__ */ maybe(z.boolean()),
  }), 'input', 'output'),
  setWorkspaceOverride: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string().trim().min(1), z.boolean()]),
    output: noResult,
  }), 'input', 'output'),
  clearWorkspaceOverride: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string().trim().min(1)]), output: noResult }), 'input', 'output'),
  isWorkspaceEnabled: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string().trim().min(1)]), output: /* @__PURE__ */ z.boolean() }), 'input', 'output'),
} satisfies ServiceContract;
