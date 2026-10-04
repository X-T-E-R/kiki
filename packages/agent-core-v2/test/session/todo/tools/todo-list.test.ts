import { describe, expect, it } from 'vitest';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { TODO_LIST_TOOL_NAME, type TodoItem } from '#/session/todo/todoItem';
import { NOTE_SECTIONS, mergeTodoNotes, type TodoNotes } from '#/session/todo/todoNotes';
import { ITodoListTool, TodoListInputSchema, TodoNotesSchema } from '#/agent/tools/todo-list/todo-list';
import { TodoListTool } from '#/agent/tools/todo-list/todoListTool';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { TestInstantiationService } from '#/_base/di/test';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { executeTool } from '../../../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

function makeTool(initial: readonly TodoItem[] = []) {
  let todos = [...initial];
  let notes: TodoNotes | undefined;
  const ix = new TestInstantiationService();
  ix.set(IAgentScopeContext, makeAgentScopeContext({ agentId: 'child', agentScope: 'child' }));
  ix.set(ISessionTodoService, {
    _serviceBrand: undefined,
    getTodos: (agentId) => { expect(agentId).toBe('child'); return todos; },
    setTodos: (next, agentId) => { expect(agentId).toBe('child'); todos = next.map(({ title, status }) => ({ title, status })); },
    getNotes: () => ({ notes }),
    setNotes: (patch) => { notes = mergeTodoNotes(notes, patch); },
    clear: () => { todos = []; },
    onDidChange: () => ({ dispose: () => {} }),
    onDidChangeAgent: () => ({ dispose: () => {} }),
  });
  ix.set(ITodoListTool, new SyncDescriptor(TodoListTool));
  return { tool: ix.get(ITodoListTool), getTodos: () => todos, getNotes: () => notes, dispose: () => ix.dispose() };
}

function receipt(output: unknown) { return JSON.parse(String(output)); }

describe('TodoListTool', () => {
  it('cannot override the caller identity with a tool argument', async () => {
    const fixture = makeTool([{ title: 'child list', status: 'pending' }]);
    const injected = { agent_id: 'main', todos: [{ title: 'still child', status: 'done' as const }] };
    const result = await executeTool(fixture.tool, { turnId: 1, toolCallId: 'identity', args: injected, signal });
    expect(result.isError).toBe(false);
    expect(fixture.getTodos()).toEqual([{ title: 'still child', status: 'done' }]);
    fixture.dispose();
  });

  it('describes independent updates and exposes every canonical section without defaults', () => {
    const fixture = makeTool();
    expect(fixture.tool.name).toBe(TODO_LIST_TOOL_NAME);
    expect(fixture.tool.description).toContain('omit todos to keep the list, omit notes to keep all notes');
    expect(fixture.tool.description).toContain('replaces that entire section');
    expect(fixture.tool.description).toContain('Writes return a compact receipt');
    expect(TodoListInputSchema.parse({})).toEqual({});
    expect(TodoListInputSchema.safeParse({ todos: [{ title: 'x', status: 'wip' }] }).success).toBe(false);
    expect(Object.keys(TodoNotesSchema.shape)).toEqual([...NOTE_SECTIONS]);
    expect(TodoListInputSchema.safeParse({ notes: { nexxt: 'typo' } }).success).toBe(false);
    expect(fixture.tool.parameters).toMatchObject({ type: 'object', additionalProperties: false, properties: { todos: { type: 'array' } } });
    expect(JSON.stringify(fixture.tool.parameters)).toContain('Omit notes to keep them unchanged, including when updating todos');
    fixture.dispose();
  });

  it('query mode renders the current list without mutating it', async () => {
    const fixture = makeTool([{ title: 'existing', status: 'in_progress' }]);
    const result = await executeTool(fixture.tool, { turnId: 1, toolCallId: 'read', args: {}, signal });
    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('[in_progress] existing');
    expect(fixture.getTodos()).toEqual([{ title: 'existing', status: 'in_progress' }]);
    fixture.dispose();
  });

  it('write mode copies the whole list but returns only counts and changed fields', async () => {
    const fixture = makeTool();
    const todos: TodoItem[] = [{ title: 'first', status: 'pending' }, { title: 'second', status: 'in_progress' }];
    const result = await executeTool(fixture.tool, { turnId: 1, toolCallId: 'write', args: { todos }, signal });
    todos[0] = { title: 'leaked', status: 'done' };
    expect(receipt(result.output)).toMatchObject({ changed: ['todos'], todos: { count: 2, pending: 1, in_progress: 1, done: 0 } });
    expect(result.output).not.toContain('first');
    expect(fixture.getTodos()).toEqual([{ title: 'first', status: 'pending' }, { title: 'second', status: 'in_progress' }]);
    fixture.dispose();
  });

  it('renders a done todo with the status enum marker on explicit read', async () => {
    const fixture = makeTool([{ title: 'shipped', status: 'done' }]);
    const result = await executeTool(fixture.tool, { turnId: 1, toolCallId: 'read', args: {}, signal });
    expect(result.output).toContain('[done] shipped');
    expect(result.output).not.toContain('[completed]');
    fixture.dispose();
  });

  it('patches, reads, and clears both domains independently and reports exact deletion scope', async () => {
    const fixture = makeTool([{ title: 'keep', status: 'pending' }]);
    const invoke = (args: object) => executeTool(fixture.tool, { turnId: 2, step: 4, toolCallId: 'notes', args, signal });
    const sentinels = Object.fromEntries(NOTE_SECTIONS.map((section) => [section, `${section}:KEEP`])) as TodoNotes;
    await invoke({ notes: sentinels });
    expect(fixture.getTodos()).toEqual([{ title: 'keep', status: 'pending' }]);
    await invoke({ notes: { next: 'new action' } });
    expect(fixture.getNotes()).toEqual({ ...sentinels, next: 'new action' });
    const mixed = await invoke({ todos: [{ title: 'new task', status: 'in_progress' }], notes: { open: '' } });
    expect(receipt(mixed.output)).toMatchObject({ changed: ['todos'], cleared: ['notes.open'], section_chars: { open: 0 } });
    expect(fixture.getNotes()?.directives).toBe(sentinels.directives);
    expect(mixed.output).not.toContain(sentinels.goal!);
    const unchanged = await invoke({ notes: {} });
    expect(receipt(unchanged.output)).toMatchObject({ unchanged: true, changed: [], cleared: [] });
    const read = await invoke({});
    expect(read.output).toContain(sentinels.directives!);
    const clearTodos = await invoke({ todos: [] });
    expect(receipt(clearTodos.output).cleared).toEqual(['todos']);
    expect(fixture.getNotes()?.goal).toBe(sentinels.goal);
    await invoke({ todos: [{ title: 'still needed', status: 'pending' }] });
    const clearNotes = await invoke({ notes: null });
    expect(receipt(clearNotes.output).cleared).toEqual(['notes']);
    expect(fixture.getNotes()).toBeUndefined();
    expect(fixture.getTodos()).toEqual([{ title: 'still needed', status: 'pending' }]);
    fixture.dispose();
  });

  it('keeps small write receipts bounded with a nearly full notebook', async () => {
    const fixture = makeTool();
    const invoke = (args: object) => executeTool(fixture.tool, { turnId: 2, step: 4, toolCallId: 'notes', args, signal });
    await invoke({ notes: { goal: 'g'.repeat(1500), directives: 'd'.repeat(1500), evidence: 'e'.repeat(1500), files: 'f'.repeat(1500), decided: 'c'.repeat(1400) } });
    const result = await invoke({ notes: { next: 'run tests' } });
    expect(typeof result.output).toBe('string');
    expect((result.output as string).length).toBeLessThan(300);
    expect(receipt(result.output)).toMatchObject({ changed: ['notes.next'], section_chars: { next: 9 }, notes_chars: 7409 });
    expect((await invoke({})).output).toContain('d'.repeat(1500));
    fixture.dispose();
  });

  it('rejects section and aggregate budgets before either domain changes', async () => {
    const fixture = makeTool([{ title: 'keep', status: 'pending' }]);
    const invoke = (args: object) => executeTool(fixture.tool, { turnId: 2, step: 4, toolCallId: 'notes', args, signal });
    await invoke({ notes: { goal: 'keep' } });
    for (const notes of [{ goal: 'x'.repeat(1501) }, Object.fromEntries(NOTE_SECTIONS.map((section) => [section, section.repeat(300).slice(0, 1500)]))]) {
      const result = await invoke({ notes, todos: [] });
      expect(result.isError).toBe(true);
      expect(fixture.getNotes()).toEqual({ goal: 'keep' });
      expect(fixture.getTodos()).toEqual([{ title: 'keep', status: 'pending' }]);
    }
    fixture.dispose();
  });

  it('resolveExecution description reflects the mode', () => {
    const fixture = makeTool();
    expect(fixture.tool.resolveExecution({})).toMatchObject({ description: 'Reading todo list' });
    expect(fixture.tool.resolveExecution({ todos: [] })).toMatchObject({ description: 'Clearing todo list' });
    expect(fixture.tool.resolveExecution({ todos: [{ title: 'x', status: 'pending' }] })).toMatchObject({ description: 'Updating todo list' });
    expect(fixture.tool.resolveExecution({ review_handoff: true })).toMatchObject({ description: 'Updating working notes' });
    fixture.dispose();
  });
});
