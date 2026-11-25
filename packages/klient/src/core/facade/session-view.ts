import { sessionSubagentsResponseSchema } from '@kiki/protocol';
import type { z } from 'zod';
import {
  transcriptDetailListQuerySchema,
  transcriptDetailListResponseSchema,
  transcriptPlanResponseSchema,
  transcriptUserMessagesResponseSchema,
} from '@kiki/transcript';
import {
  sessionViewSignalSchema,
  sessionViewSnapshotOutputSchema,
  sessionViewSubscribeInputSchema,
  sessionViewTranscriptCatchUpInputSchema,
  sessionViewTranscriptCatchUpOutputSchema,
  sessionViewTranscriptContentInputSchema,
  sessionViewTranscriptContentOutputSchema,
  sessionViewTranscriptDetailInputSchema,
  sessionViewTranscriptDetailOutputSchema,
  sessionViewTranscriptPageInputSchema,
  sessionViewTranscriptPageOutputSchema,
  type SessionViewSignal,
  type SessionViewSubscribeInput,
  type SessionViewTranscriptCatchUpInput,
  type SessionViewTranscriptDetail,
  type SessionViewTranscriptDetailInput,
  type SessionViewTranscriptEntitiesInput,
  type SessionViewTranscriptPageInput,
} from '../../contract/session/view.js';
import type { SessionViewChannel } from '../channel.js';
import { KlientValidationError } from '../validation.js';
import {
  createSessionViewFacadeCore,
  type SessionViewFacade,
  type SessionViewPlansInput,
  type SessionViewSubagentsInput,
  type SessionViewSubscription,
  type SessionViewTranscriptFacade,
  type SessionViewUserMessagesInput,
  type SessionViewValidator,
} from './session-view-core.js';

export type {
  SessionViewFacade,
  SessionViewPlansInput,
  SessionViewSignal,
  SessionViewSubagentsInput,
  SessionViewSubscribeInput,
  SessionViewSubscription,
  SessionViewTranscriptCatchUpInput,
  SessionViewTranscriptDetail,
  SessionViewTranscriptDetailInput,
  SessionViewTranscriptEntitiesInput,
  SessionViewTranscriptFacade,
  SessionViewTranscriptPageInput,
  SessionViewUserMessagesInput,
};

function parseWith<T>(phase: 'input' | 'output' | 'event', name: string, schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new KlientValidationError(phase, name, result.error.issues, value);
  }
  return result.data;
}

const sessionViewValidator: SessionViewValidator = {
  snapshotOutput: (value) => parseWith('output', 'session.view.snapshot', sessionViewSnapshotOutputSchema, value),
  pageInput: (value) => parseWith('input', 'session.view.transcript.page', sessionViewTranscriptPageInputSchema, value),
  pageOutput: (value) => parseWith('output', 'session.view.transcript.page', sessionViewTranscriptPageOutputSchema, value),
  catchUpInput: (value) => parseWith('input', 'session.view.transcript.catchUp', sessionViewTranscriptCatchUpInputSchema, value),
  catchUpOutput: (value) => parseWith('output', 'session.view.transcript.catchUp', sessionViewTranscriptCatchUpOutputSchema, value),
  entitiesInput: (value) => parseWith('input', 'session.view.transcript.entities', transcriptDetailListQuerySchema, value),
  entitiesOutput: (value) => parseWith('output', 'session.view.transcript.entities', transcriptDetailListResponseSchema, value),
  contentInput: (value) => parseWith('input', 'session.view.transcript.content', sessionViewTranscriptContentInputSchema, value),
  contentOutput: (value) => parseWith('output', 'session.view.transcript.content', sessionViewTranscriptContentOutputSchema, value),
  detailInput: (value) => parseWith('input', 'session.view.transcript.detail', sessionViewTranscriptDetailInputSchema, value),
  detailOutput: (value) => parseWith('output', 'session.view.transcript.detail', sessionViewTranscriptDetailOutputSchema, value),
  userMessagesOutput: (value) => parseWith('output', 'session.view.userMessages', transcriptUserMessagesResponseSchema, value),
  plansOutput: (value) => parseWith('output', 'session.view.plans', transcriptPlanResponseSchema, value),
  subagentsOutput: (value) => parseWith('output', 'session.view.subagents', sessionSubagentsResponseSchema, value),
  subscribeInput: (value) => parseWith('input', 'session.view.subscribe', sessionViewSubscribeInputSchema, value),
  safeParseSignal: (value) => sessionViewSignalSchema.safeParse(value),
};

export function createSessionViewFacade(
  channel: SessionViewChannel | undefined,
  sessionId: string,
  validate: boolean,
): SessionViewFacade {
  return createSessionViewFacadeCore(channel, sessionId, validate ? sessionViewValidator : undefined);
}
