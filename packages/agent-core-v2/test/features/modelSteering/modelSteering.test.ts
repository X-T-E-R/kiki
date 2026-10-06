import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createControlledPromise } from '@antfu/utils';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ContinuationStepRequest } from '#/agent/loop/stepRequest';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentProfileService } from '#/agent/profile/profile';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentModelSteeringService } from '#/features/modelSteering/modelSteering';
import type { CognitionContent } from '#/kosong/model/model';
import '#/features/modelSteering/modelSteeringFeature';

import {
  createTestAgent,
  homeDirServices,
  permissionModeServices,
  type TestAgentContext,
} from '../../harness';
import { createScriptedGenerate } from '../../harness/scripted-generate';
import { runWillBeginStepHooks } from '../../agent/loop/stubs';

const MOCK_MODEL = 'mock-model';

function steeringMessages(context: IAgentContextMemoryService): readonly ContextMessage[] {
  return context.get().filter((message) => {
    return message.origin?.kind === 'injection' && message.origin.variant === 'model_steering';
  });
}

describe('AgentModelSteeringService', () => {
  let ctx: TestAgentContext | undefined;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-cognition-steer-'));
    await mkdir(join(homeDir, 'cognition'));
    await writeFile(join(homeDir, 'cognition/steering.md'), 'CLASSIFY THEN ACT');
  });

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => undefined);
  });

  async function bindModel(steering = true, policy: CognitionContent = {}): Promise<void> {
    const agent = ctx!;
    if (steering) {
      const current = agent.kimiConfig.models![MOCK_MODEL]!;
      agent.kimiConfig = {
        ...agent.kimiConfig,
        models: {
          ...agent.kimiConfig.models,
          [MOCK_MODEL]: { ...current, cognition: { steering: 'cognition/steering.md', ...policy } },
        },
      };
    }
    await agent.get(IAgentProfileService).bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
  }

  it('preserves interval-only cadence when a legacy binding reads a native multiline body', async () => {
    ctx = createTestAgent(homeDirServices(homeDir));
    const text = 'CLASSIFY\n完整正文\n';
    await bindModel(true, { steering: { text }, steeringOnTurn: false, steeringOnInput: false, steeringIntervalSteps: 2 });
    const profile = ctx.get(IAgentProfileService);
    const binding = await profile.getCognitionBinding();
    profile.getCognitionBinding = async () => ({ ...binding, slots: undefined });
    ctx.get(IAgentModelSteeringService);
    const loop = ctx.get(IAgentLoopService);
    const memory = ctx.get(IAgentContextMemoryService);
    for (let step = 1; step <= 4; step++) {
      await runWillBeginStepHooks(loop, step === 1);
      expect(steeringMessages(memory)).toHaveLength(Math.floor(step / 2));
    }
    expect(steeringMessages(memory).map(message => message.content)).toEqual([
      [{ type: 'text', text }], [{ type: 'text', text }],
    ]);
  });

  it.each([true, false])('consumes accepted Send now inputs once at the next request (steering=%s)', async (configured) => {
    const scripted = createScriptedGenerate();
    const started = createControlledPromise<void>();
    const release = createControlledPromise<void>();
    ctx = createTestAgent(homeDirServices(homeDir), permissionModeServices('manual'), {
      generate: async (...args) => {
        const result = await scripted.generate(...args);
        if (scripted.calls.length === 1) {
          started.resolve();
          await release;
        }
        return result;
      },
    });
    await bindModel(configured);
    const agent = ctx;
    const loop = agent.get(IAgentLoopService);
    const prompts = agent.get(IAgentPromptService);
    const memory = agent.get(IAgentContextMemoryService);
    const turnBoundaries: boolean[] = [];
    agent.get(IAgentContextInjectorService).register('cadence_test', ({ isNewTurn }) => {
      turnBoundaries.push(isNewTurn);
      return undefined;
    });
    for (const text of ['initial answer', 'corrected answer', 'continued answer']) {
      scripted.mockNextResponse({ type: 'text', text });
    }
    try {
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'Initial request' }] });
      await started;
      expect(scripted.calls).toHaveLength(1);
      expect(scripted.calls[0]!.history.slice(-2)).toEqual(configured ? [
        expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'Initial request' }] }),
        expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'CLASSIFY THEN ACT' }] }),
      ] : [expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'Initial request' }] })]);
      const cancelled = await prompts.enqueue({ message: {
        role: 'user', content: [{ type: 'text', text: 'Cancelled correction' }], toolCalls: [], origin: { kind: 'user' },
      } });
      prompts.abort(cancelled.id);
      await expect(prompts.steer([cancelled.id])).rejects.toMatchObject({ code: 'prompt.not_found' });
      const first = await prompts.enqueue({ message: {
        role: 'user', content: [{ type: 'text', text: 'Superseded correction' }], toolCalls: [], origin: { kind: 'user' },
      } });
      expect(prompts.replace(first.id, [{ type: 'text', text: 'Understand the complete intent first.' }]).revision).toBe(1);
      await prompts.steer([first.id]);
      const second = await prompts.enqueue({ message: {
        role: 'user', content: [{ type: 'text', text: 'Then prioritize the intended use.' }], toolCalls: [], origin: { kind: 'user' },
      } });
      await prompts.steer([second.id]);
      expect(steeringMessages(memory)).toHaveLength(configured ? 1 : 0);
      expect(memory.get().flatMap((message) => message.content)).not.toContainEqual({ type: 'text', text: 'Understand the complete intent first.' });
      loop.enqueue(new ContinuationStepRequest());
      loop.enqueue(new ContinuationStepRequest());
    } finally {
      release.resolve();
    }
    await loop.settled();
    expect(scripted.calls).toHaveLength(3);
    expect(turnBoundaries).toEqual([true, false, false]);
    expect(memory.get().filter((message) => message.origin?.kind === 'user').map((message) => message.content)).toEqual([
      [{ type: 'text', text: 'Initial request' }],
      [{ type: 'text', text: 'Understand the complete intent first.' }],
      [{ type: 'text', text: 'Then prioritize the intended use.' }],
    ]);
    const correctionTail = [
      expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'Understand the complete intent first.\n\nThen prioritize the intended use.' }] }),
    ];
    if (configured) correctionTail.push(expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'CLASSIFY THEN ACT' }] }));
    expect(scripted.calls[1]!.history.slice(-correctionTail.length)).toEqual(correctionTail);
    for (const [index, call] of scripted.calls.entries()) {
      const texts = call.history.flatMap((message) => message.content).filter((part) => part.type === 'text').map((part) => part.text);
      expect(texts).not.toContain('Cancelled correction');
      expect(texts).not.toContain('Superseded correction');
      expect(texts.filter((text) => text === 'CLASSIFY THEN ACT')).toHaveLength(configured ? Math.min(index + 1, 2) : 0);
    }
    expect(steeringMessages(memory)).toHaveLength(configured ? 2 : 0);
  });

  it('injects steering on each new turn and skips intra-turn steps', async () => {
    ctx = createTestAgent(homeDirServices(homeDir));
    const current = ctx.kimiConfig.models?.[MOCK_MODEL];
    expect(current).toBeDefined();
    ctx.kimiConfig = {
      ...ctx.kimiConfig,
      models: {
        ...ctx.kimiConfig.models,
        [MOCK_MODEL]: { ...current!, cognition: { steering: 'cognition/steering.md' } },
      },
    };
    expect(ctx.get(IAgentModelSteeringService)).toBeDefined();
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.getSystemPrompt()).not.toContain('CLASSIFY THEN ACT');

    const loop = ctx.get(IAgentLoopService);
    const memory = ctx.get(IAgentContextMemoryService);

    await runWillBeginStepHooks(loop, true);
    expect(steeringMessages(memory)).toHaveLength(1);
    expect(steeringMessages(memory)[0]?.role).toBe('user');
    expect(steeringMessages(memory)[0]?.content[0]).toMatchObject({
      type: 'text',
      text: 'CLASSIFY THEN ACT',
    });

    await runWillBeginStepHooks(loop, false);
    expect(steeringMessages(memory)).toHaveLength(1);

    await runWillBeginStepHooks(loop, true);
    expect(steeringMessages(memory)).toHaveLength(2);
  });

  it('uses explicit human origins without treating peer or background user-shaped messages as human input', async () => {
    ctx = createTestAgent(homeDirServices(homeDir));
    await bindModel();
    const loop = ctx.get(IAgentLoopService);
    const memory = ctx.get(IAgentContextMemoryService);
    await runWillBeginStepHooks(loop, true);
    const nonHumanOrigins: ContextMessage['origin'][] = [
      undefined,
      { kind: 'injection', variant: 'background_notice' },
      { kind: 'task', taskId: 'example-task', status: 'completed', notificationId: 'example-notice' },
      { kind: 'agent_message', messageId: 'example-message', senderAgentId: 'example-child', senderTaskName: 'example' },
      { kind: 'peer_thread', source: { hostId: 'example-host', workspaceId: 'example-workspace', sessionId: 'example-session' }, messageId: 'example-peer', acceptedAt: 1 },
      { kind: 'skill_activation', activationId: 'example-tool-skill', skillName: 'example', trigger: 'model-tool' },
    ];
    for (const origin of nonHumanOrigins) {
      memory.append({ role: 'user', content: [{ type: 'text', text: 'Non-human delivery' }], toolCalls: [], origin });
      await runWillBeginStepHooks(loop, false);
      expect(steeringMessages(memory)).toHaveLength(1);
    }
    const humanOrigins: ContextMessage['origin'][] = [
      { kind: 'user' },
      { kind: 'plugin_command', activationId: 'example-command', pluginId: 'example', commandName: 'example', trigger: 'user-slash' },
      { kind: 'skill_activation', activationId: 'example-slash-skill', skillName: 'example', trigger: 'user-slash' },
    ];
    for (const [index, origin] of humanOrigins.entries()) {
      const input: ContextMessage = {
        role: 'user', content: [{ type: 'text', text: 'Human correction' }, { type: 'image_url', imageUrl: { url: 'https://example.com/image.png' } }], toolCalls: [], origin,
      };
      memory.append(input);
      await runWillBeginStepHooks(loop, false);
      expect(steeringMessages(memory)).toHaveLength(index + 2);
      expect(memory.get().at(-2)).toEqual(input);
      await runWillBeginStepHooks(loop, false);
      expect(steeringMessages(memory)).toHaveLength(index + 2);
    }
  });

  it('retains the bound text snapshot for new input and compaction re-arm', async () => {
    ctx = createTestAgent(homeDirServices(homeDir));
    await bindModel();
    const profile = ctx.get(IAgentProfileService);
    const binding = await profile.getCognitionBinding();
    expect(binding.slots?.steering).toBe('CLASSIFY THEN ACT');
    const loop = ctx.get(IAgentLoopService);
    const memory = ctx.get(IAgentContextMemoryService);
    memory.append({ role: 'user', content: [{ type: 'text', text: 'Initial input' }], toolCalls: [], origin: { kind: 'user' } });
    await runWillBeginStepHooks(loop, true);
    await writeFile(join(homeDir, 'cognition/steering.md'), 'CHANGED ON DISK');
    memory.append({ role: 'user', content: [{ type: 'text', text: 'Correction' }], toolCalls: [], origin: { kind: 'user' } });
    await runWillBeginStepHooks(loop, false);
    expect(steeringMessages(memory)).toHaveLength(2);
    memory.applyCompaction({ summary: 'Compacted conversation', compactedCount: memory.get().length, tokensBefore: 100 });
    await runWillBeginStepHooks(loop, false);
    expect(steeringMessages(memory)).toHaveLength(1);
    expect(steeringMessages(memory)[0]!.content).toEqual([{ type: 'text', text: 'CLASSIFY THEN ACT' }]);
    expect(await profile.getCognitionBinding()).toEqual(binding);
    await runWillBeginStepHooks(loop, false);
    expect(steeringMessages(memory)).toHaveLength(1);
  });

  it.each([true, false])('steering cadence combines actual model steps and Send now input (onInput=%s)', async (onInput) => {
    ctx = createTestAgent(homeDirServices(homeDir), permissionModeServices('manual'));
    await bindModel(true, { steeringOnInput: onInput, steeringIntervalSteps: 2 });
    const agent = ctx;
    const loop = agent.get(IAgentLoopService);
    const subscription = loop.hooks.onDidFinishStep.register('test.steer-and-continue', async ({ step }, next) => {
      if (step === 1) {
        await agent.rpc.steer({ input: [{ type: 'text', text: 'Accepted correction' }] });
        for (let index = 0; index < 3; index++) loop.enqueue(new ContinuationStepRequest());
      }
      await next();
    });
    for (let index = 0; index < 4; index++) agent.mockNextResponse({ type: 'text', text: `answer ${index}` });
    try {
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'Initial request' }] });
      await loop.settled();
    } finally {
      await subscription.dispose();
    }
    expect(agent.llmCalls).toHaveLength(4);
    const counts = agent.llmCalls.map((call) => call.history.flatMap((message) => message.content)
      .filter((part) => part.type === 'text' && part.text === 'CLASSIFY THEN ACT').length);
    expect(counts).toEqual(onInput ? [1, 2, 2, 3] : [1, 1, 2, 2]);
    expect(agent.llmCalls[1]!.history.at(onInput ? -2 : -1)).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'Accepted correction' }] });
    if (onInput) expect(agent.llmCalls[1]!.history.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'CLASSIFY THEN ACT' }] });
  });

  it('steering cadence can disable all triggers, including new turns and compaction re-arm', async () => {
    ctx = createTestAgent(homeDirServices(homeDir));
    await bindModel(true, { steeringOnTurn: false, steeringOnInput: false, steeringIntervalSteps: 0 });
    const loop = ctx.get(IAgentLoopService);
    const memory = ctx.get(IAgentContextMemoryService);
    memory.append({ role: 'user', content: [{ type: 'text', text: 'Human input' }], toolCalls: [], origin: { kind: 'user' } });
    await runWillBeginStepHooks(loop, true);
    await runWillBeginStepHooks(loop, false);
    memory.applyCompaction({ summary: 'Compacted input', compactedCount: memory.get().length, tokensBefore: 100 });
    await runWillBeginStepHooks(loop, false);
    expect(steeringMessages(memory)).toHaveLength(0);
  });

  it('steering cadence interval-only counts unique agent step heads across turns, not idle reconciliation or tool events', async () => {
    ctx = createTestAgent(homeDirServices(homeDir));
    await bindModel(true, { steeringOnTurn: false, steeringOnInput: false, steeringIntervalSteps: 2 });
    const loop = ctx.get(IAgentLoopService);
    const memory = ctx.get(IAgentContextMemoryService);
    const step = (turnId: number, stepId: string) => loop.hooks.onWillBeginStep.run({
      turnId, step: 1, stepId, firstStepOfTurn: true, signal: new AbortController().signal,
    });
    await step(0, 'first-step');
    await loop.hooks.onDidAppendToolResult.run({ toolCallId: 'first-tool' });
    await loop.hooks.onDidAppendToolResult.run({ toolCallId: 'second-tool' });
    await ctx.get(IAgentContextInjectorService).reconcileAllAtSafeBoundary();
    await step(0, 'first-step');
    expect(steeringMessages(memory)).toHaveLength(0);
    await step(1, 'second-step');
    expect(steeringMessages(memory)).toHaveLength(1);
    await step(1, 'second-step');
    expect(steeringMessages(memory)).toHaveLength(1);
    await step(2, 'third-step');
    expect(steeringMessages(memory)).toHaveLength(1);
    await step(3, 'fourth-step');
    expect(steeringMessages(memory)).toHaveLength(2);
  });

  it('does not inject when the bound model has no steering slot', async () => {
    ctx = createTestAgent(homeDirServices(homeDir));
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    await runWillBeginStepHooks(ctx.get(IAgentLoopService), true);
    expect(steeringMessages(ctx.get(IAgentContextMemoryService))).toHaveLength(0);
  });
});
