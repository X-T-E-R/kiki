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
import type {
  AgentExecutorProvider,
  AgentExecutorSession,
  IAgentExecutorRegistry,
} from '#/app/agentExecutor/agentExecutor';
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
      provider: () => provider,
    };
    const service = new AgentExecutionService(
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

  it('fails external execution closed when its protocol has no provider', async () => {
    const ix = new TestInstantiationService();
    const registry: IAgentExecutorRegistry = {
      _serviceBrand: undefined,
      get: () => ({ id: 'missing', protocol: 'acp-v1', args: [], revision: 'r1' }),
      resolve: () => ({
        descriptor: { id: 'missing', protocol: 'acp-v1', args: [], revision: 'r1' },
        options: {},
      }),
      provider: () => undefined,
    };
    const service = new AgentExecutionService(
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
