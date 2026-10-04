import { describe, expect, it, vi } from 'vitest';

import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { createServices } from '#/_base/di/test';
import type { TerminalProcess } from '#/os/interface/terminal';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionTerminalService, SessionTerminalService } from '#/session/terminal/terminalService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { SessionClosedEvent } from '#/workspace/sessionLifecycle/sessionLifecycle';
import { IRuntimeResolver } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { createTestAgent, permissionModeServices } from '../../harness';
import { PromptEnqueued } from '#/agent/prompt/promptService';

function accessor(
  entries: ReadonlyArray<readonly [ServiceIdentifier<unknown>, unknown]>,
): ServicesAccessor {
  return {
    get<T>(id: ServiceIdentifier<T>): T {
      for (const [key, value] of entries) {
        if (key === id) return value as T;
      }
      throw new Error(`Unexpected service request: ${String(id)}`);
    },
  };
}

async function drainMicrotasks(ticks = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

interface Fixture {
  readonly service: SessionLifecycleService;
  readonly handle: ISessionScopeHandle;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly closed: SessionClosedEvent[];
  readonly terminals: { live: number };
  readonly mirror: { hold(): void; release(): void };
  readonly drainRetirements: { fail: boolean };
}

function fixture(terminalService?: ISessionTerminalService, agentAccessor?: ServicesAccessor): Fixture {
  const terminals = { live: 0 };
  const drainRetirements = { fail: false };
  const closed: SessionClosedEvent[] = [];
  const dispose = vi.fn();
  let releaseMirror: () => void = () => {};
  const mirror = {
    gate: Promise.resolve(),
    hold(): void {
      mirror.gate = new Promise<void>((resolve) => {
        releaseMirror = resolve;
      });
    },
    release(): void {
      releaseMirror();
    },
  };
  const sessionAccessor = accessor([
    [
      ISessionActivityView,
      { state: () => ({ busy: false, mainTurnActive: false, pendingInteraction: 'none' }) },
    ],
    [IAgentLifecycleService, { countPendingBackgroundTasks: () => 0, list: () => agentAccessor === undefined ? [] : [{ id: 'main', accessor: agentAccessor }], remove: () => { throw new Error('unload must not cancel logical work'); } }],
    [ISessionTerminalService, terminalService ?? { countLiveTerminals: () => terminals.live }],
    [ISessionMetadata, { usage: () => undefined, update: async () => {} }],
  ]);
  const handle = {
    id: 'session-1',
    dispose,
    accessor: sessionAccessor,
  } as unknown as ISessionScopeHandle;
  const loader = { ready: Promise.resolve(), reload: async () => {} };
  const service = Reflect.construct(SessionLifecycleService, [
    {},
    { workspaceId: 'workspace-1', persistenceScope: 'workspace-1', cwd: '/workspace' },
    { homeDir: '/home', scope: () => 'sessions' },
    { get: () => undefined },
    { get: async () => undefined },
    { drain: () => mirror.gate },
    { retainDeletedSession: async () => {} },
    {
      append: () => {},
      flush: async () => {},
      drainRetirements: async () => {
        if (drainRetirements.fail) throw new Error('drain failed');
      },
    },
    { get: async () => undefined },
    { acquireLock: async () => ({ release: async () => {} }) },
    { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    { remove: async () => {}, readdir: async () => [] },
    {},
    { publish: () => {} },
    { track2: () => {}, withContext: () => ({ track2: () => {} }) },
    loader,
    loader,
    loader,
    loader,
    loader,
    { ready: Promise.resolve(), mergeAdditionalDirs: async () => {}, sessionInfo: () => ({}) },
    { reloadSources: async () => {}, sessionData: () => ({}) },
    { sessionProvider: () => ({}), snapshot: {}, reload: async () => {} },
    { sessionHandle: () => ({}) },
    {
      reloadPlugins: async () => {},
      enabledSystemPrompts: async () => [],
      enabledSessionStarts: async () => [],
    },
    { ready: Promise.resolve() },
    { ready: Promise.resolve() },
    () => ({ dispose: () => {} }),
  ]) as SessionLifecycleService;
  service.onDidCloseSession((event) => closed.push(event));
  const sessions = (service as unknown as { sessions: Map<string, ISessionScopeHandle> }).sessions;
  sessions.set(handle.id, handle);
  return { service, handle, dispose, closed, terminals, mirror, drainRetirements };
}

describe('SessionLifecycleService unload', () => {
  it('keeps the session while a terminal spawn is pending and after it resolves', async () => {
    const disposables = new DisposableStore();
    let resolveSpawn!: (process: TerminalProcess) => void;
    const spawn = vi.fn(() => new Promise<TerminalProcess>((resolve) => {
      resolveSpawn = resolve;
    }));
    const runtime = Object.assign(
      new FakeRuntime(
        { workspaceId: 'workspace-1', runtimeId: 'local', generation: 'test' },
        { capabilities: ['terminal'] },
      ),
      { terminal: { spawn } },
    );
    const ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(ISessionTerminalService, SessionTerminalService);
        reg.definePartialInstance(IRuntimeResolver, {
          acquire: () => ({
            runtime,
            track: <T extends { dispose(): void | Promise<void> }>(resource: T): T => resource,
            dispose: () => {},
          }),
        });
        reg.definePartialInstance(ISessionWorkspaceContext, {
          workDir: '/workspace', additionalDirs: [],
        });
        reg.defineInstance(ISessionContext, makeSessionContext({
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          sessionDir: '/workspace/.session',
          sessionScope: 'session:session-1',
          metaScope: 'session:session-1',
          cwd: '/workspace',
        }));
      },
    });
    const terminals = ix.get(ISessionTerminalService);
    const fx = fixture(terminals);
    try {
      const creating = terminals.create({ runtime_id: 'local' });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(await terminals.list()).toHaveLength(0);
      await expect(fx.service.unload('session-1')).resolves.toBe(false);
      expect(fx.dispose).not.toHaveBeenCalled();

      const kill = vi.fn();
      resolveSpawn({
        onProcessData: () => ({ dispose: () => {} }),
        onProcessExit: () => ({ dispose: () => {} }),
        write: () => {},
        resize: () => {},
        kill,
      });
      const created = await creating;
      expect(kill).not.toHaveBeenCalled();
      expect(terminals.countLiveTerminals()).toBe(1);
      expect(fx.service.get('session-1')).toBe(fx.handle);
      await expect(fx.service.unload('session-1')).resolves.toBe(false);

      await terminals.close(created.id);
      await expect(fx.service.unload('session-1')).resolves.toBe(true);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(fx.dispose).toHaveBeenCalledTimes(1);
    } finally {
      disposables.dispose();
      fx.service.dispose();
    }
  });

  it('refuses to evict a session that owns a live terminal', async () => {
    const fx = fixture();
    fx.terminals.live = 1;

    await expect(fx.service.unload('session-1')).resolves.toBe(false);

    expect(fx.dispose).not.toHaveBeenCalled();
    expect(fx.closed).toEqual([]);
    expect(fx.service.get('session-1')).toBe(fx.handle);
  });

  it('evicts once the terminal blocker is released', async () => {
    const fx = fixture();
    fx.terminals.live = 1;
    await expect(fx.service.unload('session-1')).resolves.toBe(false);

    fx.terminals.live = 0;
    await expect(fx.service.unload('session-1')).resolves.toBe(true);

    expect(fx.dispose).toHaveBeenCalledTimes(1);
    expect(fx.closed).toEqual([{ sessionId: 'session-1', reason: 'evict' }]);
    expect(fx.service.get('session-1')).toBeUndefined();
  });

  it('rechecks the terminal blocker before commit', async () => {
    const fx = fixture();
    fx.mirror.hold();
    const unload = fx.service.unload('session-1');
    await drainMicrotasks();
    fx.terminals.live = 1;
    fx.mirror.release();

    await expect(unload).resolves.toBe(false);

    expect(fx.dispose).not.toHaveBeenCalled();
    expect(fx.service.get('session-1')).toBe(fx.handle);
  });

  it('keeps the session and its terminals live when preparation fails', async () => {
    const fx = fixture();
    fx.drainRetirements.fail = true;

    await expect(fx.service.unload('session-1')).rejects.toThrow('drain failed');
    expect(fx.dispose).not.toHaveBeenCalled();

    fx.drainRetirements.fail = false;
    fx.terminals.live = 1;
    await expect(fx.service.unload('session-1')).resolves.toBe(false);
    expect(fx.service.get('session-1')).toBe(fx.handle);
    expect(fx.closed).toEqual([]);

    fx.terminals.live = 0;
    await expect(fx.service.unload('session-1')).resolves.toBe(true);
    expect(fx.dispose).toHaveBeenCalledTimes(1);
  });
});

it.each(['pending', 'launching', 'recovery', 'finalizing'] as const)('blocks runtime unload for %s work and never calls cancellation', async (kind) => {
  const promptState = { pending: kind === 'pending' || kind === 'recovery' ? [{ id: 'queued' }] : [], launching: kind === 'launching' ? { id: 'launching' } : undefined, hold: kind === 'recovery' ? { reason: 'recovery', count: 1 } : undefined };
  const fx = fixture(undefined, accessor([
    [IAgentPromptService, { list: () => promptState }],
    [IAgentLoopService, { status: () => ({ state: kind === 'finalizing' ? 'running' : 'idle', pendingTurnIds: [], hasPendingRequests: false }) }],
    [IAgentExecutionService, { status: () => ({ state: 'idle' }) }],
    [IEventDispatcher, { saveReplayCheckpoint: async () => true }],
  ]));
  try {
    expect(await fx.service.unload('session-1')).toBe(false);
    expect(fx.service.get('session-1')).toBe(fx.handle);
    expect(fx.dispose).not.toHaveBeenCalled();
  } finally { fx.service.dispose(); }
});

it('rechecks queued prompts after asynchronous preparation before disposing the runtime', async () => {
  let pending: object[] = [];
  const fx = fixture(undefined, accessor([
    [IAgentPromptService, { list: () => ({ pending }) }],
    [IAgentLoopService, { status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }) }],
    [IAgentExecutionService, { status: () => ({ state: 'idle' }) }],
    [IEventDispatcher, { saveReplayCheckpoint: async () => true }],
  ]));
  try {
    fx.mirror.hold();
    const unloading = fx.service.unload('session-1');
    await drainMicrotasks();
    pending = [{ id: 'arrived-during-save' }];
    fx.mirror.release();
    expect(await unloading).toBe(false);
    expect(fx.dispose).not.toHaveBeenCalled();
  } finally { fx.mirror.release(); fx.service.dispose(); }
});

it('keeps a durable recovered prompt through an unload attempt and resumes its own message', async () => {
  const ctx = createTestAgent(permissionModeServices('yolo'));
  const fx = fixture(undefined, { get: (id) => ctx.get(id) });
  try {
    const dispatcher = ctx.get(IEventDispatcher);
    await dispatcher.dispatch(new PromptEnqueued({ schemaVersion: 1, promptId: 'recovered', userMessageId: 'recovered', createdAt: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', id: 'recovered', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Retained task' }], toolCalls: [] },
      goalId: null, alreadyMaterialized: false, appendTiming: 'agent_idle', revision: 0, queueIndex: 0,
    }));
    await dispatcher.hooks.onDidRestore.run({});
    const prompt = ctx.get(IAgentPromptService);
    expect(prompt.list().hold).toEqual({ reason: 'recovery', count: 1 });
    expect(await fx.service.unload('session-1')).toBe(false);
    expect(prompt.list().pending.map((item) => item.id)).toEqual(['recovered']);
    expect((await ctx.persistedWireRecords()).some((record) => record.type === 'prompt.aborted')).toBe(false);
    ctx.mockNextResponse({ type: 'text', text: 'Resumed retained task' });
    await prompt.steer(['recovered']);
    await ctx.untilTurnEnd();
    expect(prompt.list().pending).toEqual([]);
    expect(JSON.stringify(ctx.lastLlmInput())).toContain('Retained task');
  } finally { fx.service.dispose(); await ctx.dispose(); }
});
