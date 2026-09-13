import type { ContextMessage } from '#/agent/contextMemory/types';

import { TODO_LIST_TOOL_NAME, type TodoItem } from './todoItem';

export const TODO_LIST_REMINDER_VARIANT = 'todo_list_reminder';

const TODO_LIST_REMINDER_TURNS_SINCE_WRITE = 10;
const TODO_LIST_REMINDER_TURNS_BETWEEN_REMINDERS = 10;

interface TodoListReminderInput {
  readonly active: boolean;
  readonly history: readonly ContextMessage[];
  readonly todos: readonly TodoItem[];
}

interface TodoListReminderTurnCounts {
  readonly turnsSinceLastWrite: number;
  readonly turnsSinceLastReminder: number;
}

export function todoListStaleReminder(input: TodoListReminderInput): string | undefined {
  if (!input.active) return undefined;

  const counts = getTodoListReminderTurnCounts(input.history);
  if (
    counts.turnsSinceLastWrite < TODO_LIST_REMINDER_TURNS_SINCE_WRITE ||
    counts.turnsSinceLastReminder < TODO_LIST_REMINDER_TURNS_BETWEEN_REMINDERS
  ) {
    return undefined;
  }

  return renderTodoListReminder(input.todos);
}

function getTodoListReminderTurnCounts(
  history: readonly ContextMessage[],
): TodoListReminderTurnCounts {
  let foundWrite = false;
  let foundReminder = false;
  let turnsSinceLastWrite = 0;
  let turnsSinceLastReminder = 0;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message === undefined) continue;

    if (message.role === 'assistant') {
      if (!foundWrite && hasTodoListWrite(message)) {
        foundWrite = true;
      }
      if (!foundWrite) turnsSinceLastWrite += 1;
      if (!foundReminder) turnsSinceLastReminder += 1;
      continue;
    }

    if (!foundReminder && isTodoListReminder(message)) {
      foundReminder = true;
    }

    if (foundWrite && foundReminder) break;
  }

  return {
    turnsSinceLastWrite,
    turnsSinceLastReminder,
  };
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
