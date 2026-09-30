import { describe, expect, it } from 'vitest';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { ContextAppendLoopEvent, ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import { TurnPrompt, TurnSteer } from '#/agent/loop/turnOps';
import { ToolsUpdateStore } from '#/session/todo/todoOps';
import { classifyDirectives, historyReferenceTopic, matchesDirectiveCue } from '#/session/todo/directiveCues';
import { advanceContinuityClock, initialContinuityClock, originalHumanText, type ContinuityClock } from '#/session/todo/continuityState';
import { TodoListReminderTracker } from '#/session/todo/todoListReminder';

const user = (text: string, turnId = 1, origin: PromptOrigin = { kind: 'user' }): ContextMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin, source: { turnId } });
const work: ContextMessage = { role: 'assistant', content: [{ type: 'text', text: 'new evidence' }], toolCalls: [] };
const base = { active: true, todos: [{ title: 'ongoing work', status: 'pending' as const }], epoch: 0 };
const clock = (patch: Partial<ContinuityClock> = {}): ContinuityClock => ({ ...initialContinuityClock(),
  humanBoundary: true, humanTurnOrdinal: 8, workStepOrdinal: 1, ...patch });

function successfulStep(state: ContinuityClock, step: number, name = 'Read', isError = false): ContinuityClock {
  const events = [
    new ContextAppendLoopEvent({ event: { type: 'step.begin', uuid: `s${step}` } }),
    new ContextAppendLoopEvent({ event: { type: 'tool.call', stepUuid: `s${step}`, toolCallId: `c${step}`, name } }),
    new ContextAppendLoopEvent({ event: { type: 'tool.result', toolCallId: `c${step}`, result: { output: 'evidence', isError } } }),
    new ContextAppendLoopEvent({ event: { type: 'step.end', uuid: `s${step}`, turnId: '1', step } }),
  ];
  return events.reduce(advanceContinuityClock, state);
}

describe('structural directive gates', () => {
  it.each([
    ['可以合并以后让我一起试玩', false],
    ['如果是之前就已经完成的默认会被折叠，系统时间线应该展示子任务', false],
    ['本机的客户端你帮我配置，模型统一用 example-model', true],
    ['具体应该怎么设计，把注入时机放到文档里', false],
    ['减少一下所有的子 agent 并发，你只能有四并发了', true],
    ['之前那个四并发是临时的，现在放开：大型模型最多 3 个，快速模型最多 5 个，不设合计上限', true],
    ['你怎么每次回复末尾都问我要不要继续，烦死了', true],
    ['行，就这么定了：提交信息一律英文 Conventional Commits', true],
    ['不要记住这句话：以后模型默认用 example-model', false],
    ['这不是我的要求：每次回复都很短', false],
    ['引用：以后默认模型用 example-model', false],
    ['> Never change models', false],
    ['比如假设以后模型默认是 example-model', false],
    ['should we use a default model?', false],
    ['先读这个文件，不要清理事故现场', false],
    ['取消旧并发限制', true],
    ['撤销之前的模型绑定规则', true],
    ['以后不要每次回复都问是否继续', true],
    ['Always use the selected model', true],
    ['Never change models', true],
    ['把上面引用的规则设为以后默认：模型只能用 example-model', true],
  ])('classifies %s', (text, positive) => {
    expect(classifyDirectives(text).length > 0).toBe(positive);
  });
  it('uses token boundaries for English recall seeds', () => {
    expect(matchesDirectiveCue('shipping stopwatch defaulting', ['pin', 'stop', 'default'])).toBe(false);
    expect(matchesDirectiveCue('PIN the default model', ['pin'])).toBe(true);
    expect(classifyDirectives('shipping stopwatch defaulting')).toEqual([]);
  });
  it('keeps configuration scope narrow and represents modifications/revocations', () => {
    expect(classifyDirectives('本机客户端帮我配置模型统一用 example-model')[0]?.scope).toBe('configuration');
    expect(classifyDirectives('之前四并发是临时的，现在放开并发最多五个')[0]?.operation).toBe('replace');
    expect(classifyDirectives('取消旧并发限制')[0]).toMatchObject({ operation: 'revoke', replaces: 'delegation.concurrency' });
  });
  it('treats history as a rule/evidence reference, not UI completion time', () => {
    expect(historyReferenceTopic('如果是之前就已经完成的默认会被折叠')).toBeUndefined();
    expect(historyReferenceTopic('上次我定的并发规则，六个符合吗')).toBe('delegation.concurrency');
    const query = '同时派6个sol，符合我定的规矩吗';
    expect(historyReferenceTopic(query)).toBe('delegation.concurrency');
    expect(classifyDirectives(query)).toEqual([]);
  });
});

describe('authenticated clocks and successful writes', () => {
  it('does not count forwarded sources and deduplicates human acceptance/steer', () => {
    const accepted = new TurnPrompt({ turnId: 1, promptId: 'p1', origin: { kind: 'user' }, input: [{ type: 'text', text: 'task' }] });
    let state = advanceContinuityClock(initialContinuityClock(), accepted);
    expect(advanceContinuityClock(state, accepted)).toEqual(state);
    state = advanceContinuityClock(state, new TurnPrompt({ turnId: 2, origin: { kind: 'agent_message', messageId: 'm1', senderAgentId: 'child', senderTaskName: 'task' }, input: [] }));
    expect(state).toMatchObject({ humanTurnOrdinal: 1, humanInputRevision: 1, humanBoundary: false });
    const steer = new TurnSteer({ promptId: 'p2', turnId: 2, origin: { kind: 'user' }, input: [{ type: 'text', text: 'Never change models' }] });
    state = advanceContinuityClock(state, steer);
    expect(state).toMatchObject({ humanTurnOrdinal: 1, humanInputRevision: 2 });
    expect(advanceContinuityClock(state, steer)).toEqual(state);
  });
  it('excludes polls, failed/empty work and successful-step retries', () => {
    let state = successfulStep(initialContinuityClock(), 0);
    expect(state.workStepOrdinal).toBe(1);
    state = successfulStep(state, 0);
    state = successfulStep(state, 1, 'TaskOutput');
    state = successfulStep(state, 2, 'TaskList');
    state = successfulStep(state, 3, 'Read', true);
    expect(state.workStepOrdinal).toBe(1);
  });
  it('resets separate ages only for successful content changes, including A→B→A', () => {
    let state = clock({ humanTurnOrdinal: 8, workStepOrdinal: 25 });
    const a = new ToolsUpdateStore({ key: 'todo_notes', value: { notes: { next: 'A' } } });
    state = advanceContinuityClock(state, a);
    expect(state.lastNotesU).toBe(8);
    state = { ...state, humanTurnOrdinal: 16, workStepOrdinal: 50, progressCount: 2 };
    expect(advanceContinuityClock(state, a)).toEqual(state);
    state = advanceContinuityClock(state, new ToolsUpdateStore({ key: 'todo', value: [{ title: 'B', status: 'pending' }] }));
    expect(state).toMatchObject({ lastTodoU: 16, lastNotesU: 8, lastNotesStep: 25 });
    state = advanceContinuityClock(state, new ToolsUpdateStore({ key: 'todo_notes', value: { notes: { next: 'B' } } }));
    state = { ...state, humanTurnOrdinal: 24 };
    expect(advanceContinuityClock(state, a)).toMatchObject({ lastNotesU: 24, progressCount: 0 });
  });
  it('does not scan skill/plugin expansion as original user intent', () => {
    const message = user('Always use the model', 1, { kind: 'user', skillActivations: [{ activationId: 'a1', skillName: 'example' }], originalInput: [{ type: 'text', text: 'ordinary request' }] });
    expect(originalHumanText(message)).toBe('ordinary request');
    expect(originalHumanText(user('Always use the model', 1, { kind: 'skill_activation', skillName: 'example', activationId: 'a2', trigger: 'model-tool' }))).toBeUndefined();
  });
});

describe('continuity cadence', () => {
  it('merges T0/T1 at 6U age and 8U spacing, without dumping the list', () => {
    const tracker = new TodoListReminderTracker();
    const input = { ...base, history: [work], threshold: 100_000, estimateMessage: () => 10_000 };
    expect(tracker.evaluate({ ...input, clock: clock({ humanTurnOrdinal: 7 }) })).toBeUndefined();
    const result = tracker.evaluate({ ...input, clock: clock() })!;
    expect(result.disclosure.triggers).toEqual(['T1', 'T0']);
    expect(result.content).not.toContain('ongoing work');
    expect(tracker.evaluate({ ...input, clock: clock() })).toBeUndefined();
  });
  it('backs off to 16U and becomes silent after two reminders across epochs/restart', () => {
    let state = clock();
    const input = { ...base, history: [work], estimateMessage: () => 10_000, clock: state };
    const result = new TodoListReminderTracker().evaluate(input)!;
    state = advanceContinuityClock(state, new ContextAppendMessage({ message: { role: 'user', content: [], toolCalls: [], origin: { kind: 'injection', variant: 'todo_list_reminder', disclosure: result.disclosure } } }));
    expect(new TodoListReminderTracker().evaluate({ ...input, clock: { ...state, humanTurnOrdinal: 23 } })).toBeUndefined();
    const second = new TodoListReminderTracker().evaluate({ ...input, epoch: 1, notes: { goal: 'task' }, notesMeta: { rev: 1, hash: 'h', coveredMessageId: 'none', writtenStep: 't1.0', writtenTurn: 1, windowEpoch: 0 }, clock: { ...state, humanTurnOrdinal: 24 } })!;
    expect(second.disclosure.triggers).toContain('T0');
    state = advanceContinuityClock({ ...state, humanTurnOrdinal: 24 }, new ContextAppendMessage({ message: { role: 'user', content: [], toolCalls: [], origin: { kind: 'injection', variant: 'todo_list_reminder', disclosure: second.disclosure } } }));
    expect(new TodoListReminderTracker().evaluate({ ...input, clock: { ...state, humanTurnOrdinal: 100 } })).toBeUndefined();
  });
  it('does not remind empty/completed lists or forwarded turns, but long tasks still checkpoint', () => {
    const tracker = new TodoListReminderTracker();
    expect(tracker.evaluate({ ...base, todos: [], history: [work], clock: clock() })).toBeUndefined();
    expect(tracker.evaluate({ ...base, todos: [{ title: 'done', status: 'done' }], history: [work], clock: clock() })).toBeUndefined();
    const input = { ...base, history: [work], clock: clock({ humanBoundary: false, humanTurnOrdinal: 100, workStepOrdinal: 23 }), estimateMessage: () => 16_000 };
    expect(tracker.evaluate(input)).toBeUndefined();
    expect(tracker.evaluate({ ...input, clock: { ...input.clock, workStepOrdinal: 24 } })?.disclosure).toMatchObject({ triggers: ['T1'], cause: 'long_task' });
  });
  it('honors configurable cadence', () => {
    expect(new TodoListReminderTracker().evaluate({ ...base, history: [work], clock: clock({ humanTurnOrdinal: 3 }), cadence: { ageHumanTurns: 2, cooldownHumanTurns: 3 } })?.disclosure.triggers).toEqual(['T0']);
  });
  it('T2 requires uncovered work and covers T0/T1; complete handoff needs no P1', () => {
    const tracker = new TodoListReminderTracker();
    const input = { ...base, epoch: 1, history: [work], clock: clock(), threshold: 100_000, currentTokens: 85_000, estimateMessage: () => 16_000 };
    expect(tracker.evaluate(input)?.disclosure.triggers).toEqual(['T2']);
    expect(tracker.evaluate(input)?.disclosure.triggers).not.toContain('T2');
    expect(new TodoListReminderTracker().evaluate({ ...input, history: [] })?.disclosure.triggers).not.toContain('T2');
    const summary: ContextMessage = { role: 'user', toolCalls: [], origin: { kind: 'compaction_summary' }, content: [{ type: 'text', text: '## Working notes\ngoal: task\nnext: finish\n\n## Notes metadata\nrevision 2\n\n## User input since notes\n(none)' }] };
    expect(new TodoListReminderTracker().evaluate({ ...base, epoch: 1, history: [summary] })).toBeUndefined();
  });
  it('rejects both forwarded E1 audit examples at the provenance gate', () => {
    for (const text of ['不要清理这些文件', '不能把回填现象直接当线上根因']) {
      expect(new TodoListReminderTracker().evaluate({ ...base, history: [user(text, 1, { kind: 'agent_message', messageId: text, senderAgentId: 'child', senderTaskName: 'audit' })] })).toBeUndefined();
    }
  });
  it('does not turn a steer into E1, and never suppresses a new modification/revocation', () => {
    const tracker = new TodoListReminderTracker();
    tracker.steer('ordinary request');
    expect(tracker.evaluate({ ...base, history: [user('ordinary request')] })).toBeUndefined();
    for (const [index, text] of ['并发只能四个', '放开旧并发限制，最多五个', '取消旧并发限制'].entries()) {
      const history = [user(text, index + 2)];
      expect(tracker.evaluate({ ...base, history })?.disclosure.triggers).toContain('E1');
      expect(tracker.evaluate({ ...base, history })).toBeUndefined();
    }
  });
  it('allows E1 with Memory and without TodoList, but does not grant subagent memory', () => {
    const history = [user('以后模型只能用 example-model')];
    const result = new TodoListReminderTracker().evaluate({ ...base, active: false, memoryAvailable: true, history });
    expect(result?.disclosure.triggers).toEqual(['E1']);
    expect(result?.content).toContain('approval policy');
    expect(new TodoListReminderTracker().evaluate({ ...base, humanAuthorized: false, history })).toBeUndefined();
  });
  it('persists a three-human-turn E2 topic cooldown and bypasses it for revisions', () => {
    const text = '上次我定的并发规则，六个符合吗';
    const state = clock({ humanTurnOrdinal: 1, latestInput: { id: 'p1', text } });
    const input = { ...base, todos: [], history: [user(text)], clock: state };
    const first = new TodoListReminderTracker().evaluate(input)!;
    const restored = advanceContinuityClock(state, new ContextAppendMessage({ message: { role: 'user', content: [], toolCalls: [], origin: { kind: 'injection', variant: 'todo_list_reminder', disclosure: first.disclosure } } }));
    expect(restored.historyReferences).toEqual([{ topic: 'delegation.concurrency', humanTurnOrdinal: 1, stateRevision: 0 }]);
    const next = { ...restored, humanTurnOrdinal: 3, latestInput: { id: 'p3', text } };
    expect(new TodoListReminderTracker().evaluate({ ...input, clock: next })).toBeUndefined();
    expect(new TodoListReminderTracker().evaluate({ ...input, clock: { ...next, humanTurnOrdinal: 4 } })?.disclosure.triggers).toEqual(['E2']);
    expect(new TodoListReminderTracker().evaluate({ ...input, clock: { ...next, stateRevision: 1 } })?.disclosure.triggers).toEqual(['E2']);
    const revoke = '取消上次我定的并发规则';
    expect(new TodoListReminderTracker().evaluate({ ...input, history: [user(revoke)], clock: { ...next, latestInput: { id: 'revoke', text: revoke } } })?.disclosure.triggers).toContain('E1');
  });
  it('todo-only writes do not reset the notes reminder budget', () => {
    const state = clock({ notesReminderCount: 2, todoReminderCount: 2 });
    const changed = advanceContinuityClock(state, new ToolsUpdateStore({ key: 'todo', value: [{ title: 'changed', status: 'pending' }] }));
    expect(changed).toMatchObject({ todoReminderCount: 0, notesReminderCount: 2 });
  });
  it('E2 does not require compaction, but skips covered references', () => {
    const history = [user('上次我定的并发规则，六个符合吗')];
    expect(new TodoListReminderTracker().evaluate({ ...base, history })?.disclosure.triggers).toEqual(['E2']);
    expect(new TodoListReminderTracker().evaluate({ ...base, history, notes: { directives: '并发最多五个' } })).toBeUndefined();
  });
});
