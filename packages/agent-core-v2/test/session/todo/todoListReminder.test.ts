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

  it('latches the near-window note reminder once per durable epoch', () => {
    const tracker = new TodoListReminderTracker();
    let remindedEpoch: number | undefined;
    const input = { active: true, history: [assistantMessage()], todos: [], notesEnabled: true,
      threshold: 100_000, currentTokens: 86_000, epoch: 2, estimateMessage: () => 1,
      onNearWindow: (epoch: number) => { remindedEpoch = epoch; } };
    expect(tracker.reminder({ ...input, remindedEpoch })).toContain('goal (the user\'s request and success criteria)');
    expect(remindedEpoch).toBe(2);
    expect(tracker.reminder({ ...input, remindedEpoch })).toBeUndefined();
    expect(tracker.reminder({ ...input, epoch: 3, remindedEpoch })).toContain('renewed soon');
  });

  it('keeps the existing reminder unchanged when notes are disabled and reminds when notes age', () => {
    const history = [todoListWrite([{ title: 'task', status: 'pending' }]),
      ...Array.from({ length: 10 }, () => assistantMessage())];
    const base = { active: true, history, todos: [{ title: 'task', status: 'pending' as const }] };
    const original = todoListStaleReminder(base);
    expect(original).toContain('clear or rewrite it if stale');
    expect(todoListStaleReminder({ ...base, notesEnabled: true, threshold: 100_000,
      estimateMessage: () => 1_000 })).toContain('goal (the user\'s request and success criteria)');
    expect(todoListStaleReminder({ ...base, notesEnabled: true, threshold: 100_000,
      estimateMessage: () => 1 })).not.toContain('Working notes were last updated');
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

function user(text: string, turnId: number): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' }, source: { turnId } };
}
function injected(result: NonNullable<ReturnType<TodoListReminderTracker['evaluate']>>): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text: result.content }], toolCalls: [],
    origin: { kind: 'injection', variant: 'todo_list_reminder', disclosure: result.disclosure } };
}
const freshMeta = { rev: 1, hash: 'test', writtenTurn: 1, writtenStep: 't1.0', windowEpoch: 1, coveredMessageId: 'compaction_summary' };
const baseReminder = { active: true, todos: [], epoch: 0 };

describe('event-driven continuity reminders', () => {
  it.each([
    '以后直接 pin 模型',
    'Always use the selected model',
    '减少一下所有的并发，你只能有四并发了',
    '之前那个是临时的，现在放开：Opus 最多 3 个',
    'That cap was temporary; lift it',
  ])('recognizes default instruction cues: %s', (text) => {
    const tracker = new TodoListReminderTracker();
    const history = [user(text, 1)];
    expect(tracker.evaluate({ ...baseReminder, history })?.disclosure.triggers).toEqual(['E1']);
    expect(tracker.evaluate({ ...baseReminder, history: [...history, user(text, 1)] })).toBeUndefined();
  });

  it('filters synthetic inputs and honors cue overrides, including empty lists', () => {
    const tracker = new TodoListReminderTracker();
    expect(tracker.evaluate({ ...baseReminder, history: [user('ordinary request', 1)] })).toBeUndefined();
    expect(tracker.evaluate({ ...baseReminder, history: [user('Always use it', 2)], cues: { instructions: [] } })).toBeUndefined();
    expect(tracker.evaluate({ ...baseReminder, history: [{ ...user('Always use it', 3), origin: { kind: 'injection', variant: 'test' } }] })).toBeUndefined();
    expect(tracker.evaluate({ ...baseReminder, history: [user('special cue', 4)], cues: { instructions: ['special cue'] }, memoryAvailable: false })?.content).not.toContain('MemoryWrite');
  });

  it('keeps event E1 available beyond six turns, deduplicates replay and restores undo', () => {
    const tracker = new TodoListReminderTracker();
    const history: ContextMessage[] = [];
    for (let turn = 1; turn <= 6; turn++) {
      history.push(user('Never change models', turn));
      const result = tracker.evaluate({ ...baseReminder, history })!;
      expect(result.disclosure.triggers).toEqual(['E1']);
      history.push(injected(result));
    }
    const beforeLast = history.slice(0, -2);
    tracker.steer('The blue option is correct.');
    history.push(user('The blue option is correct.', 7));
    const steer = tracker.evaluate({ ...baseReminder, history })!;
    expect(steer.disclosure.triggers).toEqual(['E1']);
    history.push(injected(steer));
    expect(tracker.evaluate({ ...baseReminder, history })).toBeUndefined();
    expect(new TodoListReminderTracker().evaluate({ ...baseReminder, history })).toBeUndefined();
    expect(tracker.evaluate({ ...baseReminder, history: [...beforeLast, user('Never change models', 8)] })?.disclosure.triggers).toEqual(['E1']);
    expect(tracker.evaluate({ ...baseReminder, epoch: 1, history: [user('Never change models', 9)] })?.disclosure.triggers).toEqual(['P1', 'E1']);
  });

  it('gates E2 to post-renewal windows and only once per turn, with configurable history cues', () => {
    expect(new TodoListReminderTracker().evaluate({ ...baseReminder, history: [user('as I said', 1)] })).toBeUndefined();
    const tracker = new TodoListReminderTracker();
    const input = { ...baseReminder, epoch: 1, notes: { goal: 'current' }, notesMeta: freshMeta };
    const history = [user('as I said', 2)];
    const result = tracker.evaluate({ ...input, history })!;
    expect(result.disclosure.triggers).toEqual(['E2']);
    history.push(injected(result), user('as I said', 2));
    expect(tracker.evaluate({ ...input, history })).toBeUndefined();
    history.push(user('custom history', 3));
    expect(tracker.evaluate({ ...input, history, cues: { history: ['custom history'] } })?.disclosure.triggers).toEqual(['E2']);
  });

  it('fires P1 from a nonempty handoff even when compaction already updated the notes watermark', () => {
    const summary = (block: string): ContextMessage => ({ role: 'user', toolCalls: [], origin: { kind: 'compaction_summary' },
      content: [{ type: 'text', text: `## Standing directives\nAlready saved\n\n## User input since notes\n${block}\n\nTreat Standing directives and User input since notes as in force.` }] });
    const input = { ...baseReminder, epoch: 1, notes: { directives: 'Already saved' }, notesMeta: freshMeta };
    expect(new TodoListReminderTracker().evaluate({ ...input, history: [summary('(none)')] })).toBeUndefined();
    const tracker = new TodoListReminderTracker();
    const history = [summary('- t424 (user): directly pin the model')];
    const result = tracker.evaluate({ ...input, history })!;
    expect(result.disclosure.triggers).toEqual(['P1']);
    history.push(injected(result));
    expect(tracker.evaluate({ ...input, history })).toBeUndefined();
    expect(new TodoListReminderTracker().evaluate({ ...input, history })).toBeUndefined();
  });

  it('merges at most three triggers in priority order and suppresses unavailable memory hints', () => {
    const history = [...Array.from({ length: 10 }, assistantMessage), user('Always do it as I said', 424)];
    const tracker = new TodoListReminderTracker();
    const input = { ...baseReminder, history, epoch: 1,
      threshold: 100_000, currentTokens: 86_000, estimateMessage: () => 1_000, memoryAvailable: false };
    const result = tracker.evaluate(input)!;
    expect(result.disclosure).toEqual({ kind: 'renew', triggers: ['T2', 'P1', 'E1'], epoch: 1, userTurn: 't424' });
    expect(result.content.match(/Do not mention this reminder/g)).toHaveLength(1);
    expect(result.content).toContain('There are 1 user inputs since notes');
    expect(result.content).not.toContain('MemoryWrite');
    history.push(injected(result));
    expect(tracker.evaluate(input)).toBeUndefined();
    expect(new TodoListReminderTracker().evaluate(input)).toBeUndefined();
  });

  it('backs off progress 10 to 20 to 40 and notes-only writes reset it', () => {
    const tracker = new TodoListReminderTracker();
    const history: ContextMessage[] = [];
    const positions: number[] = [];
    for (let step = 1; step <= 100; step++) {
      history.push(assistantMessage());
      const result = tracker.evaluate({ ...baseReminder, history });
      if (result) { positions.push(step); history.push(injected(result)); }
    }
    expect(positions).toEqual([10, 20, 40, 60, 100]);
    history.push({ role: 'assistant', content: [], toolCalls: [{ type: 'function', id: 'notes', name: 'TodoList', arguments: JSON.stringify({ notes: { next: 'continue' } }) }] });
    expect(tracker.evaluate({ ...baseReminder, history })).toBeUndefined();
    history.push(...Array.from({ length: 9 }, assistantMessage));
    expect(tracker.evaluate({ ...baseReminder, history })).toBeUndefined();
    history.push(assistantMessage());
    expect(tracker.evaluate({ ...baseReminder, history })?.disclosure.triggers).toEqual(['T0']);
  });

  it('T2 is below-threshold silent, latched locally while durable writes settle, and replay-safe', () => {
    const tracker = new TodoListReminderTracker();
    const input = { ...baseReminder, epoch: 1, notes: { goal: 'ready' }, notesMeta: freshMeta, threshold: 100_000, history: [] as ContextMessage[] };
    expect(tracker.evaluate({ ...input, currentTokens: 84_999 })).toBeUndefined();
    const result = tracker.evaluate({ ...input, currentTokens: 85_000 })!;
    expect(result.disclosure.triggers).toEqual(['T2']);
    expect(tracker.evaluate({ ...input, currentTokens: 86_000 })).toBeUndefined();
    expect(new TodoListReminderTracker().evaluate({ ...input, history: [injected(result)], currentTokens: 86_000 })).toBeUndefined();
  });
});
