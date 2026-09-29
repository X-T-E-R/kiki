import type { ContextMessage } from '#/agent/contextMemory/types';
import type { GoalSnapshot } from '#/agent/goal/types';
import { renderTodoList, type TodoItem } from '#/session/todo/todoItem';
import { NOTE_SECTIONS, type TodoNotes } from '#/session/todo/todoNotes';

export interface ExternalPromptHint {
  readonly id?: string;
  readonly origin: string;
  readonly text: string;
}

export function externalPromptHints(history: readonly ContextMessage[], delivered: ReadonlySet<string>): ExternalPromptHint[] {
  const lastReply = history.findLastIndex((message) => message.role === 'assistant');
  const hints: ExternalPromptHint[] = [];
  let bytes = 0;
  for (const message of history.slice(lastReply + 1)) {
    const origin = message.origin;
    if (origin === undefined || !(
      origin.kind === 'injection' || origin.kind === 'task' || origin.kind === 'agent_message'
    )) continue;
    if (message.id !== undefined && delivered.has(message.id)) continue;
    const text = message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n').trim();
    if (text.length === 0) continue;
    const size = Buffer.byteLength(text, 'utf8');
    if (hints.length >= 16) {
      hints.push({ origin: 'context_overflow', text: '' });
      break;
    }
    const hintOrigin = origin.kind === 'injection' ? `injection:${origin.variant}` : origin.kind;
    if (bytes + size > 8 * 1024) {
      hints.push({ id: message.id, origin: hintOrigin, text: '' });
      continue;
    }
    bytes += size;
    hints.push({ id: message.id, origin: hintOrigin, text });
  }
  return hints;
}

const STATE_TRUNCATED = '\n[State snapshot truncated]';

function truncateUtf8(text: string, limit: number): string {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  const max = limit - Buffer.byteLength(STATE_TRUNCATED, 'utf8');
  let bytes = 0;
  let prefix = '';
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > max) break;
    prefix += char;
    bytes += size;
  }
  return prefix + STATE_TRUNCATED;
}

export function externalStateHints(input: {
  readonly todos: readonly TodoItem[];
  readonly notes?: TodoNotes;
  readonly goal: GoalSnapshot | null;
}): ExternalPromptHint[] {
  const hints: ExternalPromptHint[] = [];
  let remaining = 8 * 1024;
  const add = (origin: string, text: string, limit = remaining): void => {
    if (text.length === 0) return;
    const rendered = truncateUtf8(text, Math.min(remaining, limit));
    hints.push({ origin, text: rendered });
    remaining -= Buffer.byteLength(rendered, 'utf8');
  };
  const goal = input.goal;
  if (goal !== null && goal.status !== 'complete') {
    add('goal_state', [
      `Goal (${goal.status}): ${goal.objective}`,
      goal.completionCriterion === undefined ? '' : `Completion criterion: ${goal.completionCriterion}`,
    ].filter(Boolean).join('\n'), 1_536);
  }
  const priority = ['goal', 'next', 'open'] as const;
  const noteLines = [
    ...priority.flatMap((key) => input.notes?.[key] ? [truncateUtf8(`${key}: ${input.notes[key]}`, 1_800)] : []),
    ...NOTE_SECTIONS.filter((key) => !priority.includes(key as typeof priority[number]))
      .flatMap((key) => input.notes?.[key] ? [`${key}: ${input.notes[key]}`] : []),
  ];
  if (input.todos.length > 0 || noteLines.length > 0) {
    add('todo_state', [
      noteLines.length > 0 ? `Working notes:\n${noteLines.join('\n')}` : '',
      input.todos.length > 0 ? renderTodoList(input.todos) : '',
    ].filter(Boolean).join('\n\n'));
  }
  return hints;
}
