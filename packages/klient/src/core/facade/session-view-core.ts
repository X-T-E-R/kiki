import type { SessionSnapshotResponse, SessionSubagentsResponse } from '@kiki/protocol';
import {
  applyContentSegment,
  compareTurnIds,
  type ContentRef,
  type ContentSegment,
  type TranscriptCursor,
  type TranscriptDetailListResponse,
  type TranscriptGradeSpec,
  type TranscriptOpsCatchupResponse,
  type TranscriptPlanResponse,
  type TranscriptResponse,
  type TranscriptUserMessagesResponse,
} from '@kiki/transcript';
import type {
  SessionViewSignal,
  SessionViewSubscribeInput,
  SessionViewTranscriptCatchUpInput,
  SessionViewTranscriptContentInput,
  SessionViewTranscriptDetail,
  SessionViewTranscriptDetailInput,
  SessionViewTranscriptEntitiesInput,
  SessionViewTranscriptPageInput,
} from '../../contract/session/view.js';
import type { CallOptions, SessionViewChannel } from '../channel.js';

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
  detail?(input: SessionViewTranscriptDetailInput, options?: CallOptions): Promise<SessionViewTranscriptDetail>;
  content?(input: SessionViewTranscriptContentInput, options?: CallOptions): Promise<ContentSegment>;
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

export interface SessionViewSubagentsInput {
  readonly q?: string;
  readonly status?: string;
  readonly agentId?: string;
  readonly limit?: number;
}

export interface SessionViewFacade {
  snapshot(options?: CallOptions): Promise<SessionSnapshotResponse>;
  readonly transcript: SessionViewTranscriptFacade;
  userMessages?(input?: SessionViewUserMessagesInput, options?: CallOptions): Promise<TranscriptUserMessagesResponse>;
  plans?(input: SessionViewPlansInput, options?: CallOptions): Promise<TranscriptPlanResponse>;
  subagents?(input?: SessionViewSubagentsInput, options?: CallOptions): Promise<SessionSubagentsResponse>;
  bootstrap?(
    input: Omit<SessionViewSubscribeInput, 'sessionCursor' | 'bootstrap'>,
    onSignal: (signal: SessionViewSignal) => void,
  ): SessionViewSubscription;
  subscribe(
    input: SessionViewSubscribeInput,
    onSignal: (signal: SessionViewSignal) => void,
  ): SessionViewSubscription;
}

export interface SessionViewValidator {
  snapshotOutput(value: unknown): SessionSnapshotResponse;
  pageInput(value: unknown): SessionViewTranscriptPageInput;
  pageOutput(value: unknown): TranscriptResponse;
  catchUpInput(value: unknown): SessionViewTranscriptCatchUpInput;
  catchUpOutput(value: unknown): TranscriptOpsCatchupResponse;
  entitiesInput(value: unknown): { agent_id: string; kind: SessionViewTranscriptEntitiesInput['kind']; cursor?: string; limit: number };
  entitiesOutput(value: unknown): TranscriptDetailListResponse;
  contentInput(value: unknown): SessionViewTranscriptContentInput;
  contentOutput(value: unknown): ContentSegment;
  detailInput(value: unknown): SessionViewTranscriptDetailInput;
  detailOutput(value: unknown): SessionViewTranscriptDetail;
  userMessagesOutput(value: unknown): TranscriptUserMessagesResponse;
  plansOutput(value: unknown): TranscriptPlanResponse;
  subagentsOutput(value: unknown): SessionSubagentsResponse;
  subscribeInput(value: unknown): SessionViewSubscribeInput;
  safeParseSignal(value: unknown): { readonly success: true; readonly data: SessionViewSignal } | { readonly success: false };
}

export function createSessionViewFacadeCore(
  channel: SessionViewChannel | undefined,
  sessionId: string,
  validator?: SessionViewValidator,
): SessionViewFacade {
  let invalidSignals = 0;
  let latestGeneration = 0;
  const requireChannel = (): SessionViewChannel => {
    if (channel === undefined) throw new Error('session view is unavailable on this transport');
    return channel;
  };
  const facade: SessionViewFacade = {
    bootstrap(input, onSignal) {
      return facade.subscribe({ ...input, sessionCursor: { seq: 0 }, bootstrap: true }, onSignal);
    },
    async snapshot(options) {
      const output = await requireChannel().snapshot(sessionId, options);
      return validator !== undefined ? validator.snapshotOutput(output) : (output as SessionSnapshotResponse);
    },
    transcript: {
      async page(input, options) {
        const wireInput = validator !== undefined ? validator.pageInput(input) : input;
        const output = await requireChannel().transcriptPage(sessionId, wireInput, options);
        return validator !== undefined ? validator.pageOutput(output) : (output as TranscriptResponse);
      },
      async catchUp(input, options) {
        const wireInput = validator !== undefined ? validator.catchUpInput(input) : input;
        const output = await requireChannel().transcriptCatchUp(sessionId, wireInput, options);
        return validator !== undefined ? validator.catchUpOutput(output) : (output as TranscriptOpsCatchupResponse);
      },
      ...(channel?.transcriptEntities === undefined ? {} : {
        async entities(input: SessionViewTranscriptEntitiesInput, options?: CallOptions) {
          const query = validator !== undefined
            ? validator.entitiesInput({ agent_id: input.agentId, kind: input.kind, cursor: input.cursor, limit: input.limit })
            : { agent_id: input.agentId ?? 'main', kind: input.kind, cursor: input.cursor, limit: input.limit };
          const output = await requireChannel().transcriptEntities!(sessionId, { agentId: query.agent_id, kind: query.kind, cursor: query.cursor, limit: query.limit }, options);
          return validator !== undefined ? validator.entitiesOutput(output) : (output as TranscriptDetailListResponse);
        },
      }),
      ...(channel?.transcriptContent === undefined ? {} : {
        async content(input: SessionViewTranscriptContentInput, options?: CallOptions) {
          const wireInput = validator !== undefined ? validator.contentInput(input) : input;
          const output = await requireChannel().transcriptContent!(sessionId, wireInput, options);
          return validator !== undefined ? validator.contentOutput(output) : (output as ContentSegment);
        },
      }),
      ...(channel?.transcriptDetail === undefined ? {} : {
        async detail(input: SessionViewTranscriptDetailInput, options?: CallOptions) {
          const wireInput = validator !== undefined ? validator.detailInput(input) : input;
          const output = await requireChannel().transcriptDetail!(sessionId, wireInput, options);
          return validator !== undefined ? validator.detailOutput(output) : (output as SessionViewTranscriptDetail);
        },
      }),
    },
    ...(channel?.userMessages === undefined ? {} : {
      async userMessages(input?: SessionViewUserMessagesInput, options?: CallOptions) {
        const read = async (cursor?: string, agentId?: string) => {
          const output = await channel.userMessages!(sessionId, { agentId, cursor }, options);
          return validator !== undefined ? validator.userMessagesOutput(output) : output as TranscriptUserMessagesResponse;
        };
        const seen = new Set<string>();
        const merged = new Map<string, { messages: TranscriptUserMessagesResponse['agents'][number]['messages']; attachments: TranscriptUserMessagesResponse['agents'][number]['attachments'] }>();
        const order: string[] = [];
        const absorb = (agent: TranscriptUserMessagesResponse['agents'][number], olderFirst: boolean) => {
          const prior = merged.get(agent.agent_id);
          if (prior === undefined) {
            order.push(agent.agent_id);
            merged.set(agent.agent_id, { messages: [...agent.messages], attachments: [...agent.attachments] });
            return;
          }
          prior.messages = olderFirst
            ? mergeBy(agent.messages, prior.messages, (message) => message.turn_id)
            : mergeBy(prior.messages, agent.messages, (message) => message.turn_id);
          prior.attachments = olderFirst
            ? mergeBy(agent.attachments, prior.attachments, (attachment) => attachment.attachmentId)
            : mergeBy(prior.attachments, agent.attachments, (attachment) => attachment.attachmentId);
        };
        const finishAgent = async (agentId: string) => {
          const agent = merged.get(agentId);
          if (agent === undefined) return undefined;
          const hydrated = [];
          for (const message of agent.messages.sort((left, right) => left.ordinal - right.ordinal || compareTurnIds(left.turn_id, right.turn_id))) {
            hydrated.push(await hydrateWindow(message, (ref) => readContent(channel, sessionId, agentId, ref, options, validator)));
          }
          return { agent_id: agentId, messages: hydrated, attachments: agent.attachments };
        };
        if (input?.agentId !== undefined) {
          let cursor = input.cursor;
          let agentId = input.agentId;
          do {
            if (cursor !== undefined) {
              if (seen.has(cursor) || seen.size >= 1000) break;
              seen.add(cursor);
            }
            const page = await read(cursor, agentId);
            const agent = page.agents.find((entry) => entry.agent_id === agentId) ?? page.agents[0];
            if (agent === undefined) break;
            agentId = agent.agent_id;
            absorb(agent, cursor !== undefined);
            cursor = agent.next_cursor;
          } while (cursor !== undefined);
        } else {
          let cursor = input?.cursor;
          do {
            if (cursor !== undefined) {
              if (seen.has(cursor) || seen.size >= 1000) break;
              seen.add(cursor);
            }
            const page = await read(cursor, undefined);
            for (const agent of page.agents) absorb(agent, cursor !== undefined);
            if (page.next_cursor !== undefined) {
              cursor = page.next_cursor;
              continue;
            }
            cursor = undefined;
            for (const agent of page.agents) {
              let olderCursor = agent.next_cursor;
              const agentSeen = new Set<string>();
              while (olderCursor !== undefined && !agentSeen.has(olderCursor) && agentSeen.size < 1000) {
                agentSeen.add(olderCursor);
                const olderPage = await read(olderCursor, agent.agent_id);
                const older = olderPage.agents.find((entry) => entry.agent_id === agent.agent_id) ?? olderPage.agents[0];
                if (older === undefined) break;
                absorb(older, true);
                olderCursor = older.next_cursor;
              }
            }
          } while (cursor !== undefined);
        }
        const agents = [];
        for (const agentId of order) {
          const hydrated = await finishAgent(agentId);
          if (hydrated !== undefined) agents.push(hydrated);
        }
        const assembled = { agents };
        return validator !== undefined ? validator.userMessagesOutput(assembled) : assembled;
      },
    }),
    ...(channel?.plans === undefined ? {} : {
      async plans(input: SessionViewPlansInput, options?: CallOptions) {
        const read = async (cursor?: string) => {
          const output = await channel.plans!(sessionId, { agentId: input.agentId, toolCallId: input.toolCallId, cursor }, options);
          return validator !== undefined ? validator.plansOutput(output) : output as TranscriptPlanResponse;
        };
        if (input.toolCallId !== undefined) {
          const page = await read();
          const plans = [];
          for (const plan of page.plans) plans.push(await hydrateWindow(plan, (ref) => readContent(channel, sessionId, input.agentId, ref, options, validator)));
          const assembled = { agent_id: page.agent_id, plans };
          return validator !== undefined ? validator.plansOutput(assembled) : assembled;
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
          hydrated.push(await hydrateWindow(plan, (ref) => readContent(channel, sessionId, agentId, ref, options, validator)));
        }
        const assembled = { agent_id: agentId, plans: hydrated };
        return validator !== undefined ? validator.plansOutput(assembled) : assembled;
      },
    }),
    ...(channel?.subagents === undefined ? {} : {
      async subagents(input: SessionViewSubagentsInput = {}, options?: CallOptions) {
        const output = await channel.subagents!(sessionId, input, options);
        return validator !== undefined ? validator.subagentsOutput(output) : output as SessionSubagentsResponse;
      },
    }),
    subscribe(input, onSignal) {
      const wireInput = validator !== undefined ? validator.subscribeInput(input) : input;
      return requireChannel().subscribe(sessionId, wireInput, (signal) => {
        if (validator === undefined) { onSignal(signal); return; }
        const parsed = validator.safeParseSignal(signal);
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
  validator: SessionViewValidator | undefined,
): Promise<ContentSegment> {
  if (channel.transcriptContent === undefined) throw new Error('session view content continuation is unavailable');
  const output = await channel.transcriptContent(sessionId, { agentId, ref }, options);
  return validator !== undefined ? validator.contentOutput(output) : output as ContentSegment;
}
