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
    ['合并以后', false],
    ['应该怎么设计', false],
    ['以后回答都用中文', true],
    ['never push to main', true],
    ['别用 emoji', true],
    ['文档一律放 docs/', true],
    ['从现在开始测试都用 vitest', true],
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
  it('retrieves named earlier artifacts without treating unrelated notes as coverage', () => {
    const text = '之前需要我拍板的example-space-design，考虑一下和工作区如何结合';
    expect(historyReferenceTopic(text)).toBe('artifact:example-space-design');
    const input = { ...base, todos: [], history: [user(text)], notes: { decided: '并发最多五个' } };
    expect(new TodoListReminderTracker().evaluate(input)?.disclosure.triggers).toEqual(['E2']);
    expect(new TodoListReminderTracker().evaluate({ ...input, notes: { decided: 'example-space-design: scoped decision is recorded' } })).toBeUndefined();
    const state = clock({ latestInput: { id: 'artifact-2', text }, historyReferences: [{ topic: 'artifact:other-plan', humanTurnOrdinal: 8, stateRevision: 0 }] });
    expect(new TodoListReminderTracker().evaluate({ ...input, clock: state })?.disclosure.triggers).toEqual(['E2']);
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

describe('review regression boundaries', () => {
  it.each(['以后回答都用中文', 'never push to main', '别用 emoji', '文档一律放 docs/', '从现在开始测试都用 vitest'])('keeps an unrecognized standing behavior: %s', (text) => {
    expect(classifyDirectives(text)[0]).toMatchObject({ subject: 'agent.behavior', scope: 'agent', lifetime: 'persistent' });
    const result = new TodoListReminderTracker().evaluate({ ...base, history: [user(text)], memoryAvailable: true });
    expect(result?.disclosure.triggers).toEqual(['E1']);
    expect(result?.content).toContain('short quote + t1');
    expect(result?.content).toContain('MemoryWrite type=feedback');
    expect(result?.content).not.toContain('agent.behavior');
  });
  it('does not instruct unavailable TodoList notes writes', () => {
    const result = new TodoListReminderTracker().evaluate({ ...base, active: false, history: [user('never push to main')], memoryAvailable: true });
    expect(result?.content).toContain('MemoryWrite type=feedback');
    expect(result?.content).not.toContain('notes.');
    expect(result?.content).not.toContain('TodoList');
  });
  it('does not suppress a generic history reference with unrelated notes or human rules', () => {
    const history = [user('以后模型只能用 example-model'), user('按我之前定的规矩来', 2)];
    expect(new TodoListReminderTracker().evaluate({ ...base, history, notes: { directives: '并发最多五个', decided: 'use example-model' } })?.disclosure.triggers).toEqual(['E2']);
  });
  it.each(['(none)', '- t1: 以后回答都用中文'])('isolates the handoff user block from its closing prose: %s', (block) => {
    const summary: ContextMessage = { role: 'user', toolCalls: [], origin: { kind: 'compaction_summary' }, content: [{ type: 'text', text: `## User input since notes\n${block}\n\nApply Standing directives at their recorded scope.\n\n## TODO List\n(none)` }] };
    const input = { ...base, todos: [], epoch: 1, history: [summary], notes: { goal: 'task' }, notesMeta: { rev: 1, hash: 'h', coveredMessageId: 'none', writtenStep: 't1.0', writtenTurn: 1, windowEpoch: 0 } };
    const result = new TodoListReminderTracker().evaluate(input);
    expect(result?.disclosure.triggers.includes('P1') ?? false).toBe(block !== '(none)');
  });
  it('bounds replay deduplication and preserves the latest input and step retries', () => {
    let state = initialContinuityClock();
    for (let i = 0; i < 300; i++) {
      state = advanceContinuityClock(state, new TurnPrompt({ turnId: i, promptId: `p${i}`, origin: { kind: 'user' }, input: [] }));
      state = successfulStep(state, i);
      state = advanceContinuityClock(state, new ContextAppendMessage({ message: { role: 'user', toolCalls: [], content: [], origin: { kind: 'injection', variant: 'todo_list_reminder', disclosure: { triggers: ['E1'], inputId: `p${i}@0` } } } }));
    }
    expect(state.inputIds).toHaveLength(256);
    expect(state.stepIds).toHaveLength(256);
    expect(state.deliveredInputs).toHaveLength(256);
    expect(state).toMatchObject({ humanTurnOrdinal: 300, workStepOrdinal: 300 });
    expect(successfulStep(state, 299).workStepOrdinal).toBe(300);
  });
});

describe('general behavior scope gates', () => {
  it.each(['别用 emoji', '不要用 emoji', '禁止使用 emoji', 'never push to main', "don't push to main", 'do not push to main'])('keeps explicit prohibitions: %s', (text) => {
    expect(classifyDirectives(text)[0]?.subject).toBe('agent.behavior');
  });
  it.each([
    '默认白色主题会视觉疲劳没有重点、注意颜色的运用',
    '工作区记忆也让用户选择开关，默认是放在某个地方',
    '好的，我确定了',
    '顶多减少压缩失败的默认重试次数',
    '然后避免让用户每次输密码，我们默认策略还是记住的',
    '上下文真实上限比如128k，然后里面做快捷值可以参考这些真实上限',
    '如果我们默认不使用worktree直接改的语义按照这样来设计呢',
    '等这波做完promote以后就可以用清空式压缩了',
    '没问题，这其实是默认值的选择，然后用户手动切换还是听用户的',
    '默认没必要筛选失败的，需要用户操作的倒是默认可以区分',
    '回车语义可以设置，默认是发送',
    '设置按钮为什么这么小，默认应该占据整个底部',
    '我的记忆系统为什么现在默认禁用，他真的好了吗',
    '让他帮我写个设计稿，然后默认的外观换一下',
    '代码单纯的名字换一下，但是它必须是独立仓库',
    '为什么默认配色是蓝色，之前定了方向你安排了吗',
    '之前需要我拍板的example-space-design，考虑一下如何结合',
  ])('rejects product discussions or acknowledgments: %s', (text) => {
    expect(classifyDirectives(text)).toEqual([]);
  });
});

describe('standing-rule review boundaries', () => {
  it.each([
    '以后不要擅自删除文件', '你以后都不要擅自删除文件',
    '测试默认用 vitest', 'By default, use Chinese for all answers',
    '以后不要擅自更换模型', '你以后都不要擅自更换模型',
    '你不要擅自删除文件', '以后禁止删除文件',
    '以后检查退出码', '每次完成任务检查退出码',
    '测试默认不要跳过失败用例', '测试默认把日志保存到 docs/',
  ])('recognizes persistent future prohibitions and default execution bindings: %s', (text) => {
    expect(classifyDirectives(text).length).toBeGreaterThan(0);
    expect(new TodoListReminderTracker().evaluate({ ...base, todos: [], history: [user(text)] })?.disclosure.triggers).toEqual(['E1']);
  });
  it('describes whole-list writes without injecting or reciting the list', () => {
    const result = new TodoListReminderTracker().evaluate({ ...base, history: [work], clock: clock() });
    expect(result?.disclosure.triggers).toEqual(['T0']);
    expect(result?.content).toContain('a todos write replaces the list');
    expect(result?.content).toContain('include every item you still need');
    expect(result?.content).toContain('Omit todos when unchanged');
    expect(result?.content).not.toContain('ongoing work');
  });
  it('does not cool unrelated unclassified references across human inputs', () => {
    const testing = '还记得我之前说的测试规矩吗';
    const documents = '查一下我之前定的文档目录规则';
    const state = clock({ humanTurnOrdinal: 1, latestInput: { id: 'testing', text: testing } });
    const first = new TodoListReminderTracker().evaluate({ ...base, todos: [], history: [], clock: state })!;
    expect(first.disclosure.triggers).toEqual(['E2']);
    const restored = advanceContinuityClock(state, new ContextAppendMessage({ message: { role: 'user', toolCalls: [], content: [], origin: { kind: 'injection', variant: 'todo_list_reminder', disclosure: first.disclosure } } }));
    expect(new TodoListReminderTracker().evaluate({ ...base, todos: [], history: [], clock: restored })).toBeUndefined();
    const next = { ...restored, humanTurnOrdinal: 2, latestInput: { id: 'documents', text: documents } };
    const second = new TodoListReminderTracker().evaluate({ ...base, todos: [], history: [], clock: next });
    expect(second?.disclosure.triggers).toEqual(['E2']);
    expect(second?.content).toContain('earlier rule, decision, or document');
    expect(second?.content).toContain('if the reference is still missing');
    expect(second?.content).not.toContain('that is not visible here');
  });
  it('still cools an identified artifact across inputs', () => {
    const text = '之前的 example-plan.md，查一下';
    const state = clock({ humanTurnOrdinal: 1, latestInput: { id: 'artifact-a', text } });
    const first = new TodoListReminderTracker().evaluate({ ...base, todos: [], history: [], clock: state })!;
    expect(first.disclosure.historyTopic).toBe('artifact:example-plan.md');
    const restored = advanceContinuityClock(state, new ContextAppendMessage({ message: { role: 'user', toolCalls: [], content: [], origin: { kind: 'injection', variant: 'todo_list_reminder', disclosure: first.disclosure } } }));
    expect(new TodoListReminderTracker().evaluate({ ...base, todos: [], history: [], clock: { ...restored, humanTurnOrdinal: 2, latestInput: { id: 'artifact-b', text } } })).toBeUndefined();
  });
});
