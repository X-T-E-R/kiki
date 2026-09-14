import { describe, expect, it, vi } from 'vitest';

import { createDecorator } from '#/_base/di/instantiation';
import { ISessionDispatchService } from '#/session/dispatch/dispatch';
import { DispatchCapacity } from '#/session/dispatch/capacity';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentProfileService as ProfileServiceId } from '#/agent/profile/profile';
import { IAgentScopeContext as ScopeContextId } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService as StateServiceId } from '#/agent/state/agentState';
import { IAgentExecutorRegistry as ExecutorRegistryId } from '#/app/agentExecutor/agentExecutor';
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
import type {
  AgentExecutorContext,
  AgentExecutorProvider,
  AgentExecutorSession,
  IAgentExecutorRegistry,
} from '#/app/agentExecutor/agentExecutor';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import { createHooks } from '#/hooks';
import { appendSharedPromptField } from '#/app/promptField/builtinPromptFields';

const IMarker = createDecorator<string>('executionTestMarker');

function profile(data: Partial<ProfileData>): IAgentProfileService {
  return {
    _serviceBrand: undefined,
    preparePromptConfiguration: async () => false,
    getSystemPrompt: () => data.systemPrompt ?? '',
    data: () => ({
      thinkingLevel: 'off',
      systemPrompt: '',
      ...data,
    }),
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

function executionService(
  ix: TestInstantiationService,
  scopeContext: IAgentScopeContext,
  profileService: IAgentProfileService,
  registry: IAgentExecutorRegistry,
  stateService: IAgentStateService,
  reserveExecution: ISessionDispatchService['reserveExecution'] = () => () => {},
): AgentExecutionService {
  ix.stub(ISessionDispatchService, { reserveExecution });
  ix.set(ScopeContextId, scopeContext);
  ix.set(ProfileServiceId, profileService);
  ix.set(ExecutorRegistryId, registry);
  ix.set(StateServiceId, stateService);
  ix.stub(IAgentLoopService, {});
  ix.stub(IAgentPromptService, {});
  ix.set(IAgentExecutionService, new SyncDescriptor(AgentExecutionService));
  return ix.get(IAgentExecutionService) as AgentExecutionService;
}

describe('AgentExecutionService', () => {
  it('holds shared dispatch capacity through real cancellation and admits the next execution only after settlement', async () => {
    const ix = new TestInstantiationService();
    const capacity = new DispatchCapacity();
    const limits = { maxDirectChildren: 1, maxTotalSubagents: 1 };
    let finish!: (value: { summary: string }) => void;
    const completion = new Promise<{ summary: string }>((resolve) => { finish = resolve; });
    const session: AgentExecutorSession = {
      run: async () => ({ agentId: 'child', completion, turn: {
        id: 1, signal: new AbortController().signal, ready: Promise.resolve(),
        result: Promise.resolve({ type: 'completed', steps: 1, truncated: false }), cancel: () => false,
      } }),
      status: () => ({ state: 'idle' }), cancel: () => true,
      shutdown: async () => {}, settled: async () => { await completion; }, hooks: createHooks(['onWillRun']),
    };
    const registry = { resolveExecutable: async () => ({
      descriptor: { id: 'fake', protocol: 'acp-v1', args: [], revision: 'r1' },
      options: {}, provider: { create: () => session },
    }) } as unknown as IAgentExecutorRegistry;
    const service = executionService(ix, { ...scope('child'), parentAgentId: 'main' }, profile({
      executorId: 'fake', executorProtocol: 'acp-v1', executorDescriptorRevision: 'r1',
    }), registry, states(), (id, owner, reservation) => {
      const slot = reservation ?? capacity.reserve(owner!, limits, id);
      slot.claim(id);
      return slot;
    });
    try {
      const reserved = capacity.reserve('main', limits);
      reserved.bind('child');
      await service.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal, capacityReservation: reserved });
      expect(service.status().state).toBe('running');
      expect(service.cancel('cancel work')).toBe(true);
      expect(service.status().state).toBe('cancelling');
      expect(() => capacity.reserve('main', limits, 'other')).toThrow(expect.objectContaining({ code: 'dispatch.limit_exceeded' }));
      finish({ summary: 'cancelled' });
      await service.settled();
      expect(service.status().state).toBe('idle');
      const next = capacity.reserve('main', limits, 'other');
      next();
    } finally {
      finish({ summary: 'cleanup' });
      await service.dispose();
      ix.dispose();
    }
  });

  it.each(['scope-close', 'shutdown', 'dispose'] as const)(
    'waits for external cleanup exactly once during %s', async (close) => {
      const ix = new TestInstantiationService();
      let finish!: (value: { summary: string }) => void;
      const completion = new Promise<{ summary: string }>((resolve) => { finish = resolve; });
      let release!: () => void;
      const cleanup = new Promise<void>((resolve) => { release = resolve; });
      const cancel = vi.fn(() => { finish({ summary: 'cancelled' }); return true; });
      const shutdown = vi.fn(() => cleanup);
      const session: AgentExecutorSession = {
        run: async () => ({ agentId: 'agent-test', completion, turn: {
          id: 1, signal: new AbortController().signal, ready: Promise.resolve(),
          result: Promise.resolve({ type: 'completed', steps: 1, truncated: false }), cancel: () => false,
        } }),
        status: () => ({ state: 'idle' }), cancel, shutdown,
        settled: async () => { await completion; }, hooks: createHooks(['onWillRun']),
      };
      const registry = {
        resolveExecutable: async () => ({
          descriptor: { id: 'fake', protocol: 'acp-v1', args: [], revision: 'r1' },
          options: {}, provider: { create: () => session },
        }),
      } as unknown as IAgentExecutorRegistry;
      const service = executionService(ix, scope(), profile({
        executorId: 'fake', executorProtocol: 'acp-v1', executorDescriptorRevision: 'r1',
      }), registry, states());
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      try {
        await service.run({ kind: 'prompt', prompt: 'work' }, { signal: controller.signal });
        if (close === 'scope-close') ix.dispose();
        if (close === 'shutdown') void service.shutdown('close');
        if (close === 'dispose') void service.dispose();
        const first = service.shutdown();
        expect(service.shutdown()).toBe(first);
        let stopped = false;
        void first.then(() => { stopped = true; });
        await completion;
        expect(stopped).toBe(false);
        release();
        await first;
        await service.dispose();
        await service.dispose();
        expect(shutdown).toHaveBeenCalledTimes(1);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(service.status()).toEqual({ state: 'idle' });
      } finally {
        release();
        ix.dispose();
      }
    },
  );

  it('does not create or run an external session when shutdown wins discovery', async () => {
    const ix = new TestInstantiationService();
    let release!: () => void;
    const discovery = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const discovering = new Promise<void>((resolve) => { entered = resolve; });
    const create = vi.fn<AgentExecutorProvider['create']>();
    const registry = {
      resolveExecutable: async () => {
        entered();
        await discovery;
        return { descriptor: { id: 'fake', protocol: 'acp-v1', args: [], revision: 'r1' },
          options: {}, provider: { create } };
      },
    } as unknown as IAgentExecutorRegistry;
    const service = executionService(ix, scope(), profile({
      executorId: 'fake', executorProtocol: 'acp-v1', executorDescriptorRevision: 'r1',
    }), registry, states());
    const running = service.run({ kind: 'prompt', prompt: 'work' }, { signal: new AbortController().signal });
    const rejected = expect(running).rejects.toThrow('shutting down');
    await discovering;
    const closing = service.shutdown();
    release();
    await rejected;
    await closing;
    expect(create).not.toHaveBeenCalled();
    ix.dispose();
  });

  it.each(['scope-close', 'shutdown', 'dispose', 'replacement'] as const)(
    'cancels native child runs and releases abort listeners during %s', async (close) => {
      const parent = new TestInstantiationService();
      let finish!: (value: Awaited<Turn['result']>) => void;
      const result = new Promise<Awaited<Turn['result']>>((resolve) => { finish = resolve; });
      const cancel = vi.fn((_id?: number, reason?: unknown) => {
        finish({ type: 'cancelled', steps: 0, reason });
        return true;
      });
      const drain = vi.fn(async () => {});
      parent.stub(ISessionDispatchService, { reserveExecution: () => () => {} });
      parent.set(ProfileServiceId, profile({}));
      parent.set(ScopeContextId, scope());
      parent.set(StateServiceId, states());
      parent.stub(ExecutorRegistryId, {});
      parent.stub(IAgentPromptService, {
        enqueue: async () => ({ launched: Promise.resolve({
          id: 1, signal: new AbortController().signal, ready: Promise.resolve(),
          result, cancel: () => false,
        }) }) as never,
        drain,
      });
      const child = parent.createChild(new ServiceCollection());
      const loop = {
        status: () => ({ state: 'running', activeTurnId: 1, pendingTurnIds: [2], hasPendingRequests: true }),
        cancel, settled: async () => {},
      } as unknown as IAgentLoopService;
      child.provide(IAgentLoopService, loop);
      child.provide(IAgentExecutionService, new SyncDescriptor(AgentExecutionService));
      const service = child.invokeFunction((a) => a.get(IAgentExecutionService)) as AgentExecutionService;
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const errors = vi.spyOn(console, 'error');
      try {
        const handle = await service.run({ kind: 'prompt', prompt: 'work' }, { signal: controller.signal });
        const completion = expect(handle.completion).rejects.toBeDefined();
        if (close === 'scope-close') child.dispose();
        if (close === 'shutdown') await service.shutdown('close');
        if (close === 'dispose') await service.dispose();
        if (close === 'replacement') {
          child.provide(IAgentLoopService, { ...loop, cancel: vi.fn(() => false) });
        }
        await completion;
        await service.shutdown();
        await service.dispose();
        await service.dispose();
        expect(cancel).toHaveBeenCalledWith(2, expect.anything());
        expect(cancel).toHaveBeenCalledWith(undefined, expect.anything());
        expect(drain).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        await expect(service.run({ kind: 'prompt', prompt: 'late' }, { signal: controller.signal })).rejects.toThrow('shutting down');
        expect(service.status()).toEqual({ state: 'idle' });
        if (close === 'replacement') {
          await vi.waitFor(() => expect(child.invokeFunction((a) => a.get(IAgentExecutionService))).not.toBe(service));
        }
      } finally {
        parent.dispose();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(errors).not.toHaveBeenCalled();
        errors.mockRestore();
      }
    },
  );

  it('rejects a restored research binding before resolving or creating an external executor', async () => {
    const ix = new TestInstantiationService();
    const run = vi.fn<AgentExecutorSession['run']>();
    const create = vi.fn<AgentExecutorProvider['create']>(() => ({
      run, status: () => ({ state: 'idle' as const }), cancel: () => false,
      settled: async () => {}, shutdown: async () => {}, hooks: createHooks(['onWillRun']),
    }));
    const resolveExecutable = vi.fn<IAgentExecutorRegistry['resolveExecutable']>(async () => ({
      descriptor: { id: 'external', protocol: 'acp-v1', args: [], revision: 'r1' },
      options: {},
      provider: {
        id: 'external', protocol: 'acp-v1', validateOptions: () => ({}),
        validateBinding: (binding) => ({ ok: true, binding }), create,
      },
    }));
    ix.stub(ISessionDispatchService, { reserveExecution: () => () => {} });
    ix.set(ProfileServiceId, profile({ executionRestriction: 'research-readonly', executorId: 'external' }));
    ix.set(ScopeContextId, scope());
    ix.set(StateServiceId, states());
    ix.stub(ExecutorRegistryId, { resolveExecutable: resolveExecutable as IAgentExecutorRegistry['resolveExecutable'] });
    ix.stub(IAgentLoopService, {});
    ix.stub(IAgentPromptService, {});
    ix.set(IAgentExecutionService, new SyncDescriptor(AgentExecutionService));
    const service = ix.get(IAgentExecutionService);
    await expect(service.run({ kind: 'prompt', prompt: 'resume research' }, {
      signal: new AbortController().signal,
    })).rejects.toThrow('native executor');
    expect(resolveExecutable).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(service.status()).toEqual({ state: 'idle' });
    ix.dispose();
  });

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
    const service = executionService(
      ix,
      scope(),
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
      preparePromptConfiguration: async () => false,
      getSystemPrompt: () => appendSharedPromptField(binding.systemPrompt, { values: { 'system.shared': 'All executors share this instruction.' }, fields: [] }),
      data: () => binding,
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
    const service = executionService(ix, scope(), profileService, registry, states());

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
    expect(contexts.map((context) => context.binding.systemPrompt)).toEqual(['\n\nAll executors share this instruction.', '\n\nAll executors share this instruction.']);
    expect(binding.systemPrompt).toBe('');
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
    const service = executionService(
      ix,
      scope(),
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
    const service = executionService(
      ix,
      scope(),
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
    }, ix.get(IAgentLoopService), ix.get(IAgentPromptService));
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
