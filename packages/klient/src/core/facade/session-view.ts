import type { SessionSnapshotResponse } from '@kiki/protocol';
import type { z } from 'zod';
import type {
  TranscriptCursor,
  TranscriptGradeSpec,
  TranscriptOpsCatchupResponse,
  TranscriptResponse,
} from '@kiki/transcript';

import {
  sessionViewSignalSchema,
  sessionViewSnapshotOutputSchema,
  sessionViewSubscribeInputSchema,
  sessionViewTranscriptCatchUpInputSchema,
  sessionViewTranscriptCatchUpOutputSchema,
  sessionViewTranscriptPageInputSchema,
  sessionViewTranscriptPageOutputSchema,
  type SessionViewSignal,
  type SessionViewSubscribeInput,
  type SessionViewTranscriptCatchUpInput,
  type SessionViewTranscriptPageInput,
} from '../../contract/session/view.js';
import type { SessionViewChannel } from '../channel.js';
import { KlientValidationError } from '../validation.js';

export interface SessionViewSubscription {
  updateSessionCursor(cursor: SessionViewSubscribeInput['sessionCursor']): void;
  setTranscriptGrades(grades: TranscriptGradeSpec): void;
  updateTranscriptCursor(agentId: string, cursor: TranscriptCursor): void;
  restart(): void;
  nudge(): void;
  close(): void;
}

export interface SessionViewTranscriptFacade {
  page(input: SessionViewTranscriptPageInput): Promise<TranscriptResponse>;
  catchUp(input: SessionViewTranscriptCatchUpInput): Promise<TranscriptOpsCatchupResponse>;
}

export interface SessionViewFacade {
  snapshot(): Promise<SessionSnapshotResponse>;
  readonly transcript: SessionViewTranscriptFacade;
  subscribe(
    input: SessionViewSubscribeInput,
    onSignal: (signal: SessionViewSignal) => void,
  ): SessionViewSubscription;
}

export function createSessionViewFacade(
  channel: SessionViewChannel | undefined,
  sessionId: string,
  validate: boolean,
): SessionViewFacade {
  let invalidSignals = 0;
  let latestGeneration = 0;
  const requireChannel = (): SessionViewChannel => {
    if (channel === undefined) throw new Error('session view is unavailable on this transport');
    return channel;
  };
  const parse = <T>(
    phase: 'input' | 'output' | 'event',
    name: string,
    schema: z.ZodType<T>,
    value: unknown,
  ): T => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new KlientValidationError(phase, name, result.error.issues, value);
    }
    return result.data;
  };
  return {
    async snapshot() {
      const output = await requireChannel().snapshot(sessionId);
      return validate
        ? parse('output', 'session.view.snapshot', sessionViewSnapshotOutputSchema, output)
        : (output as SessionSnapshotResponse);
    },
    transcript: {
      async page(input) {
        const wireInput = validate
          ? parse('input', 'session.view.transcript.page', sessionViewTranscriptPageInputSchema, input)
          : input;
        const output = await requireChannel().transcriptPage(sessionId, wireInput);
        return validate
          ? parse('output', 'session.view.transcript.page', sessionViewTranscriptPageOutputSchema, output)
          : (output as TranscriptResponse);
      },
      async catchUp(input) {
        const wireInput = validate
          ? parse('input', 'session.view.transcript.catchUp', sessionViewTranscriptCatchUpInputSchema, input)
          : input;
        const output = await requireChannel().transcriptCatchUp(sessionId, wireInput);
        return validate
          ? parse('output', 'session.view.transcript.catchUp', sessionViewTranscriptCatchUpOutputSchema, output)
          : (output as TranscriptOpsCatchupResponse);
      },
    },
    subscribe(input, onSignal) {
      const wireInput = validate
        ? parse('input', 'session.view.subscribe', sessionViewSubscribeInputSchema, input)
        : input;
      return requireChannel().subscribe(sessionId, wireInput, (signal) => {
        if (!validate) { onSignal(signal); return; }
        const parsed = sessionViewSignalSchema.safeParse(signal);
        if (!parsed.success) {
          invalidSignals += 1;
          onSignal({
            type: 'protocolError', generation: latestGeneration,
            recoverable: invalidSignals === 1,
            detail: 'Invalid session view signal; the transcript must be refreshed.',
          });
          return;
        }
        latestGeneration = Math.max(latestGeneration, parsed.data.generation);
        if (parsed.data.type === 'transcript' && parsed.data.event.type === 'transcript.reset') invalidSignals = 0;
        onSignal(parsed.data);
      });
    },
  };
}

export type {
  SessionViewSignal,
  SessionViewSubscribeInput,
  SessionViewTranscriptCatchUpInput,
  SessionViewTranscriptPageInput,
};
