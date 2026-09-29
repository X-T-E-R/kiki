import type { ContextMessage } from '#/agent/contextMemory/types';
import { coveredMessageIndex } from './freshEligibility';
import type { NotesMeta, TodoNotes } from '#/session/todo/todoNotes';
import { renderTodoNotes } from '#/session/todo/todoNotes';
import type { TodoItem } from '#/session/todo/todoItem';
import { renderTodoList } from '#/session/todo/todoItem';

export interface RelayInput {
  readonly history: readonly ContextMessage[];
  readonly compactCount: number;
  readonly agentId: string;
  readonly sessionId: string;
  readonly epoch: number;
  readonly turnId?: number;
  readonly notes?: TodoNotes;
  readonly meta?: NotesMeta;
  readonly todos: readonly TodoItem[];
  readonly memoryEntries?: readonly string[];
  readonly estimateText: (text: string) => number;
}

function textOf(message: ContextMessage): string {
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
}

function pointer(input: RelayInput, query?: string): string {
  const session = JSON.stringify(input.sessionId);
  const agent = JSON.stringify(input.agentId);
  const end = input.turnId;
  const range = end === undefined ? 'old window turns' : `old window t0–t${end}`;
  const search = query === undefined ? '' : `HistorySearch {scope:'this_session', agent_id:${agent}, query:${JSON.stringify(query)}} → `;
  const turn = query === undefined ? end ?? 0 : `<matching hit.turn in ${range}>`;
  return `${search}HistoryRead {session_id:${session}, agent_id:${agent}, turn:${turn}} (${range})`;
}

export function renderPendingReceipts(input: RelayInput): string {
  const section = input.history.slice(0, input.compactCount);
  const after = section.slice(coveredMessageIndex(section, input.meta) + 1);
  const pending = after.filter((message) => message.role === 'user' &&
    ['task', 'cron_job', 'cron_missed', 'system_trigger', 'hook_result'].includes(message.origin?.kind ?? ''));
  if (pending.length === 0) return '';
  let budget = 6_000;
  const entries = pending.reverse().map((message) => {
    const origin = message.origin!;
    const id = origin.kind === 'task' ? `task ${origin.taskId} (${origin.status}, ${origin.notificationId})`
      : origin.kind === 'cron_job' ? `cron ${origin.jobId}` : origin.kind;
    const query = origin.kind === 'task' ? origin.taskId : origin.kind === 'cron_job' ? origin.jobId : id;
    const full = textOf(message);
    const short = full.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 200) ?? '';
    const fullBody = full.slice(0, 6_000);
    const line = `- ${id}: ${fullBody}\n  ${pointer(input, query)}`;
    if (input.estimateText(line) <= Math.min(1_500, budget)) {
      budget -= input.estimateText(line);
      return line;
    }
    return `- ${id}: ${short}${short.length < full.length ? '…' : ''} · ${pointer(input, query)}`;
  });
  return `## Pending receipts\n${entries.join('\n')}`;
}

export function renderRelay(input: RelayInput): string {
  const section = input.history.slice(0, input.compactCount);
  const lastAssistant = section.findLast((message) => message.role === 'assistant' && message.toolCalls.length === 0 && textOf(message).trim());
  const after = section.slice(coveredMessageIndex(section, input.meta) + 1);
  const evidence = after.filter((message) => message.role === 'assistant' && message.toolCalls.length > 0)
    .flatMap((message) => message.toolCalls.map((call) => `- ${call.name} (${call.id}) · ${pointer(input)}`)).slice(-40);
  const blocks = [
    'The following handoff was assembled without a summarizing model. It may not cover removed history. Verify completed claims and use HistorySearch/HistoryRead for details.',
    `## Window\n${input.agentId}/${input.epoch + 1}`,
    `## Working notes\n${renderTodoNotes(input.notes) || '(empty)'}`,
    input.memoryEntries?.length ? `## Relevant frozen memory (read-only)\n${input.memoryEntries.join('\n')}` : '',
    `## Notes metadata\nrevision ${input.meta?.rev ?? 0} · covered ${input.meta?.writtenStep ?? 'none'}`,
    input.todos.length ? renderTodoList(input.todos, '## TODO List') : '',
    lastAssistant ? `## Last conclusion\n${textOf(lastAssistant).slice(-6_000)}` : '',
    evidence.length ? `## Evidence since notes\n${evidence.join('\n')}` : '',
    renderPendingReceipts(input),
    `## History\nIf HistoryRead or HistorySearch is not loaded, call SelectTools with ["HistoryRead", "HistorySearch"] first.\n${pointer(input)}\nHistorySearch {scope:'this_session', agent_id:'${input.agentId}', query:'<terms>'}`,
  ];
  return blocks.filter(Boolean).join('\n\n');
}
