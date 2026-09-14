import { describe, expect, it, vi } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { type TodoItem } from '#/session/todo/todoItem';
import { TodoListReminderTracker, todoListStaleReminder } from '#/session/todo/todoListReminder';

function assistantMessage(): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'working' }],
    toolCalls: [],
  };
}

function todoListWrite(todos: readonly TodoItem[]): ContextMessage {
  return {
    role: 'assistant',
    content: [],
    toolCalls: [
      {
        type: 'function',
        id: 'call_todo_write',
        name: 'TodoList',
        arguments: JSON.stringify({ todos }),
      },
    ],
  };
}

function todoListQuery(): ContextMessage {
  return {
    role: 'assistant',
    content: [],
    toolCalls: [
      {
        type: 'function',
        id: 'call_todo_query',
        name: 'TodoList',
        arguments: JSON.stringify({}),
      },
    ],
  };
}

function priorTodoReminder(): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder>\nPrior todo reminder\n</system-reminder>' }],
    toolCalls: [],
    origin: { kind: 'injection', variant: 'todo_list_reminder' },
  };
}

describe('todoListStaleReminder', () => {
  it('does not remind for an empty history', () => {
    expect(todoListStaleReminder({ history: [], todos: [], active: true })).toBeUndefined();
  });

  it('skips reminder injection when TodoList is not active', async () => {
    const history = Array.from({ length: 10 }, () => assistantMessage());
    const result = todoListStaleReminder({
      history,
      todos: [{ title: 'Investigate todo reminder', status: 'in_progress' }],
      active: false,
    });

    expect(result).toBeUndefined();
  });

  it('injects a reminder after enough assistant turns since the last TodoList write', async () => {
    const todos: TodoItem[] = [
      { title: 'Read current TodoList implementation', status: 'in_progress' },
      { title: 'Add reminder injector tests', status: 'pending' },
    ];
    const history = [todoListWrite(todos), ...Array.from({ length: 10 }, () => assistantMessage())];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result).toContain('Current todo list:');
    expect(result).toContain('1. [in_progress] Read current TodoList implementation');
    expect(result).toContain('2. [pending] Add reminder injector tests');
  });

  it('does not inject before the assistant-turn threshold', async () => {
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    const history = [todoListWrite(todos), ...Array.from({ length: 9 }, () => assistantMessage())];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result).toBeUndefined();
  });

  it('does not inject another reminder before the reminder spacing threshold', async () => {
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    const history = [
      todoListWrite(todos),
      ...Array.from({ length: 10 }, () => assistantMessage()),
      priorTodoReminder(),
      ...Array.from({ length: 9 }, () => assistantMessage()),
    ];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result).toBeUndefined();
  });

  it('does not treat TodoList query mode as a write', async () => {
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    const history = [
      todoListWrite(todos),
      ...Array.from({ length: 5 }, () => assistantMessage()),
      todoListQuery(),
      ...Array.from({ length: 4 }, () => assistantMessage()),
    ];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result).toBeDefined();
  });

  it('parses only appended TodoList calls after the initial scan', () => {
    const tracker = new TodoListReminderTracker();
    const parse = vi.spyOn(JSON, 'parse');
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    const history = [todoListWrite(todos), ...Array.from({ length: 9 }, () => assistantMessage())];

    expect(tracker.reminder({ history, todos, active: true })).toBeUndefined();
    expect(parse).toHaveBeenCalledTimes(1);
    const appended = [...history, assistantMessage()];
    expect(tracker.reminder({ history: appended, todos, active: true })).toBeDefined();
    expect(parse).toHaveBeenCalledTimes(1);
    expect(tracker.reminder({ history: [...appended, todoListQuery()], todos, active: true })).toBeDefined();
    expect(parse).toHaveBeenCalledTimes(2);
    parse.mockRestore();
  });

  it('rebuilds counts when history is rewritten', () => {
    const tracker = new TodoListReminderTracker();
    const todos: TodoItem[] = [{ title: 'Read code', status: 'in_progress' }];
    const stale = [todoListWrite(todos), ...Array.from({ length: 10 }, () => assistantMessage())];
    expect(tracker.reminder({ history: stale, todos, active: true })).toBeDefined();

    const rewritten = [todoListWrite(todos), assistantMessage()];
    expect(tracker.reminder({ history: rewritten, todos, active: true })).toBeUndefined();
    expect(
      tracker.reminder({
        history: [...rewritten, ...Array.from({ length: 9 }, () => assistantMessage())],
        todos,
        active: true,
      }),
    ).toBeDefined();
  });
});
