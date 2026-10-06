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
  it('never treats deliberate no-write after M1 as unfinished maintenance', () => {
    const state = clock({ latestInput: { id: 'human', text: '以后回答都用中文' }, humanBoundary: true });
    const m1 = memoryMaintenanceCandidate({ ...offerInput, clock: state, directive: true })!;
    const offered = { ...state, deliveredInputs: ['human'], memoryMaintenance: { ...initialMemoryMaintenance(), offer: m1, inputIds: ['human'] } };
    for (const epoch of [0, 1, 2]) expect(new TodoListReminderTracker().evaluate({ active: false, memoryAvailable: true, todos: [], history: [], threshold: 100, currentTokens: 85, clock: offered, epoch })).toBeUndefined();
  });
  it('hands off real errors or missing results once, including across restored windows', () => {
    let state = advanceContinuityClock(clock(), new ContextAppendLoopEvent({ event: { type: 'tool.call', stepUuid: 's', toolCallId: 'failed', name: 'MemoryWrite', args: { scope: 'global', id: 'm_rule' } } }));
    state = advanceContinuityClock(state, new ContextAppendLoopEvent({ event: { type: 'tool.result', toolCallId: 'failed', result: { output: JSON.stringify({ code: 'revision_conflict' }), isError: true } } }));
    state = advanceContinuityClock(state, new ContextAppendLoopEvent({ event: { type: 'tool.call', stepUuid: 's', toolCallId: 'unknown', name: 'MemoryWrite', args: { title: 'New rule' } } }));
    const input = { active: false, memoryAvailable: true, todos: [], history: [], threshold: 100, currentTokens: 85, clock: state };
    const result = new TodoListReminderTracker().evaluate(input)!;
    expect(result.disclosure.memory?.reason).toBe('M2');
    expect(result.content).toContain('failed → global/id:m_rule (revision_conflict)');
    expect(result.content).toContain('unknown → visible/title:New rule (result_unknown)');
    expect(result.content).toContain('Do not delay necessary compaction');
    const restored = JSON.parse(JSON.stringify(commit(state, result))) as ContinuityClock;
    for (const epoch of [0, 1, 2]) expect(new TodoListReminderTracker().evaluate({ ...input, clock: restored, epoch })).toBeUndefined();
  });
  it('resolves only the same attempted target, not other failures from the same input', () => {
    const m1 = memoryMaintenanceCandidate({ ...offerInput, directive: true, clock: clock({ latestInput: { id: 'human', text: 'rule' } }) })!;
    let state = clock({ memoryMaintenance: { ...initialMemoryMaintenance(), offer: m1 }, humanInputRevision: m1.inputRevision });
    const call = (id: string, target: string) => { state = advanceContinuityClock(state, new ContextAppendLoopEvent({ event: { type: 'tool.call', stepUuid: 's', toolCallId: id, name: 'MemoryWrite', args: { scope: 'global', id: target } } })); };
    for (const target of ['m_a', 'm_b']) {
      call(`fail-${target}`, target);
      state = advanceContinuityClock(state, new ContextAppendLoopEvent({ event: { type: 'tool.result', toolCallId: `fail-${target}`, result: { output: 'conflict', isError: true } } }));
    }
    const receipt = { action: 'update' as const, id: 'm_a', revision: 'rev-2', status: 'pending', operationId: 'op-2' };
    call('retry-a', 'm_a');
    state = advanceContinuityClock(state, new ContextAppendLoopEvent({ event: { type: 'tool.result', toolCallId: 'retry-a', result: { output: 'ok', memoryReceipt: receipt } } }));
    expect(state.memoryMaintenance?.failures).toMatchObject([{ target: 'global/id:m_b' }]);
    expect(memoryMaintenanceCandidate({ ...offerInput, clock: state, nearWindow: true })?.reason).toBe('M2');
    expect(memoryMaintenanceText(m1, state.memoryMaintenance)).toContain('m_a@rev-2 (op-2)');
    expect(memoryMaintenanceText(m1, state.memoryMaintenance)).toContain('A pending receipt does not establish active guidance');
    call('retry-b', 'm_b');
    state = advanceContinuityClock(state, new ContextAppendLoopEvent({ event: { type: 'tool.result', toolCallId: 'retry-b', result: { output: 'ok', memoryReceipt: { ...receipt, id: 'm_b', status: 'active' } } } }));
    expect(memoryMaintenanceCandidate({ ...offerInput, clock: state, nearWindow: true })).toBeUndefined();
    expect(state).toMatchObject({ lastTodoU: 0, lastNotesU: 0 });
  });
  it.each(['applied', 'pending', 'unchanged'] as const)('uses a returned owning target to resolve a scoped retry (%s) without clearing ambiguous or other-scope failures', (outcome) => {
    let state = clock({ memoryMaintenance: { ...initialMemoryMaintenance(), failures: [
      { callId: 'conflict', source: 'input:one', target: 'visible/id:m_a', code: 'revision_conflict' },
      { callId: 'ambiguous', source: 'input:one', target: 'visible/id:m_a', code: 'ambiguous_target' },
      { callId: 'other-scope', source: 'input:one', target: 'global/id:m_a', code: 'revision_conflict' },
      { callId: 'other-id', source: 'input:one', target: 'workspace/id:m_b', code: 'revision_conflict' },
    ] } });
    state = advanceContinuityClock(state, new ContextAppendLoopEvent({ event: { type: 'tool.call', stepUuid: 's', toolCallId: 'retry', name: 'MemoryWrite', args: { scope: 'workspace', id: 'm_a' } } }));
    state = advanceContinuityClock(state, new ContextAppendLoopEvent({ event: { type: 'tool.result', toolCallId: 'retry', result: { output: 'ok', memoryReceipt: {
      action: 'update', outcome, id: outcome === 'pending' ? 'm_proposal' : 'm_a', revision: 'rev-2', status: outcome === 'pending' ? 'pending' : 'active',
      target: { scope: 'workspace', id: outcome === 'pending' ? 'm_proposal' : 'm_a', expected_revision: 'rev-2' },
      proposedTarget: outcome === 'pending' ? { scope: 'workspace', id: 'm_a', expected_revision: 'rev-1' } : undefined,
    } } } }));
    expect(state.memoryMaintenance?.failures?.map((failure) => failure.callId)).toEqual(['ambiguous', 'other-scope', 'other-id']);
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
  it('does not advance material-work cadence for memory-only steps while preserving Todo clocks', () => {
    let state = clock();
    for (let index = 0; index < 64; index++) for (const event of [
      { type: 'step.begin' as const, uuid: `s${index}` },
      { type: 'content.part' as const, stepUuid: `s${index}`, part: { type: 'text' as const, text: 'memory maintenance' } },
      { type: 'tool.call' as const, stepUuid: `s${index}`, toolCallId: `c${index}`, name: ['MemorySearch', 'MemoryRead', 'MemoryWrite'][index % 3]! },
      { type: 'tool.result' as const, toolCallId: `c${index}`, result: { output: 'a'.repeat(2_000) } },
      { type: 'step.end' as const, uuid: `s${index}`, turnId: '1', step: index },
    ]) state = advanceContinuityClock(state, new ContextAppendLoopEvent({ event }));
    expect(state).toMatchObject({ workStepOrdinal: 64, materialWorkStepOrdinal: 0, materialWorkTokens: 0 });
    expect(candidate(state)).toBeUndefined();
    expect(candidate({ ...state, humanTurnOrdinal: 12, workStepOrdinal: 100 })).toBeUndefined();
  });
  it('keeps mixed material work eligible without adding memory result tokens', () => {
    let state = clock();
    for (const event of [
      { type: 'step.begin' as const, uuid: 's' },
      { type: 'tool.call' as const, stepUuid: 's', toolCallId: 'memory', name: 'MemoryRead' },
      { type: 'tool.result' as const, toolCallId: 'memory', result: { output: 'm'.repeat(2_000) } },
      { type: 'tool.call' as const, stepUuid: 's', toolCallId: 'read', name: 'Read' },
      { type: 'tool.result' as const, toolCallId: 'read', result: { output: 'w'.repeat(400) } },
      { type: 'step.end' as const, uuid: 's', turnId: '1', step: 0 },
    ]) state = advanceContinuityClock(state, new ContextAppendLoopEvent({ event }));
    expect(state).toMatchObject({ workStepOrdinal: 1, workTokens: 600, materialWorkStepOrdinal: 1, materialWorkTokens: 100 });
  });
  it('reads old wire call sources without inventing a successful write or forgetting an unknown result', () => {
    const state = clock({ memoryMaintenance: { ...initialMemoryMaintenance(), calls: { old: 'input:old' } } });
    expect(memoryMaintenanceCandidate({ ...offerInput, clock: state, nearWindow: true })?.reason).toBe('M2');
    const offer = memoryMaintenanceCandidate({ ...offerInput, clock: state, nearWindow: true })!;
    expect(memoryMaintenanceText(offer, state.memoryMaintenance)).toContain('old → visible/call:old (result_unknown)');
  });
});
