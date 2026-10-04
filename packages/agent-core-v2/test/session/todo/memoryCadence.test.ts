import { describe, expect, it } from 'vitest';
import { ContextAppendLoopEvent, ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import { TurnPrompt } from '#/agent/loop/turnOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { advanceContinuityClock, initialContinuityClock, type ContinuityClock } from '#/session/todo/continuityState';
import { initialMemoryMaintenance, memoryMaintenanceCandidate, memoryMaintenanceText } from '#/session/todo/memoryCadence';
import { TodoListReminderTracker, type TodoReminderResult } from '#/session/todo/todoListReminder';
import { ToolsUpdateStore } from '#/session/todo/todoOps';

const offerInput = { epoch: 0, available: true, periodic: true, active: true, nearWindow: false, directive: false };
const clock = (patch: Partial<ContinuityClock> = {}): ContinuityClock => ({ ...initialContinuityClock(), ...patch });
const commit = (state: ContinuityClock, result: TodoReminderResult) => advanceContinuityClock(state, new ContextAppendMessage({ message: {
  role: 'user', content: [{ type: 'text', text: result.content }], toolCalls: [], origin: { kind: 'injection', variant: 'todo_list_reminder', disclosure: result.disclosure },
} }));
const candidate = (state: ContinuityClock) => memoryMaintenanceCandidate({ ...offerInput, clock: state });
const work: ContextMessage = { role: 'assistant', toolCalls: [], content: [{ type: 'text', text: 'new work' }] };

describe('independent memory maintenance', () => {
  it('keeps notes-reminder cooldown separate from a still-undisclosed Todo opportunity', () => {
    const state = clock({ humanBoundary: true, humanTurnOrdinal: 8, workStepOrdinal: 1 });
    const input = { active: true, history: [work], clock: state, todos: [], estimateMessage: () => 10_000 };
    const notes = new TodoListReminderTracker().evaluate(input)!;
    expect(notes.disclosure.triggers).toEqual(['T1']);
    const committed = commit(state, notes);
    expect(new TodoListReminderTracker().evaluate({ ...input, clock: committed, todos: [{ title: 'work', status: 'pending' }] })?.disclosure.triggers).toEqual(['T0']);
  });
  it('defaults to 12 human turns plus 24 work steps, or 64 steps plus 32k new work tokens', () => {
    expect(candidate(clock({ humanTurnOrdinal: 12, workStepOrdinal: 23 }))).toBeUndefined();
    expect(candidate(clock({ humanTurnOrdinal: 11, workStepOrdinal: 24 }))).toBeUndefined();
    expect(candidate(clock({ humanTurnOrdinal: 12, workStepOrdinal: 24 }))?.reason).toBe('M3');
    expect(candidate(clock({ workStepOrdinal: 63, workTokens: 32_000 }))).toBeUndefined();
    expect(candidate(clock({ workStepOrdinal: 64, workTokens: 31_999 }))).toBeUndefined();
    expect(candidate(clock({ workStepOrdinal: 64, workTokens: 32_000 }))?.reason).toBe('M3');
  });
  it('keeps disabled memory, idle, periodic-off and pure waiting silent', () => {
    const state = clock({ humanTurnOrdinal: 12, workStepOrdinal: 64, workTokens: 32_000 });
    for (const patch of [{ available: false }, { active: false }, { periodic: false }]) expect(memoryMaintenanceCandidate({ ...offerInput, clock: state, ...patch })).toBeUndefined();
    const input = { active: false, memoryAvailable: true, todos: [], epoch: 0, clock: state, history: [work], running: true };
    const tracker = new TodoListReminderTracker();
    expect(tracker.evaluate(input)?.disclosure.triggers).toEqual(['M3']);
    expect(tracker.evaluate({ ...input, humanAuthorized: false })).toBeUndefined();
    expect(tracker.evaluate({ ...input, history: [{ ...work, toolCalls: [{ type: 'function', name: 'TaskWait', id: 'wait', arguments: '{}' }] }] })).toBeUndefined();
  });
  it('does not consume an offer until append and persists one M3 per window across restore', () => {
    let state = clock({ humanTurnOrdinal: 12, workStepOrdinal: 24 });
    const tracker = new TodoListReminderTracker();
    const input = { active: false, memoryAvailable: true, running: true, todos: [], history: [work], clock: state };
    const result = tracker.evaluate(input)!;
    expect(tracker.evaluate(input)).toEqual(result);
    state = commit(state, result);
    expect(new TodoListReminderTracker().evaluate({ ...input, clock: { ...state, humanTurnOrdinal: 100, workStepOrdinal: 100, workTokens: 100_000 } })).toBeUndefined();
    expect(new TodoListReminderTracker().evaluate({ ...input, epoch: 1, clock: { ...state, humanTurnOrdinal: 24, workStepOrdinal: 48 } })?.disclosure.memory?.reason).toBe('M3');
  });
  it('does not let task-notes coverage swallow M1, including memory-only and periodic-off', () => {
    const text = '以后回答都用中文';
    const state = advanceContinuityClock(clock(), new TurnPrompt({ turnId: 1, promptId: 'human', origin: { kind: 'user' }, input: [{ type: 'text', text }] }));
    const input = { active: true, memoryAvailable: true, todos: [], history: [], notes: { directives: text }, clock: state, cadence: { memoryMaintenance: false } };
    const result = new TodoListReminderTracker().evaluate(input)!;
    expect(result.disclosure).toMatchObject({ triggers: ['M1'], memory: { source: 'input:human@0', reason: 'M1' } });
    expect(new TodoListReminderTracker().evaluate({ ...input, active: false })?.disclosure.memory?.reason).toBe('M1');
    expect(new TodoListReminderTracker().evaluate({ ...input, clock: commit(state, result) })).toBeUndefined();
    expect(new TodoListReminderTracker().evaluate({ ...input, humanAuthorized: false })).toBeUndefined();
  });
  it('keeps Todo, notes and memory write/offer watermarks independent', () => {
    let state = clock({ humanTurnOrdinal: 12, workStepOrdinal: 24, notesReminderCount: 2, todoReminderCount: 1 });
    const offered = candidate(state)!;
    state = { ...state, memoryMaintenance: { ...initialMemoryMaintenance(), offer: offered, periodicEpoch: 0 } };
    const maintenance = state.memoryMaintenance;
    const notes = advanceContinuityClock(state, new ToolsUpdateStore({ key: 'todo_notes', value: { notes: { next: 'continue' } } }));
    expect(notes.memoryMaintenance).toEqual(maintenance);
    expect(notes.todoReminderCount).toBe(1);
    expect(notes.lastTodoStep).toBe(0);
    expect(new TodoListReminderTracker().evaluate({ active: true, todos: [{ title: 'work', status: 'pending' }], history: [work], clock: { ...notes, humanBoundary: true, humanTurnOrdinal: 24 } })?.disclosure.triggers).toEqual(['T0']);
    const todo = advanceContinuityClock(state, new ToolsUpdateStore({ key: 'todo', value: [] }));
    expect(todo.notesReminderCount).toBe(2);
    expect(todo.memoryMaintenance).toEqual(maintenance);
  });
  it('offers M2 independently of TodoList before renewal, only for identified unhandled M1', () => {
    const state = clock({ latestInput: { id: 'human', text: '以后回答都用中文' }, humanBoundary: true });
    const m1 = memoryMaintenanceCandidate({ ...offerInput, clock: state, directive: true })!;
    const offered = { ...state, memoryMaintenance: { ...initialMemoryMaintenance(), offer: m1, inputIds: ['human'] } };
    const input = { active: false, memoryAvailable: true, todos: [], history: [], threshold: 100, currentTokens: 85, clock: offered };
    const result = new TodoListReminderTracker().evaluate(input)!;
    expect(result.disclosure.memory?.reason).toBe('M2');
    expect(result.content).toContain('Do not delay necessary compaction');
    expect(new TodoListReminderTracker().evaluate({ ...input, clock: commit(offered, result) })).toBeUndefined();
    expect(memoryMaintenanceCandidate({ ...offerInput, nearWindow: true, clock: { ...offered, memoryMaintenance: { ...offered.memoryMaintenance, offer: { ...m1, reason: 'M3' } } } })).toBeUndefined();
  });
  it('records real pending/active IDs, revisions and operation IDs without treating an unrelated write as coverage', () => {
    const m1 = memoryMaintenanceCandidate({ ...offerInput, directive: true, clock: clock({ latestInput: { id: 'human', text: 'rule' } }) })!;
    let state = clock({ memoryMaintenance: { ...initialMemoryMaintenance(), offer: m1 }, humanInputRevision: 1 });
    const receipt = { action: 'update' as const, id: 'entry', revision: 'rev-2', status: 'pending', operationId: 'op-2' };
    state = advanceContinuityClock(state, new ContextAppendLoopEvent({ event: { type: 'tool.call', stepUuid: 's', toolCallId: 'unrelated', name: 'MemoryWrite' } }));
    state = advanceContinuityClock(state, new ContextAppendLoopEvent({ event: { type: 'tool.result', toolCallId: 'unrelated', result: { output: 'ok', memoryReceipt: receipt } } }));
    expect(state.memoryMaintenance?.receipts[0]?.source).toBe('unassociated:unrelated');
    expect(memoryMaintenanceCandidate({ ...offerInput, clock: state, nearWindow: true })?.reason).toBe('M2');
    expect(memoryMaintenanceText(m1, state.memoryMaintenance)).toContain('entry@rev-2 (op-2)');
    expect(memoryMaintenanceText(m1, state.memoryMaintenance)).toContain('pending is not active guidance');
    state = { ...state, humanInputRevision: m1.inputRevision };
    state = advanceContinuityClock(state, new ContextAppendLoopEvent({ event: { type: 'tool.call', stepUuid: 's', toolCallId: 'related', name: 'MemoryWrite' } }));
    state = advanceContinuityClock(state, new ContextAppendLoopEvent({ event: { type: 'tool.result', toolCallId: 'related', result: { output: 'ok', memoryReceipt: { ...receipt, status: 'active', revision: 'rev-3' } } } }));
    expect(state.memoryMaintenance?.receipts).toMatchObject([{ source: m1.source, revision: 'rev-3', status: 'active', operationId: 'op-2' }]);
    expect(memoryMaintenanceCandidate({ ...offerInput, clock: state, nearWindow: true })).toBeUndefined();
    expect(state).toMatchObject({ lastTodoU: 0, lastNotesU: 0 });
  });
  it('counts only new successful work tokens; polling and repeated/failed steps cannot reach M3', () => {
    let state = clock();
    const step = (index: number, name: string, isError = false) => {
      for (const event of [
        { type: 'step.begin' as const, uuid: `s${index}` },
        { type: 'tool.call' as const, stepUuid: `s${index}`, toolCallId: `c${index}`, name },
        { type: 'tool.result' as const, toolCallId: `c${index}`, result: { output: 'a'.repeat(2_000), isError } },
        { type: 'step.end' as const, uuid: `s${index}`, turnId: '1', step: index },
      ]) state = advanceContinuityClock(state, new ContextAppendLoopEvent({ event }));
    };
    for (let index = 0; index < 64; index++) step(index, 'Read');
    expect(state).toMatchObject({ workStepOrdinal: 64, workTokens: 32_000 });
    step(63, 'Read');
    step(64, 'Read', true);
    step(65, 'TaskOutput');
    expect(state).toMatchObject({ workStepOrdinal: 64, workTokens: 32_000 });
    expect(candidate(state)?.reason).toBe('M3');
  });
});
