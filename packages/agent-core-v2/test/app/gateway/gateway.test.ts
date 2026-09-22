import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { Disposable, DisposableStore } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { type IAgentScopeHandle, type ISessionScopeHandle } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IRestGateway } from '#/app/gateway/gateway';
import { RestGateway } from '#/app/gateway/gatewayService';
import { ILogService } from '#/_base/log/log';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycle';
import { IAgentLoopService } from '#/agent/loop/loop';
import { createHooks } from '#/hooks';
import { stubLog } from '../../_base/log/stubs';
import { stubLoopWithHooks, type StubLoop } from '../../agent/loop/stubs';

function makeAccessor(
  entries: ReadonlyArray<readonly [ServiceIdentifier<unknown>, unknown]>,
): ServicesAccessor {
  return {
    get<T>(id: ServiceIdentifier<T>): T {
      for (const [key, value] of entries) {
        if (key === id) return value as T;
      }
      throw new Error(`unexpected service request: ${String(id)}`);
    },
  };
}

describe('RestGateway', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let executionRun: ReturnType<typeof vi.fn<IAgentExecutionService['run']>>;
  let executorId: string;
  let turnService: StubLoop;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    executorId = 'native';
    turnService = stubLoopWithHooks({ hasActiveTurn: true });
    executionRun = vi.fn(async () => ({
      agentId: 'main',
      turn: {
        id: 7,
        signal: new AbortController().signal,
        ready: Promise.resolve(),
        result: Promise.resolve({ type: 'completed', steps: 1, truncated: false }),
        cancel: () => false,
      },
      completion: Promise.resolve({ summary: 'done' }),
    }));
    const execution: IAgentExecutionService = {
      _serviceBrand: undefined,
      run: executionRun,
      trackPromptRun: (_completion, signal) => signal,
      status: () => ({ state: 'running', turnId: 7 }),
      cancel: (reason) => turnService.cancel(undefined, reason),
      settled: () => Promise.resolve(),
      shutdown: () => Promise.resolve(),
      hooks: createHooks(['onWillRun']) as IAgentExecutionService['hooks'],
    };

    const promptService: IAgentPromptService = {
      _serviceBrand: undefined,
      enqueue: () => Promise.resolve({ id: 'p', launched: Promise.resolve(undefined) } as never),
      submit: () => Promise.resolve(undefined),
      submitAndWait: async () => {
        throw new Error('IAgentPromptService.submitAndWait is not supported in the gateway test');
      },
      submitSteer: () => Promise.resolve(undefined),
      steer: () => Promise.resolve([]),
      list: () => ({ active: undefined, pending: [] }),
      hasReadyPending: () => false,
      resumeRecoveredQueue: () => {},
      replace: () => { throw new Error('unexpected prompt replacement'); },
      changeTiming: () => { throw new Error('unexpected prompt timing change'); },
      move: () => { throw new Error('unexpected prompt move'); },
      abort: () => true,
      drain: () => Promise.resolve(),
      inject: () => Promise.resolve(undefined),
      retry: () => Promise.resolve(undefined),
      clear: () => {},
      hooks: createHooks(['onBeforeSubmitPrompt']) as IAgentPromptService['hooks'],
    };

    const agentHandle: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: makeAccessor([
        [IAgentExecutionService, execution],
        [IAgentProfileService, { data: () => ({ executorId }) }],
        [IAgentPromptService, promptService],
        [IAgentLoopService, turnService],
      ]),
      dispose: () => {},
    };
    const agents: IAgentLifecycleService = {
      _serviceBrand: undefined,
      onWillCreate: () => ({ dispose: () => {} }),
      onDidCreate: () => ({ dispose: () => {} }),
      onDidDispose: () => ({ dispose: () => {} }),
      create: () => Promise.resolve(agentHandle),
      commitCreate: () => {
        throw new Error('IAgentLifecycleService.commitCreate is not supported in the gateway test');
      },
      discard: async () => {
        throw new Error('IAgentLifecycleService.discard is not supported in the gateway test');
      },
      fork: () => Promise.resolve(agentHandle),
      get: (id) => (id === 'main' ? agentHandle : undefined),
      list: () => [agentHandle],
      remove: () => Promise.resolve(),
      broadcastPermissionMode: () => {},
      countPendingBackgroundTasks: () => {
        throw new Error('IAgentLifecycleService.countPendingBackgroundTasks is not supported in the gateway test');
      },
      drainBackgroundTasks: async () => {
        throw new Error('IAgentLifecycleService.drainBackgroundTasks is not supported in the gateway test');
      },
    };
    const sessionHandle: ISessionScopeHandle = {
      id: 's1',
      kind: LifecycleScope.Session,
      accessor: makeAccessor([[IAgentLifecycleService, agents]]),
      dispose: () => {},
    };

    const sessionLifecycle: ISessionLifecycleService = {
      _serviceBrand: undefined,
      onWillCreateSession: () => ({ dispose: () => {} }),
      onDidCreateSession: () => ({ dispose: () => {} }),
      onWillCloseSession: () => ({ dispose: () => {} }),
      onDidCloseSession: () => ({ dispose: () => {} }),
      onDidArchiveSession: () => ({ dispose: () => {} }),
      onDidForkSession: () => ({ dispose: () => {} }),
      create: () => Promise.resolve(sessionHandle),
      get: (id: string) => (id === 's1' ? sessionHandle : undefined),
      list: () => [sessionHandle],
      resume: () => Promise.resolve(sessionHandle),
      close: () => Promise.resolve(),
      archive: () => Promise.resolve(),
      restore: () => Promise.resolve(sessionHandle),
      delete: () => Promise.resolve(),
      fork: () => Promise.resolve(sessionHandle),
      createChild: () => Promise.resolve(sessionHandle),
    };
    const handlerHandle = {
      id: 'wd_stub',
      kind: 'program',
      accessor: makeAccessor([[ISessionLifecycleService, sessionLifecycle]]),
      dispose: () => {},
    } as const;
    ix.stub(ISessionManager, {
      _serviceBrand: undefined,
      create: () => Promise.resolve(sessionHandle),
      resume: () => Promise.resolve(sessionHandle),
      get: (id: string) => (id === 's1' ? sessionHandle : undefined),
      list: () => [sessionHandle],
      close: () => Promise.resolve(),
      archive: () => Promise.resolve(),
      restore: () => Promise.resolve(sessionHandle),
      delete: () => Promise.resolve(),
      fork: () => Promise.resolve(sessionHandle),
    });
    ix.stub(ILogService, stubLog());
    ix.set(IRestGateway, new SyncDescriptor(RestGateway));
  });
  afterEach(() => disposables.dispose());

  it('routes prompt through the agent execution service', async () => {
    const gw = ix.get(IRestGateway);
    await expect(gw.prompt('s1', 'main', 'hello')).resolves.toEqual({ turn_id: 7 });

    expect(executionRun).toHaveBeenCalledWith(
      { kind: 'prompt', prompt: 'hello', origin: { kind: 'user' } },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('rejects steer for an external executor', async () => {
    executorId = 'grok-acp';
    const gw = ix.get(IRestGateway);

    await expect(gw.steer('s1', 'main', 'change')).rejects.toThrow(
      /Steering is unsupported for external executor "grok-acp"/,
    );
  });

  it('aborts the active turn signal on cancel', async () => {
    const gw = ix.get(IRestGateway);
    const turn = turnService.startTurn();
    await gw.cancel('s1', 'main', 'bye');

    expect(turn.signal.aborted).toBe(true);
    expect(turn.signal.reason).toBe('bye');
  });
});
