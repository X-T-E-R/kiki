import { describe, expect, it, vi } from 'vitest';

import { createDecorator, type IInstantiationService, type ServiceIdentifier, type ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { getScopedServiceDescriptors, type ISessionScopeHandle } from '#/_base/di/scope';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ScopeUnits } from '#/_base/di/fiber';
import { Service } from '#/_base/di/service';
import { Event } from '#/_base/event';
import { createServices } from '#/_base/di/test';
import type { TerminalProcess } from '#/os/interface/terminal';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { drainSessionMetadataWrites, trackSessionMetadataWork } from '#/session/sessionMetadata/sessionMetadataService';
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

interface FactoryDependencies {
  readonly instantiation: IInstantiationService;
  readonly acquireLock: () => Promise<{ release(): Promise<void> }>;
  readonly acquireWorkspaceReference: () => IDisposable;
}

function fixture(terminalService?: ISessionTerminalService, agentAccessor?: ServicesAccessor, factory?: FactoryDependencies): Fixture {
  const terminals = { live: 0 };
  const drainRetirements = { fail: false };
  const closed: SessionClosedEvent[] = [];
  const dispose = vi.fn<() => Promise<void>>(() => Promise.resolve());
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
    [ISessionMetadata, { usage: () => undefined, update: async () => {}, setArchived: async () => {} }],
  ]);
  const handle = {
    id: 'session-1',
    dispose,
    accessor: sessionAccessor,
  } as unknown as ISessionScopeHandle;
  const loader = { ready: Promise.resolve(), reload: async () => {} };
  const service = Reflect.construct(SessionLifecycleService, [
    factory?.instantiation ?? {},
    { workspaceId: 'workspace-1', persistenceScope: 'workspace-1', cwd: '/workspace' },
    { homeDir: '/home', scope: () => 'sessions' },
    { get: () => undefined },
    { get: async () => undefined, remove: async () => {} },
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
    { acquireLock: factory?.acquireLock ?? (async () => ({ release: async () => {} })) },
    { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    { remove: async () => {}, readdir: async () => [], stat: async () => { throw Object.assign(new Error('missing session'), { code: 'ENOENT' }); } },
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
    factory?.acquireWorkspaceReference ?? (() => ({ dispose: () => {} })),
  ]) as SessionLifecycleService;
  service.onDidCloseSession((event) => closed.push(event));
  const sessions = (service as unknown as { sessions: Map<string, ISessionScopeHandle> }).sessions;
  sessions.set(handle.id, handle);
  return { service, handle, dispose, closed, terminals, mirror, drainRetirements };
}

describe('SessionLifecycleService factory ownership', () => {
  it.each(['close', 'unload', 'materialization-error', 'rollback', 'factory-error'] as const)(
    'awaits contributed cleanup and asynchronous lock release during %s', async (phase) => {
      let releaseCleanup!: () => void;
      let releaseLock!: () => void;
      const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
      const lockGate = new Promise<void>((resolve) => { releaseLock = resolve; });
      const events: string[] = [];
      const failure = new Error('materialization failed');
      class SlowSession extends Service {
        constructor() {
          super();
          this.effect(() => async () => {
            events.push('cleanup start');
            await cleanupGate;
            events.push('cleanup end');
          });
        }
      }
      class Pack extends Service {
        constructor() { super(); this.provide(ScopeUnits('session'), SlowSession); }
      }
      const parent = new InstantiationService();
      const packId = createDecorator<Pack>('session-ownership-pack');
      parent.provide(packId, new SyncDescriptor(Pack));
      parent.invokeFunction((a) => a.get(packId));
      const createChild = parent.createChild.bind(parent);
      const childSpy = vi.spyOn(parent, 'createChild').mockImplementation((collection, store) => {
        for (const entry of getScopedServiceDescriptors('session')) {
          if (collection.get(entry.id) !== undefined) continue;
          collection.set(entry.id, {
            get ready() {
              return entry.id === ISessionMetadata && (phase === 'materialization-error' || phase === 'rollback')
                ? Promise.reject(failure) : Promise.resolve();
            },
            usage: () => undefined,
            update: async () => {},
            list: () => [],
            countPendingBackgroundTasks: () => 0,
            countLiveTerminals: () => 0,
            state: () => ({ busy: false, mainTurnActive: false, pendingInteraction: 'none' }),
            onDidChange: Event.None,
          });
        }
        const child = createChild(collection, store);
        if (phase === 'factory-error') vi.spyOn(child, 'provideAll').mockImplementation(() => { throw failure; });
        return child;
      });
      const workspaceDispose = vi.fn(() => { events.push('workspace released'); });
      const lockDispose = vi.fn(async () => {
        events.push('lock release start');
        await lockGate;
        events.push('lock release end');
      });
      const fx = fixture(undefined, undefined, {
        instantiation: parent,
        acquireLock: async () => ({ release: lockDispose }),
        acquireWorkspaceReference: () => ({ dispose: workspaceDispose }),
      });
      const materialize = () => (fx.service as unknown as {
        materializeSession(opts: { sessionId: string; workDir: string; rollbackOnMaterializationFailure: boolean }): Promise<ISessionScopeHandle>;
      }).materializeSession({ sessionId: 'factory-session', workDir: '/workspace', rollbackOnMaterializationFailure: phase === 'rollback' });
      let pending: Promise<unknown> | undefined;
      try {
        let settled = false;
        const operation = phase === 'close' || phase === 'unload'
          ? materialize().then<unknown>(() => fx.service[phase]('factory-session'))
          : materialize();
        pending = operation.then(
          (value) => { settled = true; return { value }; },
          (error: unknown) => { settled = true; return { error }; },
        );
        await drainMicrotasks();
        const duringCleanup = { events: [...events], settled, closed: [...fx.closed] };
        releaseCleanup();
        await drainMicrotasks();
        const duringLock = { events: [...events], settled, closed: [...fx.closed] };
        releaseLock();
        const result = await pending;
        expect(duringCleanup).toEqual({ events: ['cleanup start'], settled: false, closed: [] });
        expect(duringLock).toEqual({ events: ['cleanup start', 'cleanup end', 'workspace released', 'lock release start'], settled: false, closed: [] });
        expect(events).toEqual(['cleanup start', 'cleanup end', 'workspace released', 'lock release start', 'lock release end']);
        expect(workspaceDispose).toHaveBeenCalledTimes(1);
        expect(lockDispose).toHaveBeenCalledTimes(1);
        expect(result).toEqual(phase === 'close' ? { value: undefined } : phase === 'unload' ? { value: true } : { error: failure });
        expect(fx.closed).toEqual(phase === 'close' || phase === 'unload' ? [{ sessionId: 'factory-session', reason: phase === 'close' ? 'exit' : 'evict' }] : []);
      } finally {
        releaseCleanup();
        releaseLock();
        await pending;
        childSpy.mockRestore();
        await fx.service.dispose();
        await parent.dispose();
      }
    },
  );
});

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
      await disposables.dispose();
      await fx.service.dispose();
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

  it.each(['unload', 'close', 'archive'] as const)('does not wait for activity propagation behind the lifecycle lock during %s', async (operation) => {
    const fx = fixture();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    trackSessionMetadataWork(lock);
    let closed = false;
    let drained = false;
    const closing = fx.service[operation]('session-1').then(() => { closed = true; });
    const shutdown = drainSessionMetadataWrites().then(() => { drained = true; });
    try {
      await drainMicrotasks();
      expect(closed).toBe(true);
      expect(fx.dispose).toHaveBeenCalledTimes(1);
      expect(drained).toBe(false);
    } finally {
      release();
      await closing;
      await shutdown;
      await fx.service.dispose();
    }
    expect(drained).toBe(true);
  });

  it.each(['unload', 'close'] as const)('awaits asynchronous scope disposal before announcing %s', async (operation) => {
    const fx = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fx.dispose.mockReturnValue(gate);
    let settled = false;
    const pending = fx.service[operation]('session-1').then((result) => { settled = true; return result; });
    await drainMicrotasks();
    expect(fx.dispose).toHaveBeenCalledTimes(1);
    expect(fx.closed).toEqual([]);
    expect(settled).toBe(false);
    release();
    await expect(pending).resolves.toBe(operation === 'unload' ? true : undefined);
    expect(fx.closed).toEqual([{ sessionId: 'session-1', reason: operation === 'unload' ? 'evict' : 'exit' }]);
    await expect(fx.service[operation]('session-1')).resolves.toBe(operation === 'unload' ? false : undefined);
    expect(fx.dispose).toHaveBeenCalledTimes(1);
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
  } finally { await fx.service.dispose(); }
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
  } finally { fx.mirror.release(); await fx.service.dispose(); }
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
  } finally { await fx.service.dispose(); await ctx.dispose(); }
});


describe('SessionLifecycleService fork cron ownership', () => {
  it.each(['full', 'turn-boundary', 'child'] as const)('does not inherit schedules during a %s fork or change existing tasks', async (kind) => {
    const fx = fixture();
    const original = { id: '1234abcd', cron: '0 9 * * *', prompt: 'Original reminder', createdAt: 1, recurring: true, paused: false, lastFiredAt: 2, tags: { sessionId: 'session-1' } };
    const existingCopy = { ...original, id: '2345bcde', tags: { sessionId: 'existing-fork' } };
    const tasks = new Map([[original.id, structuredClone(original)], [existingCopy.id, structuredClone(existingCopy)]]);
    const before = structuredClone([...tasks.values()]);
    const list = vi.fn(async () => [...tasks.values()]);
    const save = vi.fn(async (_workspaceId: string, task: typeof original) => { tasks.set(task.id, task); });
    const removeTask = vi.fn(async (_workspaceId: string, id: string) => { tasks.delete(id); });
    const records = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      { type: 'cron.add', task: original, time: 2 },
      { type: 'cron.cursor', id: original.id, lastFiredAt: 2, time: 3 },
      { type: 'cron.delete', ids: ['removed-task'], time: 4 },
      { type: 'cron.fired', origin: { kind: 'cron_job', jobId: original.id, cron: original.cron, recurring: true, coalescedCount: 1, stale: false }, prompt: 'Historical reminder', time: 5 },
      { type: 'context.append_message', time: 6, message: { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'First turn' }], toolCalls: [], origin: { kind: 'user' } } },
      { type: 'context.append_message', time: 7, message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'First reply' }], toolCalls: [] } },
      { type: 'context.append_message', time: 8, message: { id: 'user-2', role: 'user', content: [{ type: 'text', text: 'Second turn' }], toolCalls: [], origin: { kind: 'user' } } },
    ];
    const sourceRecords = structuredClone(records);
    const rewrite = vi.fn();
    const update = vi.fn(async () => {});
    const createAgent = vi.fn(async () => {});
    const target = {
      id: 'new-fork',
      dispose: vi.fn(),
      accessor: accessor([
        [ISessionContext, { sessionId: 'new-fork' }],
        [ISessionMetadata, { update }],
        [IAgentLifecycleService, { list: () => [], create: createAgent }],
      ]),
    } as unknown as ISessionScopeHandle;
    const source = {
      ...fx.handle,
      accessor: accessor([
        [ISessionMetadata, { read: async () => ({ title: 'Source', agents: { main: {} } }) }],
        [IAgentLifecycleService, { list: () => [], get: () => undefined }],
      ]),
    };
    const internals = fx.service as unknown as {
      sessions: Map<string, ISessionScopeHandle>;
      materializeSession(opts: { sessionId: string; workDir: string }): Promise<ISessionScopeHandle>;
      announceCreated(event: unknown): Promise<void>;
    };
    internals.sessions.set('session-1', source);
    const materialize = vi.spyOn(internals, 'materializeSession').mockResolvedValue(target);
    const announce = vi.spyOn(internals, 'announceCreated').mockResolvedValue();
    Object.assign(fx.service, {
      cronStore: { list, save, delete: removeTask },
      appendLogStore: { append: vi.fn(), flush: async () => {}, read: async function* () { yield* records; }, rewrite },
    });
    try {
      const result = kind === 'child'
        ? await fx.service.createChild({ sourceSessionId: 'session-1', newSessionId: target.id })
        : await fx.service.fork({ sourceSessionId: 'session-1', newSessionId: target.id, turnIndex: kind === 'turn-boundary' ? 0 : undefined });
      expect(result).toBe(target);
      expect(materialize).toHaveBeenCalledWith({ sessionId: target.id, workDir: '/workspace' });
      expect(createAgent).toHaveBeenCalledOnce();
      expect(announce).toHaveBeenCalledOnce();
      expect(save).not.toHaveBeenCalled();
      expect(removeTask).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
      expect([...tasks.values()]).toEqual(before);
      expect([...tasks.values()].filter((task) => task.tags.sessionId === target.id)).toEqual([]);
      const copied = rewrite.mock.calls[0]![2] as typeof records;
      expect(copied.filter((record) => ['cron.add', 'cron.cursor', 'cron.delete'].includes(record.type))).toEqual([]);
      expect(copied).toContainEqual(records[4]);
      expect(copied).toContainEqual(records[5]);
      expect(copied).toContainEqual(records[6]);
      expect(copied.some((record) => record.type === 'context.append_message' && record.message?.id === 'user-2')).toBe(kind !== 'turn-boundary');
      expect(copied.at(-1)?.type).toBe('forked');
      expect(records).toEqual(sourceRecords);
    } finally {
      materialize.mockRestore();
      announce.mockRestore();
      await fx.service.dispose();
    }
  });
});
