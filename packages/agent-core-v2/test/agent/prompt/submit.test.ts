import { afterEach, describe, expect, it, vi } from 'vitest';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { PromptCompleted } from '#/agent/prompt/promptService';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentLoopService } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentPlanService } from '#/features/plan/plan';

import { IEventService } from '#/app/event/event';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { MESSAGE_DELIVERY_NEXT_TURN_GUIDANCE } from '#/agent/delivery/deliveryReminder';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

function historyText(history: readonly { readonly content: readonly { readonly type: string; readonly text?: string }[] }[]): string {
  return history.map((message) => message.content.map((part) => part.type === 'text' ? part.text ?? '' : '').join('')).join('\n');
}

function deliveryReminders(ctx: TestAgentContext) {
  return ctx.get(IAgentContextMemoryService).get().filter((message) => message.origin?.kind === 'injection' && message.origin.variant === 'message_delivery');
}

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

  it('puts the complete ordinary reply and message guidance into the next request without another model call', async () => {
    ctx = createTestAgent();
    const delivery = ctx.get(ISessionDeliveryService);
    await delivery.ready;
    const documents = ctx.get(IAtomicDocumentStore);
    const scope = ctx.get(ISessionContext).metaScope;
    expect(await documents.get(scope, 'delivery.json')).toBeUndefined();
    await delivery.set('message');
    expect(await documents.get(scope, 'delivery.json')).toEqual({ mode: 'message' });
    const ordinary = 'Private reasoning result. It stays one complete reply.';
    ctx.mockNextResponse({ type: 'text', text: ordinary });
    const prompts = ctx.get(IAgentPromptService);
    const result = await prompts.submitAndWait({ input: [{ type: 'text', text: 'Please reply.' }] });
    expect(result.state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.llmCalls[0]!.tools.map((tool) => tool.name)).toContain('SendMessage');
    expect(historyText(ctx.llmCalls[0]!.history)).not.toContain(MESSAGE_DELIVERY_NEXT_TURN_GUIDANCE);
    expect(MESSAGE_DELIVERY_NEXT_TURN_GUIDANCE).not.toContain('not visible');
    expect(MESSAGE_DELIVERY_NEXT_TURN_GUIDANCE).not.toContain('You have not sent');
    expect(MESSAGE_DELIVERY_NEXT_TURN_GUIDANCE).toContain('do not call SendMessage to send it again or rewrite it');
    expect(deliveryReminders(ctx)).toHaveLength(1);
    ctx.mockNextResponse({ type: 'text', text: 'Second turn.' });
    const next = await prompts.submitAndWait({ input: [{ type: 'text', text: 'Continue.' }] });
    expect(next.state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(2);
    const second = historyText(ctx.llmCalls[1]!.history);
    expect(second).toContain(ordinary);
    expect(second).toContain(MESSAGE_DELIVERY_NEXT_TURN_GUIDANCE);
    expect(second.split(ordinary)).toHaveLength(2);
  });

  it('keeps reply mode free of SendMessage and delivery guidance', async () => {
    ctx = createTestAgent();
    await ctx.get(ISessionDeliveryService).ready;
    ctx.mockNextResponse({ type: 'text', text: 'Direct reply.' });
    const result = await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Please reply.' }] });
    expect(result.state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.llmCalls[0]!.tools.map((tool) => tool.name)).not.toContain('SendMessage');
    expect(deliveryReminders(ctx)).toHaveLength(0);
  });

  it('freezes message delivery for the turn and still guides from that mode after a mid-turn reply switch', async () => {
    ctx = createTestAgent();
    const delivery = ctx.get(ISessionDeliveryService);
    await delivery.ready;
    await delivery.set('message');
    const loop = ctx.get(IAgentLoopService);
    const hook = loop.hooks.onWillBeginStep.register('freeze-delivery', async (_event, next) => {
      await hook.dispose();
      await delivery.set('reply');
      expect(delivery.mode()).toBe('reply');
      expect(delivery.effectiveMode()).toBe('message');
      await next();
    }, { before: 'context-injector' });
    ctx.mockNextResponse({ type: 'text', text: 'Frozen message turn.' });
    const prompts = ctx.get(IAgentPromptService);
    expect((await prompts.submitAndWait({ input: [{ type: 'text', text: 'Please reply.' }] })).state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.llmCalls[0]!.tools.map((tool) => tool.name)).toContain('SendMessage');
    expect(delivery.effectiveMode()).toBe('reply');
    expect(deliveryReminders(ctx)).toHaveLength(1);
    ctx.mockNextResponse({ type: 'text', text: 'Now reply.' });
    expect((await prompts.submitAndWait({ input: [{ type: 'text', text: 'Next.' }] })).state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(2);
    expect(ctx.llmCalls[1]!.tools.map((tool) => tool.name)).not.toContain('SendMessage');
    expect(historyText(ctx.llmCalls[1]!.history)).toContain(MESSAGE_DELIVERY_NEXT_TURN_GUIDANCE);
  });

  it('does not expose SendMessage or guide when a reply turn is switched to message mid-turn', async () => {
    ctx = createTestAgent();
    const delivery = ctx.get(ISessionDeliveryService);
    await delivery.ready;
    const loop = ctx.get(IAgentLoopService);
    const hook = loop.hooks.onWillBeginStep.register('freeze-reply', async (_event, next) => {
      await hook.dispose();
      await delivery.set('message');
      expect(delivery.mode()).toBe('message');
      expect(delivery.effectiveMode()).toBe('reply');
      await next();
    }, { before: 'context-injector' });
    ctx.mockNextResponse({ type: 'text', text: 'Still a reply.' });
    const prompts = ctx.get(IAgentPromptService);
    expect((await prompts.submitAndWait({ input: [{ type: 'text', text: 'Please reply.' }] })).state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(1);
    expect(ctx.llmCalls[0]!.tools.map((tool) => tool.name)).not.toContain('SendMessage');
    expect(delivery.effectiveMode()).toBe('message');
    expect(deliveryReminders(ctx)).toHaveLength(0);
    ctx.mockNextResponse({ type: 'text', text: 'Message turn.' });
    expect((await prompts.submitAndWait({ input: [{ type: 'text', text: 'Next.' }] })).state).toBe('completed');
    expect(ctx.llmCalls[1]!.tools.map((tool) => tool.name)).toContain('SendMessage');
    expect(historyText(ctx.llmCalls[1]!.history)).not.toContain(MESSAGE_DELIVERY_NEXT_TURN_GUIDANCE);
  });

  it('does not guide the next request after a successful SendMessage', async () => {
    ctx = createTestAgent();
    const delivery = ctx.get(ISessionDeliveryService);
    await delivery.ready;
    await delivery.set('message');
    ctx.mockNextResponse({ type: 'function', id: 'send-1', name: 'SendMessage', arguments: '{"text":"Visible hello"}' });
    ctx.mockNextResponse({ type: 'text', text: 'Sent.' });
    const prompts = ctx.get(IAgentPromptService);
    expect((await prompts.submitAndWait({ input: [{ type: 'text', text: 'Please reply.' }] })).state).toBe('completed');
    expect(deliveryReminders(ctx)).toHaveLength(0);
    ctx.mockNextResponse({ type: 'text', text: 'Next.' });
    expect((await prompts.submitAndWait({ input: [{ type: 'text', text: 'Continue.' }] })).state).toBe('completed');
    expect(historyText(ctx.llmCalls.at(-1)!.history)).not.toContain(MESSAGE_DELIVERY_NEXT_TURN_GUIDANCE);
  });

  it('does not guide when a message-mode turn fails after ordinary text', async () => {
    ctx = createTestAgent();
    const delivery = ctx.get(ISessionDeliveryService);
    await delivery.ready;
    await delivery.set('message');
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'Filtered ordinary text.' }],
      finishReason: 'filtered',
    });
    const result = await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Please reply.' }] });
    expect(result.state).toBe('failed');
    expect(deliveryReminders(ctx)).toHaveLength(0);
    const last = ctx.get(IAgentContextMemoryService).get().at(-1);
    expect(last).toMatchObject({
      role: 'assistant',
      source: { turnId: 0 },
      content: [{ type: 'text', text: 'Filtered ordinary text.' }],
    });
    expect(last?.partial).not.toBe(true);
  });

  it('does not tell an external executor to call SendMessage when the native tool stays registered', async () => {
    ctx = createTestAgent();
    const delivery = ctx.get(ISessionDeliveryService);
    await delivery.ready;
    await delivery.set('message');
    const profile = ctx.get(IAgentProfileService);
    const loop = ctx.get(IAgentLoopService);
    const hook = loop.hooks.onDidFinishStep.register('external-executor', async (_event, next) => {
      await next();
      await hook.dispose();
      profile.applyBindingSnapshot({ ...profile.data(), executorId: 'external-example' });
    });
    ctx.mockNextResponse({ type: 'text', text: 'Ordinary external reply.' });
    const result = await ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Please reply.' }] });
    expect(result.state).toBe('completed');
    expect(ctx.get(IAgentToolRegistryService).resolve('SendMessage')).toBeDefined();
    expect(deliveryReminders(ctx)).toHaveLength(0);
  });

  it('does not guide a cancelled message turn from the previous turn assistant text', async () => {
    ctx = createTestAgent();
    const delivery = ctx.get(ISessionDeliveryService);
    await delivery.ready;
    const ordinary = 'Older direct reply.';
    ctx.mockNextResponse({ type: 'text', text: ordinary });
    const prompts = ctx.get(IAgentPromptService);
    expect((await prompts.submitAndWait({ input: [{ type: 'text', text: 'First.' }] })).state).toBe('completed');
    expect(deliveryReminders(ctx)).toHaveLength(0);
    await delivery.set('message');
    const loop = ctx.get(IAgentLoopService);
    const stop = ctx.get(IEventBus).subscribe(TurnStarted, () => {
      loop.cancel(undefined, new Error('abort'));
    });
    const result = await prompts.submitAndWait({ input: [{ type: 'text', text: 'Second.' }] });
    await stop.dispose();
    expect(result.state).toBe('cancelled');
    expect(deliveryReminders(ctx)).toHaveLength(0);
    const last = ctx.get(IAgentContextMemoryService).get().at(-1);
    expect(last).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: ordinary }],
      source: { turnId: 0 },
    });
  });

  it('materializes a frozen persona greeting only on explicit reply and only once', async () => {
    ctx = createTestAgent();
    const profile = ctx.get(IAgentProfileService);
    profile.applyBindingSnapshot({ ...profile.data(), personaId: 'guide', personaRevision: 'revision-1',
      persona: { definition: { id: 'guide', name: 'Guide', description: 'Be helpful.', greeting: 'Welcome aboard.' }, revision: 'revision-1' } });
    const memory = ctx.get(IAgentContextMemoryService);
    expect(memory.get()).toHaveLength(0);
    const prompts = ctx.get(IAgentPromptService);
    ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
    await prompts.submitAndWait({ input: [{ type: 'text', text: 'Ordinary message' }] });
    expect(memory.get().some((message) => message.origin?.kind === 'persona_greeting')).toBe(false);
    for (const text of ['Reply to greeting', 'Reply again']) {
      ctx.mockNextResponse({ type: 'text', text: 'Acknowledged.' });
      await prompts.submitAndWait({ input: [{ type: 'text', text }], execution: { personaGreetingReply: true } });
    }
    const history = memory.get();
    const greetings = history.filter((message) => message.origin?.kind === 'persona_greeting');
    expect(greetings).toHaveLength(1);
    expect(greetings[0]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Welcome aboard.' }],
      origin: { kind: 'persona_greeting', personaId: 'guide' } });
    expect(history.indexOf(greetings[0]!)).toBeLessThan(history.findIndex((message) =>
      message.content.some((part) => part.type === 'text' && part.text === 'Reply to greeting')));
  });

  it('rejects a greeting reply without a frozen persona greeting before any model call', async () => {
    ctx = createTestAgent();
    await expect(ctx.get(IAgentPromptService).submitAndWait({ input: [{ type: 'text', text: 'Reply' }],
      execution: { personaGreetingReply: true } })).rejects.toMatchObject({ code: 'request.invalid' });
    expect(ctx.llmCalls).toHaveLength(0);
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
      await hook.dispose();
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
      await hook.dispose(); await held; await next();
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
    await blocker.dispose();
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
      await stepHook.dispose(); await firstHeld; await next();
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
    await blocker.dispose();
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
      await hook.dispose(); await held; await next();
    }, { before: 'context-injector' });
    await goal.resumeGoal({ continueIfPaused: true });
    const queued = await prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'GUI follow-up' }], toolCalls: [], origin: { kind: 'user' } },
      execution: { planMode: false, goalObjective: 'finish the example', goalControl: 'pause' } });
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
      await hook.dispose(); await held; await next();
    }, { before: 'context-injector' });
    await goal.resumeGoal({ continueIfPaused: true });
    const queued = await prompts.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'GUI send now' }], toolCalls: [], origin: { kind: 'user' } },
      execution: { planMode: false, goalObjective: 'finish the example' } });
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
    let completed: PromptCompleted | undefined;
    ctx.get(IEventBus).subscribe(PromptCompleted, (event) => { completed = event; });
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
    expect(completed).toMatchObject({ reason: state, error: state === 'failed'
      ? { message: 'launch hook failed', details: { reason_code: 'internal' }, cause: { message: 'inner failure' } }
      : undefined });
  });

  it('waits for its queued prompt rather than the preceding turn', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'first' });
    ctx.mockNextResponse({ type: 'text', text: 'second' });
    const prompts = ctx.get(IAgentPromptService);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const hook = ctx.get(IAgentLoopService).hooks.onWillBeginStep.register('hold-terminal', async (_event, next) => {
      await hook.dispose(); await held; await next();
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
      await hook.dispose(); await held; await next();
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
    await sub.dispose();

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
