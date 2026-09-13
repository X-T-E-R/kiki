import { afterEach, describe, expect, it, vi } from 'vitest';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentLoopService } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentPlanService } from '#/features/plan/plan';

import { IEventService } from '#/app/event/event';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { createTestAgent, type TestAgentContext } from '../../harness';

describe('prompt submit', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it.each(['pause', 'cancel'] as const)('runs queued goal %s before a continuation after real normal completion', async (goalControl) => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'first complete' });
    ctx.mockNextResponse({ type: 'text', text: 'follow-up complete' });
    const prompts = ctx.get(IAgentPromptService);
    const loop = ctx.get(IAgentLoopService);
    const goal = ctx.get(IAgentGoalService);
    await goal.createGoal({ objective: 'finish the example' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const hook = loop.hooks.onWillBeginStep.register('hold-first-prompt', async (_event, next) => {
      hook.dispose();
      await held;
      await next();
    }, { before: 'context-injector' });
    const started: string[] = [];
    const ended: string[] = [];
    ctx.get(IEventBus).subscribe(TurnStarted, (event) => started.push(event.origin.kind));
    ctx.get(IEventBus).subscribe(TurnEnded, (event) => ended.push(event.reason));
    const active = await prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'first' }], toolCalls: [], origin: { kind: 'user' } } });
    const queued = await prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'follow-up' }], toolCalls: [], origin: { kind: 'user' } },
      execution: { goalObjective: 'finish the example', goalControl } });
    expect(queued.state).toBe('pending');
    release();
    expect((await active.completion).state).toBe('completed');
    expect((await queued.completion).state).toBe('completed');
    await loop.settled();
    expect(started).toEqual(['user', 'user']);
    expect(ended).toEqual(['completed', 'completed']);
    expect(goal.getGoal().goal?.status ?? null).toBe(goalControl === 'pause' ? 'paused' : null);
  });

  it.each(['pause', 'resume', 'cancel'] as const)('does not apply stale goal %s after an immediate same-objective replacement during plan preparation', async (goalControl) => {
    ctx = createTestAgent();
    const prompts = ctx.get(IAgentPromptService);
    const goal = ctx.get(IAgentGoalService);
    const plan = ctx.get(IAgentPlanService);
    const original = await goal.createGoal({ objective: 'same objective' });
    if (goalControl === 'resume') await goal.pauseGoal({});
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const status = vi.spyOn(plan, 'status').mockImplementationOnce(async () => { await held; return null; });
    const submission = prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'old control' }], toolCalls: [], origin: { kind: 'user' } },
      execution: { planMode: true, goalObjective: 'same objective', goalControl } });
    await vi.waitFor(() => expect(status).toHaveBeenCalled());
    await goal.cancelGoal({});
    const replacement = await goal.createGoal({ objective: 'same objective' });
    if (goalControl === 'resume') await goal.pauseGoal({});
    const expected = goal.getGoal().goal;
    expect(replacement.goalId).not.toBe(original.goalId);
    release();
    const prompt = await submission;
    expect(prompt.state).toBe('failed');
    expect(goal.getGoal().goal).toMatchObject({ goalId: expected!.goalId, status: expected!.status, objective: expected!.objective });
    expect(ctx.llmCalls).toHaveLength(0);
    status.mockRestore();
  });

  it.each(['profile', 'blocked'] as const)('settles a yielded goal when the queued prompt cannot launch: %s', async (failure) => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'first completed normally' });
    const prompts = ctx.get(IAgentPromptService);
    const goal = ctx.get(IAgentGoalService);
    const loop = ctx.get(IAgentLoopService);
    await goal.createGoal({ objective: 'finish' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const hook = loop.hooks.onWillBeginStep.register('hold-yield', async (_event, next) => {
      hook.dispose(); await held; await next();
    }, { before: 'context-injector' });
    const first = await prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'first' }], toolCalls: [], origin: { kind: 'user' } } });
    const blocker = prompts.hooks.onBeforeSubmitPrompt.register('block-follow-up', async (event, next) => {
      if (failure === 'blocked') event.block = true;
      await next();
    });
    const queued = await prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'follow-up' }], toolCalls: [], origin: { kind: 'user' } },
      execution: failure === 'profile' ? { model: 'unknown-model' } : undefined });
    release();
    expect((await first.completion).state).toBe('completed');
    expect((await queued.completion).state).toBe(failure === 'blocked' ? 'blocked' : 'failed');
    await loop.settled();
    expect(goal.getGoal().goal?.status).toBe(failure === 'blocked' ? 'blocked' : 'paused');
    expect(goal.getGoal().goal?.terminalReason).toContain('prompt');
    expect(ctx.llmCalls).toHaveLength(1);
    expect((await goal.resumeGoal({})).status).toBe('active');
    await goal.pauseGoal({});
    blocker.dispose();
  });

  it('does not settle a replacement goal for a blocked prompt after yielding the old goal', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'completed normally' });
    const prompts = ctx.get(IAgentPromptService);
    const loop = ctx.get(IAgentLoopService);
    const goal = ctx.get(IAgentGoalService);
    await goal.createGoal({ objective: 'same objective' });
    let finishFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { finishFirst = resolve; });
    const stepHook = loop.hooks.onWillBeginStep.register('hold-original', async (_event, next) => {
      stepHook.dispose(); await firstHeld; await next();
    }, { before: 'context-injector' });
    const first = await prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'first' }], toolCalls: [], origin: { kind: 'user' } } });
    let releasePrompt!: () => void;
    const promptHeld = new Promise<void>((resolve) => { releasePrompt = resolve; });
    let preparing = false;
    const blocker = prompts.hooks.onBeforeSubmitPrompt.register('hold-blocked-prompt', async (event, next) => {
      preparing = true; await promptHeld; event.block = true; await next();
    });
    const queued = await prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'blocked later' }], toolCalls: [], origin: { kind: 'user' } } });
    finishFirst();
    expect((await first.completion).state).toBe('completed');
    await vi.waitFor(() => expect(preparing).toBe(true));
    await goal.cancelGoal({});
    const replacement = await goal.createGoal({ objective: 'same objective' });
    releasePrompt();
    expect((await queued.completion).state).toBe('blocked');
    expect(goal.getGoal().goal).toMatchObject({ goalId: replacement.goalId, status: 'active' });
    expect(ctx.llmCalls).toHaveLength(1);
    blocker.dispose();
  });

  it('accepts a GUI goal follow-up during a real continuation and schedules it before the next continuation', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'continuation complete' });
    ctx.mockNextResponse({ type: 'text', text: 'user follow-up complete' });
    const prompts = ctx.get(IAgentPromptService);
    const loop = ctx.get(IAgentLoopService);
    const goal = ctx.get(IAgentGoalService);
    await goal.createGoal({ objective: 'finish the example' });
    await goal.pauseGoal({});
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const hook = loop.hooks.onWillBeginStep.register('hold-continuation', async (_event, next) => {
      hook.dispose(); await held; await next();
    }, { before: 'context-injector' });
    await goal.resumeGoal({ continueIfPaused: true });
    const queued = await prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'GUI follow-up' }], toolCalls: [], origin: { kind: 'user' } },
      execution: { planMode: false, swarmMode: false, goalObjective: 'finish the example', goalControl: 'pause' } });
    expect(queued.state).toBe('pending');
    release();
    expect((await queued.completion).state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(2);
    expect(goal.getGoal().goal?.status).toBe('paused');
  });

  it('steers a GUI state echo into a real autonomous goal turn and settles its prompt', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'goal completed' });
    ctx.mockNextResponse({ type: 'text', text: 'steered follow-up answered' });
    const prompts = ctx.get(IAgentPromptService);
    const loop = ctx.get(IAgentLoopService);
    const goal = ctx.get(IAgentGoalService);
    await goal.createGoal({ objective: 'finish the example' });
    await goal.pauseGoal({});
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const hook = loop.hooks.onWillBeginStep.register('hold-autonomous', async (_event, next) => {
      hook.dispose(); await held; await next();
    }, { before: 'context-injector' });
    await goal.resumeGoal({ continueIfPaused: true });
    const queued = await prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'GUI send now' }], toolCalls: [], origin: { kind: 'user' } },
      execution: { planMode: false, swarmMode: false, goalObjective: 'finish the example' } });
    const targetTurn = loop.status().activeTurnId;
    expect(queued.state).toBe('pending');
    await prompts.steer([queued.id]);
    expect(queued.state).toBe('steered');
    expect((await queued.launched)?.id).toBe(targetTurn);
    await goal.markComplete({}, 'system');
    release();
    const completion = await queued.completion;
    expect(completion.state, JSON.stringify(completion.result)).toBe('completed');
    await loop.settled();
  });

  it('reserves real Loop admission while plan status awaits and admits the user before competing turns', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'user complete' });
    ctx.mockNextResponse({ type: 'text', text: 'autonomous complete' });
    const prompts = ctx.get(IAgentPromptService);
    const loop = ctx.get(IAgentLoopService);
    const plan = ctx.get(IAgentPlanService);
    const goal = ctx.get(IAgentGoalService);
    await goal.createGoal({ objective: 'finish the example' });
    await goal.pauseGoal({});
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const status = vi.spyOn(plan, 'status').mockImplementationOnce(async () => { await held; return null; });
    const started: string[] = [];
    ctx.get(IEventBus).subscribe(TurnStarted, (event) => started.push(event.origin.kind));
    const submission = prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'user' }], toolCalls: [], origin: { kind: 'user' } },
      execution: { planMode: true, goalObjective: 'finish the example', goalControl: 'cancel' } });
    await vi.waitFor(() => expect(status).toHaveBeenCalled());
    const competing = loop.enqueue(new MessageStepRequest({ role: 'user', content: [{ type: 'text', text: 'other entry' }], toolCalls: [],
      origin: { kind: 'retry' } }, { admission: 'newTurn' }));
    await goal.resumeGoal({ continueIfPaused: true });
    expect(loop.status().state).toBe('idle');
    expect(started).toEqual([]);
    release();
    const user = await submission;
    expect((await user.completion).state).toBe('completed');
    const other = (await competing.assigned).turn;
    expect((await other.result).type).toBe('completed');
    expect(started).toEqual(['user', 'retry']);
    expect(goal.getGoal().goal).toBeNull();
    status.mockRestore();
  });

  it('returns a terminal receipt from the submitted prompt without an event subscriber', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'hi' });
    const receipt = await ctx.get(IAgentPromptService).submitAndWait({
      input: [{ type: 'text', text: 'hello' }], promptId: 'terminal-example',
    });
    expect(receipt).toMatchObject({ promptId: 'terminal-example', turnId: 0, state: 'completed', result: { type: 'completed' } });
    expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt);
    expect(ctx.llmCalls).toHaveLength(1);
  });

  it.each(['blocked', 'failed'] as const)('returns a %s terminal receipt when no turn launches', async (state) => {
    ctx = createTestAgent();
    const prompts = ctx.get(IAgentPromptService);
    prompts.hooks.onBeforeSubmitPrompt.register('terminal-hook', async (event, next) => {
      if (state === 'failed') throw new Error('launch hook failed', { cause: new Error('inner failure') });
      event.block = true;
      await next();
    });
    const receipt = await prompts.submitAndWait({ input: [{ type: 'text', text: 'hello' }] });
    expect(receipt.state).toBe(state);
    expect(receipt.turnId).toBeUndefined();
    if (state === 'failed') {
      expect(JSON.parse(JSON.stringify(receipt.result))).toMatchObject({
        type: 'failed', steps: 0,
        error: { message: 'launch hook failed', cause: { message: 'inner failure' } },
      });
    } else {
      expect(receipt.result).toBeUndefined();
    }
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('waits for its queued prompt rather than the preceding turn', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'first' });
    ctx.mockNextResponse({ type: 'text', text: 'second' });
    const prompts = ctx.get(IAgentPromptService);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const hook = ctx.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-terminal', async (_event, next) => {
      hook.dispose(); await held; await next();
    }, { before: 'context-injector' });
    await prompts.submit({ input: [{ type: 'text', text: 'first' }] });
    const waiting = prompts.submitAndWait({ input: [{ type: 'text', text: 'second' }], promptId: 'queued-terminal' });
    await vi.waitFor(() => expect(prompts.list().pending).toHaveLength(1));
    release();
    expect(await waiting).toMatchObject({ promptId: 'queued-terminal', turnId: 1, state: 'completed' });
    expect(ctx.llmCalls).toHaveLength(2);
  });

  it('aborts only the terminal waiter and leaves the admitted prompt running', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'still completes' });
    const prompts = ctx.get(IAgentPromptService);
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const hook = ctx.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-waiter', async (_event, next) => {
      hook.dispose(); await held; await next();
    }, { before: 'context-injector' });
    const waiting = prompts.submitAndWait({ input: [{ type: 'text', text: 'hello' }] }, controller.signal);
    const rejected = expect(waiting).rejects.toThrow('stop waiting');
    await vi.waitFor(() => expect(prompts.list().active).toBeDefined());
    controller.abort(new Error('stop waiting'));
    await rejected;
    expect(prompts.list().active?.state).toBe('running');
    release();
    await ctx.get(IAgentLoopService).settled();
    expect(ctx.llmCalls).toHaveLength(1);
  });

  it('does not admit an already aborted terminal wait', async () => {
    ctx = createTestAgent();
    const prompts = ctx.get(IAgentPromptService);
    await expect(prompts.submitAndWait({ input: [{ type: 'text', text: 'hello' }] }, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(prompts.list()).toEqual({ active: undefined, pending: [] });
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('submits a prompt and returns the turn id', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'hi' });

    const launched = await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    expect(launched?.turn_id).toBe(0);
    await ctx.untilTurnEnd();
  });

  it('derives the session title and lastPrompt from the first prompt', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'hi' });

    const events: { type: string; payload?: unknown }[] = [];
    const sub = ctx.get(IEventService).subscribe((event) => events.push(event));

    const launched = await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello title' }] });
    expect(launched?.turn_id).toBe(0);
    sub.dispose();

    const metadata = await ctx.get(ISessionMetadata).read();
    expect(metadata.title).toBe('hello title');
    expect(metadata.lastPrompt).toBe('hello title');

    const updated = events.find((event) => event.type === 'session.meta.updated');
    expect(updated).toBeDefined();
    const payload = updated?.payload as
      | { title?: string; patch?: { lastPrompt?: string } }
      | undefined;
    expect(payload?.title).toBe('hello title');
    expect(payload?.patch?.lastPrompt).toBe('hello title');

    await ctx.untilTurnEnd();
  });

  it('keeps a custom title and only refreshes lastPrompt on a later prompt', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'hi' });

    await ctx.get(ISessionMetadata).setTitle('keep-me');

    const launched = await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'should not become the title' }],
    });
    expect(launched?.turn_id).toBe(0);

    const metadata = await ctx.get(ISessionMetadata).read();
    expect(metadata.title).toBe('keep-me');
    expect(metadata.lastPrompt).toBe('should not become the title');

    await ctx.untilTurnEnd();
  });
});
