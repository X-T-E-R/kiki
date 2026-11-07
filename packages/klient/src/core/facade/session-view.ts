import type { SessionSnapshotResponse } from '@kiki/protocol';
import type { z } from 'zod';
import {
  applyContentSegment,
  compareTurnIds,
  transcriptDetailListQuerySchema,
  transcriptDetailListResponseSchema,
  transcriptPlanResponseSchema,
  transcriptUserMessagesResponseSchema,
  type ContentRef,
  type ContentSegment,
  type TranscriptDetailListResponse,
  type TranscriptPlanResponse,
  type TranscriptUserMessagesResponse,
} from '@kiki/transcript';
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
  catchUp(input: SessionViewTranscriptCatchUpInput, options?: CallOptions): Promise<TranscriptOpsCatchupResponse>;
  /**
   * Read the canonical body of one task, attachment, or prompt that a
   * windowed reset summarized (`detailRef`). Absent on transports that do
   * not serve the detail route.
   */
  detail?(input: SessionViewTranscriptDetailInput, options?: CallOptions): Promise<SessionViewTranscriptDetail>;
  content?(input: SessionViewTranscriptContentInput, options?: CallOptions): Promise<import('@kiki/transcript').ContentSegment>;
  entities?(input: SessionViewTranscriptEntitiesInput, options?: CallOptions): Promise<TranscriptDetailListResponse>;
}

export interface SessionViewUserMessagesInput {
  readonly agentId?: string;
  readonly cursor?: string;
}

export interface SessionViewPlansInput {
  readonly agentId: string;
  readonly toolCallId?: string;
  readonly cursor?: string;
}

export interface SessionViewFacade {
  snapshot(options?: CallOptions): Promise<SessionSnapshotResponse>;
  readonly transcript: SessionViewTranscriptFacade;
  userMessages?(input?: SessionViewUserMessagesInput, options?: CallOptions): Promise<TranscriptUserMessagesResponse>;
  plans?(input: SessionViewPlansInput, options?: CallOptions): Promise<TranscriptPlanResponse>;
  bootstrap?(
    input: Omit<SessionViewSubscribeInput, 'sessionCursor' | 'bootstrap'>,
    onSignal: (signal: SessionViewSignal) => void,
  ): SessionViewSubscription;
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
  const facade: SessionViewFacade = {
    bootstrap(input, onSignal) {
      return facade.subscribe({ ...input, sessionCursor: { seq: 0 }, bootstrap: true }, onSignal);
    },
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
      async catchUp(input, options) {
        const wireInput = validate
          ? parse('input', 'session.view.transcript.catchUp', sessionViewTranscriptCatchUpInputSchema, input)
          : input;
        const output = await requireChannel().transcriptCatchUp(sessionId, wireInput, options);
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
    ...(channel?.userMessages === undefined ? {} : {
      async userMessages(input?: SessionViewUserMessagesInput, options?: CallOptions) {
        const read = async (cursor?: string, agentId?: string) => {
          const output = await channel.userMessages!(sessionId, { agentId: agentId ?? input?.agentId, cursor }, options);
          return validate
            ? parse('output', 'session.view.userMessages', transcriptUserMessagesResponseSchema, output)
            : output as TranscriptUserMessagesResponse;
        };
        const first = await read(input?.cursor, input?.agentId);
        const agents = [];
        for (const agent of first.agents) {
          let messages = agent.messages;
          let attachments = agent.attachments;
          let cursor = agent.next_cursor;
          const seen = new Set<string>();
          while (cursor !== undefined && !seen.has(cursor) && seen.size < 1000) {
            seen.add(cursor);
            const page = await read(cursor, agent.agent_id);
            const older = page.agents.find((entry) => entry.agent_id === agent.agent_id) ?? page.agents[0];
            if (older === undefined) break;
            messages = mergeBy(older.messages, messages, (message) => message.turn_id);
            attachments = mergeBy(older.attachments, attachments, (attachment) => attachment.attachmentId);
            cursor = older.next_cursor;
          }
          const hydrated = [];
          for (const message of messages.sort((left, right) => left.ordinal - right.ordinal || compareTurnIds(left.turn_id, right.turn_id))) {
            hydrated.push(await hydrateWindow(message, (ref) => readContent(channel, sessionId, agent.agent_id, ref, options, validate, parse)));
          }
          agents.push({ agent_id: agent.agent_id, messages: hydrated, attachments });
        }
        const assembled = { agents };
        return validate
          ? parse('output', 'session.view.userMessages', transcriptUserMessagesResponseSchema, assembled)
          : assembled;
      },
    }),
    ...(channel?.plans === undefined ? {} : {
      async plans(input: SessionViewPlansInput, options?: CallOptions) {
        const read = async (cursor?: string) => {
          const output = await channel.plans!(sessionId, { agentId: input.agentId, toolCallId: input.toolCallId, cursor }, options);
          return validate
            ? parse('output', 'session.view.plans', transcriptPlanResponseSchema, output)
            : output as TranscriptPlanResponse;
        };
        if (input.toolCallId !== undefined) {
          const page = await read();
          const plans = [];
          for (const plan of page.plans) plans.push(await hydrateWindow(plan, (ref) => readContent(channel, sessionId, input.agentId, ref, options, validate, parse)));
          const assembled = { agent_id: page.agent_id, plans };
          return validate ? parse('output', 'session.view.plans', transcriptPlanResponseSchema, assembled) : assembled;
        }
        let plans: TranscriptPlanResponse['plans'] = [];
        let cursor = input.cursor;
        let agentId = input.agentId;
        const seen = new Set<string>();
        do {
          if (cursor !== undefined) {
            if (seen.has(cursor) || seen.size >= 1000) break;
            seen.add(cursor);
          }
          const page = await read(cursor);
          agentId = page.agent_id;
          plans = mergeBy(page.plans, plans, (plan) => plan.tool_call_id);
          cursor = page.next_cursor;
        } while (cursor !== undefined);
        const hydrated = [];
        for (const plan of plans.sort((left, right) => compareTurnIds(left.turn_id, right.turn_id))) {
          hydrated.push(await hydrateWindow(plan, (ref) => readContent(channel, sessionId, agentId, ref, options, validate, parse)));
        }
        const assembled = { agent_id: agentId, plans: hydrated };
        return validate ? parse('output', 'session.view.plans', transcriptPlanResponseSchema, assembled) : assembled;
      },
    }),
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
  return facade;
}

function mergeBy<T>(older: readonly T[], newer: readonly T[], id: (value: T) => string): T[] {
  const merged = new Map<string, T>();
  for (const value of [...older, ...newer]) {
    if (!merged.has(id(value))) merged.set(id(value), value);
  }
  return [...merged.values()];
}

async function hydrateWindow<T extends { readonly contentRefs?: readonly ContentRef[] }>(
  entity: T,
  read: (ref: ContentRef) => Promise<ContentSegment>,
): Promise<T> {
  let current = entity;
  const seen = new Set<string>();
  while (current.contentRefs !== undefined && current.contentRefs.length > 0) {
    const ref = current.contentRefs[0]!;
    const key = JSON.stringify(ref);
    if (seen.has(key) || seen.size > 10000) break;
    seen.add(key);
    current = applyContentSegment(current, await read(ref));
  }
  const { contentRefs: _contentRefs, ...rest } = current;
  return (current.contentRefs === undefined || current.contentRefs.length === 0 ? rest : current) as T;
}

async function readContent(
  channel: SessionViewChannel,
  sessionId: string,
  agentId: string,
  ref: ContentRef,
  options: CallOptions | undefined,
  validate: boolean,
  parse: <T>(phase: 'input' | 'output' | 'event', name: string, schema: z.ZodType<T>, value: unknown) => T,
): Promise<ContentSegment> {
  if (channel.transcriptContent === undefined) throw new Error('session view content continuation is unavailable');
  const output = await channel.transcriptContent(sessionId, { agentId, ref }, options);
  return validate
    ? parse('output', 'session.view.transcript.content', sessionViewTranscriptContentOutputSchema, output)
    : output as ContentSegment;
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
