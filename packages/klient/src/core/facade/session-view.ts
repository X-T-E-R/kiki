import type { SessionSnapshotResponse } from '@kiki/protocol';
import type { z } from 'zod';
import { transcriptDetailListQuerySchema, transcriptDetailListResponseSchema, type TranscriptDetailListResponse } from '@kiki/transcript';
import type { SessionViewTranscriptEntitiesInput } from '../../contract/session/view.js';
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
  sessionViewTranscriptContentInputSchema,
  sessionViewTranscriptContentOutputSchema,
  type SessionViewTranscriptContentInput,
  sessionViewTranscriptDetailInputSchema,
  sessionViewTranscriptDetailOutputSchema,
  sessionViewTranscriptPageInputSchema,
  sessionViewTranscriptPageOutputSchema,
  type SessionViewSignal,
  type SessionViewSubscribeInput,
  type SessionViewTranscriptCatchUpInput,
  type SessionViewTranscriptDetail,
  type SessionViewTranscriptDetailInput,
  type SessionViewTranscriptPageInput,
} from '../../contract/session/view.js';
import type { CallOptions, SessionViewChannel } from '../channel.js';
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
  page(input: SessionViewTranscriptPageInput, options?: CallOptions): Promise<TranscriptResponse>;
  catchUp(input: SessionViewTranscriptCatchUpInput): Promise<TranscriptOpsCatchupResponse>;
  /**
   * Read the canonical body of one task, attachment, or prompt that a
   * windowed reset summarized (`detailRef`). Absent on transports that do
   * not serve the detail route.
   */
  detail?(input: SessionViewTranscriptDetailInput, options?: CallOptions): Promise<SessionViewTranscriptDetail>;
  content?(input: SessionViewTranscriptContentInput, options?: CallOptions): Promise<import('@kiki/transcript').ContentSegment>;
  entities?(input: SessionViewTranscriptEntitiesInput, options?: CallOptions): Promise<TranscriptDetailListResponse>;
}

export interface SessionViewFacade {
  snapshot(options?: CallOptions): Promise<SessionSnapshotResponse>;
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
    async snapshot(options) {
      const output = await requireChannel().snapshot(sessionId, options);
      return validate
        ? parse('output', 'session.view.snapshot', sessionViewSnapshotOutputSchema, output)
        : (output as SessionSnapshotResponse);
    },
    transcript: {
      async page(input, options) {
        const wireInput = validate
          ? parse('input', 'session.view.transcript.page', sessionViewTranscriptPageInputSchema, input)
          : input;
        const output = await requireChannel().transcriptPage(sessionId, wireInput, options);
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
      ...(channel?.transcriptEntities === undefined ? {} : {
        async entities(input: SessionViewTranscriptEntitiesInput, options?: CallOptions) {
          const query = parse('input', 'session.view.transcript.entities', transcriptDetailListQuerySchema, { agent_id: input.agentId, kind: input.kind, cursor: input.cursor, limit: input.limit });
          const output = await requireChannel().transcriptEntities!(sessionId, { agentId: query.agent_id, kind: query.kind, cursor: query.cursor, limit: query.limit }, options);
          return parse('output', 'session.view.transcript.entities', transcriptDetailListResponseSchema, output);
        },
      }),
      ...(channel?.transcriptContent === undefined ? {} : {
        async content(input: SessionViewTranscriptContentInput, options?: CallOptions) {
          const wireInput = parse('input', 'session.view.transcript.content', sessionViewTranscriptContentInputSchema, input);
          const output = await requireChannel().transcriptContent!(sessionId, wireInput, options);
          return parse('output', 'session.view.transcript.content', sessionViewTranscriptContentOutputSchema, output);
        },
      }),
      ...(channel?.transcriptDetail === undefined ? {} : {
        async detail(input: SessionViewTranscriptDetailInput, options?: CallOptions) {
          const wireInput = validate
            ? parse('input', 'session.view.transcript.detail', sessionViewTranscriptDetailInputSchema, input)
            : input;
          const output = await requireChannel().transcriptDetail!(sessionId, wireInput, options);
          return validate
            ? parse('output', 'session.view.transcript.detail', sessionViewTranscriptDetailOutputSchema, output)
            : (output as SessionViewTranscriptDetail);
        },
      }),
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
  SessionViewTranscriptDetail,
  SessionViewTranscriptDetailInput,
  SessionViewTranscriptEntitiesInput,
  SessionViewTranscriptPageInput,
};
