import { describe, expect, it, vi } from 'vitest';

import { createDecorator } from '#/_base/di/instantiation';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { AgentExecutionService } from '#/agent/execution/executionService';
import { NativeAgentExecutorSession } from '#/agent/execution/nativeAgentExecutorSession';
import { IAgentLoopService, type Turn } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import type { IAgentProfileService, ProfileData } from '#/agent/profile/profile';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentUsageService } from '#/agent/usage/usage';
import type { IAgentStateService } from '#/agent/state/agentState';
import type { ISessionDispatchService } from '#/session/dispatch/dispatch';
import type {
  AgentExecutorContext,
  AgentExecutorProvider,
  AgentExecutorSession,
  IAgentExecutorRegistry,
} from '#/app/agentExecutor/agentExecutor';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { createHooks } from '#/hooks';

const IMarker = createDecorator<string>('executionTestMarker');

function profile(data: Partial<ProfileData>): IAgentProfileService {
  return {
    _serviceBrand: undefined,
    data: () => ({
      thinkingLevel: 'off',
      systemPrompt: '',
      ...data,
    }),
    preparePromptConfiguration: async () => false,
    getSystemPrompt: () => data.systemPrompt ?? '',
  } as IAgentProfileService;
}

function scope(agentId = 'agent-test'): IAgentScopeContext {
  return {
    _serviceBrand: undefined,
    agentId,
    scope: (subKey) => subKey === undefined ? agentId : `${agentId}/${subKey}`,
  };
}

function states(): IAgentStateService {
  return {
    _serviceBrand: undefined,
    contributeState: () => ({ dispose: () => {} }),
  } as unknown as IAgentStateService;
}

function dispatch(): ISessionDispatchService {
  return { reserveExecution: () => () => {} } as unknown as ISessionDispatchService;
}

describe('AgentExecutionService', () => {
  it('runs the safe-boundary hook before the provider and exposes provider context', async () => {
    const ix = new TestInstantiationService();
    ix.set(IMarker, 'marker');
    let finish!: (value: { summary: string }) => void;
    const completion = new Promise<{ summary: string }>((resolve) => {
      finish = resolve;
    });
    const turn: Turn = {
      id: 41,
      signal: new AbortController().signal,
      ready: Promise.resolve(),
      result: Promise.resolve({ type: 'completed', steps: 1, truncated: false }),
      cancel: () => false,
    };
    const order: string[] = [];
    const cancel = vi.fn(() => true);
    const shutdown = vi.fn(async () => {});
    const session: AgentExecutorSession = {
      run: vi.fn(async () => {
        order.push('provider');
        return { agentId: 'agent-test', turn, completion };
      }),
      status: () => ({ state: 'idle' }),
      cancel,
      settled: async () => {},
      shutdown,
      hooks: createHooks(['onWillRun']),
    };
    const provider: AgentExecutorProvider = {
      id: 'fake-provider',
      protocol: 'acp-v1',
      validateOptions: () => ({}),
      validateBinding: (binding) => ({ ok: true, binding }),
      create: (context) => {
        expect(context.agent.id).toBe('agent-test');
        expect(context.agent.accessor.get(IMarker)).toBe('marker');
        expect(context.binding.executorId).toBe('fake');
        return session;
      },
    };
    const registry: IAgentExecutorRegistry = {
      _serviceBrand: undefined,
      get: () => ({ id: 'fake', protocol: 'acp-v1', args: [], revision: 'r1' }),
      resolve: () => ({
        descriptor: { id: 'fake', protocol: 'acp-v1', args: [], revision: 'r1' },
        options: {},
        provider,
      }),
      validateBinding: (_id, _options, binding) => ({ ok: true, binding }),
      resolveExecutable: async function () { return this.resolve(); },
      discover: async () => [],
      provider: () => provider,
    };
    const service = new AgentExecutionService(
      ix,
      scope(),
      dispatch(),
      profile({
        executorId: 'fake',
        executorProtocol: 'acp-v1',
        executorDescriptorRevision: 'r1',
      }),
      registry,
      states(),
    );
    service.hooks.onWillRun.register('test', async (_context, next) => {
      order.push('hook');
      await next();
    });

    const run = await service.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    );

    expect(order).toEqual(['hook', 'provider']);
    expect(service.status()).toEqual({ state: 'running', turnId: 41 });
    expect(service.cancel('stop')).toBe(true);
    expect(cancel).toHaveBeenCalledWith('stop');
    expect(service.status()).toEqual({ state: 'cancelling', turnId: 41 });
    finish({ summary: 'done' });
    await expect(run.completion).resolves.toEqual({ summary: 'done' });
    await service.settled();
    expect(service.status()).toEqual({ state: 'idle' });
    await service.shutdown('close');
    expect(shutdown).toHaveBeenCalledWith('close');
    service.dispose();
    ix.dispose();
  });

  it.each([
    ['grok-acp', 'acp-v1'],
    ['cursor-acp', 'acp-v1'],
    ['codex-app-server', 'codex-app-server'],
  ] as const)(
    'recreates an idle %s session when model or effort binding changes',
    async (executorId, protocol) => {
    const ix = new TestInstantiationService();
    let binding: ProfileData = {
      modelAlias: 'model-a',
      modelCapabilities: UNKNOWN_CAPABILITY,
      profileName: 'external',
      executorId,
      executorProtocol: protocol,
      executorDescriptorRevision: 'r1',
      thinkingLevel: 'high',
      systemPrompt: '',
    };
    const profileService = {
      _serviceBrand: undefined,
      data: () => binding,
      preparePromptConfiguration: async () => false,
      getSystemPrompt: () => binding.systemPrompt,
    } as IAgentProfileService;
    const contexts: AgentExecutorContext[] = [];
    const shutdowns: ReturnType<typeof vi.fn>[] = [];
    const provider: AgentExecutorProvider = {
      id: `${executorId}-provider`,
      protocol,
      validateOptions: () => ({}),
      validateBinding: (value) => ({ ok: true, binding: value }),
      create: (context) => {
        contexts.push(context);
        const shutdown = vi.fn(async () => {});
        shutdowns.push(shutdown);
        return {
          run: async () => ({
            agentId: 'agent-test',
            turn: {
              id: contexts.length,
              signal: new AbortController().signal,
              ready: Promise.resolve(),
              result: Promise.resolve({ type: 'completed', steps: 1, truncated: false }),
              cancel: () => false,
            },
            completion: Promise.resolve({ summary: 'done' }),
          }),
          status: () => ({ state: 'idle' }),
          cancel: () => false,
          settled: async () => {},
          shutdown,
          hooks: createHooks(['onWillRun']),
        };
      },
    };
    const registry: IAgentExecutorRegistry = {
      _serviceBrand: undefined,
      get: () => ({ id: executorId, protocol, args: [], revision: 'r1' }),
      resolve: () => ({
        descriptor: { id: executorId, protocol, args: [], revision: 'r1' },
        options: {},
        provider,
      }),
      validateBinding: (_id, _options, value) => ({ ok: true, binding: value }),
      resolveExecutable: async function () { return this.resolve(); },
      discover: async () => [],
      provider: () => provider,
    };
    const service = new AgentExecutionService(ix, scope(), dispatch(), profileService, registry, states());

    const first = await service.run(
      { kind: 'prompt', prompt: 'first' },
      { signal: new AbortController().signal },
    );
    await first.completion;
    await service.settled();
    binding = { ...binding, modelAlias: 'model-b', thinkingLevel: 'xhigh' };
    const second = await service.run(
      { kind: 'prompt', prompt: 'second' },
      { signal: new AbortController().signal },
    );
    await second.completion;
    await service.settled();

    expect(contexts.map((context) => ({
      modelAlias: context.binding.modelAlias,
      thinkingLevel: context.binding.thinkingLevel,
    }))).toEqual([
      { modelAlias: 'model-a', thinkingLevel: 'high' },
      { modelAlias: 'model-b', thinkingLevel: 'xhigh' },
    ]);
    expect(shutdowns[0]).toHaveBeenCalledTimes(1);
    expect(shutdowns[1]).not.toHaveBeenCalled();
    service.dispose();
    ix.dispose();
  });

  it.each([
    ['missing protocol', { executorDescriptorRevision: 'r1' }, /protocol.*missing/i],
    ['missing revision', { executorProtocol: 'acp-v1' }, /revision.*missing/i],
    [
      'protocol mismatch',
      { executorProtocol: 'other', executorDescriptorRevision: 'r1' },
      /protocol.*changed/i,
    ],
    [
      'revision mismatch',
      { executorProtocol: 'acp-v1', executorDescriptorRevision: 'r2' },
      /descriptor.*changed/i,
    ],
  ])('fails external execution closed for %s', async (_name, binding, message) => {
    const ix = new TestInstantiationService();
    const create = vi.fn<AgentExecutorProvider['create']>();
    const provider: AgentExecutorProvider = {
      id: 'fake-provider',
      protocol: 'acp-v1',
      validateOptions: () => ({}),
      validateBinding: (value) => ({ ok: true, binding: value }),
      create,
    };
    const registry: IAgentExecutorRegistry = {
      _serviceBrand: undefined,
      get: () => ({ id: 'fake', protocol: 'acp-v1', args: [], revision: 'r1' }),
      resolve: () => ({
        descriptor: { id: 'fake', protocol: 'acp-v1', args: [], revision: 'r1' },
        options: {},
        provider,
      }),
      validateBinding: (_id, _options, binding) => ({ ok: true, binding }),
      resolveExecutable: async function () { return this.resolve(); },
      discover: async () => [],
      provider: () => provider,
    };
    const service = new AgentExecutionService(
      ix,
      scope(),
      dispatch(),
      profile({ executorId: 'fake', ...binding }),
      registry,
      states(),
    );

    await expect(service.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    )).rejects.toThrow(message);
    expect(create).not.toHaveBeenCalled();
    service.dispose();
    ix.dispose();
  });

  it('fails external execution closed when its protocol has no provider', async () => {
    const ix = new TestInstantiationService();
    const registry: IAgentExecutorRegistry = {
      _serviceBrand: undefined,
      get: () => ({ id: 'missing', protocol: 'acp-v1', args: [], revision: 'r1' }),
      resolve: () => ({
        descriptor: { id: 'missing', protocol: 'acp-v1', args: [], revision: 'r1' },
        options: {},
      }),
      validateBinding: (_id, _options, binding) => ({ ok: true, binding }),
      resolveExecutable: async function () { return this.resolve(); },
      discover: async () => [],
      provider: () => undefined,
    };
    const service = new AgentExecutionService(
      ix,
      scope(),
      dispatch(),
      profile({
        executorId: 'missing',
        executorProtocol: 'acp-v1',
        executorDescriptorRevision: 'r1',
      }),
      registry,
      states(),
    );

    await expect(service.run(
      { kind: 'prompt', prompt: 'work' },
      { signal: new AbortController().signal },
    )).rejects.toThrow(/has no registered provider/);
    expect(service.status()).toEqual({ state: 'broken' });
    service.dispose();
    ix.dispose();
  });
});

describe('NativeAgentExecutorSession', () => {
  it('keeps the native turn path and runs its hook before prompt admission', async () => {
    const ix = new TestInstantiationService();
    const order: string[] = [];
    const turn: Turn = {
      id: 9,
      signal: new AbortController().signal,
      ready: Promise.resolve(),
      result: Promise.resolve({ type: 'completed', steps: 1, truncated: false }),
      cancel: () => false,
    };
    ix.stub(IAgentPromptService, {
      _serviceBrand: undefined,
      enqueue: async (input: Parameters<IAgentPromptService['enqueue']>[0]) => {
        order.push('prompt');
        expect(input.message.origin).toEqual({ kind: 'user' });
        return { launched: Promise.resolve(turn) } as never;
      },
      retry: async () => turn,
      drain: async () => {},
    } as unknown as IAgentPromptService);
    ix.stub(IAgentLoopService, {
      _serviceBrand: undefined,
      status: () => ({
        state: 'idle',
        pendingTurnIds: [],
        hasPendingRequests: false,
      }),
      cancel: () => false,
      settled: async () => {},
    } as unknown as IAgentLoopService);
    ix.stub(IAgentContextMemoryService, {
      _serviceBrand: undefined,
      get: () => [{
        role: 'assistant',
        content: [{ type: 'text', text: 'native summary' }],
        toolCalls: [],
      }],
    } as unknown as IAgentContextMemoryService);
    ix.stub(IAgentUsageService, {
      _serviceBrand: undefined,
      status: () => ({ total: undefined }),
    } as IAgentUsageService);
    const session = new NativeAgentExecutorSession({
      id: 'native-agent',
      accessor: { get: (id) => ix.get(id) },
    });
    session.hooks.onWillRun.register('test', async (_context, next) => {
      order.push('hook');
      await next();
    });

    const run = await session.run(
      { kind: 'prompt', prompt: 'hello', origin: { kind: 'user' } },
      { signal: new AbortController().signal },
    );

    expect(order).toEqual(['hook', 'prompt']);
    await expect(run.completion).resolves.toEqual({
      summary: 'native summary',
      usage: undefined,
    });
    ix.dispose();
  });
});
