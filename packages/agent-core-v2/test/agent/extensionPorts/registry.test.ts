import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginHttpRouteDescriptor, PluginWsTopicDescriptor } from '@kiki/protocol';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import type { ProfileBindingSnapshot } from '#/agent/profile/profile';
import type {
  AgentExecutorContext,
  AgentExecutorDescriptor,
  AgentExecutorProvider,
  AgentExecutorSession,
} from '#/app/agentExecutor/agentExecutor';
import {
  IPluginExtensionPortRegistryReader,
} from '#/app/pluginExtensionPorts/pluginExtensionPortRegistry';
import { PluginExtensionPortRegistryService } from '#/app/pluginExtensionPorts/pluginExtensionPortRegistryService';
import type {
  ApprovedToolExecutionWrapperContext,
  DynamicExecutorContribution,
  LoopBoundarySnapshot,
  LoopBoundaryProposal,
} from '#/app/plugin/extensionSlots';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import type { FrozenLLMRequestSnapshot } from '#/kosong/contract/extensionHooks';
import { createHooks } from '#/hooks';
import type { ExecutableToolResult } from '#/tool/toolContract';

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const protocolAdapterStub: IProtocolAdapterRegistry = {
  _serviceBrand: undefined,
  supportedProtocols: () => [],
  registerDynamicProtocolBase: () => ({ dispose() {} }),
  registerDynamicProvider: () => ({ dispose() {} }),
  generationOfProvider: () => 0,
  resolveAdapterIdentity: () => { throw new Error('Unexpected protocol adapter access'); },
  resolveProviderBaseId: () => { throw new Error('Unexpected protocol adapter access'); },
  resolveCapability: () => { throw new Error('Unexpected protocol adapter access'); },
  explainCapability: () => { throw new Error('Unexpected protocol adapter access'); },
  createChatProvider: () => { throw new Error('Unexpected protocol adapter access'); },
};

function toolContext(signal: AbortSignal): ApprovedToolExecutionWrapperContext {
  return {
    sessionId: 'session-test',
    agentId: 'agent-test',
    turnId: 1,
    step: 1,
    toolCallId: 'tool-call-test',
    toolName: 'example_tool',
    approvedArgs: { value: 'approved' },
    execContext: { turnId: 1, step: 1, toolCallId: 'tool-call-test', signal },
  };
}

function executorDescriptor(id: string, protocol: AgentExecutorProvider['protocol']): AgentExecutorDescriptor {
  return { id, protocol, args: [], revision: `revision-${id}` };
}

function executorContribution(
  descriptor: AgentExecutorDescriptor,
  provider: AgentExecutorProvider,
): DynamicExecutorContribution {
  return { pluginId: 'plugin-executor', protocol: descriptor.protocol, descriptor, provider };
}

describe('PluginExtensionPortRegistryService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let registry: IPluginExtensionPortRegistryReader;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(IProtocolAdapterRegistry, protocolAdapterStub);
        reg.define(IPluginExtensionPortRegistryReader, PluginExtensionPortRegistryService);
      },
    });
    registry = ix.get(IPluginExtensionPortRegistryReader);
  });

  afterEach(async () => {
    await disposables.dispose();
  });

  it('merges prompt sections by order and registration sequence', async () => {
    registry.registerPromptSection({
      pluginId: 'plugin-late',
      sectionId: 'late',
      order: 20,
      render: () => ' third ',
    });
    registry.registerPromptSection({
      pluginId: 'plugin-first',
      sectionId: 'first',
      order: 10,
      suppressRuntimeContext: true,
      render: () => ' first ',
    });
    registry.registerPromptSection({
      pluginId: 'plugin-second',
      sectionId: 'second',
      order: 10,
      render: () => ' second ',
    });

    await expect(registry.renderPromptSections({ sessionId: 'session-test', agentId: 'agent-test' })).resolves.toEqual({
      text: 'first\n\nsecond\n\nthird',
      suppressRuntimeContext: true,
    });
  });

  it('does not commit a withdrawn async proposal and waits for it to settle', async () => {
    const proposal = deferred<LoopBoundaryProposal>();
    const handlerStarted = deferred<void>();
    const snapshot: LoopBoundarySnapshot = {
      sessionId: 'session-test',
      agentId: 'agent-test',
      turnId: 1,
      step: 1,
      firstStepOfTurn: true,
      modelAlias: 'model-test',
      continuationStreakCount: 0,
    };
    const registration = registry.registerPreStepPolicy('plugin-async', async () => {
      handlerStarted.resolve(undefined);
      return proposal.promise;
    });
    const proposing = registry.proposePreStep(snapshot, new AbortController().signal);
    await handlerStarted.promise;

    let disposalFinished = false;
    const disposing = Promise.resolve(registration.dispose()).then(() => {
      disposalFinished = true;
    });
    await Promise.resolve();
    expect(disposalFinished).toBe(false);

    proposal.resolve({ action: 'request_turn_stop', reason: 'withdrawn' });
    await expect(proposing).resolves.toEqual({ action: 'continue_normal' });
    await disposing;
    expect(disposalFinished).toBe(true);
  });

  it('resolves HTTP routes by exact plugin, method, and subpath and replaces frozen descriptors distinctly', async () => {
    const descriptor: PluginHttpRouteDescriptor = {
      pluginId: 'plugin-http',
      method: 'GET',
      subpath: '/items',
      scopeAcl: 'session',
      maxBodyBytes: 1024,
    };
    const registration = registry.registerHttpRoute(descriptor, async () => ({ status: 201, data: 'first' }));
    const resolved = registry.resolveHttpRoute?.('plugin-http', 'GET', '/items');

    expect(resolved).toEqual(descriptor);
    expect(resolved).not.toBe(descriptor);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(registry.resolveHttpRoute?.('other-plugin', 'GET', '/items')).toBeUndefined();
    expect(registry.resolveHttpRoute?.('plugin-http', 'POST', '/items')).toBeUndefined();
    expect(registry.resolveHttpRoute?.('plugin-http', 'GET', '/items/child')).toBeUndefined();

    const context = {
      pluginId: 'plugin-http',
      method: 'GET' as const,
      subpath: '/items',
      query: {},
      headers: {},
      body: undefined,
      signal: new AbortController().signal,
    };
    await expect(registry.invokeHttpRoute(context)).resolves.toEqual({ status: 201, data: 'first' });
    await expect(registry.invokeHttpRoute({ ...context, pluginId: 'other-plugin' })).resolves.toBeUndefined();

    await registration.dispose();
    const replacementDescriptor = { ...descriptor, maxBodyBytes: 2048 };
    const replacementRegistration = registry.registerHttpRoute(replacementDescriptor, async () => ({ status: 200, data: 'replacement' }));
    const replacement = registry.resolveHttpRoute?.('plugin-http', 'GET', '/items');
    expect(replacement).toEqual(replacementDescriptor);
    expect(replacement).not.toBe(resolved);
    expect(Object.isFrozen(replacement)).toBe(true);
    await replacementRegistration.dispose();
  });

  it('publishes WebSocket topic events only for registered topics', async () => {
    const published: Array<{ readonly pluginId: string; readonly topic: string; readonly payload: unknown }> = [];
    disposables.add(registry.onDidPublishWsTopicEvent((event) => published.push(event)));
    const descriptor: PluginWsTopicDescriptor = {
      pluginId: 'plugin-ws',
      topic: 'status.update',
      scopeAcl: 'session',
    };

    registry.publishWsTopicEvent({ pluginId: 'plugin-ws', topic: 'status.update', payload: 'before-registration' });
    registry.publishWsTopicEvent({ pluginId: 'other-plugin', topic: 'status.update', payload: 'wrong-plugin' });
    registry.publishWsTopicEvent({ pluginId: 'plugin-ws', topic: 'other.topic', payload: 'wrong-topic' });
    const registration = registry.registerWsTopic(descriptor);
    const event = { pluginId: 'plugin-ws', topic: 'status.update', payload: 'registered' };
    registry.publishWsTopicEvent(event);
    await registration.dispose();
    registry.publishWsTopicEvent({ ...event, payload: 'after-withdrawal' });

    expect(published).toEqual([event]);
  });

  it('continues each approved wrapper ticket once and narrows the signal through both wrappers', async () => {
    const outerSignals: AbortSignal[] = [];
    const innerSignals: AbortSignal[] = [];
    const outerOverrides: AbortController[] = [];
    const innerOverrides: AbortController[] = [];
    const terminalStarts: Array<Deferred<AbortSignal>> = [];
    const terminalBodies: Array<Deferred<ExecutableToolResult>> = [];
    let terminalCalls = 0;

    registry.registerApprovedToolExecutionWrapper('outer', async (context, next) => {
      outerSignals.push(context.execContext.signal);
      const override = new AbortController();
      outerOverrides.push(override);
      return next(override.signal);
    }, { order: 0 });
    registry.registerApprovedToolExecutionWrapper('inner', async (context, next) => {
      innerSignals.push(context.execContext.signal);
      const override = new AbortController();
      innerOverrides.push(override);
      const continued = next(override.signal);
      await expect(next()).rejects.toThrow('continued more than once');
      return continued;
    }, { order: 1 });

    const runTool = (signal: AbortSignal) => {
      const started = deferred<AbortSignal>();
      const body = deferred<ExecutableToolResult>();
      terminalStarts.push(started);
      terminalBodies.push(body);
      return registry.executeApprovedTool(toolContext(signal), async (terminalSignal) => {
        terminalCalls += 1;
        started.resolve(terminalSignal);
        const result = await body.promise;
        terminalSignal.throwIfAborted();
        return result;
      });
    };

    const firstController = new AbortController();
    const firstRun = runTool(firstController.signal);
    const firstTerminalSignal = await terminalStarts[0]!.promise;
    expect(outerSignals[0]).toBe(firstController.signal);
    expect(innerSignals[0]).not.toBe(firstController.signal);
    expect(firstTerminalSignal).not.toBe(innerSignals[0]);
    expect(terminalCalls).toBe(1);
    outerOverrides[0]!.abort();
    expect(innerSignals[0]!.aborted).toBe(true);
    expect(firstTerminalSignal.aborted).toBe(true);
    terminalBodies[0]!.resolve({ output: 'first body' });
    await expect(firstRun).rejects.toThrow();

    const secondController = new AbortController();
    const secondRun = runTool(secondController.signal);
    const secondTerminalSignal = await terminalStarts[1]!.promise;
    expect(outerSignals[1]).toBe(secondController.signal);
    expect(innerSignals[1]!.aborted).toBe(false);
    expect(secondTerminalSignal.aborted).toBe(false);
    expect(terminalCalls).toBe(2);
    innerOverrides[1]!.abort();
    expect(innerSignals[1]!.aborted).toBe(false);
    expect(secondTerminalSignal.aborted).toBe(true);
    terminalBodies[1]!.resolve({ output: 'second body' });
    await expect(secondRun).rejects.toThrow();
  });

  it('consumes the execution ticket before synchronous downstream code can reenter it', async () => {
    let reenter!: () => Promise<ExecutableToolResult>;
    let duplicate: Promise<unknown> | undefined;
    let terminalCalls = 0;
    registry.registerApprovedToolExecutionWrapper('reentrant', async (_context, next) => {
      reenter = next;
      await Promise.resolve();
      return next();
    });
    await expect(registry.executeApprovedTool(toolContext(new AbortController().signal), async () => {
      terminalCalls += 1;
      if (terminalCalls === 1) duplicate = expect(reenter()).rejects.toThrow('continued more than once');
      return { output: 'tool result' };
    })).resolves.toEqual({ output: 'tool result' });
    await duplicate;
    expect(terminalCalls).toBe(1);
  });

  it('does not start a tool when a queued callback calls next after the wrapper resolves', async () => {
    let late!: Promise<unknown>;
    let terminalCalls = 0;
    registry.registerApprovedToolExecutionWrapper('late', async (_context, next) => {
      queueMicrotask(() => { late = expect(next()).rejects.toThrow('ticket has closed'); });
      return { output: 'wrapper result' };
    });
    await expect(registry.executeApprovedTool(toolContext(new AbortController().signal), async () => {
      terminalCalls += 1;
      return { output: 'tool result' };
    })).resolves.toEqual({ output: 'wrapper result' });
    await late;
    expect(terminalCalls).toBe(0);
  });

  it.each(['returns early', 'throws'] as const)('drains the tool body when a wrapper %s', async (behavior) => {
    const terminalStarted = deferred<void>();
    const terminalBody = deferred<ExecutableToolResult>();
    registry.registerApprovedToolExecutionWrapper('early-wrapper', async (_context, next) => {
      void next();
      if (behavior === 'returns early') return { output: 'wrapper result' };
      throw new Error('wrapper failed');
    });

    let finished = false;
    const execution = registry.executeApprovedTool(
      toolContext(new AbortController().signal),
      async () => {
        terminalStarted.resolve(undefined);
        return terminalBody.promise;
      },
    ).then((result) => {
      finished = true;
      return result;
    }, (error: unknown) => {
      finished = true;
      throw error;
    });
    await terminalStarted.promise;
    expect(finished).toBe(false);

    terminalBody.resolve({ output: 'tool body result' });
    if (behavior === 'returns early') {
      await expect(execution).resolves.toEqual({ output: 'wrapper result' });
    } else {
      await expect(execution).rejects.toThrow('wrapper failed');
    }
    expect(finished).toBe(true);
  });

  it('shuts down and drains a withdrawn executor before settling, without creating its old generation', async () => {
    const sessionSettlement = deferred<void>();
    const shutdownCompletion = deferred<void>();
    const shutdownStarted = deferred<void>();
    const withdrawalSettlementStarted = deferred<void>();
    let settlementCalls = 0;
    let oldProviderCreates = 0;
    let disposalFinished = false;
    const oldDescriptor = executorDescriptor('executor-old', 'example-executor');
    const session: AgentExecutorSession = {
      run: async () => { throw new Error('Unexpected executor run'); },
      status: () => ({ state: 'idle' }),
      cancel: () => false,
      settled: () => {
        settlementCalls += 1;
        if (settlementCalls === 1) withdrawalSettlementStarted.resolve(undefined);
        return sessionSettlement.promise;
      },
      shutdown: async () => {
        shutdownStarted.resolve(undefined);
        await shutdownCompletion.promise;
      },
      hooks: createHooks<{ onWillRun: { signal: AbortSignal } }, 'onWillRun'>(['onWillRun']),
    };
    const oldProvider: AgentExecutorProvider = {
      id: 'provider-old',
      protocol: oldDescriptor.protocol,
      validateOptions: () => ({}),
      validateBinding: (binding) => ({ ok: true, binding }),
      create: () => {
        oldProviderCreates += 1;
        return session;
      },
    };
    const oldContribution = executorContribution(oldDescriptor, oldProvider);
    const oldRegistration = registry.registerDynamicExecutor(oldContribution);
    const context: AgentExecutorContext = {
      agent: { id: 'agent-test', accessor: ix },
      descriptor: oldDescriptor,
      binding: {} as ProfileBindingSnapshot,
    };
    const oldGeneration = registry.dynamicExecutor(oldDescriptor.protocol)!;
    const tracked = registry.createDynamicExecutorSession(oldGeneration, context);
    expect(settlementCalls).toBe(0);
    expect(tracked.status().state).toBe('idle');
    expect(oldProviderCreates).toBe(1);

    const disposing = Promise.resolve(oldRegistration.dispose()).then(() => {
      disposalFinished = true;
    });
    await shutdownStarted.promise;
    expect(registry.dynamicExecutors()).toEqual([]);
    expect(registry.dynamicExecutor(oldDescriptor.protocol)).toBeUndefined();

    const replacementDescriptor = executorDescriptor('executor-new', oldDescriptor.protocol);
    const replacementProvider: AgentExecutorProvider = {
      id: 'provider-new',
      protocol: replacementDescriptor.protocol,
      validateOptions: () => ({}),
      validateBinding: (binding) => ({ ok: true, binding }),
      create: () => { throw new Error('Unexpected replacement executor creation'); },
    };
    const replacement = executorContribution(replacementDescriptor, replacementProvider);
    const replacementRegistration = registry.registerDynamicExecutor(replacement);
    expect(registry.dynamicExecutor(oldDescriptor.protocol)?.descriptor.id).toBe(replacementDescriptor.id);
    expect(registry.dynamicExecutor(oldDescriptor.protocol)?.descriptor.revision).not.toBe(oldGeneration.descriptor.revision);
    expect(() => registry.createDynamicExecutorSession(oldGeneration, context)).toThrow('no longer active');
    expect(oldProviderCreates).toBe(1);
    expect(disposalFinished).toBe(false);

    shutdownCompletion.resolve(undefined);
    await withdrawalSettlementStarted.promise;
    expect(disposalFinished).toBe(false);
    sessionSettlement.resolve(undefined);
    await disposing;
    expect(disposalFinished).toBe(true);
    await replacementRegistration.dispose();
  });
});
