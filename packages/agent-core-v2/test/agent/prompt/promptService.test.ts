import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { deferred } from '../../deferred';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';
import { userCancellationReason } from '#/_base/utils/abort';

import { Readable } from 'node:stream';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ContentPart } from '#/kosong/contract/message';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService, reservePrompt } from '#/agent/prompt/prompt';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentPlanService } from '#/features/plan/plan';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import {
  AgentPromptService,
  PromptAborted,
  PromptCompleted,
  PromptEnqueued,
  PromptMoved,
  PromptQueued,
  PromptQueueHoldChanged,
  PromptReplaced,
  PromptStarted,
  PromptSteered,
  PromptSubmitted,
  promptQueueKey,
  promptResolutionKey,
} from '#/agent/prompt/promptService';
import {
  IAgentProfileService,
  type BindAgentInput,
  type ProfileData,
} from '#/agent/profile/profile';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentTaskService, type AgentTaskInfo } from '#/agent/task/task';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IEventBus } from '#/app/event/eventBus';
import { IEventService } from '#/app/event/event';
import { EventBusService } from '#/app/event/eventBusService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, Error2 } from '#/errors';
import { createHooks } from '#/hooks';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionHistoryMutationService } from '#/session/historyMutation/historyMutation';
import { SessionHistoryMutationService } from '#/session/historyMutation/historyMutationService';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { IWireService } from '#/wire/wire';
import { IFileService } from '#/app/file/fileService';
import { ISessionMediaStore } from '#/agent/media/sessionMediaStore';

import { stubContextMemory } from '../contextMemory/stubs';
import { stubLoopWithHooks, stubToolExecutor, stubWire, type StubLoopOptions } from '../loop/stubs';
import { registerStateServices } from '../../state/stubs';
import { PromptStepRequest, SteerStepRequest } from '#/agent/prompt/promptStepRequests';

function message(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } };
}

function peerMessage(messageId: string, text: string): ContextMessage {
  return {
    id: messageId,
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: {
      kind: 'peer_thread',
      source: { hostId: 'host', workspaceId: 'source-workspace', sessionId: 'source-session' },
      messageId,
      acceptedAt: 1,
    },
  };
}

function bundledMessage(
  skillName: string,
  user: string,
  extra: readonly ContentPart[] = [],
): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: `<skill>${skillName}</skill>` }, { type: 'text', text: user }, ...extra],
    toolCalls: [],
    origin: { kind: 'user', skillActivations: [{ activationId: `act-${skillName}`, skillName }] },
  };
}

function goalSnapshot(objective: string) {
  return {
    goalId: 'created-goal',
    objective,
    status: 'active' as const,
    turnsUsed: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    budget: {
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
    },
  };
}

const noopBlob: IAgentBlobService = {
  _serviceBrand: undefined,
  offloadParts: async (parts) => parts,
  loadParts: async (parts) => parts,
  isBlobRef: () => false,
};

function boundProfileData(profileName: string): ProfileData {
  return {
    profileName,
    modelAlias: `${profileName}-model`,
    modelCapabilities: {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: true,
      tool_use: true,
      max_context_tokens: 1_000_000,
    },
    thinkingLevel: `${profileName}-thinking`,
    systemPrompt: `${profileName} system prompt`,
    activeToolNames: [`${profileName}-tool`],
    subagents: [`${profileName}-subagent`],
    spawnPolicy: { allowedModels: [`${profileName}-spawn-model`] },
  };
}

function harness(loopOptions: StubLoopOptions = { pendingTurnResult: true }) {
  const disposables = new DisposableStore();
  onTestFinished(() => disposables.dispose());
  const context = stubContextMemory();
  const loop = stubLoopWithHooks(loopOptions);
  const fullCompaction = {
    _serviceBrand: undefined,
    compacting: null,
    begin: () => false,
    hooks: createHooks(['onWillCompact']),
    onDidFinishCompaction: Event.None,
  } as unknown as IAgentFullCompactionService;
  const intake = {
    get: vi.fn(async () => ({
      meta: {
        id: 'file_1',
        size: 3,
        name: 'pic.png',
        media_type: 'image/png',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      stream: () => Readable.from([new Uint8Array([1, 2, 3])]),
    })),
    materialize: vi.fn(async (): Promise<string | undefined> => undefined),
  };
  let profileState = boundProfileData('initial');
  let providerTypeOverride: string | undefined;
  const profile = {
    data: vi.fn(() => profileState),
    bind: vi.fn(async (input: BindAgentInput) => {
      profileState = boundProfileData(input.profile ?? profileState.profileName ?? 'initial');
      if (input.model !== undefined) profileState = { ...profileState, modelAlias: input.model };
      if (input.thinking !== undefined) {
        profileState = { ...profileState, thinkingLevel: input.thinking };
      }
    }),
    setModel: vi.fn(async (model: string) => {
      profileState = { ...profileState, modelAlias: model };
      return { model };
    }),
    setThinking: vi.fn((thinking: string) => {
      profileState = { ...profileState, thinkingLevel: thinking };
    }),
    isRunnable: vi.fn(() =>
      profileState.profileName !== undefined && profileState.modelAlias !== undefined,
    ),
    getModelProviderType: vi.fn((): string | undefined => providerTypeOverride),
  };
  const toolPolicy = {
    setSessionDisabledTools: vi.fn(async (_disabledTools: readonly string[]) => {}),
  };
  const plan = {
    status: vi.fn<IAgentPlanService['status']>().mockResolvedValue(null),
    enter: vi.fn<IAgentPlanService['enter']>().mockResolvedValue(undefined),
    exit: vi.fn(),
  };
  const swarm = { isActive: false, enter: vi.fn(), exit: vi.fn() };
  const goal = {
    getGoal: vi.fn<IAgentGoalService['getGoal']>().mockReturnValue({ goal: null }),
    createGoal: vi.fn<IAgentGoalService['createGoal']>(),
    pauseGoal: vi.fn<IAgentGoalService['pauseGoal']>(),
    resumeGoal: vi.fn<IAgentGoalService['resumeGoal']>(),
    cancelGoal: vi.fn<IAgentGoalService['cancelGoal']>(),
  };
  let agentMeta: Record<string, unknown> = {};
  const metadata = {
    read: async () => ({
      id: 'test-session',
      createdAt: 0,
      updatedAt: 0,
      archived: false,
      agents: { main: agentMeta },
    }),
    update: async () => {},
    registerAgent: async (_agentId: string, next: Record<string, unknown>) => {
      agentMeta = next;
    },
  };
  let activeTasks: readonly AgentTaskInfo[] = [];
  const taskService = { list: vi.fn(() => activeTasks) };
  const ix = createServices(disposables, {
    strict: true, additionalServices: (reg) => {
      registerStateServices(reg);
      reg.defineInstance(IAgentContextMemoryService, context);
      reg.defineInstance(IAgentLoopService, loop);
      reg.definePartialInstance(IAgentTaskService, taskService);
      reg.definePartialInstance(IAgentProfileService, profile);
      reg.definePartialInstance(IAgentPlanService, plan);
      reg.definePartialInstance(IAgentSwarmService, swarm);
      reg.definePartialInstance(IAgentGoalService, goal);
      reg.defineInstance(IWireService, stubWire());
      reg.defineInstance(IAgentBlobService, noopBlob);
      reg.define(IEventDispatcher, EventDispatcherService);
      reg.defineInstance(IAgentToolExecutorService, stubToolExecutor());
      reg.definePartialInstance(IAgentToolPolicyService, toolPolicy);
      reg.defineInstance(IAgentFullCompactionService, fullCompaction);
      reg.define(IEventBus, EventBusService);
      reg.define(IAgentSystemReminderService, AgentSystemReminderService);
      reg.define(ISessionHistoryMutationService, SessionHistoryMutationService);
      reg.define(IAgentPromptService, AgentPromptService);
      reg.definePartialInstance(ITelemetryService, { track: () => {}, track2: () => {} });
      reg.definePartialInstance(ISessionMetadata, metadata);
      reg.definePartialInstance(IEventService, { publish: () => {} });
      reg.definePartialInstance(ISessionContext, { sessionId: 'test-session' });
      reg.defineInstance(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: '' }));
      reg.definePartialInstance(IFileService, { get: intake.get });
      reg.definePartialInstance(ISessionMediaStore, { materialize: intake.materialize });
    }
  });
  return {
    target: { id: 'main', accessor: ix },
    prompt: ix.get(IAgentPromptService),
    plan,
    swarm,
    goal,
    profile,
    toolPolicy,
    loop,
    context,
    fullCompaction,
    eventBus: ix.get(IEventBus),
    dispatcher: ix.get(IEventDispatcher),
    states: ix.get(IAgentStateService),
    intake,
    setActiveTasks: (value: readonly AgentTaskInfo[]) => {
      activeTasks = value;
    },
    setProviderType: (value: string | undefined) => {
      providerTypeOverride = value;
    },
  };
}

describe('AgentPromptService', () => {
  it.each(['prompt', 'mailbox'] as const)('cancels a queued native %s run without cancelling another active turn', async (kind) => {
    const { prompt, loop, target } = harness({ manualTurnResult: true });
    const active = await prompt.enqueue({ id: 'active', message: message('other work') });
    const controller = new AbortController();
    const reason = userCancellationReason();
    const pending = runAgentTurn(target, kind === 'prompt'
      ? { kind, prompt: 'cancel this run' }
      : { kind, prompt: 'cancel this run', message: message('cancel this run') }, { signal: controller.signal });
    const outcome = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(prompt.list().pending).toHaveLength(1));
    controller.abort(reason);
    expect(prompt.list().pending).toEqual([]);
    expect(await outcome).toBe(reason);
    expect(loop.cancels).toEqual([]);
    expect((await active.launched)?.signal.aborted).toBe(false);
    loop.settleActive();
    await active.completion;
    expect(loop.launches).toHaveLength(1);
  });

  it('cancels a queued native summary continuation without launching it or stopping unrelated work', async () => {
    const { prompt, loop, target } = harness({ manualTurnResult: true });
    const controller = new AbortController();
    const reason = userCancellationReason();
    const run = await runAgentTurn(target, { kind: 'prompt', prompt: 'initial work' }, {
      signal: controller.signal,
      summaryPolicy: { minChars: 100, retries: 1, continuationPrompt: 'write summary' },
    });
    const outcome = run.completion.catch((error: unknown) => error);
    const other = await prompt.enqueue({ id: 'other', message: message('other work') });
    loop.settleActive();
    await other.launched;
    await vi.waitFor(() => expect(prompt.list().pending).toHaveLength(1));
    controller.abort(reason);
    expect(prompt.list().pending).toEqual([]);
    expect(await outcome).toBe(reason);
    expect((await other.launched)?.signal.aborted).toBe(false);
    expect(loop.cancels.every((cancel) => cancel.turnId === run.turn.id)).toBe(true);
    loop.settleActive();
    await other.completion;
    expect(loop.launches).toHaveLength(2);
  });

  it('cancels a queued prompt while it is launching without cancelling the next prompt', async () => {
    const { prompt, loop } = harness({ manualTurnResult: true });
    const first = await prompt.enqueue({ id: 'first', message: message('first') });
    const gate = deferred<void>();
    const entered = deferred<void>();
    prompt.hooks.onBeforeSubmitPrompt.register('hold-launch', async (context, next) => {
      if (context.promptMessage.id === 'launching') {
        entered.resolve();
        await gate.promise;
      }
      await next();
    });
    const controller = new AbortController();
    const launching = await reservePrompt(prompt, 'launching').submit(message('second'), undefined, undefined, undefined, controller.signal);
    const next = await prompt.enqueue({ id: 'next', message: message('third') });
    loop.settleActive();
    await first.completion;
    await entered.promise;
    expect(prompt.list().launching?.id).toBe('launching');
    controller.abort(new Error('stop second'));
    expect((await launching.completion).state).toBe('cancelled');
    expect(loop.cancels).toEqual([]);
    gate.resolve();
    await next.launched;
    expect(prompt.list().active?.id).toBe('next');
    expect(() => prompt.abort('launching')).toThrow(expect.objectContaining({ code: ErrorCodes.PROMPT_NOT_FOUND }));
    expect(loop.cancels).toEqual([]);
    loop.settleActive();
    await next.completion;
  });

  it('holds an assigned launching cancellation until its own turn settles', async () => {
    const { prompt, loop } = harness({ manualTurnResult: true });
    const enqueue = loop.enqueue.bind(loop);
    const gate = deferred<void>();
    const entered = deferred<void>();
    vi.spyOn(loop, 'enqueue').mockImplementation((request, options) => {
      const receipt = enqueue(request, options);
      entered.resolve();
      return { assigned: gate.promise.then(() => receipt.assigned), abort: receipt.abort };
    });
    const submitted = prompt.enqueue({ id: 'assigning', message: message('work') });
    await entered.promise;
    expect(prompt.abort('assigning')).toBe(true);
    let returned = false;
    void submitted.then(() => { returned = true; });
    await Promise.resolve();
    expect(returned).toBe(false);
    gate.resolve();
    const handle = await submitted;
    const turn = await handle.launched;
    expect(turn?.signal.aborted).toBe(true);
    let completed = false;
    void handle.completion.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    loop.settleActive({ type: 'cancelled', steps: 0, reason: new Error('stopped') });
    expect((await handle.completion).state).toBe('cancelled');
  });

  it('cancels an in-flight steer assignment without settling before its assigned turn', async () => {
    const { prompt, loop } = harness({ manualTurnResult: true });
    const active = await prompt.enqueue({ id: 'active', message: message('first') });
    const activeTurn = await active.launched;
    const controller = new AbortController();
    const selected = await reservePrompt(prompt, 'selected').submit(message('steer'), undefined, undefined, undefined, controller.signal);
    const next = await prompt.enqueue({ id: 'next', message: message('next') });
    const gate = deferred<void>();
    const entered = deferred<void>();
    const enqueue = loop.enqueue.bind(loop);
    vi.spyOn(loop, 'enqueue').mockImplementation((request, options) => {
      const receipt = enqueue(request, options);
      if (!(request instanceof SteerStepRequest)) return receipt;
      entered.resolve();
      return { assigned: gate.promise.then(() => receipt.assigned), abort: receipt.abort };
    });
    const steering = prompt.steer([selected.id]);
    await entered.promise;
    controller.abort(new Error('cancel during assignment'));
    expect(loop.cancels).toEqual([{ turnId: activeTurn!.id, reason: controller.signal.reason }]);
    let settled = false;
    void selected.completion.then(() => { settled = true; });
    gate.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    loop.settleActive({ type: 'cancelled', steps: 0, reason: controller.signal.reason });
    await steering;
    expect((await selected.completion).state).toBe('cancelled');
    expect((await next.launched)?.signal.aborted).toBe(false);
    expect(loop.cancels).toHaveLength(1);
    loop.settleActive();
    await next.completion;
  });

  it('cancels a steered prompt by its original turn and never a later active prompt', async () => {
    const { prompt, loop } = harness({ manualTurnResult: true });
    const controller = new AbortController();
    const active = await prompt.enqueue({ id: 'active', message: message('first') });
    const steered = await reservePrompt(prompt, 'steered').submit(message('steer'), undefined, undefined, undefined, controller.signal);
    const turn = await active.launched;
    await prompt.steer(['steered']);
    controller.abort(new Error('stop steer'));
    expect(loop.cancels).toEqual([{ turnId: turn!.id, reason: controller.signal.reason }]);
    loop.settleActive({ type: 'cancelled', steps: 0, reason: controller.signal.reason });
    expect((await steered.completion).state).toBe('cancelled');
    const later = await prompt.enqueue({ id: 'later', message: message('later') });
    expect(() => prompt.abort('steered')).toThrow(expect.objectContaining({ code: ErrorCodes.PROMPT_NOT_FOUND }));
    expect(loop.cancels).toHaveLength(1);
    expect((await later.launched)?.signal.aborted).toBe(false);
    loop.settleActive();
    await later.completion;
  });

  it.each(['prompt.accepted', 'prompt.enqueued'])('cancels during %s persistence without starting or recovering a prompt', async (type) => {
    const { prompt, dispatcher, states, loop } = harness();
    const dispatch = dispatcher.dispatch.bind(dispatcher);
    const entered = deferred<void>();
    const gate = deferred<void>();
    vi.spyOn(dispatcher, 'dispatch').mockImplementation(async (event) => {
      await dispatch(event);
      if (event.type === type) {
        entered.resolve();
        await gate.promise;
      }
    });
    const controller = new AbortController();
    const submitted = reservePrompt(prompt, 'admission').submit(message('work'), undefined, undefined, undefined, controller.signal);
    const rejected = expect(submitted).rejects.toMatchObject({ code: ErrorCodes.PROMPT_ALREADY_COMPLETED });
    await entered.promise;
    controller.abort(new Error('cancel admission'));
    gate.resolve();
    await rejected;
    expect(prompt.list().pending).toEqual([]);
    expect(prompt.list().active).toBeUndefined();
    expect(loop.launches).toEqual([]);
    expect(states.get(promptQueueKey).entries.size).toBe(0);
  });

  it('removes a completed prompt signal listener before the next prompt starts', async () => {
    const { prompt, loop } = harness({ manualTurnResult: true });
    const controller = new AbortController();
    const first = await reservePrompt(prompt, 'complete').submit(message('first'), undefined, undefined, undefined, controller.signal);
    loop.settleActive();
    await first.completion;
    const next = await prompt.enqueue({ id: 'next', message: message('next') });
    controller.abort(new Error('late stop'));
    expect(loop.cancels).toEqual([]);
    expect((await next.launched)?.signal.aborted).toBe(false);
    loop.settleActive();
    await next.completion;
  });

  it('applies runtime controls only after a prompt passes its submit hook', async () => {
    const { prompt, plan, swarm, goal } = harness();
    goal.createGoal.mockImplementation(async ({ objective }) => {
      const snapshot = {
        goalId: 'created-goal', objective, status: 'active' as const, turnsUsed: 0, tokensUsed: 0, wallClockMs: 0,
        budget: { tokenBudget: null, turnBudget: null, wallClockBudgetMs: null,
          remainingTokens: null, remainingTurns: null, remainingWallClockMs: null,
          tokenBudgetReached: false, turnBudgetReached: false, wallClockBudgetReached: false, overBudget: false },
      };
      goal.getGoal.mockReturnValue({ goal: snapshot });
      return snapshot;
    });
    prompt.hooks.onBeforeSubmitPrompt.register('observe-controls', async (_ctx, next) => {
      expect(plan.enter).not.toHaveBeenCalled();
      expect(swarm.enter).not.toHaveBeenCalled();
      expect(goal.createGoal).not.toHaveBeenCalled();
      await next();
    });
    const handle = await prompt.enqueue({ message: message('start'), execution: {
      planMode: true, swarmMode: true, goalObjective: 'finish the task', goalControl: 'resume',
    } });
    expect(handle.state).toBe('running');
    expect(plan.enter).toHaveBeenCalledOnce();
    expect(swarm.enter).toHaveBeenCalledWith('manual');
    expect(goal.createGoal).toHaveBeenCalledWith({ objective: 'finish the task' });
    expect(goal.resumeGoal).toHaveBeenCalledWith({});
  });

  it('does not apply queued controls when aborted or rejected for steering', async () => {
    const { prompt, plan, swarm, goal } = harness();
    await prompt.enqueue({ message: message('active') });
    const queued = await prompt.enqueue({ message: message('later'), execution: {
      planMode: true, swarmMode: true, goalObjective: 'later goal',
    } });
    await expect(prompt.steer([queued.id])).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
    expect(queued.state).toBe('pending');
    prompt.abort(queued.id);
    expect((await queued.completion).state).toBe('cancelled');
    expect(plan.enter).not.toHaveBeenCalled();
    expect(swarm.enter).not.toHaveBeenCalled();
    expect(goal.createGoal).not.toHaveBeenCalled();
  });

  it.each(['hook', 'profile'] as const)('leaves runtime controls untouched after %s failure', async (failure) => {
    const { prompt, plan, swarm, goal, profile } = harness();
    if (failure === 'hook') {
      prompt.hooks.onBeforeSubmitPrompt.register('block', async (ctx, next) => { ctx.block = true; await next(); });
    }
    if (failure === 'profile') profile.bind.mockRejectedValueOnce(new Error('profile unavailable'));
    const input = message('start');
    const handle = await prompt.enqueue({ message: input, execution: {
      profile: 'next', planMode: true, swarmMode: true, goalObjective: 'finish',
    } });
    expect(handle.state).toBe(failure === 'hook' ? 'blocked' : 'failed');
    expect(plan.enter).not.toHaveBeenCalled();
    expect(swarm.enter).not.toHaveBeenCalled();
    expect(goal.createGoal).not.toHaveBeenCalled();
  });

  it('rejects invalid goals before prompt admission and disabled-tool mutation', async () => {
    const { prompt, toolPolicy, plan } = harness();
    await expect(prompt.submit({ input: message('invalid').content, promptId: 'retryable', disabledTools: [],
      execution: { planMode: true, goalObjective: '   ' },
    })).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
    expect(toolPolicy.setSessionDisabledTools).not.toHaveBeenCalled();
    expect(plan.enter).not.toHaveBeenCalled();
    const reservation = reservePrompt(prompt, 'retryable');
    reservation.dispose();
  });

  it.each([false, true])('steers GUI mode echoes without rebinding the active turn: %s', async (enabled) => {
    const { prompt, plan, swarm } = harness();
    plan.status.mockResolvedValue(enabled ? { id: 'plan', path: '/plan', content: '' } : null);
    swarm.isActive = enabled;
    await prompt.enqueue({ message: message('active') });
    const queued = await prompt.enqueue({ message: message('follow-up'), execution: { planMode: enabled, swarmMode: enabled } });
    await expect(prompt.steer([queued.id])).resolves.toHaveLength(1);
    expect(queued.state).toBe('steered');
    expect(plan.enter).not.toHaveBeenCalled();
    expect(plan.exit).not.toHaveBeenCalled();
    expect(swarm.enter).not.toHaveBeenCalled();
    expect(swarm.exit).not.toHaveBeenCalled();
  });

  it('fails a queued prompt whose goal becomes invalid without applying other controls', async () => {
    const { prompt, loop, plan, swarm, goal } = harness({ manualTurnResult: true });
    await prompt.enqueue({ message: message('active') });
    const queued = await prompt.enqueue({ message: message('later'), execution: {
      planMode: true, swarmMode: true, goalObjective: 'finish',
    } });
    goal.getGoal.mockImplementation(() => { throw new Error2(ErrorCodes.REQUEST_INVALID, 'goal unavailable'); });
    loop.settleActive();
    expect((await queued.completion).state).toBe('failed');
    expect(plan.enter).not.toHaveBeenCalled();
    expect(swarm.enter).not.toHaveBeenCalled();
  });

  it('reports launch failure after controls without automatic replay or fake rollback', async () => {
    const { prompt, loop, plan } = harness();
    vi.spyOn(loop, 'enqueue').mockImplementation(() => { throw new Error('launch unavailable'); });
    await expect(prompt.submit({ input: message('launch').content, execution: { planMode: true } }))
      .rejects.toMatchObject({ code: ErrorCodes.INTERNAL });
    expect(plan.enter).toHaveBeenCalledOnce();
    expect(plan.exit).not.toHaveBeenCalled();
    expect(prompt.list()).toEqual({ active: undefined, pending: [] });
  });

  it('settles queued prompts when Loop admission closes during teardown', async () => {
    const { prompt, loop, plan } = harness({ manualTurnResult: true });
    await prompt.enqueue({ message: message('active') });
    const queued = await prompt.enqueue({ message: message('queued'), execution: { planMode: true } });
    vi.spyOn(loop, 'tryAcquireQuiescence').mockImplementation(() => { throw new Error('Agent loop disposed'); });
    loop.settleActive();
    expect((await queued.completion).state).toBe('cancelled');
    expect(plan.enter).not.toHaveBeenCalled();
  });

  it('assigns stable identity and launches an idle prompt', async () => {
    const { prompt } = harness();
    const handle = await prompt.enqueue({ id: 'prompt-1', message: message('hello') });
    expect(handle.id).toBe('prompt-1');
    expect(handle.userMessageId).toBe('prompt-1');
    expect((await handle.launched)?.id).toBe(0);
  });

  it('persists prompt resolution identities in replayable state', async () => {
    const { dispatcher, states } = harness();
    await dispatcher.dispatch(
      new PromptCompleted({
        promptId: 'completed',
        finishedAt: '2026-01-01T00:00:00.000Z',
        reason: 'completed',
      }),
    );
    await dispatcher.dispatch(
      new PromptAborted({ promptId: 'aborted', abortedAt: '2026-01-01T00:00:01.000Z' }),
    );
    await dispatcher.dispatch(
      new PromptSteered({
        activePromptId: 'active',
        promptIds: ['steered-1', 'steered-2'],
        content: [],
        steeredAt: '2026-01-01T00:00:02.000Z',
      }),
    );

    expect([...states.get(promptResolutionKey).keys()]).toEqual([
      'completed',
      'aborted',
      'steered-1',
      'steered-2',
    ]);
  });

  it('projects queued content, replacements, timing and order into durable prompt state', async () => {
    const { prompt, states } = harness({ manualTurnResult: true });
    await prompt.enqueue({ id: 'active', message: message('active') });
    await prompt.enqueue({ id: 'first', message: message('first'), appendTiming: 'tasks_done' });
    await prompt.enqueue({ id: 'second', message: message('second') });
    prompt.replace('first', [{ type: 'text', text: 'edited' }]);
    prompt.changeTiming('first', 'subagents_done', 1);
    prompt.move('second', 0);

    const persisted = states.get(promptQueueKey);
    expect(persisted.order).toEqual(['second', 'first']);
    expect(persisted.entries.get('first')).toMatchObject({
      appendTiming: 'subagents_done',
      revision: 2,
      message: { content: [{ type: 'text', text: 'edited' }] },
    });

    prompt.abort('second');
    expect(states.get(promptQueueKey).order).toEqual(['first']);
  });

  it('keeps later prompts in FIFO order while active', async () => {
    const { prompt } = harness();
    await prompt.enqueue({ message: message('active') });
    const first = await prompt.enqueue({ message: message('one') });
    const second = await prompt.enqueue({ message: message('two') });
    expect(prompt.list().pending.map((item) => item.id)).toEqual([first.id, second.id]);
  });

  it('launches the first ready prompt in manual order across all timing levels', async () => {
    const { prompt, loop, setActiveTasks } = harness({ manualTurnResult: true });
    await prompt.enqueue({ id: 'active', message: message('active') });
    setActiveTasks([
      { taskId: 'agent-1', description: 'agent', status: 'running', startedAt: 1, endedAt: null, kind: 'agent' },
      { taskId: 'process-1', description: 'build', status: 'running', startedAt: 1, endedAt: null, kind: 'process', command: 'build', pid: 1, exitCode: null, lifetime: 'finite' },
      { taskId: 'service-1', description: 'server', status: 'running', startedAt: 1, endedAt: null, kind: 'process', command: 'server', pid: 2, exitCode: null, lifetime: 'service' },
    ]);
    const tasksDone = await prompt.enqueue({ id: 'tasks', message: message('tasks'), appendTiming: 'tasks_done' });
    const idle = await prompt.enqueue({ id: 'idle', message: message('idle'), appendTiming: 'agent_idle' });
    const subagentsDone = await prompt.enqueue({ id: 'subagents', message: message('subagents'), appendTiming: 'subagents_done' });

    loop.settleActive();
    await idle.launched;
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['tasks', 'subagents']);

    setActiveTasks([{ taskId: 'process-1', description: 'build', status: 'running', startedAt: 1, endedAt: null, kind: 'process', command: 'build', pid: 1, exitCode: null, lifetime: 'finite' }]);
    loop.settleActive();
    await subagentsDone.launched;
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['tasks']);

    setActiveTasks([{ taskId: 'service-1', description: 'server', status: 'running', startedAt: 1, endedAt: null, kind: 'process', command: 'server', pid: 2, exitCode: null, lifetime: 'service' }]);
    loop.settleActive();
    await tasksDone.launched;
    expect(prompt.list().pending).toEqual([]);
  });

  it('changes queued timing in place with revision checks', async () => {
    const { prompt, setActiveTasks } = harness({ manualTurnResult: true });
    await prompt.enqueue({ id: 'active', message: message('active') });
    setActiveTasks([{ taskId: 'agent-1', description: 'agent', status: 'running', startedAt: 1, endedAt: null, kind: 'agent' }]);
    const queued = await prompt.enqueue({ id: 'queued', message: message('queued'), appendTiming: 'subagents_done' });

    const changed = prompt.changeTiming('queued', 'agent_idle', 0);
    expect(changed).toBe(queued);
    expect(changed.appendTiming).toBe('agent_idle');
    expect(changed.revision).toBe(1);
    expect(() => prompt.changeTiming('queued', 'tasks_done', 0)).toThrowError(
      expect.objectContaining({ code: ErrorCodes.REQUEST_INVALID }),
    );
  });

  it('moves queued prompts to an exact final index and publishes the resulting order', async () => {
    const { prompt, eventBus } = harness();
    const moved: Array<{ promptId: string; targetIndex: number; queuedPromptIds: string[] }> = [];
    eventBus.subscribe(PromptMoved, (event) => {
      moved.push({
        promptId: event.promptId,
        targetIndex: event.targetIndex,
        queuedPromptIds: event.queuedPromptIds,
      });
    });
    await prompt.enqueue({ id: 'active', message: message('active') });
    await prompt.enqueue({ id: 'a', message: message('a') });
    await prompt.enqueue({ id: 'b', message: message('b') });
    await prompt.enqueue({ id: 'c', message: message('c') });

    prompt.move('a', 2);
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['b', 'c', 'a']);
    expect(moved).toEqual([
      { promptId: 'a', targetIndex: 2, queuedPromptIds: ['b', 'c', 'a'] },
    ]);

    prompt.move('a', 0);
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(moved[1]).toEqual({
      promptId: 'a',
      targetIndex: 0,
      queuedPromptIds: ['a', 'b', 'c'],
    });
  });

  it('rejects moving a running, missing, or out-of-range prompt without mutating the queue', async () => {
    const { prompt } = harness();
    await prompt.enqueue({ id: 'active', message: message('active') });
    await prompt.enqueue({ id: 'queued', message: message('queued') });
    const before = prompt.list();

    expect(() => prompt.move('active', 0)).toThrowError(
      expect.objectContaining({ code: ErrorCodes.PROMPT_NOT_FOUND }),
    );
    expect(() => prompt.move('missing', 0)).toThrowError(
      expect.objectContaining({ code: ErrorCodes.PROMPT_NOT_FOUND }),
    );
    expect(() => prompt.move('queued', 1)).toThrowError(
      expect.objectContaining({ code: ErrorCodes.REQUEST_INVALID }),
    );
    expect(prompt.list()).toEqual(before);
  });

  it('atomically replaces a queued prompt without changing identity, order, or terminal state', async () => {
    const { prompt, context, eventBus, loop } = harness({ manualTurnResult: true });
    const replaced: Array<{ promptId: string; content: ContentPart[] }> = [];
    const aborted: string[] = [];
    eventBus.subscribe(PromptReplaced, (event) => {
      replaced.push({ promptId: event.promptId, content: event.content });
    });
    eventBus.subscribe(PromptAborted, (event) => aborted.push(event.promptId));
    const active = await prompt.enqueue({ id: 'active', message: message('active') });
    await active.launched;
    const attachment = {
      type: 'image_url',
      imageUrl: { url: 'https://example.test/queued.png' },
    } as const;
    const queued = await prompt.enqueue({
      id: 'queued',
      message: bundledMessage('review', 'old text', [attachment]),
    });
    await prompt.enqueue({ id: 'later', message: message('later') });
    const before = prompt.list().pending[0]!;

    const returned = prompt.replace('queued', [{ type: 'text', text: 'new text' }]);

    expect(returned).toBe(queued);
    expect(returned.state).toBe('pending');
    expect(returned.createdAt).toBe(before.createdAt);
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['queued', 'later']);
    expect(prompt.list().pending[0]?.message.content).toEqual([
      { type: 'text', text: '<skill>review</skill>' },
      { type: 'text', text: 'new text' },
      attachment,
    ]);
    expect(replaced).toEqual([
      { promptId: 'queued', content: [{ type: 'text', text: 'new text' }, attachment] },
    ]);
    expect(aborted).toEqual([]);

    loop.settleActive();
    await queued.launched;
    loop.drainNextBatch(context);
    loop.drainNextBatch(context);
    expect(context.get().find((entry) => entry.id === 'queued')?.content).toEqual([
      { type: 'text', text: '<skill>review</skill>' },
      { type: 'text', text: 'new text' },
      attachment,
    ]);
  });

  it('rejects replacing running, missing, and completed prompts without mutating the queue', async () => {
    const { prompt, loop } = harness({ manualTurnResult: true });
    const active = await prompt.enqueue({ id: 'active', message: message('active') });
    await active.launched;
    await prompt.enqueue({ id: 'queued', message: message('queued') });
    const before = prompt.list();

    expect(() => prompt.replace('active', [{ type: 'text', text: 'replacement' }])).toThrowError(
      expect.objectContaining({ code: ErrorCodes.PROMPT_NOT_FOUND }),
    );
    expect(() => prompt.replace('missing', [{ type: 'text', text: 'replacement' }])).toThrowError(
      expect.objectContaining({ code: ErrorCodes.PROMPT_NOT_FOUND }),
    );
    expect(prompt.list()).toEqual(before);

    prompt.abort('queued');
    loop.settleActive();
    await active.completion;
    expect(() => prompt.replace('active', [{ type: 'text', text: 'replacement' }])).toThrowError(
      expect.objectContaining({ code: ErrorCodes.PROMPT_NOT_FOUND }),
    );
    expect(prompt.list()).toEqual({ active: undefined, pending: [] });
  });

  it('preserves a queued prompt execution binding across replacement', async () => {
    const { prompt, profile, loop } = harness({ manualTurnResult: true });
    const inputs: ContentPart[][] = [];
    const enqueue = loop.enqueue.bind(loop);
    vi.spyOn(loop, 'enqueue').mockImplementation((request, options) => {
      if (request instanceof PromptStepRequest) inputs.push([...request.turnSeed.input]);
      return enqueue(request, options);
    });
    const active = await prompt.enqueue({ id: 'active', message: message('active') });
    await active.launched;
    const queued = await prompt.enqueue({
      id: 'queued',
      message: message('old text'),
      execution: { profile: 'A', model: 'replacement-model' },
    });

    prompt.replace('queued', [{ type: 'text', text: 'new text' }]);
    expect(profile.bind).not.toHaveBeenCalled();

    loop.settleActive();
    await queued.launched;
    expect(profile.bind).toHaveBeenCalledWith({
      profile: 'A',
      model: 'replacement-model',
      thinking: undefined,
      strictThinking: false,
    });
    expect(profile.setModel).toHaveBeenCalledWith('replacement-model');
    expect(inputs[1]).toEqual([{ type: 'text', text: 'new text' }]);
  });

  it('syncs the goal objective of a queued goal-creation prompt when its message is replaced', async () => {
    const { prompt, goal, loop, states, eventBus } = harness({ manualTurnResult: true });
    goal.createGoal.mockImplementation(async ({ objective }) => {
      const snapshot = goalSnapshot(objective);
      goal.getGoal.mockReturnValue({ goal: snapshot });
      return snapshot;
    });
    const replaced: Array<{ promptId: string; execution?: unknown }> = [];
    eventBus.subscribe(PromptReplaced, (event) => {
      replaced.push({ promptId: event.promptId, execution: event.execution });
    });
    const active = await prompt.enqueue({ id: 'active', message: message('active') });
    await active.launched;
    const queued = await prompt.enqueue({
      id: 'queued',
      message: message('start the goal'),
      execution: { goalObjective: 'old objective' },
    });

    prompt.replace('queued', [{ type: 'text', text: '  new objective  ' }]);

    expect(replaced).toEqual([
      { promptId: 'queued', execution: { goalObjective: 'new objective' } },
    ]);
    expect(
      (states.get(promptQueueKey).entries.get('queued') as { execution?: { goalObjective?: string } })
        .execution?.goalObjective,
    ).toBe('new objective');

    loop.settleActive();
    await queued.launched;
    expect(goal.createGoal).toHaveBeenCalledWith({ objective: 'new objective' });
  });

  it('leaves ordinary and already-bound queued executions unchanged when their message is replaced', async () => {
    const { prompt, goal, loop, states, eventBus } = harness({ manualTurnResult: true });
    const replaced: Array<{ promptId: string; execution?: unknown }> = [];
    eventBus.subscribe(PromptReplaced, (event) => {
      replaced.push({ promptId: event.promptId, execution: event.execution });
    });
    const active = await prompt.enqueue({ id: 'active', message: message('active') });
    await active.launched;
    await prompt.enqueue({ id: 'ordinary', message: message('ordinary') });
    goal.getGoal.mockReturnValue({ goal: goalSnapshot('existing objective') });
    await prompt.enqueue({
      id: 'bound',
      message: message('bound'),
      execution: { goalObjective: 'existing objective', goalControl: 'pause' },
    });

    prompt.replace('ordinary', [{ type: 'text', text: 'edited ordinary' }]);
    prompt.replace('bound', [{ type: 'text', text: 'edited bound' }]);

    expect(replaced).toEqual([
      { promptId: 'ordinary', execution: undefined },
      { promptId: 'bound', execution: undefined },
    ]);
    const entries = states.get(promptQueueKey).entries;
    expect((entries.get('ordinary') as { execution?: unknown }).execution).toBeUndefined();
    expect(
      (entries.get('bound') as { execution?: { goalObjective?: string } }).execution?.goalObjective,
    ).toBe('existing objective');
    expect(goal.createGoal).not.toHaveBeenCalled();
    expect(loop.launches).toEqual([0]);
  });

  it.each([1, 3])('sends only the selected recovered prompt as a new turn from a %s-item held queue', async (count) => {
    const { prompt, loop, dispatcher, states, profile, setActiveTasks } = harness({ manualTurnResult: true });
    for (let index = 0; index < count; index++) {
      const id = `recovered-${index}`;
      await dispatcher.dispatch(new PromptEnqueued({
        schemaVersion: 1,
        promptId: id,
        userMessageId: id,
        createdAt: '2026-01-01T00:00:00.000Z',
        message: message(id),
        execution: { profile: `profile-${index}` },
        goalId: null,
        alreadyMaterialized: false,
        appendTiming: 'tasks_done',
        revision: 0,
        queueIndex: index,
      }));
    }
    await dispatcher.hooks.onDidRestore.run({});
    setActiveTasks([{ taskId: 'busy-child', description: 'agent', status: 'running', startedAt: 1, endedAt: null, kind: 'agent' }]);
    expect(prompt.list().hold).toEqual({ reason: 'recovery', count });
    expect(loop.status().activeTurnId).toBeUndefined();
    const selectedId = `recovered-${count - 1}`;
    await expect(prompt.steer([selectedId, 'missing'])).rejects.toMatchObject({ code: ErrorCodes.PROMPT_NOT_FOUND });
    expect(loop.launches).toEqual([]);
    expect(prompt.list().hold).toEqual({ reason: 'recovery', count });

    const [selected] = await prompt.steer([selectedId]);
    expect((await selected!.launched)?.id).toBe(0);
    expect(loop.launches).toEqual([0]);
    expect(profile.bind).toHaveBeenCalledWith(expect.objectContaining({ profile: `profile-${count - 1}` }));
    expect(prompt.list().active?.id).toBe(selectedId);
    expect(states.get(promptQueueKey).order).not.toContain(selectedId);
    expect(prompt.list().pending).toHaveLength(count - 1);
    expect(prompt.list().hold).toEqual(count === 1 ? undefined : { reason: 'recovery', count: count - 1 });

    loop.settleActive();
    await selected!.completion;
    expect(loop.launches).toEqual([0]);
    if (count > 1) {
      const fresh = await prompt.enqueue({ id: 'fresh', message: message('new message') });
      expect(fresh.state).toBe('pending');
      expect(prompt.list().hold).toEqual({ reason: 'recovery', count });
      setActiveTasks([]);
      prompt.resumeRecoveredQueue();
      await vi.waitFor(() => expect(loop.launches).toEqual([0, 1]));
      expect(prompt.list().active?.id).toBe('recovered-0');
    }
  });

  it('rebuilds and releases the observable recovery hold from durable prompt state', async () => {
    const { prompt, goal, dispatcher, eventBus } = harness();
    const holds: Array<{ readonly reason: 'recovery'; readonly count: number } | null> = [];
    eventBus.subscribe(PromptQueueHoldChanged, (event) => holds.push(event.hold));
    goal.createGoal.mockImplementation(async ({ objective }) => {
      const snapshot = goalSnapshot(objective);
      goal.getGoal.mockReturnValue({ goal: snapshot });
      return snapshot;
    });
    await dispatcher.dispatch(new PromptEnqueued({
      schemaVersion: 1,
      promptId: 'recovered',
      userMessageId: 'recovered',
      createdAt: '2026-01-01T00:00:00.000Z',
      message: message('start the goal'),
      execution: { goalObjective: 'old objective' },
      goalId: null,
      alreadyMaterialized: true,
      appendTiming: 'agent_idle',
      revision: 0,
      queueIndex: 0,
    }));
    await dispatcher.dispatch(new PromptReplaced({
      promptId: 'recovered',
      content: [{ type: 'text', text: 'restored objective' }],
      message: message('restored objective'),
      execution: { goalObjective: 'restored objective' },
      revision: 1,
      replacedAt: '2026-01-01T00:00:01.000Z',
    }));

    await dispatcher.hooks.onDidRestore.run({});
    expect(prompt.list()).toMatchObject({
      active: undefined,
      pending: [{ id: 'recovered', revision: 1 }],
      hold: { reason: 'recovery', count: 1 },
    });
    await vi.waitFor(() => {
      expect(holds).toEqual([{ reason: 'recovery', count: 1 }]);
    });

    prompt.resumeRecoveredQueue();
    expect(prompt.list().hold).toBeUndefined();

    await vi.waitFor(() => {
      expect(holds).toEqual([{ reason: 'recovery', count: 1 }, null]);
      expect(goal.createGoal).toHaveBeenCalledWith({ objective: 'restored objective' });
    });
  });

  it('applies each queued execution binding only when its turn starts', async () => {
    const { prompt, profile, loop } = harness({ manualTurnResult: true });
    const turnBindings: ProfileData[] = [];
    const enqueue = loop.enqueue.bind(loop);
    vi.spyOn(loop, 'enqueue').mockImplementation((request, options) => {
      if (request instanceof PromptStepRequest) {
        turnBindings.push(structuredClone(profile.data()));
      }
      return enqueue(request, options);
    });

    const active = await prompt.enqueue({ id: 'active', message: message('active') });
    await active.launched;
    const first = await prompt.enqueue({
      id: 'q1',
      message: message('one'),
      execution: { profile: 'A' },
    });
    const second = await prompt.enqueue({
      id: 'q2',
      message: message('two'),
      execution: { profile: 'B' },
    });

    expect(profile.data()).toMatchObject(boundProfileData('initial'));
    expect(profile.bind).not.toHaveBeenCalled();
    expect(turnBindings).toEqual([expect.objectContaining(boundProfileData('initial'))]);

    loop.settleActive();
    await first.launched;
    expect(turnBindings[1]).toMatchObject({
      profileName: 'A',
      modelAlias: 'A-model',
      thinkingLevel: 'A-thinking',
      systemPrompt: 'A system prompt',
      activeToolNames: ['A-tool'],
      subagents: ['A-subagent'],
      spawnPolicy: { allowedModels: ['A-spawn-model'] },
    });
    expect(profile.data()).toMatchObject(turnBindings[1] as ProfileData);

    loop.settleActive();
    await second.launched;
    expect(turnBindings[2]).toMatchObject({
      profileName: 'B',
      modelAlias: 'B-model',
      thinkingLevel: 'B-thinking',
      systemPrompt: 'B system prompt',
      activeToolNames: ['B-tool'],
      subagents: ['B-subagent'],
      spawnPolicy: { allowedModels: ['B-spawn-model'] },
    });
    expect(profile.bind).toHaveBeenNthCalledWith(1, {
      profile: 'A',
      model: undefined,
      thinking: undefined,
      strictThinking: false,
    });
    expect(profile.bind).toHaveBeenNthCalledWith(2, {
      profile: 'B',
      model: undefined,
      thinking: undefined,
      strictThinking: false,
    });

    loop.settleActive();
    await second.completion;
  });

  it('applies deferred disabled tools after binding and before turn launch', async () => {
    const { prompt, profile, toolPolicy, loop } = harness();
    const enqueue = vi.spyOn(loop, 'enqueue');

    const handle = await prompt.enqueue({
      id: 'bootstrap',
      message: message('bootstrap'),
      execution: { profile: 'A' },
      deferredDisabledTools: ['Bash'],
    });
    await handle.launched;

    expect(toolPolicy.setSessionDisabledTools).toHaveBeenCalledWith(['Bash']);
    expect(profile.bind.mock.invocationCallOrder[0]).toBeLessThan(
      toolPolicy.setSessionDisabledTools.mock.invocationCallOrder[0] as number,
    );
    expect(toolPolicy.setSessionDisabledTools.mock.invocationCallOrder[0]).toBeLessThan(
      enqueue.mock.invocationCallOrder[0] as number,
    );
  });

  it('rejects a queued profile switch when the current profile is route-locked', async () => {
    const { prompt, profile, loop } = harness({ manualTurnResult: true });
    profile.data.mockReturnValue({
      ...boundProfileData('locked'),
      routeId: 'locked.route',
    });
    profile.bind.mockRejectedValue(
      new Error2(ErrorCodes.ROUTE_SWITCH_FORBIDDEN, 'route switch forbidden'),
    );
    const active = await prompt.enqueue({ id: 'active', message: message('active') });
    await active.launched;
    const queued = await prompt.enqueue({
      id: 'queued',
      message: message('queued'),
      execution: { profile: 'other' },
    });

    loop.settleActive();

    await expect(queued.completion).resolves.toMatchObject({ state: 'failed' });
    expect(profile.bind).toHaveBeenCalledWith({
      profile: 'other',
      model: undefined,
      thinking: undefined,
      strictThinking: false,
    });
    expect(loop.launches).toEqual([0]);
  });

  it('keeps same-name profile selection idempotent when a queued prompt starts', async () => {
    const { prompt, profile, loop } = harness({ manualTurnResult: true });
    const active = await prompt.enqueue({ id: 'active', message: message('active') });
    await active.launched;
    const queued = await prompt.enqueue({
      id: 'queued',
      message: message('queued'),
      execution: {
        profile: 'initial',
        model: 'override-model',
        thinking: 'override-thinking',
      },
    });

    loop.settleActive();
    await queued.launched;

    expect(profile.bind).not.toHaveBeenCalled();
    expect(profile.setModel).toHaveBeenCalledWith('override-model');
    expect(profile.setThinking).toHaveBeenCalledWith('override-thinking');
    expect(profile.data()).toMatchObject({
      profileName: 'initial',
      modelAlias: 'override-model',
      thinkingLevel: 'override-thinking',
    });
    loop.settleActive();
    await queued.completion;
  });

  it('deduplicates a peer origin already present in durable context', async () => {
    const { prompt, context, loop } = harness();
    context.append(peerMessage('peer-message-1', 'already delivered'));
    const enqueue = vi.spyOn(loop, 'enqueue');

    const handle = await prompt.enqueue({
      id: 'peer-message-1',
      message: peerMessage('peer-message-1', 'already delivered'),
    });

    expect(handle.state).toBe('completed');
    expect(enqueue).not.toHaveBeenCalled();
    await expect(handle.completion).resolves.toMatchObject({
      promptId: 'peer-message-1',
      state: 'completed',
    });
  });

  it('publishes prompt.queued only for prompts that cannot launch immediately', async () => {
    const { prompt, eventBus } = harness();
    const queued: Array<{ promptId: string; queueLength: number }> = [];
    eventBus.subscribe(PromptQueued, (e) => {
      queued.push({ promptId: e.promptId, queueLength: e.queueLength });
    });

    await prompt.enqueue({ id: 'active', message: message('active') });
    expect(queued).toEqual([]);

    await prompt.enqueue({ id: 'waiting', message: message('waiting') });
    expect(queued).toEqual([{ promptId: 'waiting', queueLength: 1 }]);
  });

  it('publishes prompt.submitted for every user prompt and prompt.started on launch', async () => {
    const { prompt, eventBus } = harness();
    const submitted: Array<{ promptId: string; userMessageId: string; status: string; content: ContentPart[] }> = [];
    const started: string[] = [];
    eventBus.subscribe(PromptSubmitted, (e) => {
      submitted.push({ promptId: e.promptId, userMessageId: e.userMessageId, status: e.status, content: e.content });
    });
    eventBus.subscribe(PromptStarted, (e) => {
      started.push(e.promptId);
    });

    const active = await prompt.enqueue({ id: 'active', message: message('active') });
    expect(submitted).toEqual([
      { promptId: 'active', userMessageId: 'active', status: 'running', content: [{ type: 'text', text: 'active' }] },
    ]);
    await active.launched;
    expect(started).toEqual(['active']);

    await prompt.enqueue({ id: 'waiting', message: message('waiting') });
    expect(submitted).toEqual([
      { promptId: 'active', userMessageId: 'active', status: 'running', content: [{ type: 'text', text: 'active' }] },
      { promptId: 'waiting', userMessageId: 'waiting', status: 'queued', content: [{ type: 'text', text: 'waiting' }] },
    ]);
    expect(started).toEqual(['active']);
  });

  it('suppresses lifecycle events for non-user-origin prompts', async () => {
    const { prompt, eventBus, loop } = harness({ manualTurnResult: true });
    const submitted: string[] = [];
    const started: string[] = [];
    const completed: string[] = [];
    const aborted: string[] = [];
    eventBus.subscribe(PromptSubmitted, (e) => submitted.push(e.promptId));
    eventBus.subscribe(PromptStarted, (e) => started.push(e.promptId));
    eventBus.subscribe(PromptCompleted, (e) => completed.push(e.promptId));
    eventBus.subscribe(PromptAborted, (e) => aborted.push(e.promptId));

    const cronMessage = (text: string) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text }],
      toolCalls: [],
      origin: {
        kind: 'cron_job' as const,
        jobId: 'j1',
        cron: '* * * * *',
        recurring: true,
        coalescedCount: 0,
        stale: false,
      },
    });

    const active = await prompt.enqueue({ id: 'cron-active', message: cronMessage('run') });
    await active.launched;
    const queued = await prompt.enqueue({ id: 'cron-queued', message: cronMessage('later') });
    expect(prompt.abort(queued.id)).toBe(true);
    loop.settleActive();
    await active.completion;

    expect(submitted).toEqual([]);
    expect(started).toEqual([]);
    expect(completed).toEqual([]);
    expect(aborted).toEqual([]);

    const user = await prompt.enqueue({ id: 'user-1', message: message('hi') });
    await user.launched;
    loop.settleActive();
    await user.completion;
    expect(submitted).toEqual(['user-1']);
    expect(started).toEqual(['user-1']);
    expect(completed).toEqual(['user-1']);
    expect(aborted).toEqual([]);
  });

  it('atomically rejects steer when any id is not pending', async () => {
    const { prompt } = harness();
    await prompt.enqueue({ message: message('active') });
    const queued = await prompt.enqueue({ message: message('one') });
    await expect(prompt.steer([queued.id, 'missing'])).rejects.toMatchObject({ code: 'prompt.not_found' });
    expect(prompt.list().pending.map((item) => item.id)).toEqual([queued.id]);
  });

  it('steers bound and ordinary prompts without rebinding the active turn', async () => {
    const { prompt, profile, toolPolicy, loop } = harness({ manualTurnResult: true });
    const active = await prompt.enqueue({ id: 'active', message: message('active') });
    await active.launched;
    const bound = await prompt.enqueue({
      id: 'bound',
      message: message('bound'),
      execution: {
        profile: 'A',
        model: 'bound-model',
        thinking: 'bound-thinking',
      },
      deferredDisabledTools: ['Bash'],
    });
    const ordinary = await prompt.enqueue({ id: 'ordinary', message: message('ordinary') });
    const later = await prompt.enqueue({
      id: 'later',
      message: message('later'),
      execution: {
        profile: 'B',
        model: 'later-model',
        thinking: 'later-thinking',
      },
      deferredDisabledTools: ['Write'],
    });
    const activeBinding = structuredClone(profile.data());

    const handles = await prompt.steer([ordinary.id, bound.id]);

    expect(handles).toEqual([bound, ordinary]);
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['later']);
    expect(profile.bind).not.toHaveBeenCalled();
    expect(profile.setModel).not.toHaveBeenCalled();
    expect(profile.setThinking).not.toHaveBeenCalled();
    expect(profile.data()).toEqual(activeBinding);
    expect(toolPolicy.setSessionDisabledTools).not.toHaveBeenCalled();

    loop.settleActive();
    await later.launched;
    expect(profile.bind).toHaveBeenCalledWith({
      profile: 'B',
      model: 'later-model',
      thinking: 'later-thinking',
      strictThinking: true,
    });
    expect(profile.setModel).toHaveBeenCalledWith('later-model');
    expect(toolPolicy.setSessionDisabledTools).toHaveBeenCalledExactlyOnceWith(['Write']);
  });

  it('steers selected prompts in FIFO order', async () => {
    const { prompt, context, loop } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const one = await prompt.enqueue({ message: message('one') });
    const two = await prompt.enqueue({ message: message('two') });
    const handles = await prompt.steer([two.id, one.id]);
    expect(handles.map((item) => item.id)).toEqual([one.id, two.id]);
    loop.drainNextBatch(context);
  });

  it('aborts pending prompts and marks the durable event as before-start', async () => {
    const { prompt, eventBus } = harness();
    const aborted: Array<{ promptId: string; beforeStart?: boolean }> = [];
    eventBus.subscribe(PromptAborted, (event) => {
      aborted.push({ promptId: event.promptId, beforeStart: event.beforeStart });
    });
    await prompt.enqueue({ message: message('active') });
    const handle = await prompt.enqueue({ message: message('queued') });
    expect(prompt.abort(handle.id)).toBe(true);
    await expect(handle.completion).resolves.toMatchObject({ state: 'cancelled' });
    expect(prompt.list().pending).toEqual([]);
    expect(aborted).toEqual([{ promptId: handle.id, beforeStart: true }]);
  });

  it('keeps injections outside the prompt queue', async () => {
    const { prompt } = harness();
    await prompt.inject({ ...message('system'), origin: { kind: 'injection', variant: 'test' } });
    expect(prompt.list()).toEqual({ active: undefined, pending: [] });
  });

  it('settles blocked prompts', async () => {
    const { prompt } = harness();
    prompt.hooks.onBeforeSubmitPrompt.register('block', async (ctx, next) => { ctx.block = true; await next(); });
    const handle = await prompt.enqueue({ message: message('blocked') });
    await expect(handle.completion).resolves.toMatchObject({ state: 'blocked' });
  });

  it('delivers a blocked prompt’s compression captions right after their host message', async () => {
    const { prompt, context } = harness();
    prompt.hooks.onBeforeSubmitPrompt.register('block', async (ctx, next) => { ctx.block = true; await next(); });
    const handle = await prompt.enqueue({
      id: 'prompt-caption',
      message: message(
        '<system>Image compressed to fit model limits: 800x600</system>look at this',
      ),
    });
    await expect(handle.completion).resolves.toMatchObject({ state: 'blocked' });

    const history = context.get();
    expect(history).toHaveLength(2);
    expect(history[0]?.origin).toEqual({
      kind: 'injection',
      variant: 'image_compression',
      ownerPromptId: 'prompt-caption',
    });
    expect(history[1]?.origin).toEqual({ kind: 'user' });
    expect(history[1]?.content).toEqual([{ type: 'text', text: 'look at this' }]);
    const captionPart = history[0]?.content[0];
    expect(captionPart?.type).toBe('text');
    expect((captionPart as { text: string }).text).toContain(
      'Image compressed to fit model limits: 800x600',
    );
  });

  it('settles the prompt as failed when the loop throws on launch', async () => {
    const { prompt, loop } = harness();
    vi.spyOn(loop, 'enqueue').mockImplementation(() => {
      throw new Error2(ErrorCodes.TURN_AGENT_BUSY, 'Cannot launch a new turn while another turn is active');
    });
    const handle = await prompt.enqueue({ id: 'prompt-x', message: message('hello') });
    expect(handle.state).toBe('failed');
    await expect(handle.launched).resolves.toBeUndefined();
    await expect(handle.completion).resolves.toMatchObject({
      state: 'failed',
      result: { type: 'failed', steps: 0, error: { code: ErrorCodes.TURN_AGENT_BUSY } },
    });
    expect(prompt.list()).toEqual({ active: undefined, pending: [] });
  });

  it('lets a Kimi-bound prompt keep a HEIC image the baseline gate would drop', async () => {
    const { prompt, context, loop, setProviderType } = harness();
    setProviderType('kimi');
    const heicUrl = `data:image/heic;base64,${Buffer.from([1, 2, 3]).toString('base64')}`;
    const handle = await prompt.enqueue({
      id: 'prompt-heic',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: heicUrl } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await handle.launched;
    loop.drainNextBatch(context);

    const parts = context.get()[0]!.content;
    expect(parts).toEqual([{ type: 'image_url', imageUrl: { url: heicUrl } }]);
  });

  it('preserves an unsupported prompt image for request-time preparation', async () => {
    const { prompt, context, loop } = harness();
    const avifUrl = `data:image/avif;base64,${Buffer.from([1, 2, 3]).toString('base64')}`;
    const handle = await prompt.enqueue({
      id: 'prompt-img',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: avifUrl } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await handle.launched;
    loop.drainNextBatch(context);

    const appended = context.get();
    expect(appended).toHaveLength(1);
    expect(appended[0]!.content).toEqual([
      { type: 'image_url', imageUrl: { url: avifUrl } },
    ]);
  });

  it('preserves steered prompt images for request-time preparation', async () => {
    const { prompt, context, loop } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const avifUrl = `data:image/avif;base64,${Buffer.from([4, 5, 6]).toString('base64')}`;
    const queued = await prompt.enqueue({
      id: 'prompt-steer-img',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: avifUrl } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });
    await prompt.steer([queued.id]);
    loop.drainNextBatch(context);

    const appended = context.get();
    const parts = appended.flatMap((entry) => entry.content);
    expect(parts).toContainEqual({ type: 'image_url', imageUrl: { url: avifUrl } });
  });

  it('materializes daemon-ref media at steer intake', async () => {
    const { prompt, intake } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const queued = await prompt.enqueue({
      id: 'prompt-steer-daemon',
      message: {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url: 'kimi-file://file_1' } }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    });

    await prompt.steer([queued.id]);

    expect(intake.get).toHaveBeenCalledWith('file_1');
    expect(intake.materialize).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'file_1', name: 'pic.png' }),
    );
  });

  it('publishes each record’s user parts when steering bundled prompts', async () => {
    const { prompt, eventBus } = harness();
    const steered: ContentPart[][] = [];
    eventBus.subscribe(PromptSteered, (event) => steered.push(event.content));
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const one = await prompt.enqueue({ message: bundledMessage('review', 'first user text') });
    const two = await prompt.enqueue({ message: bundledMessage('security', 'second user text') });

    await prompt.steer([one.id, two.id]);

    expect(steered).toHaveLength(1);
    expect(steered[0]).toEqual([
      { type: 'text', text: 'first user text' },
      { type: 'text', text: 'second user text' },
    ]);
  });

  it('restores failed steers to their original queue positions', async () => {
    const { prompt, loop } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    await prompt.enqueue({ id: 'a', message: message('a') });
    await prompt.enqueue({ id: 'b', message: message('b') });
    await prompt.enqueue({ id: 'c', message: message('c') });
    vi.spyOn(loop, 'enqueue').mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(prompt.steer(['b'])).rejects.toMatchObject({ code: 'prompt.not_found' });

    expect(prompt.list().pending.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('publishes only caller parts when a bundled prompt queues', async () => {
    const { prompt, eventBus } = harness();
    const queued: Array<{ promptId: string; content: ContentPart[] }> = [];
    eventBus.subscribe(PromptQueued, (event) => {
      queued.push({ promptId: event.promptId, content: event.content });
    });
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;

    await prompt.enqueue({ id: 'bundled', message: bundledMessage('review', 'user text') });

    expect(queued).toEqual([
      { promptId: 'bundled', content: [{ type: 'text', text: 'user text' }] },
    ]);
  });

  it('rejects the whole steer when a selected prompt is aborted during intake', async () => {
    const { prompt, intake } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    let releaseIntake!: () => void;
    intake.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseIntake = () =>
            resolve({
              meta: {
                id: 'file_1',
                size: 3,
                name: 'pic.png',
                media_type: 'image/png',
                created_at: '2026-01-01T00:00:00.000Z',
              },
              stream: () => Readable.from([new Uint8Array([1, 2, 3])]),
            });
        }),
    );
    await prompt.enqueue({
      id: 'a',
      message: bundledMessage('review', 'a text', [
        { type: 'image_url', imageUrl: { url: 'kimi-file://file_1' } },
      ]),
    });
    await prompt.enqueue({ id: 'b', message: message('b') });

    const steerPromise = prompt.steer(['a', 'b']);
    expect(() => prompt.replace('a', [{ type: 'text', text: 'replacement' }])).toThrowError(
      expect.objectContaining({ code: ErrorCodes.PROMPT_NOT_FOUND }),
    );
    prompt.abort('a');
    releaseIntake();

    await expect(steerPromise).rejects.toMatchObject({ code: 'prompt.not_found' });
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['b']);
  });

  it('keeps bundled skill blocks at the merged message prefix when steering', async () => {
    const { prompt, context, loop } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const one = await prompt.enqueue({ message: bundledMessage('review', 'user A') });
    const two = await prompt.enqueue({ message: bundledMessage('security', 'user B') });

    await prompt.steer([one.id, two.id]);
    loop.drainNextBatch(context);

    const merged = context
      .get()
      .find(
        (entry) => entry.origin?.kind === 'user' && entry.origin.skillActivations !== undefined,
      );
    expect(merged?.content).toEqual([
      { type: 'text', text: '<skill>review</skill>' },
      { type: 'text', text: '<skill>security</skill>' },
      { type: 'text', text: 'user A' },
      { type: 'text', text: 'user B' },
    ]);
  });

  it('keeps the peer_thread origin at the merged steer message', async () => {
    const { prompt, context, loop } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const one = await prompt.enqueue({ message: peerMessage('peer-1', 'one') });

    await prompt.steer([one.id]);
    loop.drainNextBatch(context);

    const merged = context
      .get()
      .filter((entry) => entry.origin?.kind === 'peer_thread')
      .at(-1);
    expect(merged?.origin).toEqual(peerMessage('peer-1', 'one').origin);
  });

  it('falls back to the user origin when steered records mix origins', async () => {
    const { prompt, context, loop } = harness();
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const one = await prompt.enqueue({ message: peerMessage('peer-1', 'one') });
    const two = await prompt.enqueue({ message: message('user two') });

    await prompt.steer([one.id, two.id]);
    loop.drainNextBatch(context);

    const merged = context
      .get()
      .filter(
        (entry) => entry.origin?.kind === 'user' && entry.origin.skillActivations === undefined,
      )
      .at(-1);
    expect(merged?.content).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'user two' },
    ]);
  });

  it('restarts the queue after restoring a steer raced by the active turn settling', async () => {
    const { prompt, loop } = harness({ manualTurnResult: true });
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const queued = await prompt.enqueue({ id: 'queued', message: message('queued') });
    let steerEnqueued!: () => void;
    const enqueued = new Promise<void>((resolve) => {
      steerEnqueued = resolve;
    });
    let rejectSteer!: (reason?: unknown) => void;
    const original = loop.enqueue.bind(loop);
    vi.spyOn(loop, 'enqueue').mockImplementation((request, options) => {
      if (request instanceof SteerStepRequest) {
        return {
          assigned: new Promise<never>((_, reject) => {
            rejectSteer = reject;
            steerEnqueued();
          }),
          abort: () => true,
        };
      }
      return original(request, options);
    });

    const steerPromise = prompt.steer([queued.id]);
    await enqueued;
    loop.settleActive();
    rejectSteer(new Error('held'));

    await expect(steerPromise).rejects.toMatchObject({ code: 'prompt.not_found' });
    await expect(queued.launched).resolves.toBeDefined();
    expect(prompt.list().active?.id).toBe('queued');
  });

  it('does not advance the queue while a steer assignment is in flight', async () => {
    const { prompt, loop } = harness({ manualTurnResult: true });
    const active = await prompt.enqueue({ message: message('active') });
    await active.launched;
    const a = await prompt.enqueue({ id: 'a', message: message('a') });
    await prompt.enqueue({ id: 'b', message: message('b') });
    let steerEnqueued!: () => void;
    const enqueued = new Promise<void>((resolve) => {
      steerEnqueued = resolve;
    });
    let rejectSteer!: (reason?: unknown) => void;
    const original = loop.enqueue.bind(loop);
    vi.spyOn(loop, 'enqueue').mockImplementation((request, options) => {
      if (request instanceof SteerStepRequest) {
        return {
          assigned: new Promise<never>((_, reject) => {
            rejectSteer = reject;
            steerEnqueued();
          }),
          abort: () => true,
        };
      }
      return original(request, options);
    });

    const steerPromise = prompt.steer([a.id]);
    await enqueued;
    loop.settleActive();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(loop.launches).toHaveLength(1);
    rejectSteer(new Error('held'));

    await expect(steerPromise).rejects.toMatchObject({ code: 'prompt.not_found' });
    await expect(a.launched).resolves.toBeDefined();
    expect(prompt.list().active?.id).toBe('a');
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['b']);
  });
});
