import type { ContextMessage } from '#/agent/contextMemory/types';
import type { GoalSnapshot } from '#/agent/goal/types';
import { renderTodoList, type TodoItem } from '#/session/todo/todoItem';
import { renderTodoNotes, type TodoNotes } from '#/session/todo/todoNotes';

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

export function externalStateHints(input: {
  readonly todos: readonly TodoItem[];
  readonly notes?: TodoNotes;
  readonly goal: GoalSnapshot | null;
}): ExternalPromptHint[] {
  const hints: ExternalPromptHint[] = [];
  let remaining = 8 * 1024;
  const add = (origin: string, text: string): void => {
    if (text.length === 0) return;
    if (remaining < 128) {
      hints.push({ origin, text: '' });
      return;
    }
    const bytes = Buffer.from(text, 'utf8');
    const suffix = '\n[State snapshot truncated]';
    const rendered = bytes.length <= remaining ? text
      : `${bytes.subarray(0, remaining - Buffer.byteLength(suffix)).toString('utf8')}${suffix}`;
    hints.push({ origin, text: rendered });
    remaining -= Buffer.byteLength(rendered, 'utf8');
  };
  const goal = input.goal;
  if (goal !== null && goal.status !== 'complete') {
    add('goal_state', [
      `Goal (${goal.status}): ${goal.objective}`,
      goal.completionCriterion === undefined ? '' : `Completion criterion: ${goal.completionCriterion}`,
    ].filter(Boolean).join('\n'));
  }
  const notes = renderTodoNotes(input.notes);
  if (input.todos.length > 0 || notes.length > 0) {
    add('todo_state', [
      input.todos.length > 0 ? renderTodoList(input.todos) : '',
      notes.length > 0 ? `Working notes:\n${notes}` : '',
    ].filter(Boolean).join('\n\n'));
  }
  return hints;
}
