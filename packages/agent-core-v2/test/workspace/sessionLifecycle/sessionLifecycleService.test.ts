import { describe, expect, it, vi } from 'vitest';

import { resetUnexpectedErrorHandler, setUnexpectedErrorHandler } from '#/_base/errors/unexpectedError';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { AGENT_WIRE_RECORD_KEY } from '#/wire/record';
import { WIRE_TRANSCRIPT_RECEIPT_KEY, parseWireTranscriptReceipt } from '#/wire/transcriptReceipt';
import { IWireService } from '#/wire/wire';
import { SessionManager } from '#/app/sessionManager/sessionManagerService';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { noopLogger, registerTestAgentWire, testWireScope } from '../../wire/stubs';

import { createDecorator, type IInstantiationService, type ServiceIdentifier, type ServicesAccessor } from '#/_base/di/instantiation';
import { Error2, ErrorCodes } from '#/errors';
import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { getScopedServiceDescriptors, type IAgentScopeHandle, type ISessionScopeHandle } from '#/_base/di/scope';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ScopeUnits } from '#/_base/di/fiber';
import { Service } from '#/_base/di/service';
import { Emitter, Event } from '#/_base/event';
import { createServices, TestInstantiationService } from '#/_base/di/test';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { TerminalProcess } from '#/os/interface/terminal';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { IAgentActivityView } from '#/agent/activityView/activityView';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { drainSessionMetadataWrites, trackSessionMetadataWork } from '#/session/sessionMetadata/sessionMetadataService';
import { ISessionTerminalService, SessionTerminalService } from '#/session/terminal/terminalService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { SessionClosedEvent, SessionCreatedEvent } from '#/workspace/sessionLifecycle/sessionLifecycle';
import { IRuntimeResolver, IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
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
  readonly metadata: { hold(): void; release(): void };
  readonly mirror: { hold(): void; release(): void };
  readonly activity: { busy: boolean; mainTurnActive: boolean; pendingInteraction: string };
  readonly drainRetirements: { fail: boolean };
  readonly cleanupStages: Array<{ operationId: string; sessionId: string; stage: string }>;
}

interface FactoryDependencies {
  readonly instantiation: IInstantiationService;
  readonly acquireLock: () => Promise<{ release(): Promise<void> }>;
  readonly acquireWorkspaceReference: () => IDisposable;
}

function fixture(terminalService?: ISessionTerminalService, agentAccessor?: ServicesAccessor, factory?: FactoryDependencies): Fixture {
  const terminals = { live: 0 };
  const drainRetirements = { fail: false };
  const cleanupStages: Fixture['cleanupStages'] = [];
  const closed: SessionClosedEvent[] = [];
  const activity: Fixture['activity'] = { busy: false, mainTurnActive: false, pendingInteraction: 'none' };
  const dispose = vi.fn<() => Promise<void>>(() => Promise.resolve());
  let releaseMetadata: () => void = () => {};
  const metadata = {
    gate: Promise.resolve(),
    hold(): void {
      metadata.gate = new Promise<void>((resolve) => {
        releaseMetadata = resolve;
      });
    },
    release(): void {
      releaseMetadata();
    },
  };
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
      { state: () => activity },
    ],
    [IAgentLifecycleService, {
      countPendingBackgroundTasks: () => 0,
      list: () => agentAccessor === undefined ? [] : [{ id: 'main', accessor: agentAccessor }],
      remove: (...args: unknown[]) => {
        const candidate = agentAccessor as unknown as { remove?: (...values: unknown[]) => unknown } | undefined;
        return candidate?.remove?.(...args) ?? Promise.reject(new Error('unload must not cancel logical work'));
      },
    }],
    [ISessionTerminalService, terminalService ?? { countLiveTerminals: () => terminals.live }],
    [ISessionMetadata, { drain: () => metadata.gate, read: async () => ({ agents: {} }), usage: () => undefined, update: async () => {}, setArchived: async () => {} }],
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
    { error: () => {}, warn: () => {}, info: (message: string, payload: Fixture['cleanupStages'][number]) => {
      if (message === 'session cleanup waiting') cleanupStages.push(payload);
    }, debug: () => {} },
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
      enabledMcpServers: async () => ({}),
    },
    { ready: Promise.resolve() },
    { ready: Promise.resolve() },
    factory?.acquireWorkspaceReference ?? (() => ({ dispose: () => {} })),
  ]) as SessionLifecycleService;
  service.onDidCloseSession((event) => closed.push(event));
  const sessions = (service as unknown as { sessions: Map<string, ISessionScopeHandle> }).sessions;
  sessions.set(handle.id, handle);
  return { service, handle, dispose, closed, terminals, metadata, mirror, activity, drainRetirements, cleanupStages };
}

describe('SessionLifecycleService create persistence ownership', () => {
  it.each(['blocked', 'failed'] as const)('does not couple a new session to an unrelated %s append', async (unrelated) => {
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    let releaseOther!: () => void;
    let releaseIndex!: () => void;
    const otherGate = new Promise<void>((resolve) => { releaseOther = resolve; });
    const indexGate = new Promise<void>((resolve) => { releaseIndex = resolve; });
    const originalAppend = storage.append.bind(storage);
    storage.append = async (scope, key, bytes, options) => {
      if (scope === 'unrelated-agent') {
        if (unrelated === 'failed') throw new Error('unrelated append failed');
        await otherGate;
      }
      if (key === 'session_index.jsonl') await indexGate;
      return originalAppend(scope, key, bytes, options);
    };
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const logs = ix.get(IAppendLogStore);
    logs.append('unrelated-agent', 'wire.jsonl', { value: 'unrelated' });
    const fx = fixture();
    Object.assign(fx.service, { appendLogStore: logs });
    const handle = {
      id: 'new-session', dispose: vi.fn(async () => {}),
      accessor: accessor([
        [ITelemetryService, { track2: () => {} }],
        [ISessionContext, { sessionDir: '/home/new-session' }],
        [IAgentLifecycleService, { list: () => [] }],
      ]),
    } as unknown as ISessionScopeHandle;
    const owner = fx.service as unknown as { materializeSession(opts: unknown): Promise<ISessionScopeHandle> };
    const materialize = vi.spyOn(owner, 'materializeSession').mockResolvedValue(handle);
    const created: string[] = [];
    fx.service.onDidCreateSession((event) => created.push(event.sessionId));
    let result: { value?: ISessionScopeHandle; error?: unknown } | undefined;
    const pending = fx.service.create({ sessionId: handle.id, workDir: '/empty-workspace' }).then(
      (value) => { result = { value }; }, (error: unknown) => { result = { error }; },
    );
    try {
      await drainMicrotasks();
      expect(result).toBeUndefined();
      expect(created).toEqual([]);
      releaseIndex();
      await drainMicrotasks();
      expect(result).toEqual({ value: handle });
      expect(created).toEqual([handle.id]);
      const records = [];
      for await (const record of logs.read('', 'session_index.jsonl')) records.push(record);
      expect(records).toEqual([expect.objectContaining({ sessionId: handle.id, workDir: '/empty-workspace' })]);
    } finally {
      releaseOther();
      releaseIndex();
      await pending;
      materialize.mockRestore();
      await fx.service.dispose();
      await disposables.dispose();
    }
  });

  it('rejects its own index failure and rolls back the created scope and lock', async () => {
    const failure = new Error2(ErrorCodes.STORAGE_DISK_FULL, 'Example index storage is full');
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const storage = new InMemoryStorageService();
    storage.append = async () => { throw failure; };
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const fx = fixture();
    Object.assign(fx.service, { appendLogStore: ix.get(IAppendLogStore) });
    const dispose = vi.fn(async () => {});
    const release = vi.fn(async () => {});
    const handle = {
      id: 'failed-session', dispose,
      accessor: accessor([
        [ISessionContext, { sessionDir: '/home/failed-session' }],
        [IAgentLifecycleService, { list: () => [] }],
        [ISessionMetadata, { drain: async () => {} }],
      ]),
    } as unknown as ISessionScopeHandle;
    const owner = fx.service as unknown as {
      materializeSession(opts: unknown): Promise<ISessionScopeHandle>;
      sessionLocks: Map<string, { release(): Promise<void> }>;
    };
    const materialize = vi.spyOn(owner, 'materializeSession').mockResolvedValue(handle);
    owner.sessionLocks.set(handle.id, { release });
    const created: string[] = [];
    fx.service.onDidCreateSession((event) => created.push(event.sessionId));
    try {
      await expect(fx.service.create({ sessionId: handle.id, workDir: '/empty-workspace' })).rejects.toBe(failure);
      expect(dispose).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(fx.service.get(handle.id)).toBeUndefined();
      expect(created).toEqual([]);
    } finally {
      materialize.mockRestore();
      await fx.service.dispose();
      await disposables.dispose();
    }
  });
});

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
            drain: async () => {},
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

  it('publishes a settled cleanup receipt after close disposes the session owner', async () => {
    const fx = fixture();
    const receipts: unknown[] = [];
    fx.service.onDidCleanup!((receipt) => receipts.push(receipt));

    await fx.service.close('session-1');

    expect(receipts).toContainEqual(expect.objectContaining({
      sessionId: 'session-1', reason: 'exit', callerOutcome: 'resolved',
      terminalOwner: 'session', cleanupOutcome: 'closed', resourcesBefore: 1, resourcesAfter: 0,
    }));
  });

  it('identifies the awaited session tail after agent disposal without announcing premature close', async () => {
    const remove = vi.fn(async () => {});
    const agentAccessor = Object.assign(accessor([
      [IEventDispatcher, { saveReplayCheckpoint: async () => true }],
    ]), { remove });
    const fx = fixture(undefined, agentAccessor);
    let releaseScope!: () => void;
    let releaseLock!: () => void;
    const scopeGate = new Promise<void>((resolve) => { releaseScope = resolve; });
    const lockGate = new Promise<void>((resolve) => { releaseLock = resolve; });
    fx.dispose.mockReturnValue(scopeGate);
    const release = vi.fn(() => lockGate);
    const internals = fx.service as unknown as { sessionLocks: Map<string, { release(): Promise<void> }> };
    internals.sessionLocks.set('session-1', { release });
    const receipts: unknown[] = [];
    fx.service.onDidCleanup!((receipt) => receipts.push(receipt));
    fx.metadata.hold();
    fx.mirror.hold();
    let settled = false;
    const closing = fx.service.close('session-1').then(() => { settled = true; });
    try {
      await drainMicrotasks();
      expect(remove).toHaveBeenCalledOnce();
      expect(fx.cleanupStages.at(-1)?.stage).toBe('metadata_writes');
      expect(fx.dispose).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      expect(fx.closed).toEqual([]);
      expect(receipts).toEqual([]);
      fx.metadata.release();
      await drainMicrotasks();
      expect(fx.cleanupStages.at(-1)?.stage).toBe('session_scope');
      expect(fx.dispose).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      releaseScope();
      await drainMicrotasks();
      expect(fx.cleanupStages.at(-1)?.stage).toBe('session_lock');
      expect(release).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(fx.closed).toEqual([]);
      releaseLock();
      await closing;
      const operationId = fx.cleanupStages[0]!.operationId;
      expect(operationId).toMatch(/^[a-f0-9-]{36}$/);
      expect(fx.cleanupStages.every((stage) => stage.operationId === operationId && stage.sessionId === 'session-1')).toBe(true);
      expect(fx.cleanupStages.map((entry) => entry.stage)).toEqual([
        'will_close', 'replay_checkpoints', 'checkpoint_scheduling', 'usage_snapshot',
        'agents', 'usage_persistence', 'append_retirements', 'metadata_writes',
        'session_scope', 'log_closes', 'session_lock',
      ]);
      expect(receipts).toContainEqual(expect.objectContaining({ operationId, callerOutcome: 'resolved', resourcesAfter: 0 }));
      expect(fx.closed).toEqual([{ sessionId: 'session-1', reason: 'exit' }]);
    } finally {
      fx.metadata.release();
      fx.mirror.release();
      releaseScope();
      releaseLock();
      await closing;
      await fx.service.dispose();
    }
  });

  it('retries a changed checkpoint while idle and bounds persistent failures with diagnostics', async () => {
    vi.useFakeTimers();
    const save = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValue(true);
    const warn = vi.fn();
    const debug = vi.fn();
    const fx = fixture(undefined, accessor([[IEventDispatcher, {
      saveReplayCheckpoint: save,
      replayCheckpointSkipReason: () => 'state_changed',
    }]]));
    Object.assign(fx.service, { log: { warn, debug } });
    const scheduling = fx.service as unknown as {
      scheduleCheckpoint(id: string, handle: ISessionScopeHandle, delay: number): void;
      disposeCheckpointScheduling(id: string): void;
    };
    try {
      scheduling.scheduleCheckpoint('session-1', fx.handle, 1_000);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(save).toHaveBeenCalledTimes(2);
      expect(warn).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledWith('session replay checkpoint deferred', expect.objectContaining({ reasons: [{ agentId: 'main', reason: 'state_changed' }] }));
      save.mockRejectedValue(new Error('replay checkpoint write failed: injected disk failure'));
      scheduling.scheduleCheckpoint('session-1', fx.handle, 1_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(save).toHaveBeenCalledTimes(6);
      expect(warn.mock.calls.filter(([message]) => message === 'agent replay checkpoint failed; keeping canonical journal')).toHaveLength(4);
      expect(warn).toHaveBeenCalledWith('agent replay checkpoint failed; keeping canonical journal', expect.objectContaining({ sessionId: 'session-1', agentId: 'main', error: 'replay checkpoint write failed: injected disk failure' }));
      expect(warn).toHaveBeenLastCalledWith('session replay checkpoint recovery exhausted', expect.objectContaining({ attempts: 4 }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(save).toHaveBeenCalledTimes(6);
    } finally {
      scheduling.disposeCheckpointScheduling('session-1');
      vi.useRealTimers();
    }
  });

  it('isolates derived checkpoint failures from other agents, the ninth resume and archive', async () => {
    const failed = vi.fn(async () => { throw new Error('replay checkpoint write failed: injected disk failure'); });
    const saved = vi.fn(async () => true);
    const remove = vi.fn(async () => {});
    const agentAccessor = Object.assign(accessor([
      [IEventDispatcher, { saveReplayCheckpoint: failed }],
      [IAgentPromptService, { list: () => ({ pending: [] }) }],
      [IAgentLoopService, { status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }) }],
      [IAgentExecutionService, { status: () => ({ state: 'idle' }) }],
    ]), { remove });
    const fx = fixture(undefined, agentAccessor);
    const agents = fx.handle.accessor.get(IAgentLifecycleService);
    const main = agents.list()[0]!;
    vi.spyOn(agents, 'list').mockReturnValue([main, {
      ...main, id: 'child', accessor: accessor([[IEventDispatcher, { saveReplayCheckpoint: saved }],
        [IAgentPromptService, { list: () => ({ pending: [] }) }],
        [IAgentLoopService, { status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }) }],
        [IAgentExecutionService, { status: () => ({ state: 'idle' }) }]]),
    }]);
    const warn = vi.fn();
    Object.assign(fx.service, { log: { warn, info: () => {}, debug: () => {} } });
    const release = vi.fn(async () => {});
    (fx.service as unknown as { sessionLocks: Map<string, { release(): Promise<void> }> }).sessionLocks.set('session-1', { release });
    await expect(fx.service.unload('session-1')).resolves.toBe(false);
    expect(saved).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(fx.dispose).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('agent replay checkpoint failed; keeping canonical journal', {
      sessionId: 'session-1', agentId: 'main', error: 'replay checkpoint write failed: injected disk failure',
    });
    const created = new Emitter<SessionCreatedEvent>();
    const controller = {
      onWillCreateSession: Event.None, onDidCreateSession: created.event,
      onWillCloseSession: Event.None, onDidCloseSession: Event.None,
      onDidArchiveSession: Event.None, onDidForkSession: Event.None,
      resume: async (id: string) => {
        const handle = { id } as ISessionScopeHandle;
        created.fire({ sessionId: id, handle, source: 'resume' });
        return handle;
      },
      unload: () => fx.service.unload('session-1'),
      close: async () => {}, dispose: () => {},
    };
    const workspace = { id: 'workspace-1', program: { sessionControllerGeneration: 'generation-1', createSessionController: () => controller } };
    const disposables = new DisposableStore();
    const services = createServices(disposables, { additionalServices: (reg) => {
      reg.defineInstance(IWorkspaceInstanceManager, { get: () => workspace, acquire: async () => ({ instance: workspace, dispose: () => {} }) } as unknown as IWorkspaceInstanceManager);
      reg.defineInstance(ISessionIndex, { get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }) } as unknown as ISessionIndex);
      reg.defineInstance(IConfigService, { get: () => ({ minIdleMs: 0, maxLiveSessions: 8, maxResidentHeapBytes: 0 }) } as unknown as IConfigService);
      reg.definePartialInstance(IFlagService, { enabled: () => true });
      reg.define(ISessionManager, SessionManager);
    } });
    const manager = services.get(ISessionManager);
    try {
      for (let id = 1; id <= 8; id++) await manager.resume(`resident-${id}`);
      await expect(manager.resume('ninth-session')).resolves.toMatchObject({ id: 'ninth-session' });
      expect(manager.residencyReport?.()).toMatchObject({ liveSessions: 9, evictionAttempts: 8, evictionFailures: 0 });
      expect(saved).toHaveBeenCalledTimes(9);
      expect(fx.service.get('session-1')).toBe(fx.handle);
      await expect(fx.service.archive('session-1')).resolves.toBeUndefined();
      expect(saved).toHaveBeenCalledTimes(10);
      expect(remove).toHaveBeenCalledTimes(2);
      expect(fx.dispose).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await disposables.dispose();
      created.dispose();
      await fx.service.dispose();
    }
  });

  it('closes all resources when an optional replay checkpoint fails', async () => {
    const durableFailure = new Error2(ErrorCodes.STORAGE_DISK_FULL, 'Example checkpoint storage is full');
    const remove = vi.fn(async () => {});
    const agentAccessor = Object.assign(accessor([
      [IEventDispatcher, { saveReplayCheckpoint: async () => { throw durableFailure; } }],
    ]), { remove });
    const fx = fixture(undefined, agentAccessor);
    const release = vi.fn(async () => {});
    const internals = fx.service as unknown as { sessionLocks: Map<string, { release(): Promise<void> }> };
    internals.sessionLocks.set('session-1', { release });
    const receipts: unknown[] = [];
    fx.service.onDidCleanup!((receipt) => receipts.push(receipt));
    await expect(fx.service.close('session-1')).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledOnce();
    expect(fx.dispose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(receipts).toContainEqual(expect.objectContaining({
      callerOutcome: 'resolved', cleanupOutcome: 'closed', resourcesAfter: 0,
    }));
  });

  it('cancels a busy session without waiting for a regenerative checkpoint', async () => {
    let release!: () => void;
    const checkpointGate = new Promise<void>((resolve) => { release = resolve; });
    const checkpoint = vi.fn(async () => {
      await checkpointGate;
      return true;
    });
    const remove = vi.fn(async () => {});
    const agentAccessor = Object.assign(accessor([
      [IEventDispatcher, { saveReplayCheckpoint: checkpoint }],
    ]), { remove });
    const fx = fixture(undefined, agentAccessor);
    fx.activity.busy = true;

    const closing = fx.service.close('session-1');
    await drainMicrotasks();
    expect(remove).toHaveBeenCalledOnce();
    expect(checkpoint).not.toHaveBeenCalled();
    expect(fx.dispose).toHaveBeenCalledOnce();
    await closing;
    release();
    await fx.service.dispose();
  });

  it('retains the session and writer lock on canonical failure and closes after recovery', async () => {
    const durableFailure = new Error2(ErrorCodes.STORAGE_DISK_FULL, 'no space left on device');
    const remove = vi.fn<() => Promise<void>>().mockRejectedValueOnce(durableFailure).mockResolvedValue(undefined);
    const agentAccessor = Object.assign(accessor([
      [IEventDispatcher, { saveReplayCheckpoint: async () => true }],
    ]), { remove });
    const fx = fixture(undefined, agentAccessor);
    const release = vi.fn(async () => {});
    const internals = fx.service as unknown as {
      sessionLocks: Map<string, { release(): Promise<void> }>;
    };
    internals.sessionLocks.set('session-1', { release });
    const receipts: unknown[] = [];
    fx.service.onDidCleanup!((receipt) => receipts.push(receipt));

    await expect(fx.service.close('session-1')).rejects.toBe(durableFailure);

    expect(remove).toHaveBeenCalledOnce();
    expect(fx.dispose).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(fx.service.get('session-1')).toBe(fx.handle);
    expect(receipts).toContainEqual(expect.objectContaining({
      sessionId: 'session-1', callerOutcome: 'rejected', cleanupOutcome: 'cleanup_failed',
      failureDomain: 'persistence', errorCode: 'storage.disk_full', resourcesAfter: 1,
    }));
    await fx.service.close('session-1');
    expect(fx.dispose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    await fx.service.dispose();
  });

  it.each(['close', 'archive', 'delete'] as const)('preserves durable pending only for normal exit, not %s cancellation', async (operation) => {
    const fx = fixture();
    const owner = fx.service as unknown as { drainAgents(handle: ISessionScopeHandle, mode?: 'cancel' | 'preserve-pending'): Promise<void> };
    const drain = vi.spyOn(owner, 'drainAgents');
    await fx.service[operation]('session-1');
    expect(drain).toHaveBeenCalledWith(fx.handle, ...(operation === 'archive' ? [] : [operation === 'close' ? 'preserve-pending' : 'cancel']));
    await fx.service.dispose();
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
    fx.metadata.hold();
    fx.mirror.hold();
    const unload = fx.service.unload('session-1');
    try {
      await drainMicrotasks();
      fx.terminals.live = 1;
      fx.metadata.release();

      await expect(unload).resolves.toBe(false);

      expect(fx.dispose).not.toHaveBeenCalled();
      expect(fx.service.get('session-1')).toBe(fx.handle);
    } finally {
      fx.metadata.release();
      fx.mirror.release();
      await fx.service.dispose();
    }
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

it('allows runtime unload after execution has reached the closed terminal state', async () => {
  const fx = fixture(undefined, accessor([
    [IAgentPromptService, { list: () => ({ active: undefined, launching: undefined, pending: [], hold: undefined }) }],
    [IAgentLoopService, { status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }) }],
    [IAgentExecutionService, { status: () => ({ state: 'closed' }) }],
    [IEventDispatcher, { saveReplayCheckpoint: async () => true }],
  ]));
  try {
    await expect(fx.service.unload('session-1')).resolves.toBe(true);
    expect(fx.dispose).toHaveBeenCalledOnce();
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
    fx.metadata.hold();
    fx.mirror.hold();
    const unloading = fx.service.unload('session-1');
    await drainMicrotasks();
    pending = [{ id: 'arrived-during-save' }];
    fx.metadata.release();
    expect(await unloading).toBe(false);
    expect(fx.dispose).not.toHaveBeenCalled();
  } finally {
    fx.metadata.release();
    fx.mirror.release();
    await fx.service.dispose();
  }
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


describe('SessionLifecycleService fork file copying', () => {
  it.each(['present', 'removed'] as const)('excludes %s journal coordination files without excluding conversation attachments', async (sidecarState) => {
    const fx = fixture();
    const sidecars = ['wire.jsonl.cold.lock', 'wire.jsonl.cold.lock.tmp-123-1',
      'wire.jsonl.cold.lock.watch-123-example', 'wire.jsonl.cold.lock.bid-123-2'];
    const kept = ['attachment.txt', 'wire.jsonl.cold.lock.notes', 'ordinary.lock', 'ordinary.tmp-123-1'];
    const file = (name: string) => ({ name, isFile: true, isDirectory: false });
    const directory = (name: string) => ({ name, isFile: false, isDirectory: true });
    const read = vi.fn(async (path: string) => {
      if (sidecarState === 'removed' && sidecars.some(name => path === `/source/agents/main/${name}`)) {
        throw Object.assign(new Error('removed coordination file'), { code: 'ENOENT' });
      }
      return new TextEncoder().encode(path);
    });
    const write = vi.fn(async () => {});
    const readdir = vi.fn(async (path: string) => {
      if (path === '/source') return [directory('agents'), directory('attachments')];
      if (path === '/source/agents') return [directory('main')];
      if (path === '/source/agents/main') return [...sidecars.map(file), ...kept.map(file),
        directory('wire.jsonl.readers'), directory('attachments'), file(AGENT_WIRE_RECORD_KEY), file(WIRE_TRANSCRIPT_RECEIPT_KEY)];
      if (path.endsWith('/attachments')) return sidecars.map(file);
      if (path.endsWith('/wire.jsonl.readers')) throw Object.assign(new Error('removed lease directory'), { code: 'ENOENT' });
      throw new Error(`Unexpected directory: ${path}`);
    });
    Object.assign(fx.service, { hostFs: { readdir, readBytes: read, writeBytes: write, mkdir: async () => {} } });
    try {
      await (fx.service as unknown as { copySessionFiles(source: string, target: string): Promise<void> }).copySessionFiles('/source', '/target');
      const copied = [...kept.map(name => `agents/main/${name}`),
        ...sidecars.map(name => `attachments/${name}`), ...sidecars.map(name => `agents/main/attachments/${name}`)];
      expect(read.mock.calls.map(([path]) => path).toSorted()).toEqual(copied.map(path => `/source/${path}`).toSorted());
      expect(write.mock.calls).toHaveLength(copied.length);
      for (const path of copied) expect(write).toHaveBeenCalledWith(`/target/${path}`, new TextEncoder().encode(`/source/${path}`));
      expect(readdir).not.toHaveBeenCalledWith('/source/agents/main/wire.jsonl.readers');
    } finally { await fx.service.dispose(); }
  });

  it('propagates a required source file disappearing after directory enumeration', async () => {
    const fx = fixture();
    const failure = Object.assign(new Error('missing attachment'), { code: 'ENOENT' });
    const write = vi.fn(async () => {});
    Object.assign(fx.service, { hostFs: {
      readdir: async () => [{ name: 'attachment.txt', isFile: true, isDirectory: false }],
      readBytes: async () => { throw failure; }, writeBytes: write, mkdir: async () => {},
    } });
    try {
      await expect((fx.service as unknown as { copySessionFiles(source: string, target: string): Promise<void> })
        .copySessionFiles('/source', '/target')).rejects.toBe(failure);
      expect(write).not.toHaveBeenCalled();
    } finally { await fx.service.dispose(); }
  });
});

describe('SessionLifecycleService fork cron ownership', () => {
  it('supports an external-material-only fork without cloning child agents or main task state', async () => {
    const fx = fixture();
    const sourceRecords = [
      { type: 'metadata', protocol_version: '1.5', created_at: 1 },
      {
        type: 'external.activity', activityId: 'op-1', phase: 'started', operationId: 'op-1',
        toolCallId: 'call-1', toolName: 'Read', turnId: 0,
        source: { connectionId: 'conn-1', clientName: 'Example Client', sessionRef: 'session-1', driver: 'external' },
        time: 2,
      },
      {
        type: 'external.text', recordId: 'text-1', turnId: 0, text: 'saved material', kind: 'handoff',
        source: { connectionId: 'conn-1', clientName: 'Example Client', sessionRef: 'session-1', driver: 'external' },
        time: 3,
      },
      { type: 'task.started', info: { taskId: 'task-1', status: 'running' }, time: 4 },
      { type: 'subagent.spawned', subagentId: 'child', parentToolCallId: 'call-1', runInBackground: true, time: 5 },
      {
        type: 'context.append_message', time: 6,
        message: { role: 'user', content: [{ type: 'text', text: 'task notification' }], toolCalls: [], origin: { kind: 'task', taskId: 'task-1' } },
      },
    ];
    const rewrite = vi.fn();
    const createAgent = vi.fn(async () => {});
    const update = vi.fn(async () => {});
    const target = {
      id: 'external-fork',
      dispose: vi.fn(),
      accessor: accessor([
        [ISessionContext, { sessionId: 'external-fork' }],
        [ISessionMetadata, { drain: async () => {}, update }],
        [IAgentLifecycleService, { list: () => [], create: createAgent }],
      ]),
    } as unknown as ISessionScopeHandle;
    const child = {
      id: 'child',
      accessor: accessor([[IAgentActivityView, { state: () => ({ turn: { id: 1 } }) }]]),
    } as unknown as IAgentScopeHandle;
    const source = {
      ...fx.handle,
      accessor: accessor([
        [ISessionMetadata, {
          drain: async () => {},
          read: async () => ({
            title: 'External source',
            agents: { main: { type: 'main' }, child: { type: 'sub', parentAgentId: 'main' } },
            custom: { externalClient: {
              connectionId: 'conn-1', clientName: 'Example Client', sessionRef: 'session-1', driver: 'external',
            } },
          }),
        }],
        [IAgentLifecycleService, { list: () => [child], get: () => undefined }],
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
      appendLogStore: { append: vi.fn(), flush: async () => {}, read: async function* () { yield* sourceRecords; }, rewrite },
    });
    try {
      await fx.service.fork({
        sourceSessionId: 'session-1',
        newSessionId: target.id,
        externalMaterialOnly: true,
      });
      expect(createAgent).toHaveBeenCalledOnce();
      expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'main' }));
      const copied = rewrite.mock.calls[0]![2] as typeof sourceRecords;
      expect(copied).toContainEqual(sourceRecords[1]);
      expect(copied).toContainEqual(sourceRecords[2]);
      expect(copied.some((record) => record.type === 'task.started' || record.type === 'subagent.spawned')).toBe(false);
      expect(copied.some((record) => record.type === 'context.append_message' && record.message?.origin?.kind === 'task')).toBe(false);
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ custom: undefined }));
    } finally {
      materialize.mockRestore();
      announce.mockRestore();
      await fx.service.dispose();
    }
  });

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
        [ISessionMetadata, { drain: async () => {}, update }],
        [IAgentLifecycleService, { list: () => [], create: createAgent }],
      ]),
    } as unknown as ISessionScopeHandle;
    const source = {
      ...fx.handle,
      accessor: accessor([
        [ISessionMetadata, { drain: async () => {}, read: async () => ({ title: 'Source', agents: { main: {} } }) }],
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
      if (kind !== 'child') expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ copiedIdentity: true }));
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

describe('SessionLifecycleService archive transcript certification', () => {
  async function divergentWire(): Promise<{
    readonly ix: TestInstantiationService;
    readonly wire: IWireService;
    readonly storage: InMemoryStorageService;
    readonly changed: string;
  }> {
    const ix = new TestInstantiationService();
    const storage = new InMemoryStorageService();
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const wire = registerTestAgentWire(ix, testWireScope('archive', 'child'), {
      log: ix.get(IAppendLogStore), storage, logger: noopLogger, telemetry: noopTelemetryService,
    });
    await wire.seal();
    await wire.beginTranscriptEpoch!();
    wire.appendRecord({
      type: 'turn.prompt', turnId: 0, input: [{ type: 'text', text: 'kept' }], origin: { kind: 'user' },
    });
    await wire.flush();
    const scope = testWireScope('archive', 'child');
    const original = Buffer.from((await storage.read(scope, AGENT_WIRE_RECORD_KEY))!).toString('utf8');
    const changed = original.replace('"text":"kept"', '"text":"held"');
    await storage.write(scope, AGENT_WIRE_RECORD_KEY, Buffer.from(changed));
    return { ix, wire, storage, changed };
  }

  function installArchiveHandle(
    fx: ReturnType<typeof fixture>,
    remove: () => Promise<void>,
  ): { readonly archived: { value: boolean }; readonly order: string[]; readonly release: ReturnType<typeof vi.fn> } {
    const archived = { value: false };
    const order: string[] = [];
    const release = vi.fn(async () => { order.push('lock'); });
    const handle = {
      id: 'session-1',
      dispose: vi.fn(async () => { order.push('dispose'); }),
      accessor: accessor([
        [ISessionActivityView, { state: () => ({ busy: false, mainTurnActive: false, pendingInteraction: 'none' }) }],
        [IAgentLifecycleService, {
          countPendingBackgroundTasks: () => 0,
          list: () => [{ id: 'child', accessor: accessor([[IEventDispatcher, { saveReplayCheckpoint: async () => true }]]) }],
          remove: async () => {
            order.push('drain');
            await remove();
          },
        }],
        [ISessionTerminalService, { countLiveTerminals: () => 0 }],
        [ISessionMetadata, {
          drain: async () => { order.push('metadata'); },
          usage: () => undefined,
          update: async () => {},
          setArchived: async (value: boolean) => { archived.value = value; order.push('meta'); },
        }],
      ]),
    } as unknown as ISessionScopeHandle;
    const internals = fx.service as unknown as {
      sessions: Map<string, ISessionScopeHandle>;
      sessionLocks: Map<string, { release(): Promise<void> }>;
      indexMirror: { drain(): Promise<void> };
      event: { publish(event: { readonly type: string }): void };
    };
    internals.sessions.set('session-1', handle);
    internals.sessionLocks.set('session-1', { release });
    internals.indexMirror = { drain: async () => { order.push('index'); } };
    internals.event = { publish: (event) => { order.push(event.type); } };
    return { archived, order, release };
  }

  it('archives a session after transcript bytes diverge and releases its resources', async () => {
    const prepared = await divergentWire();
    const fx = fixture();
    const installed = installArchiveHandle(fx, async () => { await prepared.wire.sealTranscriptEpoch!(); });
    const archivedIds: string[] = [];
    const receipts: unknown[] = [];
    fx.service.onDidArchiveSession((event) => archivedIds.push(event.sessionId));
    fx.service.onDidCleanup((receipt) => receipts.push(receipt));
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    try {
      await fx.service.archive('session-1');
      expect(installed.archived.value).toBe(true);
      expect(installed.order).toEqual(['drain', 'meta', 'event.session.archived', 'metadata', 'dispose', 'lock']);
      expect(fx.service.get('session-1')).toBeUndefined();
      expect(installed.release).toHaveBeenCalledOnce();
      expect(archivedIds).toEqual(['session-1']);
      expect(receipts).toContainEqual(expect.objectContaining({
        sessionId: 'session-1', reason: 'archive', callerOutcome: 'resolved', cleanupOutcome: 'closed', resourcesAfter: 0,
      }));
      const scope = testWireScope('archive', 'child');
      expect(Buffer.from((await prepared.storage.read(scope, AGENT_WIRE_RECORD_KEY))!).toString('utf8')).toBe(prepared.changed);
      const sealed = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
        (await prepared.storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!,
      ).toString('utf8')));
      expect(sealed).toMatchObject({ state: 'sealed', trusted: false });
      expect(unexpected).toEqual([expect.objectContaining({ message: 'Transcript wire contents do not match accepted events' })]);
    } finally {
      resetUnexpectedErrorHandler();
      await prepared.ix.dispose();
      await fx.service.dispose();
    }
  });

  it('does not archive successfully when transcript flush fails', async () => {
    const ix = new TestInstantiationService();
    const storage = new InMemoryStorageService();
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const wire = registerTestAgentWire(ix, testWireScope('archive', 'flush'), {
      log: ix.get(IAppendLogStore), storage, logger: noopLogger, telemetry: noopTelemetryService,
    });
    await wire.seal();
    await wire.beginTranscriptEpoch!();
    const failure = new Error('dehydration failed');
    const unexpected: unknown[] = [];
    setUnexpectedErrorHandler((error) => unexpected.push(error));
    const fx = fixture();
    const installed = installArchiveHandle(fx, async () => { await wire.sealTranscriptEpoch!(); });
    const archivedIds: string[] = [];
    const receipts: unknown[] = [];
    fx.service.onDidArchiveSession((event) => archivedIds.push(event.sessionId));
    fx.service.onDidCleanup((receipt) => receipts.push(receipt));
    wire.appendRecord({ type: 'turn.prompt', turnId: 0 }, async () => { throw failure; });
    try {
      await expect(fx.service.archive('session-1')).rejects.toBe(failure);
      expect(installed.archived.value).toBe(false);
      expect(installed.order).toEqual(['drain']);
      expect(archivedIds).toEqual([]);
      expect(receipts).toEqual([]);
      expect(fx.service.get('session-1')).toBeDefined();
      expect(installed.release).not.toHaveBeenCalled();
      const scope = testWireScope('archive', 'flush');
      const receipt = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
        (await storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!,
      ).toString('utf8')));
      expect(receipt).toMatchObject({ state: 'open', trusted: true });
      expect(unexpected).toEqual([failure]);
    } finally {
      resetUnexpectedErrorHandler();
      await ix.dispose();
      await fx.service.dispose();
    }
  });

  it('does not archive successfully when the transcript receipt write fails', async () => {
    const ix = new TestInstantiationService();
    const storage = new InMemoryStorageService();
    ix.stub(IFileSystemStorageService, storage);
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const wire = registerTestAgentWire(ix, testWireScope('archive', 'receipt'), {
      log: ix.get(IAppendLogStore), storage, logger: noopLogger, telemetry: noopTelemetryService,
    });
    await wire.seal();
    await wire.beginTranscriptEpoch!();
    const failure = new Error('receipt write failed');
    const original = storage.write.bind(storage);
    storage.write = async (scope, key, data, options) => {
      if (key === WIRE_TRANSCRIPT_RECEIPT_KEY) throw failure;
      return original(scope, key, data, options);
    };
    const fx = fixture();
    const installed = installArchiveHandle(fx, async () => { await wire.sealTranscriptEpoch!(); });
    const archivedIds: string[] = [];
    const receipts: unknown[] = [];
    fx.service.onDidArchiveSession((event) => archivedIds.push(event.sessionId));
    fx.service.onDidCleanup((receipt) => receipts.push(receipt));
    try {
      await expect(fx.service.archive('session-1')).rejects.toBe(failure);
      expect(installed.archived.value).toBe(false);
      expect(installed.order).toEqual(['drain']);
      expect(archivedIds).toEqual([]);
      expect(receipts).toEqual([]);
      expect(fx.service.get('session-1')).toBeDefined();
      expect(installed.release).not.toHaveBeenCalled();
      const scope = testWireScope('archive', 'receipt');
      const receipt = parseWireTranscriptReceipt(JSON.parse(Buffer.from(
        (await storage.read(scope, WIRE_TRANSCRIPT_RECEIPT_KEY))!,
      ).toString('utf8')));
      expect(receipt).toMatchObject({ state: 'open', trusted: true });
      expect(receipt?.wire).toBeUndefined();
    } finally {
      await ix.dispose();
      await fx.service.dispose();
    }
  });
});
