import { MAIN_AGENT_ID } from '@kiki/agent-core-v2';
import {
  AgentTranscript,
  filterOpsForGrade,
  paginateTurns as paginateCanonicalTurns,
  redactSnapshotForGrade,
  type TranscriptGrade,
  type TranscriptResetEvent,
  type TranscriptAttachment,
  type TranscriptDetailListResponse,
  type TranscriptOpsCatchupResponse,
  type TranscriptPrompt,
  type TranscriptResponse,
  type TranscriptTask,
  transcriptReadForCoverage,
  type TranscriptRead,
  jsonBytes,
  type ContentRef,
  type ContentSegment,
  type TranscriptItem,
} from '@kiki/transcript';

import type { TranscriptService } from '../../services/transcript/transcriptService';
import { boundedEntity, readContentSegment } from './boundedContent';
import { boundedAttachment, boundedTranscriptOps, boundedTranscriptResponse, boundedTranscriptSnapshot, boundedTranscriptPageSource, itemKey, TRANSCRIPT_WINDOW_BYTES } from './boundedTranscript';

const DETAIL_PAGE_BYTES = 48 * 1024;
const DETAIL_ENTITY_BYTES = 2048;

export async function readSessionViewTranscriptContent(
  service: TranscriptService, sessionId: string,
  input: { readonly agentId: string; readonly ref: ContentRef; readonly range?: boolean; readonly signal?: AbortSignal },
): Promise<ContentSegment | undefined> {
  const entity = await readSessionViewCanonicalEntity(service, sessionId, input);
  return entity === undefined ? undefined : readContentSegment(entity, input.ref, input.range, input.agentId, DETAIL_PAGE_BYTES);
}

export async function readSessionViewCanonicalEntity(
  service: TranscriptService, sessionId: string,
  input: { readonly agentId: string; readonly ref: Pick<ContentRef, 'source'>; readonly signal?: AbortSignal },
): Promise<object | undefined> {
  input.signal?.throwIfAborted();
  if (input.ref.source.kind === 'turn' || input.ref.source.kind === 'frame') {
    return service.readCanonicalEntity(sessionId, input.agentId, input.ref.source, input.signal);
  }
  const store = service.forSessionLive(sessionId);
  const transcript = store === undefined ? undefined : await service.ensureAgentHistory(sessionId, input.agentId);
  const snapshot = transcript?.snapshot() ?? await service.readColdSnapshot(sessionId, input.agentId, undefined, input.signal);
  if (snapshot === undefined) return undefined;
  const source = input.ref.source;
  const select = (value: typeof snapshot): object | undefined => {
    switch (source.kind) {
      case 'turn': return value.items.find((item) => item.kind === 'turn' && item.turnId === source.id);
      case 'marker': return value.items.find((item) => item.kind === 'marker' && item.markerId === source.id);
      case 'frame': {
        const turn = value.items.find((item) => item.kind === 'turn' && item.turnId === source.turnId);
        return turn?.kind === 'turn' ? turn.steps.find((step) => step.stepId === source.stepId)?.frames.find((frame) => frame.frameId === source.id) : undefined;
      }
      case 'task': return value.tasks.find((task) => task.taskId === source.id);
      case 'attachment': return value.attachments.find((attachment) => attachment.attachmentId === source.id);
      case 'prompt': return value.prompts.find((prompt) => prompt.promptId === source.id);
      case 'interaction': return service.reconcileQuestionSnapshot(sessionId, value).interactions.find((interaction) => interaction.interactionId === source.id);
      case 'todo': return value.todos.find((todo) => todo.todoId === source.id);
      case 'meta': return value.meta;
      default: return undefined;
    }
  };
  let entity = source.kind === 'roster' ? (store?.agents() ?? await service.readColdRoster(sessionId))?.find((agent) => agent.agentId === source.id) : select(snapshot);
  if (entity === undefined && transcript !== undefined && source.kind !== 'roster') {
    const cold = await service.readColdSnapshot(sessionId, input.agentId, undefined, input.signal);
    if (cold !== undefined) entity = select(cold);
  }
  input.signal?.throwIfAborted();
  return entity;
}

export async function readSessionViewTranscriptPage(
  ...args: Parameters<typeof readSessionViewTranscriptPageRaw>
): Promise<TranscriptResponse | undefined> {
  try {
    const response = await readSessionViewTranscriptPageRaw(...args);
    if (response === undefined) return undefined;
    const bounded = boundedTranscriptResponse(response, args[2].afterTurn !== undefined || args[2].afterItem !== undefined ? 'head' : 'tail', 64 * 1024);
    return { ...bounded, next_cursor: bounded.next_cursor === undefined || response.read === undefined ? bounded.next_cursor
      : encodePageCursor(bounded.next_cursor, response.agent_id, response.read.source, response.cursor?.epoch) };
  } catch (error) {
    if (!(error instanceof TranscriptSourceChangedError)) throw error;
    return {
      session_id: args[1], agent_id: args[2].agentId, items: [], has_more: true,
      tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {}, agents: [], pending_interactions: [],
      coverage: { kind: 'unknown', hasMoreOlder: true }, read: staleRead(error.source),
    };
  }
}

export async function readSessionViewTranscriptDetail(
  ...args: Parameters<typeof readSessionViewTranscriptDetailRaw>
): ReturnType<typeof readSessionViewTranscriptDetailRaw> {
  const detail = await readSessionViewTranscriptDetailRaw(...args);
  if (detail === undefined) return undefined;
  if (detail.kind === 'tool') {
    const lookup = detail.lookup;
    return lookup.status !== 'found' ? detail : { ...detail, lookup: { ...lookup, frame: boundedEntity(lookup.frame, { kind: 'frame', id: lookup.frame.frameId, turnId: lookup.turnId, stepId: lookup.stepId }, undefined, detail.agent_id) } };
  }
  if (detail.kind === 'task') return { ...detail, task: boundedEntity(detail.task, { kind: 'task', id: detail.task.taskId }) };
  if (detail.kind === 'attachment') return { ...detail, attachment: boundedAttachment(detail.attachment, detail.agent_id) };
  return { ...detail, prompt: boundedEntity(detail.prompt, { kind: 'prompt', id: detail.prompt.promptId }) };
}

export async function readColdSessionViewBaseline(
  service: TranscriptService,
  sessionId: string,
  agentId: string,
  grade: Exclude<TranscriptGrade, 'off'>,
  signal: AbortSignal,
): Promise<TranscriptResetEvent | undefined> {
  const source = await service.readColdPageSnapshot(sessionId, agentId,
    (snapshot) => boundedTranscriptPageSource(snapshot, agentId), signal);
  if (source === undefined) return undefined;
  signal.throwIfAborted();
  const transcript = new AgentTranscript(agentId);
  transcript.apply([{ op: 'reset', agentId, snapshot: service.reconcileQuestionSnapshot(sessionId, source) }]);
  const snapshot = boundedTranscriptSnapshot(redactSnapshotForGrade(grade, transcript.snapshot({ tailTurns: 20 })), agentId);
  const coverage = coverageForItems(snapshot.items, snapshot.hasMoreOlder ?? false, source.toolCallCountKnown === true);
  const cursor = { seq: 0, epoch: `cold:${sessionId}:${agentId}` };
  return {
    type: 'transcript.reset', session_id: sessionId, agent_id: agentId,
    snapshot, grade, cursor, coverage,
    read: readFor('cold', coverage, cursor),
  };
}

export class TranscriptDetailCursorError extends Error {
  constructor() {
    super('invalid transcript detail cursor');
    this.name = 'TranscriptDetailCursorError';
  }
}

class TranscriptSourceChangedError extends Error {
  constructor(readonly source: TranscriptRead['source']) { super('transcript source changed'); }
}

function staleRead(source: TranscriptRead['source']): TranscriptRead {
  return { source, readiness: 'partial', reason: 'source_changed', stale: { reason: 'source_changed', retry: 'authoritative' } };
}

interface TranscriptDetailCursor {
  readonly v: 1 | 2;
  readonly agentId: string;
  readonly kind: TranscriptDetailListResponse['kind'];
  readonly after: string;
  readonly source?: TranscriptRead['source'];
}

function encodeTranscriptDetailCursor(cursor: TranscriptDetailCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeTranscriptDetailCursor(
  encoded: string,
  agentId: string,
  kind: TranscriptDetailCursor['kind'],
): TranscriptDetailCursor {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<TranscriptDetailCursor>;
    if (
      (parsed.v !== 1 && parsed.v !== 2) ||
      parsed.agentId !== agentId ||
      parsed.kind !== kind ||
      typeof parsed.after !== 'string' ||
      parsed.after.length === 0 ||
      (parsed.v === 2 && !isTranscriptSource(parsed.source))
    ) throw new Error('invalid cursor');
    return parsed as TranscriptDetailCursor;
  } catch {
    throw new TranscriptDetailCursorError();
  }
}

async function readSessionViewTranscriptPageRaw(
  transcriptService: TranscriptService,
  sessionId: string,
  input: {
    readonly agentId: string;
    readonly beforeTurn?: string;
    readonly beforeItem?: string;
    readonly afterTurn?: string;
    readonly afterItem?: string;
    readonly pageSize?: number;
    readonly signal?: AbortSignal;
  },
): Promise<TranscriptResponse | undefined> {
  const pageQueryInput = { agentId: input.agentId, beforeTurn: input.beforeTurn, beforeItem: input.beforeItem, afterTurn: input.afterTurn, afterItem: input.afterItem, pageSize: input.pageSize ?? 20 };
  const store = transcriptService.forSessionLive(sessionId);
  if (store !== undefined) {
    const transcript = await transcriptService.ensureAgentHistory(sessionId, input.agentId);
    if (transcript === undefined) return undefined;
    const liveVerified = await transcriptService.verifyTranscriptLiveCoverage(sessionId, input.agentId);
    if (transcript.hasMoreOlder && (input.beforeTurn !== undefined || input.beforeItem !== undefined || input.afterTurn !== undefined || input.afterItem !== undefined)) {
      const cold = await transcriptService.readFullAgentSnapshot(sessionId, input.agentId, transcript, input.signal,
        (source) => boundedTranscriptPageSource(source, input.agentId));
      if (cold === undefined) return undefined;
      const page = paginateTurns(cold.items, pageQueryFor(pageQueryInput, 'derived'));
      const verified = liveVerified && transcriptService.isTranscriptLiveCoverageVerified(sessionId, input.agentId) &&
        cold.toolCallCountKnown === true;
      const cursor = transcriptService.getTranscriptCursor(sessionId, input.agentId);
      const coverage = coverageForItems(page.items, page.hasMore, verified);
      return {
        session_id: sessionId, agent_id: input.agentId,
        items: page.items, has_more: page.hasMore, tool_call_count: verified ? cold.toolCallCount : undefined,
        tasks: cold.tasks, interactions: [...transcript.getInteractions().values()], attachments: cold.attachments,
        todos: cold.todos, prompts: cold.prompts, meta: cold.meta, agents: store.agents(),
        pending_interactions: transcript.listPendingInteractions(), cursor, coverage,
        read: readFor('derived', coverage, cursor),
        next_cursor: page.hasMore ? encodePageCursor(itemKey(page.items[0]!), input.agentId, 'derived', cursor?.epoch) : undefined,
      } as unknown as TranscriptResponse;
    }
    const snapshot = transcript.snapshot();
    const page = paginateTurns(transcript.getItems(), pageQueryFor(pageQueryInput, 'live'));
    const verified = liveVerified && transcriptService.isTranscriptLiveCoverageVerified(sessionId, input.agentId) &&
      snapshot.toolCallCountKnown === true;
    const cursor = transcriptService.getTranscriptCursor(sessionId, input.agentId);
    const hasMore = page.hasMore || transcript.hasMoreOlder;
    const coverage = coverageForItems(page.items, hasMore, verified);
    return {
      session_id: sessionId, agent_id: input.agentId,
      items: page.items, has_more: hasMore, tool_call_count: verified ? snapshot.toolCallCount : undefined,
      tasks: [...transcript.getTasks().values()],
      interactions: [...transcript.getInteractions().values()],
      attachments: [...transcript.getAttachments().values()],
      todos: [...transcript.getTodos().values()],
      prompts: [...transcript.getPrompts().values()],
      meta: transcript.getMeta(), agents: store.agents(),
      pending_interactions: transcript.listPendingInteractions(), cursor, coverage,
      read: readFor('live', coverage, cursor),
      next_cursor: hasMore && page.items.length > 0 ? encodePageCursor(itemKey(page.items[0]!), input.agentId, 'live', cursor?.epoch) : undefined,
    } as unknown as TranscriptResponse;
  }
  const snapshot = await transcriptService.readColdPageSnapshot(sessionId, input.agentId,
    (source) => boundedTranscriptPageSource(source, input.agentId), input.signal);
  if (snapshot === undefined) return undefined;
  const page = paginateTurns(snapshot.items, pageQueryFor(pageQueryInput, 'cold'));
  const roster = (await transcriptService.readColdRoster(sessionId)) ?? [];
  if (!roster.some((descriptor) => descriptor.agentId === input.agentId) &&
      (snapshot.items.length > 0 || snapshot.tasks.length > 0 || input.agentId === MAIN_AGENT_ID)) {
    roster.push({ agentId: input.agentId, type: input.agentId === MAIN_AGENT_ID ? 'main' : 'sub' });
  }
  const coverage = coverageForItems(page.items, page.hasMore, snapshot.toolCallCountKnown === true);
  const cursor = { seq: 0, epoch: `cold:${sessionId}:${input.agentId}` };
  return {
    session_id: sessionId, agent_id: input.agentId,
    items: page.items, has_more: page.hasMore, tool_call_count: snapshot.toolCallCount,
    tasks: snapshot.tasks, interactions: transcriptService.reconcileQuestionSnapshot(sessionId, snapshot).interactions, attachments: snapshot.attachments,
    todos: snapshot.todos, prompts: snapshot.prompts, meta: snapshot.meta, agents: roster,
    pending_interactions: [], cursor, coverage,
    read: readFor('cold', coverage, cursor),
    next_cursor: page.hasMore && page.items.length > 0 ? encodePageCursor(itemKey(page.items[0]!), input.agentId, 'cold', cursor.epoch) : undefined,
  } as unknown as TranscriptResponse;
}

async function readSessionViewTranscriptDetailRaw(
  transcriptService: TranscriptService,
  sessionId: string,
  input: {
    readonly agentId: string;
    readonly kind: 'task' | 'attachment' | 'prompt' | 'tool';
    readonly id: string;
    readonly signal?: AbortSignal;
  },
): Promise<
  | {
      readonly session_id: string;
      readonly agent_id: string;
      readonly kind: 'task';
      readonly task: TranscriptTask;
      readonly read?: TranscriptRead;
    }
  | {
      readonly session_id: string;
      readonly agent_id: string;
      readonly kind: 'attachment';
      readonly attachment: TranscriptAttachment;
      readonly read?: TranscriptRead;
    }
  | {
      readonly session_id: string;
      readonly agent_id: string;
      readonly kind: 'prompt';
      readonly prompt: TranscriptPrompt;
      readonly read?: TranscriptRead;
    }
  | { readonly session_id: string; readonly agent_id: string; readonly kind: 'tool'; readonly lookup: Awaited<ReturnType<TranscriptService['lookupToolCall']>>; readonly read?: TranscriptRead }
  | undefined
> {
  if (input.kind === 'tool') {
    const lookup = await transcriptService.lookupToolCall(sessionId, input.agentId, input.id, input.signal);
    return {
      session_id: sessionId, agent_id: input.agentId, kind: 'tool', lookup,
      read: lookup.status === 'preparing'
        ? { source: 'derived', readiness: 'preparing' }
        : { source: transcriptService.forSessionLive(sessionId) === undefined ? 'cold' : 'live', readiness: 'ready' },
    };
  }
  const store = transcriptService.forSessionLive(sessionId);
  let task: TranscriptTask | undefined;
  let attachment: TranscriptAttachment | undefined;
  let prompt: TranscriptPrompt | undefined;
  if (store !== undefined) {
    const transcript = await transcriptService.ensureAgentHistory(sessionId, input.agentId);
    if (transcript === undefined) return undefined;
    if (input.kind === 'task') task = transcript.getTask(input.id);
    else if (input.kind === 'attachment') attachment = transcript.getAttachment(input.id);
    else prompt = transcript.getPrompt(input.id);
    if ((task ?? attachment ?? prompt) === undefined && transcript.hasMoreOlder) {
      const snapshot = await transcriptService.readFullAgentSnapshot(sessionId, input.agentId, transcript, input.signal);
      if (input.kind === 'task') task = snapshot?.tasks.find((entry) => entry.taskId === input.id);
      else if (input.kind === 'attachment') attachment = snapshot?.attachments.find((entry) => entry.attachmentId === input.id);
      else prompt = snapshot?.prompts.find((entry) => entry.promptId === input.id);
    }
  } else {
    const snapshot = await transcriptService.readColdSnapshot(sessionId, input.agentId, undefined, input.signal);
    if (snapshot === undefined) return undefined;
    if (input.kind === 'task') task = snapshot.tasks.find((entry) => entry.taskId === input.id);
    else if (input.kind === 'attachment') attachment = snapshot.attachments.find((entry) => entry.attachmentId === input.id);
    else prompt = snapshot.prompts.find((entry) => entry.promptId === input.id);
  }
  if (input.kind === 'task') {
    return task === undefined
      ? undefined
      : { session_id: sessionId, agent_id: input.agentId, kind: 'task', task, read: { source: store === undefined ? 'cold' : 'live', readiness: 'ready' as const } };
  }
  if (input.kind === 'attachment') {
    return attachment === undefined
      ? undefined
      : { session_id: sessionId, agent_id: input.agentId, kind: 'attachment', attachment, read: { source: store === undefined ? 'cold' : 'live', readiness: 'ready' as const } };
  }
  return prompt === undefined
    ? undefined
    : { session_id: sessionId, agent_id: input.agentId, kind: 'prompt', prompt, read: { source: store === undefined ? 'cold' : 'live', readiness: 'ready' as const } };
}

type TranscriptCollectionKind = TranscriptDetailListResponse['kind'];
type TranscriptCollectionEntity = TranscriptTask | TranscriptAttachment | TranscriptPrompt | import('@kiki/transcript').TranscriptInteraction | import('@kiki/transcript').TranscriptTodo;

export async function readSessionViewTranscriptDetails(
  transcriptService: TranscriptService,
  sessionId: string,
  input: {
    readonly agentId: string;
    readonly kind: TranscriptCollectionKind;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  },
): Promise<TranscriptDetailListResponse | undefined> {
  input.signal?.throwIfAborted();
  const store = transcriptService.forSessionLive(sessionId);
  const transcript = store === undefined ? undefined : await transcriptService.ensureAgentHistory(sessionId, input.agentId);
  const snapshot = transcript === undefined ? await transcriptService.readColdSnapshot(sessionId, input.agentId, undefined, input.signal)
    : transcript.hasMoreOlder ? await transcriptService.readFullAgentSnapshot(sessionId, input.agentId, transcript, input.signal) : transcript.snapshot();
  if (snapshot === undefined) return undefined;
  const collections = { task: snapshot.tasks, attachment: snapshot.attachments, prompt: snapshot.prompts, interaction: transcriptService.reconcileQuestionSnapshot(sessionId, snapshot).interactions, todo: snapshot.todos };
  const ordered: readonly TranscriptCollectionEntity[] = collections[input.kind].toSorted((left, right) => {
    const a = detailEntityId(input.kind, left);
    const b = detailEntityId(input.kind, right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const source: TranscriptRead['source'] = transcript === undefined ? 'cold' : transcript.hasMoreOlder ? 'derived' : 'live';
  const cursor = input.cursor === undefined ? undefined : decodeTranscriptDetailCursor(input.cursor, input.agentId, input.kind);
  if (cursor?.v === 2 && cursor.source !== source) return {
    session_id: sessionId, agent_id: input.agentId, kind: input.kind, items: [], has_more: true, read: staleRead(source),
  };
  const after = cursor?.after;
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  const start = after === undefined ? 0 : ordered.findIndex((entry) => detailEntityId(input.kind, entry) > after);
  const offset = start < 0 ? ordered.length : start;
  const items: TranscriptCollectionEntity[] = [];
  const pageBytes = input.kind === 'todo' ? TRANSCRIPT_WINDOW_BYTES : DETAIL_PAGE_BYTES;
  let bytes = 2048;
  for (const entity of ordered.slice(offset, offset + limit)) {
    input.signal?.throwIfAborted();
    const projected = input.kind === 'attachment' ? boundedAttachment(entity as TranscriptAttachment, input.agentId, DETAIL_ENTITY_BYTES)
      : boundedEntity(entity, { kind: input.kind, id: detailEntityId(input.kind, entity) }, input.kind === 'todo' ? undefined : DETAIL_ENTITY_BYTES);
    const size = jsonBytes(projected) + 1;
    if (items.length > 0 && bytes + size > pageBytes) break;
    items.push(projected);
    bytes += size;
  }
  const hasMore = offset + items.length < ordered.length;
  const nextCursor = hasMore && items.length > 0 ? encodeTranscriptDetailCursor({ v: 2, agentId: input.agentId, kind: input.kind, source, after: detailEntityId(input.kind, items.at(-1)!) }) : undefined;
  const read = readFor(source, snapshot.toolCallCountKnown === true ? { kind: 'full', hasMoreOlder: false } : { kind: 'unknown', hasMoreOlder: true });
  const result = { session_id: sessionId, agent_id: input.agentId, kind: input.kind, items, total: ordered.length, has_more: hasMore, read, ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }) };

  return result as TranscriptDetailListResponse;
}

function detailEntityId(kind: TranscriptCollectionKind, entity: TranscriptCollectionEntity): string {
  switch (kind) {
    case 'task': return (entity as TranscriptTask).taskId;
    case 'attachment': return (entity as TranscriptAttachment).attachmentId;
    case 'prompt': return (entity as TranscriptPrompt).promptId;
    case 'interaction': return (entity as import('@kiki/transcript').TranscriptInteraction).interactionId;
    case 'todo': return (entity as import('@kiki/transcript').TranscriptTodo).todoId;
  }
}

export async function readSessionViewTranscriptCatchUp(
  transcriptService: TranscriptService,
  sessionId: string,
  input: { readonly agentId: string; readonly since: { readonly seq: number; readonly epoch?: string }; readonly grade?: 'turn' | 'block' | 'delta' },
): Promise<TranscriptOpsCatchupResponse | undefined> {
  const catchup = transcriptService.getOpsSince(sessionId, input.agentId, input.since);
  if (catchup === undefined) {
    const roster = await transcriptService.readColdRoster(sessionId);
    if (roster === undefined) return undefined;
    return {
      session_id: sessionId, agent_id: input.agentId,
      epoch: input.since.epoch ?? `cold:${sessionId}:${input.agentId}`,
      batches: [], through_seq: 0, complete: false,
    };
  }
  const grade = input.grade ?? 'delta';
  const transcript = transcriptService.forSessionLive(sessionId)?.getAgent(input.agentId);
  const batches: TranscriptOpsCatchupResponse['batches'] = [];
  let bytes = 2048;
  let through = input.since.seq;
  let hasMore = false;
  let complete = catchup.complete;
  if (transcript === undefined) complete = false;
  else for (const batch of catchup.batches) {
    const ops = boundedTranscriptOps(filterOpsForGrade(grade, batch.ops), transcript, DETAIL_ENTITY_BYTES);
    const bounded = { seq: batch.seq, ops };
    const size = jsonBytes(bounded) + 1;
    if (bytes + size > DETAIL_PAGE_BYTES) {
      if (batches.length === 0) complete = false;
      else hasMore = true;
      break;
    }
    if (ops.length > 0) { batches.push(bounded as TranscriptOpsCatchupResponse['batches'][number]); bytes += size; }
    through = batch.seq;
  }
  const result = { session_id: sessionId, agent_id: input.agentId, epoch: catchup.epoch, batches, through_seq: hasMore ? through : catchup.throughSeq, complete, has_more: hasMore };

  return result;
}

function coverageForItems(items: readonly { readonly kind: string; readonly turnId?: string }[], hasMoreOlder: boolean, verified: boolean) {
  if (!verified) return { kind: 'unknown' as const, hasMoreOlder: true as const };
  if (!hasMoreOlder) return { kind: 'full' as const, hasMoreOlder: false as const };
  const turns = items.filter((item) => item.kind === 'turn');
  return { kind: 'tail' as const, fromTurnId: turns[0]?.turnId, throughTurnId: turns.at(-1)?.turnId, hasMoreOlder };
}

function readFor(source: TranscriptRead['source'], coverage: ReturnType<typeof coverageForItems>, cursor?: { readonly epoch?: string; readonly seq: number }): TranscriptRead {
  return transcriptReadForCoverage(source, coverage, cursor === undefined ? undefined : { transcript: cursor });
}

interface PageCursor {
  readonly v: 2;
  readonly agentId: string;
  readonly source: TranscriptRead['source'];
  readonly anchor: string;
  readonly epoch?: string;
}

function encodePageCursor(anchor: string, agentId: string, source: TranscriptRead['source'], epoch?: string): string {
  return Buffer.from(JSON.stringify({ v: 2, agentId, source, anchor, epoch } satisfies PageCursor), 'utf8').toString('base64url');
}

function isTranscriptSource(source: unknown): source is TranscriptRead['source'] {
  return source === 'live' || source === 'cold' || source === 'derived';
}

function pageQueryFor(input: { readonly agentId: string; readonly beforeTurn?: string; readonly beforeItem?: string; readonly afterTurn?: string; readonly afterItem?: string; readonly pageSize: number }, source: TranscriptRead['source']) {
  const decode = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<PageCursor>;
      if (parsed.v === 2) {
        if (parsed.agentId !== input.agentId || typeof parsed.anchor !== 'string' || parsed.anchor.length === 0 || !isTranscriptSource(parsed.source)) throw new TranscriptDetailCursorError();
        if (parsed.source !== source) throw new TranscriptSourceChangedError(source);
        return parsed.anchor;
      }
    } catch (error) {
      if (error instanceof TranscriptDetailCursorError || error instanceof TranscriptSourceChangedError) throw error;
      return value;
    }
    return value;
  };
  return { beforeTurn: input.beforeTurn, beforeItem: decode(input.beforeItem), afterTurn: input.afterTurn, afterItem: decode(input.afterItem), pageSize: input.pageSize };
}

function paginateTurns(items: readonly TranscriptItem[], query: { beforeTurn?: string; beforeItem?: string; afterTurn?: string; afterItem?: string; pageSize: number }) {
  const cursor = query.beforeItem ?? query.afterItem;
  if (cursor === undefined) return paginateCanonicalTurns(items, query);
  const index = items.findIndex((item) => itemKey(item) === cursor);
  if (index < 0) throw new TranscriptDetailCursorError();
  const pageSize = Math.max(1, Math.min(100, Math.floor(query.pageSize)));
  if (query.afterItem !== undefined) {
    const end = Math.min(items.length, index + pageSize + 1);
    return { items: items.slice(index + 1, end), hasMore: end < items.length };
  }
  const start = Math.max(0, index - pageSize);
  return { items: items.slice(start, index), hasMore: start > 0 };
}
