import { Error2, ErrorCodes, MAIN_AGENT_ID } from '@kiki/agent-core-v2';
import { abortable } from '@kiki/agent-core-v2/_base/utils/abort';
import {
  AgentTranscript,
  compareTurnIds,
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
  rebindTurnContentRefs,
  type ContentRef,
  type ContentSegment,
  type AgentTranscriptSnapshot,
  type TranscriptItem,
  type TranscriptTurn,
} from '@kiki/transcript';

import type { TranscriptService } from '../../services/transcript/transcriptService';
import { boundedEntity, ContentChangedError, readContentSegment } from './boundedContent';
import { boundedAttachment, boundedTranscriptOps, boundedTranscriptResponse, boundedTranscriptSnapshot, boundedTranscriptPageSource, historyAnchorMatches, historyDigestAnchor, itemKey, TRANSCRIPT_WINDOW_BYTES } from './boundedTranscript';

const DETAIL_PAGE_BYTES = 48 * 1024;
const DETAIL_ENTITY_BYTES = 2048;

export async function readSessionViewTranscriptContent(
  service: TranscriptService, sessionId: string,
  input: { readonly agentId: string; readonly ref: ContentRef; readonly range?: boolean; readonly signal?: AbortSignal },
): Promise<ContentSegment | undefined> {
  const resident = residentTimelineEntity(service, sessionId, input.agentId, input.ref.source);
  if (resident !== undefined) {
    input.signal?.throwIfAborted();
    try {
      return readContentSegment(resident, input.ref, input.range, input.agentId, DETAIL_PAGE_BYTES);
    } catch (error) {
      if (!(error instanceof ContentChangedError)) throw error;
    }
  }
  const entity = await readSessionViewCanonicalEntity(service, sessionId, input);
  return entity === undefined ? undefined : readContentSegment(entity, input.ref, input.range, input.agentId, DETAIL_PAGE_BYTES);
}

function residentTimelineEntity(service: TranscriptService, sessionId: string, agentId: string, source: ContentRef['source']): object | undefined {
  if (source.kind !== 'turn' && source.kind !== 'frame') return undefined;
  if (typeof service.forSessionLive !== 'function') return undefined;
  const turn = service.forSessionLive(sessionId)?.getAgent(agentId)?.getTurn(source.kind === 'turn' ? source.id : source.turnId ?? '');
  if (turn === undefined || source.kind === 'turn') return turn;
  return turn.steps.find((step) => step.stepId === source.stepId)?.frames.find((frame) => frame.frameId === source.id);
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

export const TRANSCRIPT_PAGE_TIMEOUT_MS = 5_000;

export async function readSessionViewTranscriptPage(
  service: TranscriptService,
  sessionId: string,
  input: Parameters<typeof readSessionViewTranscriptPageRaw>[2],
): Promise<TranscriptResponse | undefined> {
  input.signal?.throwIfAborted();
  const deadline = new AbortController();
  const signal = input.signal === undefined ? deadline.signal : AbortSignal.any([input.signal, deadline.signal]);
  const timer = setTimeout(() => { deadline.abort(new Error2(ErrorCodes.SESSION_BUSY, 'History page timed out. Retry to continue.')); }, TRANSCRIPT_PAGE_TIMEOUT_MS);
  try { return await abortable(readSessionViewTranscriptPageWithinBudget(service, sessionId, { ...input, signal }), signal); }
  finally { clearTimeout(timer); }
}

async function readSessionViewTranscriptPageWithinBudget(
  ...args: Parameters<typeof readSessionViewTranscriptPageRaw>
): Promise<TranscriptResponse | undefined> {
  try {
    const response = await readSessionViewTranscriptPageRaw(...args);
    if (response === undefined) return undefined;
    const forward = args[2].afterTurn !== undefined || args[2].afterItem !== undefined;
    const bounded = boundedTranscriptResponse(response, forward ? 'head' : 'tail', 64 * 1024);
    const aligned = await alignSingleBeforeTurn(args[0], args[1], args[2], bounded);
    const anchor = looseAnchor(aligned.next_cursor, response.agent_id);
    const seekTurn = anchor === undefined ? undefined : seekTurnForAnchor(response.items, anchor)
      ?? cursorSeekTurn(args[2].beforeItem ?? args[2].afterItem, response.agent_id);
    let beforeTurn = forward ? undefined : cursorBeforeTurn(args[2].beforeItem, response.agent_id);
    if (!forward) for (const item of aligned.items) {
      if (item.kind === 'turn' && /^t\d+$/.test(item.turnId) && (beforeTurn === undefined || compareTurnIds(item.turnId, beforeTurn) < 0)) beforeTurn = item.turnId;
    }
    const refreshedTurn = decodePageCursor(response.next_cursor, response.agent_id)?.refreshedTurn;
    const orphan = aligned.items.find((item): item is TranscriptTurn => item.kind === 'turn' && itemKey(item) === anchor &&
      item.origin.kind === 'other' && item.message === undefined && item.promptId === undefined);
    const pendingOrphan = decodePageCursor(args[2].beforeItem, response.agent_id)?.orphanTurn;
    const orphanTurn = refreshedTurn === undefined ? orphan?.turnId ?? (anchor === `turn:${pendingOrphan}` ? pendingOrphan : undefined) : undefined;
    return { ...aligned, next_cursor: anchor === undefined || response.read === undefined ? aligned.next_cursor
      : encodePageCursor(anchor, response.agent_id, response.read.source, response.cursor?.epoch, seekTurn, beforeTurn, refreshedTurn, orphanTurn) };
  } catch (error) {
    if (!(error instanceof TranscriptSourceChangedError)) throw error;
    return {
      session_id: args[1], agent_id: args[2].agentId, items: [], has_more: true,
      tasks: [], interactions: [], attachments: [], todos: [], prompts: [], meta: {}, agents: [], pending_interactions: [],
      coverage: { kind: 'unknown', hasMoreOlder: true }, read: staleRead(error.source, error.reason),
    };
  }
}

async function alignSingleBeforeTurn(
  service: TranscriptService,
  sessionId: string,
  input: { readonly agentId: string; readonly beforeTurn?: string; readonly pageSize?: number; readonly signal?: AbortSignal },
  response: TranscriptResponse,
): Promise<TranscriptResponse> {
  if (input.beforeTurn === undefined || input.pageSize !== 1 || typeof service.readCanonicalEntity !== 'function') return response;
  const items: TranscriptResponse['items'] = [];
  let replaced = false;
  for (const item of response.items) {
    if (item.kind !== 'turn') { items.push(item); continue; }
    let entity: object | undefined;
    try {
      entity = await service.readCanonicalEntity(sessionId, input.agentId, { kind: 'turn', id: item.turnId }, input.signal);
    } catch (error) {
      if (input.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) throw error;
      items.push(item);
      continue;
    }
    const canonical = entity as TranscriptTurn | undefined;
    if (canonical?.kind !== 'turn' || !Array.isArray(canonical.steps) || (canonical.steps.length === 0 && item.steps.length > 0)) {
      items.push(item);
      continue;
    }
    items.push(rebindTurnContentRefs(boundedEntity(canonical, { kind: 'turn', id: item.turnId }, undefined, input.agentId, 'tail')));
    replaced = true;
  }
  return replaced ? { ...response, items } : response;
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

export function sessionViewSnapshotHistoryCursor(snapshot: AgentTranscriptSnapshot, agentId: string,
  source: TranscriptRead['source'], epoch?: string): string | undefined {
  const first = snapshot.items[0];
  if (snapshot.olderCursor === undefined || first?.kind !== 'turn' || first.origin.kind !== 'other' ||
      first.message !== undefined || first.promptId !== undefined) return snapshot.olderCursor;
  return encodePageCursor(itemKey(first), agentId, source, epoch, undefined, first.turnId, undefined, first.turnId);
}

export async function readColdSessionViewBaseline(
  service: TranscriptService,
  sessionId: string,
  agentId: string,
  grade: Exclude<TranscriptGrade, 'off'>,
  signal: AbortSignal,
): Promise<TranscriptResetEvent | undefined> {
  const source = await service.readColdPageSnapshot(sessionId, agentId,
    (snapshot) => boundedTranscriptPageSource(snapshot, agentId, 'tail'), signal, false, undefined, false, true);
  if (source === undefined) return undefined;
  signal.throwIfAborted();
  const transcript = new AgentTranscript(agentId);
  transcript.apply([{ op: 'reset', agentId, snapshot: service.reconcileQuestionSnapshot(sessionId, source) }]);
  const snapshot = boundedTranscriptSnapshot(redactSnapshotForGrade(grade, transcript.snapshot({ tailTurns: 20 })), agentId);
  const coverage = coverageForItems(snapshot.items, snapshot.hasMoreOlder ?? false, source.toolCallCountKnown === true);
  const cursor = { seq: 0, epoch: `cold:${sessionId}:${agentId}` };
  return {
    type: 'transcript.reset', session_id: sessionId, agent_id: agentId,
    snapshot: { ...snapshot, olderCursor: sessionViewSnapshotHistoryCursor(snapshot, agentId, 'cold', cursor.epoch) }, grade, cursor, coverage,
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
  constructor(readonly source: TranscriptRead['source'], readonly reason: 'source_changed' | 'stale_cursor' = 'source_changed') { super(reason); }
}

function staleRead(source: TranscriptRead['source'], reason: 'source_changed' | 'stale_cursor' = 'source_changed'): TranscriptRead {
  return { source, readiness: 'partial', reason, stale: { reason, retry: 'authoritative' } };
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
  const anchored = input.beforeTurn !== undefined || input.beforeItem !== undefined || input.afterTurn !== undefined || input.afterItem !== undefined;
  const singleBeforeTurn = input.beforeTurn !== undefined && input.pageSize === 1;
  const sourceDirection: 'head' | 'tail' = input.afterTurn !== undefined || input.afterItem !== undefined || (anchored && !singleBeforeTurn) ? 'head' : 'tail';
  const store = transcriptService.forSessionLive(sessionId);
  if (store !== undefined) {
    const transcript = await transcriptService.ensureAgentHistory(sessionId, input.agentId, { signal: input.signal });
    if (transcript === undefined) return undefined;
    const liveVerified = transcriptService.isTranscriptLiveCoverageVerified(sessionId, input.agentId);
    if (!liveVerified) void transcriptService.verifyTranscriptLiveCoverage(sessionId, input.agentId).catch(() => {});
    if (transcript.hasMoreOlder && (anchored || !transcript.getItems().some(item => item.kind === 'turn'))) {
      const loaded = await readColdTranscriptPage(transcriptService, sessionId, input, sourceDirection, 'derived');
      if (loaded === undefined) return undefined;
      const query = loaded.query;
      const cold = await transcriptService.readFullAgentSnapshot(sessionId, input.agentId, transcript, input.signal,
        (source) => boundedTranscriptPageSource(source, input.agentId, sourceDirection), query.beforeTurn, loaded.snapshot);
      if (cold === undefined) return undefined;
      const anchor = query.beforeItem;
      const exact = anchor !== undefined && cold.items.some((item) => historyAnchorMatches(itemKey(item), anchor));
      const turnId = !exact && anchor?.startsWith('turn:') === true ? anchor.slice(5) : undefined;
      const covered = turnId !== undefined && coldWindowCovers(cold.items, turnId);
      const anchorState = typeof transcriptService.anchorReadState === 'function' ? transcriptService.anchorReadState(cold) : undefined;
      let page: ReturnType<typeof paginateTurns>;
      try {
        page = paginateTurns(cold.items, covered ? { ...query, beforeTurn: turnId, beforeItem: undefined } : query);
      } catch (error) {
        if (!(error instanceof TranscriptDetailCursorError)) throw error;
        if (anchorState !== 'pending' && decodePageCursor(input.beforeItem, input.agentId) !== undefined) throw new TranscriptSourceChangedError('derived', 'stale_cursor');
        if (loaded.snapshot.hasMoreOlder !== true && cold.hasMoreOlder !== true) throw error;
        page = { items: [], hasMore: true };
      }
      if (query.refreshTurn !== undefined) {
        const refreshed = cold.items.find(item => item.kind === 'turn' && item.turnId === query.refreshTurn);
        if (refreshed !== undefined) page = { items: [refreshed], hasMore: page.items.length > 0 || page.hasMore };
      }
      const hasMore = page.hasMore || cold.hasMoreOlder === true || anchorState === 'continues' || anchorState === 'pending';
      const verified = liveVerified && transcriptService.isTranscriptLiveCoverageVerified(sessionId, input.agentId) &&
        cold.toolCallCountKnown === true;
      const cursor = transcriptService.getTranscriptCursor(sessionId, input.agentId);
      const coverage = coverageForItems(page.items, hasMore, verified);
      const emptyContinuation = page.items.length === 0 && hasMore;
      const anchorCursor = anchorState === 'pending' || emptyContinuation ? requestedAnchor({ ...input, ...query }) : undefined;
      return {
        session_id: sessionId, agent_id: input.agentId,
        items: page.items, has_more: hasMore, tool_call_count: verified ? cold.toolCallCount : undefined,
        tasks: cold.tasks, interactions: [...transcript.getInteractions().values()], attachments: cold.attachments,
        todos: cold.todos, prompts: cold.prompts, meta: cold.meta, agents: store.agents(),
        pending_interactions: transcript.listPendingInteractions(), cursor, coverage,
        read: anchorState === 'pending' ? { source: 'derived', readiness: 'preparing' }
          : emptyContinuation ? { ...readFor('derived', coverage, cursor), readiness: 'partial', reason: 'budget' }
          : readFor('derived', coverage, cursor),
        next_cursor: hasMore && page.items.length > 0 ? encodePageCursor(itemKey(page.items[0]!), input.agentId, 'derived', cursor?.epoch, undefined, undefined, query.refreshTurn)
          : anchorCursor,
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
  const loaded = await readColdTranscriptPage(transcriptService, sessionId, input, sourceDirection);
  if (loaded === undefined) return undefined;
  const snapshot = loaded.snapshot;
  const page = loaded.page;
  const anchorState = typeof transcriptService.anchorReadState === 'function' ? transcriptService.anchorReadState(snapshot) : undefined;
  const truncated = anchorState !== undefined ? anchorState === 'continues' || anchorState === 'pending'
    : !page.hasMore && typeof transcriptService.coldHistoryTruncated === 'function'
      ? await transcriptService.coldHistoryTruncated(sessionId, input.agentId) : false;
  const hasMore = page.hasMore || truncated;
  const continuationAnchor = page.items.length > 0 ? undefined : requestedAnchor({ ...input, ...loaded.query });
  const roster = (await transcriptService.readColdRoster(sessionId)) ?? [];
  if (!roster.some((descriptor) => descriptor.agentId === input.agentId) &&
      (snapshot.items.length > 0 || snapshot.tasks.length > 0 || input.agentId === MAIN_AGENT_ID)) {
    roster.push({ agentId: input.agentId, type: input.agentId === MAIN_AGENT_ID ? 'main' : 'sub' });
  }
  const coverage = coverageForItems(page.items, hasMore, snapshot.toolCallCountKnown === true);
  const cursor = { seq: 0, epoch: `cold:${sessionId}:${input.agentId}` };
  const coldRead = anchorState === 'pending' ? { source: 'cold' as const, readiness: 'preparing' as const } : readFor('cold', coverage, cursor);
  const emptyContinuation = page.items.length === 0 && hasMore && anchorState !== 'pending';
  return {
    session_id: sessionId, agent_id: input.agentId,
    items: page.items, has_more: hasMore, tool_call_count: snapshot.toolCallCount,
    tasks: snapshot.tasks, interactions: transcriptService.reconcileQuestionSnapshot(sessionId, snapshot).interactions, attachments: snapshot.attachments,
    todos: snapshot.todos, prompts: snapshot.prompts, meta: snapshot.meta, agents: roster,
    pending_interactions: [], cursor, coverage,
    read: emptyContinuation ? { ...coldRead, readiness: 'partial' as const, reason: 'budget' as const } : coldRead,
    next_cursor: hasMore && page.items.length > 0 ? encodePageCursor(itemKey(page.items[0]!), input.agentId, 'cold', cursor.epoch, undefined, undefined, loaded.query.refreshTurn)
      : hasMore ? continuationAnchor : undefined,
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
  readonly seekTurn?: string;
  readonly beforeTurn?: string;
  readonly refreshedTurn?: string;
  readonly orphanTurn?: string;
}

function encodePageCursor(anchor: string, agentId: string, source: TranscriptRead['source'], epoch?: string, seekTurn?: string, beforeTurn?: string, refreshedTurn?: string, orphanTurn?: string): string {
  const encode = (value: string) => Buffer.from(JSON.stringify({ v: 2, agentId, source, anchor: value, epoch, seekTurn, beforeTurn, refreshedTurn, orphanTurn } satisfies PageCursor), 'utf8').toString('base64url');
  const direct = encode(anchor);
  if (direct.length <= 512) return direct;
  return encode(anchor.startsWith('~') ? anchor : historyDigestAnchor(anchor));
}

function seekTurnForAnchor(items: readonly TranscriptItem[], anchor: string): string | undefined {
  const index = items.findIndex((item) => historyAnchorMatches(itemKey(item), anchor));
  if (index < 0 || items[index]?.kind === 'turn') return undefined;
  const next = items.slice(index + 1).find((item) => item.kind === 'turn');
  if (next?.kind === 'turn') return next.turnId;
  const previous = items.slice(0, index).findLast((item) => item.kind === 'turn');
  return previous?.kind === 'turn' && Number.isSafeInteger(previous.ordinal) ? `t${previous.ordinal + 1}` : undefined;
}

function decodePageCursor(value: string | undefined, agentId: string): PageCursor | undefined {
  if (value === undefined) return undefined;
  let parsed: Partial<PageCursor>;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<PageCursor>; }
  catch { return undefined; }
  if (parsed.v !== 2) return undefined;
  if (parsed.agentId !== agentId || typeof parsed.anchor !== 'string' || parsed.anchor.length === 0 || !isTranscriptSource(parsed.source)) throw new TranscriptDetailCursorError();
  for (const turn of [parsed.seekTurn, parsed.beforeTurn, parsed.refreshedTurn, parsed.orphanTurn]) {
    if (turn !== undefined && (typeof turn !== 'string' || !/^t\d+$/.test(turn))) throw new TranscriptDetailCursorError();
  }
  return parsed as PageCursor;
}

function cursorSeekTurn(value: string | undefined, agentId: string): string | undefined {
  return decodePageCursor(value, agentId)?.seekTurn;
}

function cursorBeforeTurn(value: string | undefined, agentId: string): string | undefined {
  return decodePageCursor(value, agentId)?.beforeTurn;
}

function isTranscriptSource(source: unknown): source is TranscriptRead['source'] {
  return source === 'live' || source === 'cold' || source === 'derived';
}

async function readColdTranscriptPage(
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
  sourceDirection: 'head' | 'tail',
  source: TranscriptRead['source'] = 'cold',
): Promise<{ snapshot: AgentTranscriptSnapshot; page: ReturnType<typeof paginateTurns>; query: PageQuery } | undefined> {
  const query = pageQueryFor({ ...input, pageSize: input.pageSize ?? 20 }, source);
  const project = (source: AgentTranscriptSnapshot) => boundedTranscriptPageSource(source, input.agentId, sourceDirection);
  const boundary = () => typeof transcriptService.coldWindowBoundary === 'function' ? transcriptService.coldWindowBoundary(sessionId, input.agentId) : undefined;
  const initialBoundary = await boundary();
  const anchored = input.beforeTurn !== undefined || input.beforeItem !== undefined || input.afterTurn !== undefined || input.afterItem !== undefined;
  const initialSnapshot = await transcriptService.readColdPageSnapshot(sessionId, input.agentId, project, input.signal, false, undefined, anchored, false, true);
  if (initialSnapshot === undefined) return undefined;
  let snapshot: AgentTranscriptSnapshot = initialSnapshot;
  const anchor = requestedAnchor(input);
  query.seekTurn ??= anchor === undefined ? undefined : seekTurnForAnchor(snapshot.items, anchor);
  const locate = (prefixMaterialized = false) => {
    const result = locateColdPage(snapshot.items, query);
    if (!result.missing || !prefixMaterialized || query.beforeItem === undefined) return result;
    if (query.consumedBeforeTurn === undefined) {
      if (source !== 'derived') throw new TranscriptSourceChangedError(source, 'stale_cursor');
      return result;
    }
    query.beforeItem = undefined;
    query.beforeTurn = query.consumedBeforeTurn;
    return locateColdPage(snapshot.items, query);
  };
  let located = locate(prefixWasMaterialized(initialBoundary, await boundary()));
  const orphan = snapshot.items.find((item): item is TranscriptTurn => item.kind === 'turn' && itemKey(item) === anchor &&
    item.origin.kind === 'other' && item.message === undefined && item.promptId === undefined);
  let extendingBoundary = false;
  let extendedBoundary = false;
  if (orphan === undefined && anchor !== undefined && snapshot.items.some(item => historyAnchorMatches(itemKey(item), anchor)) &&
      anchored && !located.missing && located.page.items.length === 0) {
    const attempts = 4;
    for (let attempt = 0; attempt < attempts && !located.missing && located.page.items.length === 0 && snapshot.hasMoreOlder === true; attempt += 1) {
      const next = await extendColdPage(transcriptService, sessionId, input.agentId, project, input.signal, snapshot, false);
      extendedBoundary = true;
      if (next === undefined) break;
      snapshot = next.snapshot;
      located = locate(next.prefixMaterialized);
      extendingBoundary = next.progressed;
      if (!next.progressed) break;
    }
  }
  const turnAnchor = query.beforeTurn ?? (query.beforeItem?.startsWith('turn:') === true ? query.beforeItem.slice(5) : undefined)
    ?? query.seekTurn ?? (anchor === undefined ? undefined : seekTurnForAnchor(snapshot.items, anchor));
  const anchorInWindow = turnAnchor !== undefined && snapshot.items.some((item) => item.kind === 'turn' && item.turnId === turnAnchor);
  let anchorPending: AgentTranscriptSnapshot | undefined;
  if ((!extendingBoundary || orphan !== undefined) && turnAnchor !== undefined && (!anchorInWindow || located.missing || located.page.items.length === 0 || orphan !== undefined) && snapshot.hasMoreOlder === true &&
      typeof transcriptService.readAnchoredColdSnapshot === 'function') {
    const previousBoundary = await boundary();
    const anchoredSnapshot = await transcriptService.readAnchoredColdSnapshot(sessionId, input.agentId, turnAnchor, input.signal);
    const anchorState = anchoredSnapshot === undefined || typeof transcriptService.anchorReadState !== 'function'
      ? undefined : transcriptService.anchorReadState(anchoredSnapshot);
    if (anchoredSnapshot !== undefined && anchorState !== 'pending' && (anchoredSnapshot.items.length > 0 || anchorState === 'window')) {
      snapshot = anchoredSnapshot;
      located = locate(prefixWasMaterialized(previousBoundary, await boundary()));
      const upgradeTurn = query.orphanTurn;
      const updated = upgradeTurn === undefined || query.refreshedTurn === upgradeTurn ? undefined
        : snapshot.items.find((item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === upgradeTurn &&
          (item.promptId !== undefined || item.message !== undefined || item.origin.kind !== 'other'));
      if (updated !== undefined) {
        located = { page: { items: [updated], hasMore: located.page.items.length > 0 || located.page.hasMore }, missing: false };
        query.refreshTurn = updated.turnId;
      }
    } else if (anchorState === 'pending' && anchoredSnapshot !== undefined) anchorPending = anchoredSnapshot;
  }
  if (!extendedBoundary && anchorPending === undefined && anchored && snapshot.hasMoreOlder === true && !coldWindowCovers(snapshot.items, turnAnchor ?? '')) {
    for (let attempt = 0; attempt < 4 && (located.missing || located.page.items.length === 0) && snapshot.hasMoreOlder === true; attempt += 1) {
      const next = await extendColdPage(transcriptService, sessionId, input.agentId, project, input.signal, snapshot, !anchorInWindow);
      if (next === undefined) break;
      snapshot = next.snapshot;
      located = locate(next.prefixMaterialized);
      if (!next.progressed || !located.missing) break;
    }
  }
  if (anchorPending !== undefined) {
    snapshot = anchorPending;
    located = { page: { items: [], hasMore: true }, missing: false };
  }
  if (anchored && !located.missing && located.page.items.length > 0 && !located.page.hasMore && snapshot.hasMoreOlder === true &&
      typeof transcriptService.coldWindowReachedStart === 'function') {
    if (await transcriptService.coldWindowReachedStart(sessionId, input.agentId)) snapshot = { ...snapshot, hasMoreOlder: false };
    else if (source === 'cold' && query.refreshTurn === undefined && anchorPending === undefined) {
      const next = await extendColdPage(transcriptService, sessionId, input.agentId, project, input.signal, snapshot, false);
      if (next?.progressed) {
        const extended = next.snapshot;
        const page = locateColdPage(extended.items, query);
        if (!page.missing && page.page.items.length > 0) {
          snapshot = extended;
          located = page;
        } else if (await transcriptService.coldWindowReachedStart(sessionId, input.agentId)) snapshot = { ...snapshot, hasMoreOlder: false };
      }
    }
  }
  if (located.missing && source !== 'derived' && decodePageCursor(input.beforeItem, input.agentId) !== undefined) throw new TranscriptSourceChangedError(source, 'stale_cursor');
  if (located.missing && source !== 'derived' && snapshot.hasMoreOlder !== true) throw new TranscriptDetailCursorError();
  return { snapshot, page: located.page, query };
}

type ColdPageBoundary = Awaited<ReturnType<TranscriptService['coldWindowBoundary']>>;

function prefixWasMaterialized(before: ColdPageBoundary, after: ColdPageBoundary): boolean {
  return before !== undefined && after !== undefined && before.fingerprint === after.fingerprint &&
    after.start < before.start && after.end >= before.start && after.end <= before.end;
}

async function extendColdPage(
  transcriptService: TranscriptService,
  sessionId: string,
  agentId: string,
  project: (source: AgentTranscriptSnapshot) => AgentTranscriptSnapshot,
  signal: AbortSignal | undefined,
  snapshot: AgentTranscriptSnapshot,
  wide: boolean,
): Promise<{ snapshot: AgentTranscriptSnapshot; progressed: boolean; prefixMaterialized: boolean } | undefined> {
  const boundary = typeof transcriptService.coldWindowBoundary === 'function'
    ? await transcriptService.coldWindowBoundary(sessionId, agentId) : undefined;
  const next = await transcriptService.readColdPageSnapshot(sessionId, agentId, project, signal, true, wide ? 8 << 20 : undefined, true, false, true);
  if (next === undefined) return undefined;
  const nextBoundary = typeof transcriptService.coldWindowBoundary === 'function'
    ? await transcriptService.coldWindowBoundary(sessionId, agentId) : undefined;
  return {
    snapshot: next,
    progressed: boundary?.fingerprint !== nextBoundary?.fingerprint || boundary?.start !== nextBoundary?.start || boundary?.end !== nextBoundary?.end ||
      next.hasMoreOlder !== snapshot.hasMoreOlder || next.items.map(itemKey).join('\0') !== snapshot.items.map(itemKey).join('\0'),
    prefixMaterialized: prefixWasMaterialized(boundary, nextBoundary),
  };
}

function coldWindowCovers(items: readonly TranscriptItem[], beforeTurn: string): boolean {
  const ordered = items.flatMap((item) => item.kind === 'turn' ? [item.turnId] : []).sort(compareTurnIds);
  if (ordered.length === 0) return false;
  let start = ordered[0]!;
  for (let index = 1; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    if (compareTurnIds(current, ordered[index - 1]!) > 1) start = current;
  }
  const end = ordered.at(-1)!;
  if (compareTurnIds(beforeTurn, end) > 0) return true;
  return compareTurnIds(beforeTurn, start) > 0;
}

function requestedAnchor(input: {
  readonly agentId: string;
  readonly beforeTurn?: string;
  readonly beforeItem?: string;
  readonly afterTurn?: string;
  readonly afterItem?: string;
}): string | undefined {
  const beforeItem = looseAnchor(input.beforeItem, input.agentId);
  if (beforeItem !== undefined) return beforeItem;
  if (input.beforeTurn !== undefined) return `turn:${input.beforeTurn}`;
  const afterItem = looseAnchor(input.afterItem, input.agentId);
  if (afterItem !== undefined) return afterItem;
  return input.afterTurn === undefined ? undefined : `turn:${input.afterTurn}`;
}

function looseAnchor(value: string | undefined, agentId: string): string | undefined {
  if (value === undefined || value.startsWith('~')) return value;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<PageCursor>;
    if (parsed.v === 2) {
      if (parsed.agentId !== agentId || typeof parsed.anchor !== 'string' || parsed.anchor.length === 0) throw new TranscriptDetailCursorError();
      return parsed.anchor;
    }
  } catch (error) {
    if (error instanceof TranscriptDetailCursorError) throw error;
    return value;
  }
  return value;
}

interface PageQuery {
  beforeTurn?: string;
  beforeItem?: string;
  afterTurn?: string;
  afterItem?: string;
  pageSize: number;
  seekTurn?: string;
  consumedBeforeTurn?: string;
  refreshedTurn?: string;
  orphanTurn?: string;
  refreshTurn?: string;
}

function locateColdPage(items: readonly TranscriptItem[], query: PageQuery): { page: ReturnType<typeof paginateTurns>; missing: boolean } {
  try {
    return { page: paginateTurns(items, query), missing: false };
  } catch (error) {
    if (!(error instanceof TranscriptDetailCursorError)) throw error;
    return { page: { items: [], hasMore: true }, missing: true };
  }
}

function pageQueryFor(input: { readonly agentId: string; readonly beforeTurn?: string; readonly beforeItem?: string; readonly afterTurn?: string; readonly afterItem?: string; readonly pageSize: number }, source: TranscriptRead['source']): PageQuery {
  const decode = (value: string | undefined): string | undefined => {
    const parsed = decodePageCursor(value, input.agentId);
    if (parsed === undefined) return value;
    if (parsed.source !== source) throw new TranscriptSourceChangedError(source);
    return parsed.anchor;
  };
  return { beforeTurn: input.beforeTurn, beforeItem: decode(input.beforeItem), afterTurn: input.afterTurn, afterItem: decode(input.afterItem), pageSize: input.pageSize,
    seekTurn: cursorSeekTurn(input.beforeItem, input.agentId),
    consumedBeforeTurn: cursorBeforeTurn(input.beforeItem, input.agentId),
    refreshedTurn: decodePageCursor(input.beforeItem, input.agentId)?.refreshedTurn,
    orphanTurn: decodePageCursor(input.beforeItem, input.agentId)?.orphanTurn };
}

function paginateTurns(items: readonly TranscriptItem[], query: PageQuery) {
  const cursor = query.beforeItem ?? query.afterItem;
  const consumed = query.afterItem !== undefined || query.afterTurn !== undefined ? undefined : query.consumedBeforeTurn;
  const eligible = consumed === undefined ? undefined : new Set(paginateCanonicalTurns(items, { beforeTurn: consumed, pageSize: Number.MAX_SAFE_INTEGER }).items);
  if (cursor === undefined) return paginateCanonicalTurns(eligible === undefined ? items : items.filter(item => eligible.has(item)), query);
  const index = items.findIndex((item) => historyAnchorMatches(itemKey(item), cursor));
  const pageSize = Math.max(1, Math.min(100, Math.floor(query.pageSize)));
  if (index < 0) {
    const beforeTurn = query.beforeItem?.startsWith('turn:') === true ? query.beforeItem.slice(5) : undefined;
    if (beforeTurn !== undefined && items.every((item) => item.kind !== 'turn' || compareTurnIds(item.turnId, beforeTurn) < 0)) {
      const older = eligible === undefined ? items : items.filter(item => eligible.has(item));
      const start = Math.max(0, older.length - pageSize);
      return { items: older.slice(start), hasMore: start > 0 };
    }
    throw new TranscriptDetailCursorError();
  }
  if (query.afterItem !== undefined) {
    const end = Math.min(items.length, index + pageSize + 1);
    return { items: items.slice(index + 1, end), hasMore: end < items.length };
  }
  const older = items.slice(0, index).filter(item => eligible === undefined || eligible.has(item));
  const start = Math.max(0, older.length - pageSize);
  return { items: older.slice(start), hasMore: start > 0 };
}
