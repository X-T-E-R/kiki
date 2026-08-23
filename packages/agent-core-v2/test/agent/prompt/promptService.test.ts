import { describe, expect, it, onTestFinished, vi } from 'vitest';

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
import { IAgentPromptService } from '#/agent/prompt/prompt';
import {
  AgentPromptService,
  PromptAborted,
  PromptQueued,
  PromptReplaced,
  PromptSteered,
} from '#/agent/prompt/promptService';
import {
  IAgentProfileService,
  type BindAgentInput,
  type ProfileData,
} from '#/agent/profile/profile';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
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
  };
  const toolPolicy = {
    setSessionDisabledTools: vi.fn(async (_disabledTools: readonly string[]) => {}),
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
  const ix = createServices(disposables, {
    strict: true, additionalServices: (reg) => {
      registerStateServices(reg);
      reg.defineInstance(IAgentContextMemoryService, context);
      reg.defineInstance(IAgentLoopService, loop);
      reg.definePartialInstance(IAgentProfileService, profile);
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
    prompt: ix.get(IAgentPromptService),
    profile,
    toolPolicy,
    loop,
    context,
    fullCompaction,
    eventBus: ix.get(IEventBus),
    intake,
  };
}

describe('AgentPromptService', () => {
  it('assigns stable identity and launches an idle prompt', async () => {
    const { prompt } = harness();
    const handle = await prompt.enqueue({ id: 'prompt-1', message: message('hello') });
    expect(handle.id).toBe('prompt-1');
    expect(handle.userMessageId).toBe('prompt-1');
    expect((await handle.launched)?.id).toBe(0);
  });

  it('keeps later prompts in FIFO order while active', async () => {
    const { prompt } = harness();
    await prompt.enqueue({ message: message('active') });
    const first = await prompt.enqueue({ message: message('one') });
    const second = await prompt.enqueue({ message: message('two') });
    expect(prompt.list().pending.map((item) => item.id)).toEqual([first.id, second.id]);
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

  it('aborts pending prompts and settles completion', async () => {
    const { prompt } = harness();
    await prompt.enqueue({ message: message('active') });
    const handle = await prompt.enqueue({ message: message('queued') });
    expect(prompt.abort(handle.id)).toBe(true);
    await expect(handle.completion).resolves.toMatchObject({ state: 'cancelled' });
    expect(prompt.list().pending).toEqual([]);
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
    await expect(handle.completion).resolves.toMatchObject({ state: 'failed', result: undefined });
    expect(prompt.list()).toEqual({ active: undefined, pending: [] });
  });

  it('replaces an unsupported prompt image with a text notice at the history funnel', async () => {
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
    const parts = appended[0]!.content;
    expect(parts.some((part) => part.type === 'image_url')).toBe(false);
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect((parts[0] as { text: string }).text).toContain('image/avif');
  });

  it('gates steered prompt images too', async () => {
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
    expect(parts.some((part) => part.type === 'image_url')).toBe(false);
    expect(
      parts.some((part) => part.type === 'text' && part.text.includes('image/avif')),
    ).toBe(true);
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
