import type { ContextMessage } from '#/agent/contextMemory/types';

import { TODO_LIST_TOOL_NAME, type TodoItem } from './todoItem';
import { coveredMessageIndex } from '#/agent/fullCompaction/freshEligibility';
import type { NotesMeta } from './todoNotes';

export const TODO_LIST_REMINDER_VARIANT = 'todo_list_reminder';

const TODO_LIST_REMINDER_TURNS_SINCE_WRITE = 10;
const TODO_LIST_REMINDER_TURNS_BETWEEN_REMINDERS = 10;

interface TodoListReminderInput {
  readonly active: boolean;
  readonly history: readonly ContextMessage[];
  readonly todos: readonly TodoItem[];
  readonly notesEnabled?: boolean;
  readonly notesMeta?: NotesMeta;
  readonly threshold?: number;
  readonly currentTokens?: number;
  readonly epoch?: number;
  readonly remindedEpoch?: number;
  readonly estimateMessage?: (message: ContextMessage) => number;
  readonly onNearWindow?: (epoch: number) => void;
}

interface TodoListReminderTurnCounts {
  readonly turnsSinceLastWrite: number;
  readonly turnsSinceLastReminder: number;
}

export class TodoListReminderTracker {
  private scannedLength = 0;
  private lastScannedMessage: ContextMessage | undefined;
  private counts: TodoListReminderTurnCounts = {
    turnsSinceLastWrite: 0,
    turnsSinceLastReminder: 0,
  };

  reminder(input: TodoListReminderInput): string | undefined {
    if (!input.active) return undefined;

    this.scan(input.history);
    const todoStale = this.counts.turnsSinceLastWrite >= TODO_LIST_REMINDER_TURNS_SINCE_WRITE &&
      this.counts.turnsSinceLastReminder >= TODO_LIST_REMINDER_TURNS_BETWEEN_REMINDERS;
    if (!input.notesEnabled) return todoStale ? renderTodoListReminder(input.todos) : undefined;
    const after = input.history.slice(coveredMessageIndex(input.history, input.notesMeta) + 1);
    const assistantCount = after.filter((message) => message.role === 'assistant').length;
    const newTokens = input.estimateMessage === undefined ? 0 : after.reduce((sum, message) => sum + input.estimateMessage!(message), 0);
    const threshold = input.threshold ?? 0;
    const near = threshold > 0 && (input.currentTokens ?? 0) >= threshold * 0.85 &&
      input.epoch !== undefined && input.remindedEpoch !== input.epoch;
    const stale = assistantCount >= 10 && newTokens >= Math.max(8_000, threshold * 0.1);
    if (!near && (!stale || this.counts.turnsSinceLastReminder < 10) && !todoStale) return undefined;
    if (near && input.epoch !== undefined) input.onNearWindow?.(input.epoch);
    const prefix = near ? `The context window will be renewed soon (about ${Math.max(0, Math.round(threshold - (input.currentTokens ?? 0)))} tokens left). Bring TodoList notes up to date: decisions, rejected options, evidence, and the exact next step. Do not mention this reminder to the user.`
      : stale && this.counts.turnsSinceLastReminder >= 10 ? `Working notes were last updated at ${input.notesMeta?.writtenStep ?? 'none'} and ~${newTokens} tokens of new work followed. Update TodoList notes when convenient. Do not mention this reminder to the user.` : '';
    return [prefix, todoStale ? renderTodoListReminder(input.todos).replace('clear or rewrite it if stale', 'rewrite items if stale') : ''].filter(Boolean).join('\n\n');
  }

  private scan(history: readonly ContextMessage[]): void {
    if (
      history.length < this.scannedLength ||
      (this.scannedLength > 0 && history[this.scannedLength - 1] !== this.lastScannedMessage)
    ) {
      this.scannedLength = 0;
      this.lastScannedMessage = undefined;
      this.counts = { turnsSinceLastWrite: 0, turnsSinceLastReminder: 0 };
    }

    for (let index = this.scannedLength; index < history.length; index += 1) {
      const message = history[index];
      if (message === undefined) continue;
      if (message.role === 'assistant') {
        this.counts = {
          turnsSinceLastWrite: hasTodoListWrite(message)
            ? 0
            : this.counts.turnsSinceLastWrite + 1,
          turnsSinceLastReminder: this.counts.turnsSinceLastReminder + 1,
        };
      } else if (isTodoListReminder(message)) {
        this.counts = { ...this.counts, turnsSinceLastReminder: 0 };
      }
    }
    this.scannedLength = history.length;
    this.lastScannedMessage = history.at(-1);
  }
}

export function todoListStaleReminder(input: TodoListReminderInput): string | undefined {
  return new TodoListReminderTracker().reminder(input);
}

function hasTodoListWrite(message: ContextMessage): boolean {
  return message.toolCalls.some((toolCall) => {
    if (toolCall.name !== TODO_LIST_TOOL_NAME) return false;
    if (typeof toolCall.arguments !== 'string') return false;

    try {
      const args = JSON.parse(toolCall.arguments) as { todos?: unknown };
      return Array.isArray(args.todos);
    } catch {
      return false;
    }
  });
}

function isTodoListReminder(message: ContextMessage): boolean {
  return (
    message.origin?.kind === 'injection' &&
    message.origin.variant === TODO_LIST_REMINDER_VARIANT
  );
}

function renderTodoListReminder(todos: readonly TodoItem[]): string {
  let message =
    'TodoList has not been updated recently. If it still helps, update it; clear or rewrite it if stale. Ignore this reminder when it is not relevant. Do not mention this reminder to the user.';

  const items = renderTodoItems(todos);
  if (items.length > 0) {
    message += `\n\nCurrent todo list:\n${items}`;
  }

  return message;
}

function renderTodoItems(todos: readonly TodoItem[]): string {
  return todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.title}`).join('\n');
}
