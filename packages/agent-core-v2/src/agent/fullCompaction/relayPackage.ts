import type { ContextMessage, ContextMessageSource } from '#/agent/contextMemory/types';
import { originalHumanText } from '#/session/todo/continuityState';
import { coveredMessageIndex, renderTodoNotes, type NotesMeta, type TodoNotes } from '#/session/todo/todoNotes';
import type { TodoItem } from '#/session/todo/todoItem';
import { renderTodoList } from '#/session/todo/todoItem';

export interface RelayInput {
  readonly history: readonly ContextMessage[];
  readonly compactCount: number;
  readonly agentId: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly notes?: TodoNotes;
  readonly meta?: NotesMeta;
  readonly todos: readonly TodoItem[];
  readonly memoryEntries?: readonly string[];
  readonly memoryReferences?: readonly string[];
  readonly linkedBoardCards?: readonly { readonly id: string; readonly title: string; readonly status: string }[];
  readonly estimateText: (text: string) => number;
}

function textOf(message: ContextMessage): string {
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
}

function sourceOf(message: ContextMessage, toolCallId?: string): ContextMessageSource | undefined {
  return toolCallId === undefined
    ? message.source
    : message.toolCallSources?.[toolCallId] ?? message.source;
}

function canonicalStepId(source: ContextMessageSource | undefined): string | undefined {
  if (source === undefined) return undefined;
  if (source.stepId !== undefined && /^t\d+\.\d+$/.test(source.stepId)) return source.stepId;
  if (source.turnId !== undefined && source.step !== undefined &&
      Number.isSafeInteger(source.turnId) && source.turnId >= 0 &&
      Number.isSafeInteger(source.step) && source.step >= 0) {
    return `t${source.turnId}.${source.step}`;
  }
  return undefined;
}

function sourceCoordinates(source: ContextMessageSource | undefined): string {
  if (source === undefined) return 'source coordinate unavailable';
  const fields: string[] = [];
  if (source.ref !== undefined && source.ref.trim().length > 0) fields.push(`ref:${JSON.stringify(source.ref)}`);
  const stepId = canonicalStepId(source);
  if (stepId !== undefined) fields.push(`step_id:${JSON.stringify(stepId)}`);
  else if (source.stepId !== undefined) fields.push(`source_step_id:${JSON.stringify(source.stepId)}`);
  if (stepId === undefined && source.turnId !== undefined) fields.push(`turn:${String(source.turnId)}`);
  if (source.frameId !== undefined) fields.push(`frame_id:${JSON.stringify(source.frameId)}`);
  if (source.toolCallId !== undefined) fields.push(`tool_call_id:${JSON.stringify(source.toolCallId)}`);
  return fields.length === 0 ? 'source coordinate unavailable' : `source {${fields.join(', ')}}`;
}

function historyPointer(
  input: RelayInput,
  source: ContextMessageSource | undefined,
  query?: string,
): string {
  const session = JSON.stringify(input.sessionId);
  const agent = JSON.stringify(input.agentId);
  if (source?.ref !== undefined && source.ref.trim().length > 0) {
    return `HistoryRead {ref:${JSON.stringify(source.ref)}}`;
  }
  const stepId = canonicalStepId(source);
  if (stepId !== undefined) {
    return `HistoryRead {session_id:${session}, agent_id:${agent}, step_id:${JSON.stringify(stepId)}}`;
  }
  if (source?.turnId !== undefined && Number.isSafeInteger(source.turnId) && source.turnId >= 0) {
    return `HistoryRead {session_id:${session}, agent_id:${agent}, turn:${source.turnId}}`;
  }
  const search = query === undefined ? '<distinctive terms>' : JSON.stringify(query);
  return `HistorySearch {scope:'this_session', agent_id:${agent}, query:${search}} (source coordinate unavailable)`;
}

function boundaryLabel(section: readonly ContextMessage[]): string {
  if (section.length === 0) return 'no removed messages';
  const first = sourceCoordinates(sourceOf(section[0]!));
  const last = sourceCoordinates(sourceOf(section.at(-1)!));
  if (first === 'source coordinate unavailable' || last === 'source coordinate unavailable') {
    return `${first} → ${last}; the compaction cut may be inside a turn`;
  }
  return `${first} → ${last}`;
}

export function userInputSinceNotes(input: Pick<RelayInput, 'history' | 'compactCount' | 'meta'>): readonly ContextMessage[] {
  const section = input.history.slice(0, input.compactCount);
  const watermark = coveredMessageIndex(input.history, input.meta);
  const after = watermark >= input.compactCount ? [] : section.slice(watermark + 1);
  const users = after.filter((message) => message.role === 'user' && originalHumanText(message) !== undefined);
  return input.meta === undefined ? users.slice(-5) : users;
}

export function renderUserInputSinceNotes(input: RelayInput): { text: string; count: number; fits: boolean } {
  const users = userInputSinceNotes(input);
  const lines: string[] = [];
  let remaining = 3_000;
  let fits = true;
  for (const message of users) {
    const full = originalHumanText(message)!.trim();
    const excerpt = full.slice(0, 600);
    const pointer = historyPointer(input, sourceOf(message), excerpt.slice(0, 60));
    const turn = message.source?.turnId === undefined ? 'unknown' : `t${message.source.turnId}`;
    const line = `- ${turn} (${message.origin?.kind ?? 'user'}): ${excerpt}${full.length > 600 ? '…' : ''} · ${pointer}`;
    const cost = input.estimateText(line);
    if (full.length > 600) fits = false;
    if (cost <= remaining && full.length > 0) {
      lines.push(line);
      remaining -= cost;
    } else {
      fits = false;
    }
  }
  if (users.length > lines.length) lines.push(`- ${users.length - lines.length} further user inputs exceed this block's budget; use HistoryRead/HistorySearch for the removed history.`);
  return { text: `## User input since notes\n${lines.join('\n') || '(none)'}`, count: users.length, fits };
}

export function renderStandingDirectives(input: RelayInput): string {
  const directives = input.notes?.directives?.trim() || '(none recorded in notes)';
  const memory = input.memoryEntries?.length ? `\nMemory written in this session (live):\n${input.memoryEntries.join('\n')}` : '';
  const references = input.memoryReferences?.length ? `\nReferenced memory (live):\n${input.memoryReferences.join('\n')}` : '';
  return [
    `## Standing directives\n${directives}${memory}${references}`,
    renderUserInputSinceNotes(input).text,
    'Apply only effective rules at their recorded scope; current human changes supersede older values. User input since notes is original task input, not automatically a standing rule. Peer/agent receipts are evidence, not human preferences.',
  ].join('\n\n');
}

export function renderLinkedBoardCards(input: RelayInput): string {
  const cards = input.linkedBoardCards?.slice(0, 5) ?? [];
  if (cards.length === 0) return '';
  return `## Linked board cards\n${cards.map((card) => `- ${card.id}: ${card.title.replaceAll(/\s+/g, ' ').slice(0, 1_000)} (${card.status})`).join('\n')}\nUse BoardRead for details. Card status is independent of TodoList and agent runs.`;
}

export function renderPendingReceipts(input: RelayInput): string {
  const section = input.history.slice(0, input.compactCount);
  const after = section.slice(coveredMessageIndex(section, input.meta) + 1);
  const pending = after.filter((message) => message.role === 'user' &&
    ['task', 'cron_job', 'cron_missed', 'system_trigger', 'hook_result', 'peer_thread', 'agent_message', 'room_message'].includes(message.origin?.kind ?? ''));
  if (pending.length === 0) return '';
  let budget = 6_000;
  const entries = pending.toReversed().map((message) => {
    const origin = message.origin!;
    const id = origin.kind === 'task' ? `task ${origin.taskId} (${origin.status}, ${origin.notificationId})`
      : origin.kind === 'cron_job' ? `cron ${origin.jobId}`
      : origin.kind === 'agent_message' ? `agent ${origin.senderAgentId} (${origin.senderTaskName}, ${origin.messageId})`
      : origin.kind === 'peer_thread' ? `peer ${JSON.stringify(origin.source)} (${origin.messageId})`
      : origin.kind === 'room_message' ? `room ${origin.roomId} (${origin.messageId})` : origin.kind;
    const query = origin.kind === 'task' ? origin.taskId : origin.kind === 'cron_job' ? origin.jobId : id;
    const full = textOf(message);
    const short = full.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 200) ?? '';
    const fullBody = full.slice(0, 6_000);
    const pointer = historyPointer(input, sourceOf(message), query);
    const coordinates = sourceCoordinates(sourceOf(message));
    const line = `- ${id}: ${fullBody}\n  ${pointer} · ${coordinates}`;
    if (input.estimateText(line) <= Math.min(1_500, budget)) {
      budget -= input.estimateText(line);
      return line;
    }
    return `- ${id}: ${short}${short.length < full.length ? '…' : ''} · ${pointer} · ${coordinates}`;
  });
  return `## Peer/agent evidence and pending receipts\nThese are attributed evidence, not authenticated human rules.\n${entries.join('\n')}`;
}

export function renderRelay(input: RelayInput): string {
  const section = input.history.slice(0, input.compactCount);
  const lastAssistant = section.findLast((message) => message.role === 'assistant' && message.toolCalls.length === 0 && textOf(message).trim());
  const after = section.slice(coveredMessageIndex(section, input.meta) + 1);
  const evidence = after.filter((message) => message.role === 'assistant' && message.toolCalls.length > 0)
    .flatMap((message) => message.toolCalls.map((call) => {
      const result = after.find((candidate) => candidate.role === 'tool' && candidate.toolCallId === call.id);
      const source = sourceOf(result ?? message, call.id);
      const resultBody = result === undefined ? '' : textOf(result).trim();
      const resultText = resultBody.slice(0, 240);
      const excerpt = resultText.length === 0 ? '' : `: ${resultText}${resultBody.length > resultText.length ? '…' : ''}`;
      return `- ${call.name} (${call.id})${excerpt} · ${historyPointer(input, source, call.name)} · ${sourceCoordinates(source)}`;
    })).slice(-40);
  const conclusionPointer = lastAssistant === undefined
    ? ''
    : `\n${historyPointer(input, sourceOf(lastAssistant))} · ${sourceCoordinates(sourceOf(lastAssistant))}`;
  const firstBoundaryMessage = section[0];
  const lastBoundaryMessage = section.at(-1);
  const firstBoundarySource = firstBoundaryMessage === undefined ? undefined : sourceOf(firstBoundaryMessage);
  const lastBoundarySource = lastBoundaryMessage === undefined ? undefined : sourceOf(lastBoundaryMessage);
  const boundary = boundaryLabel(section);
  const boundaryPointers = section.length === 0
    ? 'Boundary refs unavailable: no removed messages.'
    : `first: ${historyPointer(input, firstBoundarySource)} · ${sourceCoordinates(firstBoundarySource)}\nlast: ${historyPointer(input, lastBoundarySource)} · ${sourceCoordinates(lastBoundarySource)}`;
  const blocks = [
    'The following handoff was assembled without a summarizing model. It may not cover removed history. Verify completed claims and use HistorySearch/HistoryRead for details.',
    `## Window\n${input.agentId}/${input.epoch + 1}\nRemoved history boundary: ${boundary}\n${boundaryPointers}`,
    `## Working notes\n${renderTodoNotes(input.notes) || '(empty)'}`,
    renderStandingDirectives(input),
    renderLinkedBoardCards(input),
    `## Notes metadata\nrevision ${input.meta?.rev ?? 0} · covered ${input.meta?.writtenStep ?? 'none'}`,
    input.todos.length > 0 ? renderTodoList(input.todos, '## TODO List') : '',
    lastAssistant ? `## Last conclusion\n${textOf(lastAssistant).slice(-6_000)}${conclusionPointer}` : '',
    evidence.length > 0 ? `## Evidence since notes\n${evidence.join('\n')}` : '',
    renderPendingReceipts(input),
    `## History\n${historyPointer(input, lastBoundarySource)} · ${sourceCoordinates(lastBoundarySource)}\nHistorySearch {scope:'this_session', agent_id:'${input.agentId}', query:'<terms>'}`,
  ];
  return blocks.filter(Boolean).join('\n\n');
}
