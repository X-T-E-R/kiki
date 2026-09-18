import { MAIN_AGENT_ID } from '@kiki/agent-core-v2';
import {
  filterOpsForGrade,
  paginateTurns,
  type TranscriptOpsCatchupResponse,
  type TranscriptResponse,
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
      return {
        session_id: sessionId, agent_id: input.agentId,
        items: page.items, has_more: page.hasMore, tool_call_count: cold.toolCallCount,
        tasks: cold.tasks, interactions: cold.interactions, attachments: cold.attachments,
        todos: cold.todos, prompts: cold.prompts, meta: cold.meta, agents: store.agents(),
        pending_interactions: transcript.listPendingInteractions(),
        cursor: transcriptService.getTranscriptCursor(sessionId, input.agentId),
        coverage: coverageForItems(page.items, page.hasMore),
      } as unknown as TranscriptResponse;
    }
    const snapshot = transcript.snapshot();
    const page = paginateTurns(transcript.getItems(), pageQuery);
    return {
      session_id: sessionId, agent_id: input.agentId,
      items: page.items, has_more: page.hasMore, tool_call_count: snapshot.toolCallCount,
      tasks: [...transcript.getTasks().values()],
      interactions: [...transcript.getInteractions().values()],
      attachments: [...transcript.getAttachments().values()],
      todos: [...transcript.getTodos().values()],
      prompts: [...transcript.getPrompts().values()],
      meta: transcript.getMeta(), agents: store.agents(),
      pending_interactions: transcript.listPendingInteractions(),
      cursor: transcriptService.getTranscriptCursor(sessionId, input.agentId),
      coverage: coverageForItems(page.items, page.hasMore),
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
    pending_interactions: [], cursor: undefined, coverage: coverageForItems(page.items, page.hasMore),
  } as unknown as TranscriptResponse;
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

function coverageForItems(items: readonly { readonly kind: string; readonly turnId?: string }[], hasMoreOlder: boolean) {
  if (!hasMoreOlder) return { kind: 'full' as const, hasMoreOlder: false as const };
  const turns = items.filter((item) => item.kind === 'turn');
  return { kind: 'tail' as const, fromTurnId: turns[0]?.turnId, throughTurnId: turns.at(-1)?.turnId, hasMoreOlder };
}
