import {
  sessionCursorSchema,
  sessionSnapshotResponseSchema,
  resyncRequiredReasonSchema,
  type ResyncRequiredReason,
  type SessionCursor,
} from '@kiki/protocol';
import {
  isPlainAgentId,
  contentRefSchema,
  contentSegmentSchema,
  transcriptCursorSchema,
  transcriptDetailResponseSchema,
  transcriptEventSchema,
  transcriptGradeSpecSchema,
  transcriptOpsCatchupResponseSchema,
  transcriptResponseSchema,
  type TranscriptCursor,
  type TranscriptEvent,
  type TranscriptGradeSpec,
} from '@kiki/transcript';
import { z } from 'zod';

export const sessionViewSnapshotInputSchema = z.object({});

export const sessionViewTranscriptPageInputSchema = z
  .object({
    agentId: z.string().min(1),
    beforeTurn: z.string().min(1).optional(),
    beforeItem: z.string().min(1).max(512).optional(),
    afterTurn: z.string().min(1).optional(),
    afterItem: z.string().min(1).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
  })
  .refine((value) => [value.beforeTurn, value.beforeItem, value.afterTurn, value.afterItem].filter((entry) => entry !== undefined).length <= 1, {
    message: 'beforeTurn, beforeItem, afterTurn and afterItem are mutually exclusive',
  })
  .refine((value) => isPlainAgentId(value.agentId), {
    message: 'agentId must be a plain agent id',
    path: ['agentId'],
  });

export const sessionViewTranscriptCatchUpInputSchema = z
  .object({
    agentId: z.string().min(1),
    since: transcriptCursorSchema,
    grade: z.enum(['turn', 'block', 'delta']).optional(),
  })
  .refine((value) => isPlainAgentId(value.agentId), {
    message: 'agentId must be a plain agent id',
    path: ['agentId'],
  });

export const sessionViewTranscriptDetailInputSchema = z
  .object({
    agentId: z.string().min(1),
    kind: z.enum(['task', 'attachment', 'prompt', 'tool']),
    id: z.string().min(1),
  })
  .refine((value) => isPlainAgentId(value.agentId), {
    message: 'agentId must be a plain agent id',
    path: ['agentId'],
  });

export interface SessionViewTranscriptEntitiesInput {
  readonly agentId: string;
  readonly kind: import('@kiki/transcript').TranscriptDetailListResponse['kind'];
  readonly cursor?: string;
  readonly limit?: number;
}

export const sessionViewTranscriptContentInputSchema = z.object({
  agentId: z.string().min(1),
  ref: contentRefSchema,
}).refine((value) => isPlainAgentId(value.agentId), { message: 'agentId must be a plain agent id', path: ['agentId'] });
export const sessionViewTranscriptContentOutputSchema = contentSegmentSchema;
export type SessionViewTranscriptContentInput = z.infer<typeof sessionViewTranscriptContentInputSchema>;

export const sessionViewSubscribeInputSchema = z.object({
  sessionCursor: sessionCursorSchema,
  transcriptGrades: transcriptGradeSpecSchema,
  transcriptSince: z.record(z.string(), transcriptCursorSchema).optional(),
});

const sessionViewGenerationSchema = z.number().int().nonnegative();

export const sessionViewStatusSignalSchema = z.object({
  type: z.literal('status'),
  status: z.enum(['connecting', 'open', 'closed']),
  generation: sessionViewGenerationSchema,
  detail: z.string().optional(),
});

export const sessionViewReadySignalSchema = z.object({
  type: z.literal('ready'),
  currentSessionCursor: sessionCursorSchema,
  reconnected: z.boolean(),
  generation: sessionViewGenerationSchema,
});

export const sessionViewCursorAdvancedSignalSchema = z.object({
  type: z.literal('sessionCursorAdvanced'),
  cursor: sessionCursorSchema,
  generation: sessionViewGenerationSchema,
  rosterAgentId: z.string().min(1).optional(),
  title: z.string().optional(),
});

export const sessionViewHistoryRewrittenSignalSchema = z.object({
  type: z.literal('historyRewritten'),
  reason: z.enum(['edit_resend', 'regenerate']),
  targetMessageId: z.string().min(1),
  cursor: sessionCursorSchema,
  generation: sessionViewGenerationSchema,
});

export const sessionViewTranscriptSignalSchema = z.object({
  type: z.literal('transcript'),
  event: transcriptEventSchema,
  generation: sessionViewGenerationSchema,
});

export const sessionViewResyncRequiredSignalSchema = z.object({
  type: z.literal('resyncRequired'),
  reason: resyncRequiredReasonSchema,
  currentSessionCursor: sessionCursorSchema,
  generation: sessionViewGenerationSchema,
});

export const sessionViewProtocolErrorSchema = z.object({
  type: z.literal('protocolError'),
  detail: z.string(),
  recoverable: z.boolean(),
  generation: sessionViewGenerationSchema,
});

export const sessionViewSignalSchema = z.discriminatedUnion('type', [
  sessionViewProtocolErrorSchema,
  sessionViewStatusSignalSchema,
  sessionViewReadySignalSchema,
  sessionViewCursorAdvancedSignalSchema,
  sessionViewHistoryRewrittenSignalSchema,
  sessionViewTranscriptSignalSchema,
  sessionViewResyncRequiredSignalSchema,
]);

export const sessionViewSnapshotOutputSchema = sessionSnapshotResponseSchema;
export const sessionViewTranscriptPageOutputSchema = transcriptResponseSchema;
export const sessionViewTranscriptCatchUpOutputSchema = transcriptOpsCatchupResponseSchema;
export const sessionViewTranscriptDetailOutputSchema = transcriptDetailResponseSchema;

export interface SessionViewSubscribeInput {
  readonly sessionCursor: SessionCursor;
  readonly transcriptGrades: TranscriptGradeSpec;
  readonly transcriptSince?: Readonly<Record<string, TranscriptCursor>>;
}

interface SessionViewSignalBase {
  readonly generation: number;
}

export type SessionViewSignal =
  | (SessionViewSignalBase & {
      readonly type: 'protocolError';
      readonly detail: string;
      readonly recoverable: boolean;
    })
  | (SessionViewSignalBase & {
      readonly type: 'status';
      readonly status: 'connecting' | 'open' | 'closed';
      readonly detail?: string;
    })
  | (SessionViewSignalBase & {
      readonly type: 'ready';
      readonly currentSessionCursor: SessionCursor;
      readonly reconnected: boolean;
    })
  | (SessionViewSignalBase & {
      readonly type: 'sessionCursorAdvanced';
      readonly cursor: SessionCursor;
      readonly rosterAgentId?: string;
      readonly title?: string;
    })
  | (SessionViewSignalBase & {
      readonly type: 'historyRewritten';
      readonly reason: 'edit_resend' | 'regenerate';
      readonly targetMessageId: string;
      readonly cursor: SessionCursor;
    })
  | (SessionViewSignalBase & {
      readonly type: 'transcript';
      readonly event: TranscriptEvent;
    })
  | (SessionViewSignalBase & {
      readonly type: 'resyncRequired';
      readonly reason: ResyncRequiredReason;
      readonly currentSessionCursor: SessionCursor;
    });

export type SessionViewTranscriptPageInput = z.infer<typeof sessionViewTranscriptPageInputSchema>;
export type SessionViewTranscriptCatchUpInput = z.infer<typeof sessionViewTranscriptCatchUpInputSchema>;
export type SessionViewTranscriptDetailInput = z.infer<typeof sessionViewTranscriptDetailInputSchema>;
/** One canonical global entity read by reference (task, attachment, or prompt). */
export type SessionViewTranscriptDetail = z.infer<typeof sessionViewTranscriptDetailOutputSchema>;
