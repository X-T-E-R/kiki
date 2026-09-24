import {
  sessionCursorSchema,
  sessionSnapshotResponseSchema,
  type SessionCursor,
} from '@kiki/protocol';
import {
  isPlainAgentId,
  transcriptCursorSchema,
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
    afterTurn: z.string().min(1).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
  })
  .refine((value) => value.beforeTurn === undefined || value.afterTurn === undefined, {
    message: 'beforeTurn and afterTurn are mutually exclusive',
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
  reason: z.enum(['buffer_overflow', 'session_recreated', 'epoch_changed', 'history_rewritten']),
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
      readonly reason: 'buffer_overflow' | 'session_recreated' | 'epoch_changed' | 'history_rewritten';
      readonly currentSessionCursor: SessionCursor;
    });

export type SessionViewTranscriptPageInput = z.infer<typeof sessionViewTranscriptPageInputSchema>;
export type SessionViewTranscriptCatchUpInput = z.infer<typeof sessionViewTranscriptCatchUpInputSchema>;
