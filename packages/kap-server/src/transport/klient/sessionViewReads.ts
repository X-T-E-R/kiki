import { MAIN_AGENT_ID } from '@kiki/agent-core-v2';
import {
  filterOpsForGrade,
  paginateTurns,
  type TranscriptAttachment,
  type TranscriptDetailListResponse,
  type TranscriptOpsCatchupResponse,
  type TranscriptPrompt,
  type TranscriptResponse,
  type TranscriptTask,
} from '@kiki/transcript';

import type { TranscriptService } from '../../services/transcript/transcriptService';

export class TranscriptDetailCursorError extends Error {
  constructor() {
    super('invalid transcript detail cursor');
    this.name = 'TranscriptDetailCursorError';
  }
}

interface TranscriptDetailCursor {
  readonly v: 1;
  readonly agentId: string;
  readonly kind: 'task' | 'attachment' | 'prompt';
  readonly after: string;
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
      parsed.v !== 1 ||
      parsed.agentId !== agentId ||
      parsed.kind !== kind ||
      typeof parsed.after !== 'string' ||
      parsed.after.length === 0
    ) throw new Error('invalid cursor');
    return parsed as TranscriptDetailCursor;
  } catch {
    throw new TranscriptDetailCursorError();
  }
}

export async function readSessionViewTranscriptPage(
  transcriptService: TranscriptService,
  sessionId: string,
  input: {
    readonly agentId: string;
    readonly beforeTurn?: string;
    readonly afterTurn?: string;
    readonly pageSize?: number;
    readonly signal?: AbortSignal;
  },
): Promise<TranscriptResponse | undefined> {
  const pageQuery = { beforeTurn: input.beforeTurn, afterTurn: input.afterTurn, pageSize: input.pageSize ?? 20 };
  const store = transcriptService.forSessionLive(sessionId);
  if (store !== undefined) {
    await transcriptService.whenReady(sessionId);
    await transcriptService.ensureAgentHistory(sessionId, input.agentId);
    const liveVerified = await transcriptService.verifyTranscriptLiveCoverage(sessionId, input.agentId);
    const transcript = store.ensureAgent(input.agentId);
    if (transcript.hasMoreOlder && input.beforeTurn !== undefined) {
      const cold = await transcriptService.readColdSnapshot(
        sessionId,
        input.agentId,
        undefined,
        input.signal,
      );
      if (cold === undefined) return undefined;
      const page = paginateTurns(cold.items, pageQuery);
      const verified = liveVerified && transcriptService.isTranscriptLiveCoverageVerified(sessionId, input.agentId) &&
        cold.toolCallCountKnown === true;
      return {
        session_id: sessionId, agent_id: input.agentId,
        items: page.items, has_more: page.hasMore, tool_call_count: verified ? cold.toolCallCount : undefined,
        tasks: cold.tasks, interactions: cold.interactions, attachments: cold.attachments,
        todos: cold.todos, prompts: cold.prompts, meta: cold.meta, agents: store.agents(),
        pending_interactions: transcript.listPendingInteractions(),
        cursor: transcriptService.getTranscriptCursor(sessionId, input.agentId),
        coverage: coverageForItems(page.items, page.hasMore, verified),
      } as unknown as TranscriptResponse;
    }
    const snapshot = transcript.snapshot();
    const page = paginateTurns(transcript.getItems(), pageQuery);
    const verified = liveVerified && transcriptService.isTranscriptLiveCoverageVerified(sessionId, input.agentId) &&
      snapshot.toolCallCountKnown === true;
    return {
      session_id: sessionId, agent_id: input.agentId,
      items: page.items, has_more: page.hasMore, tool_call_count: verified ? snapshot.toolCallCount : undefined,
      tasks: [...transcript.getTasks().values()],
      interactions: [...transcript.getInteractions().values()],
      attachments: [...transcript.getAttachments().values()],
      todos: [...transcript.getTodos().values()],
      prompts: [...transcript.getPrompts().values()],
      meta: transcript.getMeta(), agents: store.agents(),
      pending_interactions: transcript.listPendingInteractions(),
      cursor: transcriptService.getTranscriptCursor(sessionId, input.agentId),
      coverage: coverageForItems(page.items, page.hasMore, verified),
    } as unknown as TranscriptResponse;
  }
  const snapshot = await transcriptService.readColdSnapshot(sessionId, input.agentId, undefined, input.signal);
  if (snapshot === undefined) return undefined;
  const page = paginateTurns(snapshot.items, pageQuery);
  const roster = (await transcriptService.readColdRoster(sessionId)) ?? [];
  if (!roster.some((descriptor) => descriptor.agentId === input.agentId) &&
      (snapshot.items.length > 0 || snapshot.tasks.length > 0 || input.agentId === MAIN_AGENT_ID)) {
    roster.push({ agentId: input.agentId, type: input.agentId === MAIN_AGENT_ID ? 'main' : 'sub' });
  }
  return {
    session_id: sessionId, agent_id: input.agentId,
    items: page.items, has_more: page.hasMore, tool_call_count: snapshot.toolCallCount,
    tasks: snapshot.tasks, interactions: snapshot.interactions, attachments: snapshot.attachments,
    todos: snapshot.todos, prompts: snapshot.prompts, meta: snapshot.meta, agents: roster,
    pending_interactions: [], cursor: undefined, coverage: coverageForItems(page.items, page.hasMore, snapshot.toolCallCountKnown === true),
  } as unknown as TranscriptResponse;
}

export async function readSessionViewTranscriptDetail(
  transcriptService: TranscriptService,
  sessionId: string,
  input: {
    readonly agentId: string;
    readonly kind: 'task' | 'attachment' | 'prompt';
    readonly id: string;
    readonly signal?: AbortSignal;
  },
): Promise<
  | {
      readonly session_id: string;
      readonly agent_id: string;
      readonly kind: 'task';
      readonly task: TranscriptTask;
    }
  | {
      readonly session_id: string;
      readonly agent_id: string;
      readonly kind: 'attachment';
      readonly attachment: TranscriptAttachment;
    }
  | {
      readonly session_id: string;
      readonly agent_id: string;
      readonly kind: 'prompt';
      readonly prompt: TranscriptPrompt;
    }
  | undefined
> {
  const store = transcriptService.forSessionLive(sessionId);
  let task: TranscriptTask | undefined;
  let attachment: TranscriptAttachment | undefined;
  let prompt: TranscriptPrompt | undefined;
  if (store !== undefined) {
    await transcriptService.whenReady(sessionId);
    await transcriptService.ensureAgentHistory(sessionId, input.agentId);
    const transcript = store.ensureAgent(input.agentId);
    if (input.kind === 'task') task = transcript.getTask(input.id);
    else if (input.kind === 'attachment') attachment = transcript.getAttachment(input.id);
    else prompt = transcript.getPrompt(input.id);
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
      : { session_id: sessionId, agent_id: input.agentId, kind: 'task', task };
  }
  if (input.kind === 'attachment') {
    return attachment === undefined
      ? undefined
      : { session_id: sessionId, agent_id: input.agentId, kind: 'attachment', attachment };
  }
  return prompt === undefined
    ? undefined
    : { session_id: sessionId, agent_id: input.agentId, kind: 'prompt', prompt };
}

export async function readSessionViewTranscriptDetails(
  transcriptService: TranscriptService,
  sessionId: string,
  input: {
    readonly agentId: string;
    readonly kind: 'task' | 'attachment' | 'prompt';
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  },
): Promise<TranscriptDetailListResponse | undefined> {
  const store = transcriptService.forSessionLive(sessionId);
  let tasks: readonly TranscriptTask[];
  let attachments: readonly TranscriptAttachment[];
  let prompts: readonly TranscriptPrompt[];
  if (store !== undefined) {
    await transcriptService.whenReady(sessionId);
    await transcriptService.ensureAgentHistory(sessionId, input.agentId);
    const transcript = store.ensureAgent(input.agentId);
    tasks = [...transcript.getTasks().values()];
    attachments = [...transcript.getAttachments().values()];
    prompts = [...transcript.getPrompts().values()];
  } else {
    const snapshot = await transcriptService.readColdSnapshot(sessionId, input.agentId, undefined, input.signal);
    if (snapshot === undefined) return undefined;
    tasks = snapshot.tasks;
    attachments = snapshot.attachments;
    prompts = snapshot.prompts;
  }
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  const cursor = input.cursor === undefined
    ? undefined
    : decodeTranscriptDetailCursor(input.cursor, input.agentId, input.kind);
  if (input.kind === 'task') {
    const ordered = tasks.toSorted((left, right) => left.taskId.localeCompare(right.taskId));
    return detailListResponse(sessionId, input.agentId, input.kind, ordered, limit, cursor?.after);
  }
  if (input.kind === 'attachment') {
    const ordered = attachments.toSorted((left, right) => left.attachmentId.localeCompare(right.attachmentId));
    return detailListResponse(sessionId, input.agentId, input.kind, ordered, limit, cursor?.after);
  }
  const ordered = prompts.toSorted((left, right) => left.promptId.localeCompare(right.promptId));
  return detailListResponse(sessionId, input.agentId, input.kind, ordered, limit, cursor?.after);
}

function detailListResponse<T extends TranscriptTask | TranscriptAttachment | TranscriptPrompt>(
  sessionId: string,
  agentId: string,
  kind: 'task' | 'attachment' | 'prompt',
  ordered: readonly T[],
  limit: number,
  after: string | undefined,
): TranscriptDetailListResponse {
  const start = after === undefined
    ? 0
    : ordered.findIndex((entry) => detailEntityId(kind, entry) > after);
  const offset = start < 0 ? ordered.length : start;
  const items = ordered.slice(offset, offset + limit);
  const hasMore = offset + items.length < ordered.length;
  const nextCursor = hasMore && items.at(-1) !== undefined
    ? encodeTranscriptDetailCursor({
        v: 1,
        agentId,
        kind,
        after: detailEntityId(kind, items.at(-1)!),
      })
    : undefined;
  return {
    session_id: sessionId,
    agent_id: agentId,
    kind,
    items,
    has_more: hasMore,
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
  } as TranscriptDetailListResponse;
}

function detailEntityId(
  kind: 'task' | 'attachment' | 'prompt',
  entity: TranscriptTask | TranscriptAttachment | TranscriptPrompt,
): string {
  if (kind === 'task') return (entity as TranscriptTask).taskId;
  if (kind === 'attachment') return (entity as TranscriptAttachment).attachmentId;
  return (entity as TranscriptPrompt).promptId;
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
  return {
    session_id: sessionId, agent_id: input.agentId, epoch: catchup.epoch,
    batches: catchup.batches.map((batch) => ({ ...batch, ops: filterOpsForGrade(grade, batch.ops) })).filter((batch) => batch.ops.length > 0),
    through_seq: catchup.throughSeq, complete: catchup.complete,
  } as unknown as TranscriptOpsCatchupResponse;
}

function coverageForItems(items: readonly { readonly kind: string; readonly turnId?: string }[], hasMoreOlder: boolean, verified: boolean) {
  if (!verified) return { kind: 'unknown' as const, hasMoreOlder: true as const };
  if (!hasMoreOlder) return { kind: 'full' as const, hasMoreOlder: false as const };
  const turns = items.filter((item) => item.kind === 'turn');
  return { kind: 'tail' as const, fromTurnId: turns[0]?.turnId, throughTurnId: turns.at(-1)?.turnId, hasMoreOlder };
}
