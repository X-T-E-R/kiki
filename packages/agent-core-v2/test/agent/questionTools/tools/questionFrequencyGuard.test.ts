import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestInstantiationService } from '#/_base/di/test';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { CoreErrors } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IConfigService } from '#/app/config/config';
import { IModelService, type ModelRecord } from '#/kosong/model/model';
import { IAgentProfileService } from '#/agent/profile/profile';
import { TurnStarted } from '#/agent/loop/turnEvents';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { SessionInteractionService } from '#/session/interaction/interactionService';
import { ISessionQuestionService } from '#/session/question/question';
import { SessionQuestionService } from '#/session/question/questionService';
import { IQuestionFrequencyGuard, QuestionFrequencyGuard, QUESTION_FREQUENCY_REMINDER } from '#/agent/tools/ask-user-question/questionFrequencyGuard';
import { IAskUserQuestionTool, type AskUserQuestionInput } from '#/agent/tools/ask-user-question/ask-user-question';
import { AskUserQuestionTool } from '#/agent/tools/ask-user-question/askUserQuestionTool';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { QuestionBackgroundTask } from '#/agent/tools/ask-user-question/question-background-task';
import type { InteractionConfig } from '#/agent/tools/ask-user-question/configSection';
import { executeTool } from '../../../tools/fixtures/execute-tool';

const input: AskUserQuestionInput = { questions: [{ question: 'Choose the release target', header: 'Release', options: [{ label: 'Staging', description: 'Test rollout' }, { label: 'Production', description: 'Public rollout' }], multi_select: false }] };
const hosts: TestInstantiationService[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); vi.useRealTimers(); });

function fixture(config: InteractionConfig = { askUserQuestion: 'background', askUserQuestionGuard: { enabled: true } }) {
  const ix = new TestInstantiationService();
  hosts.push(ix);
  let currentConfig = config;
  let modelId = 'a';
  const models: Record<string, ModelRecord> = { a: { behavior: undefined }, b: { behavior: { askUserQuestionGuard: { enabled: false } } } };
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.set(ISessionStateService, new SyncDescriptor(SessionStateService));
  ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
  ix.set(ISessionQuestionService, new SyncDescriptor(SessionQuestionService));
  ix.stub(IConfigService, { get: <T>() => currentConfig as T });
  ix.stub(IModelService, { get: (id) => models[id], resolveId: (id) => id === 'alias-b' ? 'b' : id });
  ix.stub(IAgentProfileService, { getModel: () => modelId });
  ix.set(IQuestionFrequencyGuard, new SyncDescriptor(QuestionFrequencyGuard));
  const guard = ix.get(IQuestionFrequencyGuard);
  const events = ix.get(IEventBus);
  const interaction = ix.get(ISessionInteractionService);
  interaction.acquireConsumer('test');
  ix.stub(ITelemetryService, { track2: vi.fn() });
  ix.stub(IAgentScopeContext, { agentId: 'main' });
  let background: QuestionBackgroundTask | undefined;
  const registerTask = vi.fn((task: QuestionBackgroundTask) => { background = task; return 'question-task'; });
  ix.stub(IAgentTaskService, { registerTask, getTask: () => undefined });
  ix.set(IAskUserQuestionTool, new SyncDescriptor(AskUserQuestionTool));
  const tool = ix.get(IAskUserQuestionTool);
  let turnId = 0;
  let callId = 0;
  const round = (origin: PromptOrigin = { kind: 'user' }) => events.publish(new TurnStarted({ turnId: ++turnId, origin }));
  const call = (args = input, step?: number, signal = new AbortController().signal, id = `call-${++callId}`) => executeTool(tool, { turnId, step, toolCallId: id, args, signal });
  const settle = async () => { await Promise.resolve(); const questions = interaction.listPending('question'); for (const q of questions) interaction.respond(q.id, null); };
  return { ix, guard, models, interaction, registerTask, round, call, settle,
    setModel: (id: string) => { modelId = id; }, setConfig: (value: InteractionConfig) => { currentConfig = value; },
    startBackground: async (signal = new AbortController().signal) => background!.start({ signal, appendOutput: vi.fn(), settle: vi.fn() }),
  };
}

async function admitted(f: ReturnType<typeof fixture>) { const pending = f.call(); await f.settle(); return pending; }

describe('AskUserQuestion frequency guard on actual interaction acceptance', () => {
  it('defaults off and still accepts repeated questions', async () => {
    const f = fixture({ askUserQuestion: 'background' }); f.round();
    for (let i = 0; i < 5; i++) expect((await admitted(f)).isError).toBe(false);
  });
  it('warns once, creates no question/task, allows the next explicit call once and warns again', async () => {
    const f = fixture(); f.round();
    expect((await admitted(f)).isError).toBe(false);
    const reminder = await f.call({ ...input, background: true });
    expect(reminder).toEqual({ isError: true, output: QUESTION_FREQUENCY_REMINDER });
    expect(f.registerTask).not.toHaveBeenCalled(); expect(f.interaction.listPending()).toHaveLength(0);
    expect((await admitted(f)).isError).toBe(false);
    expect((await f.call()).isError).toBe(true);
  });
  it('counts a 1–4 question batch as one accepted invocation', async () => {
    const f = fixture(); f.round();
    const pending = f.call({ questions: Array.from({ length: 4 }, (_, i) => ({ ...input.questions[0]!, question: `Target ${i}?` })) });
    await f.settle(); expect((await pending).isError).toBe(false); expect((await f.call()).isError).toBe(true);
  });
  it('keeps the user round through question-answer task, retry and compaction turns', async () => {
    const f = fixture(); f.round(); await admitted(f);
    f.round({ kind: 'task', taskId: 'question-task', status: 'completed', notificationId: 'note' });
    f.round({ kind: 'retry' }); f.round({ kind: 'compaction_summary' });
    expect((await f.call()).isError).toBe(true);
    f.round(); expect((await admitted(f)).isError).toBe(false);
  });
  it('normal fourth invocation in a rolling 10-minute window warns across fresh user rounds; exact expiry allows', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const f = fixture();
    for (let i = 0; i < 3; i++) { f.round(); expect((await admitted(f)).isError).toBe(false); }
    f.round(); expect((await f.call()).isError).toBe(true);
    vi.setSystemTime(new Date('2026-01-01T00:10:00Z')); f.round(); expect((await admitted(f)).isError).toBe(false);
  });
  it('no consumer, pre-send abort and invalid input do not count; accepted cancellation does count', async () => {
    const f = fixture(); f.round(); f.interaction.releaseConsumer('test');
    expect((await f.call()).output).toContain('no_consumer');
    f.interaction.acquireConsumer('test');
    const controller = new AbortController(); controller.abort(); await expect(f.call(input, undefined, controller.signal)).rejects.toThrow();
    expect((await f.call({ questions: [input.questions[0]!, input.questions[0]!] })).isError).toBe(true);
    const pending = f.call(input, undefined, new AbortController().signal); await Promise.resolve();
    f.interaction.cancelPendingForTurn(1, 'main'); expect((await pending).output).toContain('turn_ended');
    expect((await f.call()).output).toBe(QUESTION_FREQUENCY_REMINDER);
  });
  it('background starts consume only when actually parked, including dismissal', async () => {
    const f = fixture(); f.round(); expect((await f.call({ ...input, background: true })).isError).toBe(false);
    const task = f.startBackground(); await f.settle(); await task;
    expect((await f.call()).output).toBe(QUESTION_FREQUENCY_REMINDER);
  });
  it('unsupported and failed pre-send requests do not count; aborted pre-start background reservations are released', async () => {
    const f = fixture(); f.round();
    const request = vi.spyOn(f.ix.get(ISessionQuestionService), 'request');
    request.mockRejectedValueOnce(new Error2(CoreErrors.codes.NOT_IMPLEMENTED, 'unsupported'));
    expect((await f.call()).output).toContain('does not support');
    request.mockRejectedValueOnce(new Error('pre-send failed'));
    expect((await f.call()).output).toContain('pre-send failed');
    await f.call({ ...input, background: true }); const controller = new AbortController(); controller.abort(); await f.startBackground(controller.signal);
    expect((await admitted(f)).isError).toBe(false); expect((await f.call()).output).toBe(QUESTION_FREQUENCY_REMINDER);
  });
  it('holds concurrent no-step calls behind the reminder until a later explicit invocation', async () => {
    const f = fixture(); f.round(); const first = f.call(); const second = f.call(); const third = f.call();
    await f.settle(); expect((await first).isError).toBe(false); expect((await second).isError).toBe(true); expect((await third).isError).toBe(true);
    expect((await admitted(f)).isError).toBe(false);
  });
  it('keeps independent agent instances isolated', async () => {
    const a = fixture(); const b = fixture(); a.round(); b.round();
    await admitted(a); expect((await a.call()).isError).toBe(true); expect((await admitted(b)).isError).toBe(false);
  });
  it('concurrent initial calls do not both send, same-step calls cannot consume a reminder, duplicate id never re-sends', async () => {
    const f = fixture(); f.round();
    const first = f.call(input, 1, undefined, 'one'); const duplicate = f.call(input, 1, undefined, 'one'); const second = f.call(input, 1);
    await f.settle(); await first; await duplicate; expect((await second).isError).toBe(true);
    expect((await f.call(input, 1)).isError).toBe(true);
    const next = f.call(input, 2); const parallel = f.call(input, 2); await f.settle();
    expect((await next).isError).toBe(false); expect((await parallel).isError).toBe(true);
    expect((await f.call(input, 2)).isError).toBe(true);
    const retry = f.call(input, 3); await f.settle(); expect((await retry).isError).toBe(false);
    expect((await f.call(input, 4)).isError).toBe(true);
  });
  it('inherits global field-by-field, false overrides true and model switches do not reset counts', async () => {
    const f = fixture(); f.round(); await admitted(f);
    f.setModel('alias-b'); expect((await admitted(f)).isError).toBe(false);
    f.setModel('a'); expect((await f.call()).isError).toBe(true);
    f.models['a']!.behavior = { askUserQuestionGuard: { maxPerUserRound: 10, maxPerWindow: 10 } };
    expect((await admitted(f)).isError).toBe(false);
    f.setConfig({ askUserQuestion: 'background', askUserQuestionGuard: { enabled: false } });
    f.models['a']!.behavior = { askUserQuestionGuard: { enabled: true, maxPerUserRound: 1 } };
    expect((await f.call()).isError).toBe(true);
  });
  it('a failed override before acceptance releases rather than permanently bypassing or losing the one-shot grant', async () => {
    const f = fixture(); f.round(); await admitted(f); await f.call();
    f.registerTask.mockImplementationOnce(() => { throw new Error('capacity'); });
    expect((await f.call({ ...input, background: true })).output).toBe('capacity');
    expect((await admitted(f)).isError).toBe(false);
    expect((await f.call()).isError).toBe(true);
  });
});
