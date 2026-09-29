import { MAIN_AGENT_ID } from '@kiki/agent-core-v2';
import {
  filterOpsForGrade,
  paginateTurns,
  type TranscriptAttachment,
  type TranscriptOpsCatchupResponse,
  type TranscriptPrompt,
  type TranscriptResponse,
  type TranscriptTask,
} from '@kiki/transcript';

import type { TranscriptService } from '../../services/transcript/transcriptService';

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
