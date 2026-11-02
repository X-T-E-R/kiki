import { rm } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';
import { ConfigTarget, IConfigService, IHomeRuntimeService, ISessionManager, IThreadCommunicationService } from '@kiki/agent-core-v2';
import { drainQueryStoreDisposals } from '@kiki/agent-core-v2/persistence/queryStoreDisposals';
import { Error2, ErrorCodes } from '@kiki/agent-core-v2/errors';
import { getLiveSessionById } from '@kiki/agent-core-v2/app/sessionManager/sessionLookup';
import { ISessionIndex } from '@kiki/agent-core-v2/app/sessionIndex/sessionIndex';
import { IAppendLogStore } from '@kiki/agent-core-v2/persistence/interface/appendLogStore';
import { ISessionMetadata, type SessionMeta } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { Emitter } from '@kiki/agent-core-v2/_base/event';
import { IInstantiationService, type ServiceIdentifier } from '@kiki/agent-core-v2/_base/di/instantiation';
import { IAgentLifecycleService } from '@kiki/agent-core-v2/session/agentLifecycle/agentLifecycle';
import { IAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/interface/atomicDocumentStore';
import { IEventBus } from '@kiki/agent-core-v2/app/event/eventBus';
import { IThreadMailboxStore } from '@kiki/agent-core-v2/app/threadCommunication/threadMailboxStore';
import { Service } from '@kiki/agent-core-v2/_base/di/service';
import { IAgentPermissionModeService } from '@kiki/agent-core-v2/agent/permissionMode/permissionMode';
import { IEventDispatcher } from '@kiki/agent-core-v2/state/eventDispatcher';

import { defineKlientConformance } from './helpers/conformance.js';
import { createKlient } from '../src/transports/memory/index.js';
import { createContractDispatcher } from '../src/transports/contractDispatcher.js';
import {
  createMemoryDispatcher,
  type ScopeLike,
} from '../src/transports/memory/dispatcher.js';
import { RPCError, toRPCError } from '../src/core/errors.js';
import { makeEngine } from './helpers/engine.js';

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

defineKlientConformance('memory', async () => {
  const { homeDir, app } = await makeEngine();
  // Thread communication is opt-in (BK11); the conformance suite exercises it,
  // so enable it explicitly for this engine.
  await app.accessor
    .get(IConfigService)
    .replace('threadCommunication', { enabled: true }, ConfigTarget.Memory);
  const klient = createKlient({ scope: app });
  return {
    klient,
    app,
    cleanup: async () => {
      await klient.close();
      await app.accessor.get(IThreadCommunicationService).shutdown();
      await app.accessor.get(IThreadMailboxStore).close();
      await app.accessor.get(IHomeRuntimeService).close();
      await app.dispose();
      await drainQueryStoreDisposals();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    },
  };
});

describe('memory dispatcher specifics', () => {
  it('reads durable model-switch queues without resuming a cold session', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app });
    try {
      const created = await klient.global.sessions.create({ workDir: homeDir });
      const session = klient.session(created.id);
      await session.close();
      const manager = app.accessor.get(ISessionManager);
      const resume = vi.spyOn(manager, 'resume');
      const summary = await app.accessor.get(ISessionIndex).get(created.id);
      const logs = app.accessor.get(IAppendLogStore);
      const scope = `sessions/${summary!.workspaceId}/${created.id}/agents/main`;
      logs.append(scope, 'wire.jsonl', { type: 'prompt.model_switch_queued', time: 1, queueIndex: 0,
        entry: { input: { operationId: 'queued-switch', model: 'model/new', mode: 'direct' }, revision: 0,
          originalBinding: { model: 'model/old', thinking: '' },
          receipt: { operationId: 'queued-switch', agentId: 'main', state: 'pending', mode: 'direct', fromModel: 'model/old', toModel: 'model/new' } } });
      await logs.flush(scope, 'wire.jsonl');
      expect(await session.agent('main').listModelSwitches()).toMatchObject([{ input: { operationId: 'queued-switch' }, queueIndex: 0 }]);
      await expect(session.agent('missing-child').listModelSwitches()).rejects.toMatchObject({ code: 40404 });
      const controller = new AbortController(); controller.abort(new Error('cancelled queue read'));
      await expect(session.agent('main').listModelSwitches({ signal: controller.signal })).rejects.toThrow('cancelled queue read');
      expect(manager.get(created.id)).toBeUndefined();
      expect(resume).not.toHaveBeenCalled();
    } finally {
      await klient.close(); await app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });
  it('continues a bounded cold model-switch read after an unrelated >8MiB wire record', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app });
    try {
      const created = await klient.global.sessions.create({ workDir: homeDir });
      const session = klient.session(created.id);
      await session.close();
      const manager = app.accessor.get(ISessionManager);
      const resume = vi.spyOn(manager, 'resume');
      const summary = await app.accessor.get(ISessionIndex).get(created.id);
      const logs = app.accessor.get(IAppendLogStore);
      const scope = `sessions/${summary!.workspaceId}/${created.id}/agents/main`;
      logs.append(scope, 'wire.jsonl', { type: 'unrelated', payload: 'x'.repeat(9 * 1024 * 1024) });
      logs.append(scope, 'wire.jsonl', { type: 'prompt.model_switch_queued', time: 1, queueIndex: 0,
        entry: { input: { operationId: 'queued-switch', model: 'model/new', mode: 'direct' }, revision: 0,
          originalBinding: { model: 'model/old', thinking: '' },
          receipt: { operationId: 'queued-switch', agentId: 'main', state: 'pending', mode: 'direct', fromModel: 'model/old', toModel: 'model/new' } } });
      await logs.flush(scope, 'wire.jsonl');
      await expect(session.agent('main').listModelSwitches()).rejects.toMatchObject({
        code: 40001, details: { reason: 'model_switch_queue_preparing' },
      });
      await expect(session.agent('main').listModelSwitches()).resolves.toMatchObject([
        { input: { operationId: 'queued-switch' }, queueIndex: 0 },
      ]);
      expect(manager.get(created.id)).toBeUndefined();
      expect(resume).not.toHaveBeenCalled();
    } finally {
      await klient.close();
      await app.accessor.get(IThreadCommunicationService).shutdown();
      await app.accessor.get(IThreadMailboxStore).close();
      await app.accessor.get(IHomeRuntimeService).close();
      await app.dispose();
      await drainQueryStoreDisposals();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });
  it('reads cold session metadata and its agent registry without resuming', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app });
    const dispatcher = createMemoryDispatcher(app);
    try {
      const created = await klient.global.sessions.create({ workDir: homeDir });
      const session = klient.session(created.id);
      await session.agent('main').setPermission('manual');
      const internal = getLiveSessionById(app.accessor, created.id)!.accessor.get(ISessionMetadata);
      const publicPatch = { title: 'public title', executionPhase: 'paused' };
      await session.update(publicPatch);
      expect((await internal.read()).executionPhase).toBeUndefined();
      expect((await internal.read()).title).toBe('public title');
      await internal.update({ executionPhase: 'paused' });
      const agents = await session.agents();
      expect(agents['main']).toBeDefined();
      const metadata = await session.get();
      expect(metadata.id).toBe(created.id);
      expect(metadata.executionPhase).toBe('paused');
      await session.close();
      const manager = app.accessor.get(ISessionManager);
      const resume = vi.spyOn(manager, 'resume');
      expect(await session.get()).toEqual(metadata);
      expect(await klient.global.sessions.get(created.id)).toMatchObject({ executionPhase: 'paused' });
      expect(await klient.global.sessions.list({ sessionId: created.id })).toMatchObject({
        items: [expect.objectContaining({ id: created.id, executionPhase: 'paused' })],
      });
      expect(await session.agents()).toEqual(agents);
      await expect(klient.session('missing-session').get()).rejects.toMatchObject({ code: 40404 });
      const controller = new AbortController();
      controller.abort(new Error('cancelled metadata read'));
      await expect(dispatcher.call({ sessionId: created.id }, 'sessionMetadata', 'read', [], { signal: controller.signal })).rejects.toThrow('cancelled metadata read');
      expect(manager.get(created.id)).toBeUndefined();
      expect(resume).not.toHaveBeenCalled();
    } finally {
      await klient.close();
      await app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });

  it('reads a cold agent executor without resuming', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app });
    const dispatcher = createMemoryDispatcher(app);
    try {
      const created = await klient.global.sessions.create({ workDir: homeDir });
      const live = getLiveSessionById(app.accessor, created.id);
      if (live === undefined) throw new Error('created session was not live');
      const metadata = live.accessor.get(ISessionMetadata);
      await metadata.registerAgent('main', { executor: 'native' });
      await metadata.registerAgent('null-exec', { executor: null as unknown as string });
      const recorded = await metadata.read();
      expect(recorded.agents?.['main']?.executor).toBe('native');
      expect(recorded.agents?.['null-exec']?.executor).toBeNull();
      await klient.session(created.id).close();
      const manager = app.accessor.get(ISessionManager);
      const resume = vi.spyOn(manager, 'resume');
      expect(await klient.session(created.id).getAgentExecutor('main')).toBe('native');
      expect(await dispatcher.call(
        { sessionId: created.id },
        'sessionMetadata',
        'getAgentExecutor',
        ['null-exec'],
      )).toBeNull();
      expect(await dispatcher.call(
        { sessionId: created.id },
        'sessionMetadata',
        'getAgentExecutor',
        ['missing-agent'],
      )).toBeUndefined();
      await expect(dispatcher.call(
        { sessionId: 'missing-session' },
        'sessionMetadata',
        'getAgentExecutor',
        ['main'],
      )).rejects.toMatchObject({ code: 40404 });
      const controller = new AbortController();
      controller.abort(new Error('cancelled executor read'));
      await expect(dispatcher.call(
        { sessionId: created.id },
        'sessionMetadata',
        'getAgentExecutor',
        ['main'],
        { signal: controller.signal },
      )).rejects.toThrow('cancelled executor read');
      expect(manager.get(created.id)).toBeUndefined();
      expect(resume).not.toHaveBeenCalled();
    } finally {
      await klient.close();
      await app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });

  it('reads a persisted cold plan without resuming and rejects missing agents and cancelled reads', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app });
    const dispatcher = createMemoryDispatcher(app);
    try {
      const created = await klient.global.sessions.create({ workDir: process.cwd() });
      const session = klient.session(created.id);
      await session.agent('main').enterPlan();
      expect(await session.agent('main').getPlan()).not.toBeNull();
      await session.agent('main').exitPlan();
      expect(await session.agent('main').getPlan()).toBeNull();
      await session.agent('main').enterPlan();
      const expected = await session.agent('main').getPlan();
      expect(expected).not.toBeNull();
      await session.close();
      const manager = app.accessor.get(ISessionManager);
      const resume = vi.spyOn(manager, 'resume');
      await expect(session.agent('main').getPlan()).resolves.toEqual(expected);
      await expect(session.agent('missing-child').getPlan()).rejects.toMatchObject({ code: 40404 });
      await expect(klient.session('missing-session').agent('main').getPlan()).rejects.toMatchObject({ code: 40404 });
      const controller = new AbortController();
      controller.abort(new Error('cancelled plan read'));
      await expect(dispatcher.call({ sessionId: created.id, agentId: 'main' }, 'agentPlanService', 'status', [],
        { signal: controller.signal })).rejects.toThrow('cancelled plan read');
      expect(manager.get(created.id)).toBeUndefined();
      expect(resume).not.toHaveBeenCalled();
    } finally {
      await klient.close();
      await app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });
  it('COLD-EVENTS-R1 keeps new saved-child subscriptions attached across the real session closing window', async () => {
    const { homeDir, app } = await makeEngine('klient-closing-events-');
    const manager = app.accessor.get(ISessionManager);
    let releaseTeardown!: () => void;
    const teardown = new Promise<void>(resolve => { releaseTeardown = resolve; });
    let closing: Promise<void> | undefined;
    let subscription: ReturnType<ReturnType<typeof createMemoryDispatcher>['listen']> | undefined;
    const lifecycleSpies: Array<{ mockRestore(): void }> = [];
    try {
      const session = await manager.create({ workDir: homeDir });
      const metadata = session.accessor.get(ISessionMetadata);
      await metadata.registerAgent('example-child', { type: 'sub', status: 'cancelled' });
      (metadata as unknown as Service).effect(() => () => teardown, 'closing subscription teardown latch');
      let resolveDisposing!: () => void;
      const disposing = new Promise<void>(resolve => { resolveDisposing = resolve; });
      session.accessor.get(IInstantiationService).onWillDispose(resolveDisposing);
      closing = manager.close(session.id);
      await disposing;
      expect(manager.get(session.id)).toBe(session);
      expect(() => session.accessor.get(IInstantiationService)).toThrow('InstantiationService has been disposed');
      const created = vi.spyOn(manager, 'onDidCreateSession');
      const closed = vi.spyOn(manager, 'onDidCloseSession');
      const archived = vi.spyOn(manager, 'onDidArchiveSession');
      const deleted = vi.spyOn(manager, 'onDidDeleteSession');
      const resume = vi.spyOn(manager, 'resume');
      lifecycleSpies.push(created, closed, archived, deleted, resume);
      const seen = vi.fn();
      const error = vi.fn();
      const ready = vi.fn();
      const dispatcher = createMemoryDispatcher(app);
      const scope = { sessionId: session.id, agentId: 'example-child' };
      subscription = dispatcher.listen(scope, { kind: 'stream', name: 'events' }, seen, error, ready);
      await vi.waitFor(() => { expect(ready.mock.calls.length + error.mock.calls.length).toBe(1); });
      expect(error).not.toHaveBeenCalled();
      expect(ready).toHaveBeenCalledOnce();
      expect(resume).not.toHaveBeenCalled();
      const detached = [created, closed, archived, deleted].map(spy => vi.spyOn(spy.mock.results[0]!.value, 'dispose'));
      const cancelledReady = vi.fn();
      const cancelled = dispatcher.listen(scope, { kind: 'stream', name: 'events' }, vi.fn(), error, cancelledReady);
      cancelled.dispose();
      releaseTeardown();
      await closing;
      const reopened = await manager.resume(session.id);
      const lifecycle = reopened!.accessor.get(IAgentLifecycleService);
      expect(lifecycle.get(scope.agentId)).toBeUndefined();
      expect((await reopened!.accessor.get(ISessionMetadata).read()).agents?.[scope.agentId]).toMatchObject({ status: 'cancelled' });
      const child = await lifecycle.create({ agentId: scope.agentId });
      const permissions = child.accessor.get(IAgentPermissionModeService);
      permissions.setMode('manual');
      await child.accessor.get(IEventDispatcher).flush();
      expect(seen.mock.calls.some(([event]) => event.type === 'agent.status.updated' && event.permission === 'manual')).toBe(true);
      subscription.dispose();
      for (const watch of detached) expect(watch).toHaveBeenCalledOnce();
      const count = seen.mock.calls.length;
      permissions.setMode('yolo');
      await child.accessor.get(IEventDispatcher).flush();
      expect(seen).toHaveBeenCalledTimes(count);
      expect(cancelledReady).not.toHaveBeenCalled();
      expect(ready).toHaveBeenCalledOnce();
      expect(error).not.toHaveBeenCalled();
    } finally {
      releaseTeardown(); await closing; subscription?.dispose();
      for (const spy of lifecycleSpies) spy.mockRestore();
      for (const session of manager.list()) await manager.close(session.id);
      await app.accessor.get(IThreadCommunicationService).shutdown();
      await app.accessor.get(IThreadMailboxStore).close();
      await app.accessor.get(IHomeRuntimeService).close();
      await app.dispose(); await drainQueryStoreDisposals();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('validates cold membership before ready and cancels every pending watch on dispose', async () => {
    const fixture = agentEventWatchFixture();
    let resolveMetadata!: (metadata: SessionMeta) => void;
    fixture.read.mockImplementationOnce(() => new Promise<SessionMeta>(resolve => { resolveMetadata = resolve; }));
    const ready = vi.fn();
    const error = vi.fn();
    const sub = fixture.dispatcher.listen(fixture.scope, { kind: 'stream', name: 'events' }, vi.fn(), error, ready);
    await vi.waitFor(() => { expect(fixture.read).toHaveBeenCalledOnce(); });
    expect(fixture.created.listenerCount).toBe(1);
    expect(ready).not.toHaveBeenCalled();
    sub.dispose();
    resolveMetadata(fixture.metadata);
    await Promise.resolve();
    expect(fixture.created.listenerCount).toBe(0);
    expect(fixture.closed.listenerCount).toBe(0);
    expect(fixture.deleted.listenerCount).toBe(0);
    expect(ready).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps the live source when an older cold membership read finishes after creation', async () => {
    const fixture = agentEventWatchFixture();
    let rejectMetadata!: (error: Error) => void;
    fixture.read.mockImplementationOnce(() => new Promise<SessionMeta>((_resolve, reject) => { rejectMetadata = reject; }));
    const ready = vi.fn();
    const error = vi.fn();
    const seen = vi.fn();
    const sub = fixture.dispatcher.listen(fixture.scope, { kind: 'stream', name: 'events' }, seen, error, ready);
    await vi.waitFor(() => { expect(fixture.read).toHaveBeenCalledOnce(); });
    const session = fixture.makeSession();
    fixture.created.fire({ sessionId: fixture.scope.sessionId, handle: session.handle });
    const agent = session.createAgent();
    rejectMetadata(new Error('retired cold read'));
    await vi.waitFor(() => { expect(ready).toHaveBeenCalledOnce(); });
    agent.events.fire({ type: 'real source' });
    expect(seen).toHaveBeenCalledWith({ type: 'real source' });
    expect(error).not.toHaveBeenCalled();
    sub.dispose();
  });

  it('detaches retired generations, follows reopened sessions and releases lifecycle watches', async () => {
    const fixture = agentEventWatchFixture();
    const ready = vi.fn();
    const error = vi.fn();
    const seen = vi.fn();
    const sub = fixture.dispatcher.listen(fixture.scope, { kind: 'stream', name: 'events' }, seen, error, ready);
    await vi.waitFor(() => { expect(ready).toHaveBeenCalledOnce(); });
    const first = fixture.makeSession();
    fixture.created.fire({ sessionId: fixture.scope.sessionId, handle: first.handle });
    expect(first.created.listenerCount).toBe(1);
    const oldAgent = first.createAgent();
    oldAgent.events.fire({ type: 'first' });
    oldAgent.disposal.fire();
    oldAgent.events.fire({ type: 'retired' });
    expect(oldAgent.events.listenerCount).toBe(0);
    const replacement = first.createAgent();
    replacement.events.fire({ type: 'replacement' });
    expect(replacement.events.listenerCount).toBe(1);
    first.disposal.fire();
    expect(first.created.listenerCount).toBe(0);
    expect(first.removed.listenerCount).toBe(0);
    expect(replacement.events.listenerCount).toBe(0);
    fixture.closed.fire({ sessionId: fixture.scope.sessionId });
    const reopened = fixture.makeSession();
    fixture.created.fire({ sessionId: fixture.scope.sessionId, handle: reopened.handle });
    const active = reopened.createAgent();
    active.events.fire({ type: 'reopened' });
    expect(seen.mock.calls.map(([event]) => event.type)).toEqual(['first', 'replacement', 'reopened']);
    sub.dispose(); sub.dispose();
    expect(active.events.listenerCount).toBe(0);
    expect(active.disposal.listenerCount).toBe(0);
    expect(reopened.created.listenerCount).toBe(0);
    expect(reopened.disposal.listenerCount).toBe(0);
    expect(fixture.created.listenerCount).toBe(0);
    expect(fixture.closed.listenerCount).toBe(0);
    expect(fixture.deleted.listenerCount).toBe(0);
    expect(ready).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it.each(['metadata', 'source'])('preserves real %s failures even when they name disposed instantiation', async boundary => {
    const fixture = agentEventWatchFixture();
    const failure = new Error('InstantiationService has been disposed');
    if (boundary === 'metadata') fixture.read.mockRejectedValueOnce(failure);
    const ready = vi.fn();
    const error = vi.fn();
    fixture.dispatcher.listen(fixture.scope, { kind: 'stream', name: 'events' }, vi.fn(), error, ready);
    if (boundary === 'source') {
      await vi.waitFor(() => { expect(ready).toHaveBeenCalledOnce(); });
      const session = fixture.makeSession();
      session.createAgent(() => { throw failure; });
      fixture.created.fire({ sessionId: fixture.scope.sessionId, handle: session.handle });
      expect(session.created.listenerCount).toBe(0);
      expect(session.disposal.listenerCount).toBe(0);
    } else expect(ready).not.toHaveBeenCalled();
    await vi.waitFor(() => { expect(error).toHaveBeenCalledWith(failure); });
    expect(fixture.created.listenerCount).toBe(0);
    expect(fixture.closed.listenerCount).toBe(0);
    expect(fixture.deleted.listenerCount).toBe(0);
  });

  it.each(['missing', 'attachment failure', 'deleted'])('cleans agent event watches after %s', async failure => {
    const fixture = agentEventWatchFixture();
    if (failure === 'missing') fixture.read.mockResolvedValueOnce({ ...fixture.metadata, agents: {} });
    const ready = vi.fn();
    const error = vi.fn();
    fixture.dispatcher.listen(fixture.scope, { kind: 'stream', name: 'events' }, vi.fn(), error, ready);
    if (failure === 'missing') {
      await vi.waitFor(() => { expect(error).toHaveBeenCalledOnce(); });
      expect(error.mock.calls[0]![0]).toMatchObject({ code: 40404 });
      expect(ready).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => { expect(ready).toHaveBeenCalledOnce(); });
      if (failure === 'deleted') fixture.deleted.fire({ sessionId: fixture.scope.sessionId });
      else {
        const session = fixture.makeSession();
        session.createAgent(() => { throw new Error('attachment failure'); });
        fixture.created.fire({ sessionId: fixture.scope.sessionId, handle: session.handle });
        expect(session.created.listenerCount).toBe(0);
        expect(session.disposal.listenerCount).toBe(0);
      }
      expect(error).toHaveBeenCalledOnce();
    }
    expect(fixture.created.listenerCount).toBe(0);
    expect(fixture.closed.listenerCount).toBe(0);
    expect(fixture.deleted.listenerCount).toBe(0);
  });

  it('acknowledges only attached subscriptions and cancels pending attach on dispose', async () => {
    const dispose = vi.fn();
    const attach = vi.fn(() => ({ dispose }));
    const dispatcher = createMemoryDispatcher({ accessor: { get: () => ({ onDidChange: attach }) } } as unknown as ScopeLike);
    const ready = vi.fn();
    const error = vi.fn();
    const source = { kind: 'emitter' as const, service: 'configService', event: 'onDidChange' };
    const cancelled = dispatcher.listen({}, source, vi.fn(), error, ready);
    cancelled.dispose();
    await Promise.resolve();
    expect(attach).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    const active = dispatcher.listen({}, source, vi.fn(), error, ready);
    await Promise.resolve();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledTimes(1);
    active.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    dispatcher.listen({}, { kind: 'stream', name: 'missing' }, vi.fn(), error, ready);
    await Promise.resolve();
    expect(error).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it.each([
    [ErrorCodes.THREAD_NOT_FOUND, 40421],
    [ErrorCodes.THREAD_ARCHIVED, 40927],
    [ErrorCodes.THREAD_DISABLED, 40928],
    [ErrorCodes.THREAD_CROSS_HOST, 40929],
    [ErrorCodes.THREAD_SELF_SEND, 40930],
    [ErrorCodes.THREAD_CURSOR_INVALID, 40931],
    [ErrorCodes.THREAD_IDEMPOTENCY_CONFLICT, 40932],
    [ErrorCodes.THREAD_LIMIT_EXCEEDED, 42903],
    ['dispatch.limit_exceeded' as const, 42904],
    [ErrorCodes.THREAD_DELIVERY_FAILED, 50005],
  ])('maps engine error %s to RPC code %i', (reason, code) => {
    expect(toRPCError(new Error2(reason, 'failure', { details: { field: 'value' } }))).toMatchObject({
      name: 'RPCError',
      code,
      reason,
      details: { field: 'value' },
    });
  });

  it('rejects unknown services and methods with RPCError(40001)', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(dispatcher.call({}, 'noSuchService', 'get', [])).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
    await expect(dispatcher.call({}, 'sessionIndex', 'noSuchMethod', [])).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
    await expect(
      dispatcher.call({}, 'threadCommunicationService', 'sendPeerThreadMessage', []),
    ).rejects.toMatchObject({ name: 'RPCError', code: 40001 });
    await app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('reads non-function members as properties', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(dispatcher.call({}, 'bootstrapService', 'platform', [])).resolves.toBe(
      process.platform,
    );
    await app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('rejects session/agent scopes for now', async () => {
    const { homeDir, app } = await makeEngine();
    const dispatcher = createMemoryDispatcher(app);
    await expect(
      dispatcher.call({ sessionId: 's1' }, 'sessionIndex', 'list', [{}]),
    ).rejects.toBeInstanceOf(RPCError);
    await app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });

  it('delivers wire-cloned payloads (no live object identity)', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app });
    const list = await klient.global.workspaces.list();
    // Mutating the result must not affect what a second call returns.
    (list as unknown[]).push({ id: 'polluted' });
    const again = await klient.global.workspaces.list();
    expect(again.some((w) => w.id === 'polluted')).toBe(false);
    await app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  });
});

function scopeReturning(value: unknown): ScopeLike {
  return {
    accessor: {
      get<T>(): T {
        return value as T;
      },
    },
  };
}

function scopeWithServices(entries: Array<readonly [ServiceIdentifier<unknown>, unknown]>): ScopeLike {
  const services = new Map(entries);
  return { accessor: { get<T>(id: ServiceIdentifier<T>): T {
    if (!services.has(id)) throw new Error(`unexpected service: ${String(id)}`);
    return services.get(id) as T;
  } } };
}

function agentEventWatchFixture() {
  const scope = { sessionId: 'example-session', agentId: 'example-child' };
  const metadata: SessionMeta = { id: scope.sessionId, createdAt: 1, updatedAt: 1, archived: false,
    agents: { [scope.agentId]: { type: 'sub', status: 'cancelled' } } };
  const created = new Emitter<{ sessionId: string; handle: ScopeLike }>();
  const closed = new Emitter<{ sessionId: string }>();
  const deleted = new Emitter<{ sessionId: string }>();
  const read = vi.fn(async () => metadata);
  const root = scopeWithServices([
    [ISessionManager, { get: () => undefined, onDidCreateSession: created.event, onDidCloseSession: closed.event,
      onDidDeleteSession: deleted.event }],
    [ISessionIndex, { get: async () => ({ workspaceId: 'example-workspace' }) }],
    [IAtomicDocumentStore, { get: read }],
  ]);
  const makeSession = () => {
    const disposal = new Emitter<void>();
    const agentCreated = new Emitter<{ id: string } & ScopeLike>();
    const removed = new Emitter<string>();
    let agent: ({ id: string } & ScopeLike) | undefined;
    const handle = scopeWithServices([
      [IInstantiationService, { onWillDispose: disposal.event }],
      [ISessionMetadata, { read }],
      [IAgentLifecycleService, { get: () => agent, onDidCreate: agentCreated.event, onDidDispose: removed.event }],
    ]);
    return { handle, disposal, created: agentCreated, removed, createAgent: (subscribe?: () => never) => {
      const agentDisposal = new Emitter<void>();
      const events = new Emitter<unknown>();
      agent = { id: scope.agentId, ...scopeWithServices([
        [IInstantiationService, { onWillDispose: agentDisposal.event }],
        [IEventBus, { subscribe: subscribe ?? events.event }],
      ]) };
      agentCreated.fire(agent);
      return { events, disposal: agentDisposal };
    } };
  };
  return { scope, metadata, created, closed, deleted, read, makeSession, dispatcher: createMemoryDispatcher(root) };
}

describe('contract dispatcher boundary', () => {
  it('rejects undeclared procedures and invalid declared input', async () => {
    const dispatcher = createContractDispatcher(scopeReturning({ platform: process.platform }));
    await expect(dispatcher.call({}, 'sessionManager', 'list', [])).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
    await expect(
      dispatcher.call({}, 'bootstrapService', 'platform', ['unexpected']),
    ).rejects.toMatchObject({ name: 'RPCError', code: 40001 });
  });

  it('normalizes JSON null only for optional positional arguments', async () => {
    const inspectServers = vi.fn(async () => []);
    const dispatcher = createContractDispatcher(scopeReturning({ inspectServers }));
    const query = { cwd: process.cwd() };
    await expect(
      dispatcher.call({}, 'mcpManagementService', 'inspectServers', [null, query]),
    ).resolves.toEqual([]);
    expect(inspectServers).toHaveBeenCalledWith(undefined, query);
  });

  it('validates declared procedure output', async () => {
    const dispatcher = createContractDispatcher(scopeReturning({ platform: 42 }));
    await expect(dispatcher.call({}, 'bootstrapService', 'platform', [])).rejects.toMatchObject({
      name: 'RPCError',
      code: 50001,
    });
  });

  it('enforces streaming procedure kind and validates chunks', async () => {
    const returnIterator = vi.fn(async () => ({ done: true as const, value: undefined }));
    const iterator: AsyncIterator<unknown> = {
      next: async () => ({ done: false, value: { text: 'missing type' } }),
      return: returnIterator,
    };
    const dispatcher = createContractDispatcher(
      scopeReturning({
        getRequester: () => ({
          request: () => ({
            [Symbol.asyncIterator]: () => iterator,
          }),
        }),
      }),
    );
    expect(() => dispatcher.stream({}, 'bootstrapService', 'platform', [])).toThrow(RPCError);
    await expect(
      dispatcher.call({}, 'modelResolver', 'generate', [
        'test-model',
        { systemPrompt: '', messages: [] },
      ]),
    ).rejects.toMatchObject({ name: 'RPCError', code: 40001 });
    const source = dispatcher.stream({}, 'modelResolver', 'generate', [
      'test-model',
      { systemPrompt: '', messages: [] },
    ]);
    await expect(source[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      name: 'RPCError',
      code: 50001,
    });
    expect(returnIterator).toHaveBeenCalledOnce();
  });
});
