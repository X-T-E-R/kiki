import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import {
  CREATED_BY_AGENT_ID_KEY,
  CREATED_BY_SESSION_ID_KEY,
  ISessionIndexMirror,
} from '#/app/sessionIndex/sessionIndex';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';
import { readCommittedAgentRunOutcomes } from '#/agent/task/agentOutcome';
import {
  drainSessionMetadataWrites,
  SessionMetadata,
} from '#/session/sessionMetadata/sessionMetadataService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { AGENT_WIRE_RECORD_KEY } from '#/wire/record';

import { stubSessionIndexMirror } from '../../app/sessionIndex/stubs';
import { stubLog } from '../../_base/log/stubs';

const META_SCOPE = 'sessions/wd_test/s1/session-meta';

function createFreshMetadata(ix: TestInstantiationService): SessionMetadata {
  return ix
    .createChild(new ServiceCollection([ISessionStateService, new SessionStateService()]))
    .createInstance(SessionMetadata);
}

function makeContext(): ISessionContext {
  return makeSessionContext({
    sessionId: 's1',
    workspaceId: 'wd_test',
    sessionDir: '/tmp/sessions/wd_test/s1',
    sessionScope: 'sessions/wd_test/s1',
    metaScope: META_SCOPE,
    cwd: '/tmp/sessions/wd_test/s1',
  });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

async function ticks(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

describe('SessionMetadata', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mirror: ReturnType<typeof stubSessionIndexMirror>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    mirror = stubSessionIndexMirror();
    ix.stub(ILogService, stubLog());
    ix.stub(ISessionContext, makeContext());
    ix.stub(ISessionIndexMirror, mirror);
    ix.set(ISessionStateService, new SyncDescriptor(SessionStateService));
    ix.set(IFileSystemStorageService, new SyncDescriptor(InMemoryStorageService));
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
    ix.set(ISessionMetadata, new SyncDescriptor(SessionMetadata));
  });

  afterEach(async () => {
    await disposables.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['read', 'create', 'migration'] as const)('keeps an initial %s failure with its callers while drains and disposal join cleanly', async (phase) => {
    const store = ix.get(IAtomicDocumentStore);
    if (phase === 'migration') {
      await store.set(META_SCOPE, 'state.json', { id: 's1', createdAt: 1, updatedAt: 1, archived: false, agents: {} });
    }
    const entered = deferred();
    const gate = deferred();
    const failure = new Error(`initial metadata ${phase} failed`);
    let attempts = 0;
    const fail = async () => {
      attempts += 1;
      entered.resolve();
      await gate.promise;
      throw failure;
    };
    if (phase === 'read') vi.spyOn(store, 'get').mockImplementation(fail);
    else vi.spyOn(store, 'set').mockImplementation(fail);
    const meta = ix.get(ISessionMetadata);
    const owners = [meta.ready, meta.read(), meta.setTitle('not committed'),
      meta.update({ lastPrompt: 'not committed' }, { deferPersistence: true }), meta.registerAgent('child', {})]
      .map((pending) => expect(pending).rejects.toBe(failure));
    let drained = false;
    let shutdown = false;
    const draining = meta.drain().then(() => { drained = true; });
    const closing = drainSessionMetadataWrites().then(() => { shutdown = true; });
    await entered.promise;
    await ticks();
    expect(drained).toBe(false);
    expect(shutdown).toBe(false);
    gate.resolve();
    await Promise.all([...owners, draining, closing]);
    expect(drained).toBe(true);
    expect(shutdown).toBe(true);
    expect(attempts).toBe(1);
    expect(mirror.recorded).toEqual([]);
    await expect((meta as SessionMetadata).dispose()).resolves.toBeUndefined();
    await expect(meta.ready).rejects.toBe(failure);
    expect(failure.message).toBe(`initial metadata ${phase} failed`);
    await expect(drainSessionMetadataWrites()).resolves.toBeUndefined();
  });

  it('commits one 50ms agent batch for 100 callers on a 900-agent roster and releases them only after durability', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', { id: 's1', version: 2, createdAt: 1, updatedAt: 1,
      archived: false, custom: {}, isCustomTitle: false,
      agents: Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`child-${i}`, { labels: { padding: 'x'.repeat(8_000) } }])),
    });
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    vi.useFakeTimers();
    const gate = deferred();
    const storage = ix.get(IFileSystemStorageService);
    const original = storage.write.bind(storage);
    const writes: number[] = [];
    vi.spyOn(storage, 'write').mockImplementation(async (scope, key, data, options) => {
      if (key === 'state.json') { writes.push(data.byteLength); await gate.promise; }
      return original(scope, key, data, options);
    });
    let receipts = 0;
    const pending = Array.from({ length: 100 }, (_, i) => meta.updateAgent(`child-${i}`, (current) => ({
      ...current, taskId: `task-${i}`,
    })).then(() => { receipts += 1; }));
    await vi.advanceTimersByTimeAsync(49);
    expect(writes).toEqual([]);
    expect(receipts).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBeGreaterThan(7_000_000);
    expect(receipts).toBe(0);
    gate.resolve();
    await Promise.all(pending);
    expect(receipts).toBe(100);
    const restored = await createFreshMetadata(ix).read();
    for (let i = 0; i < 100; i += 1) expect(restored.agents?.[`child-${i}`]?.taskId).toBe(`task-${i}`);
  });

  it('rejects every caller of a failed batch, rolls it back and commits a later retry', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('a', { model: 'old' });
    await meta.registerAgent('b', { model: 'old' });
    vi.useFakeTimers();
    const store = ix.get(IAtomicDocumentStore);
    const fail = vi.spyOn(store, 'set').mockRejectedValueOnce(new Error('batch failed'));
    const a = meta.updateAgent('a', (current) => ({ ...current, model: 'new-a' }));
    const b = meta.updateAgent('b', (current) => ({ ...current, model: 'new-b' }));
    const settled = Promise.allSettled([a, b]);
    await vi.advanceTimersByTimeAsync(50);
    expect((await settled).map((value) => value.status)).toEqual(['rejected', 'rejected']);
    expect((await meta.read()).agents).toMatchObject({ a: { model: 'old' }, b: { model: 'old' } });
    fail.mockRestore();
    const retry = meta.updateAgent('a', (current) => ({ ...current, model: 'retry' }));
    await meta.drain();
    await retry;
    expect((await createFreshMetadata(ix).read()).agents?.['a']?.model).toBe('retry');
  });

  it('drains only its own canonical work while process shutdown joins a blocked other session', async () => {
    const a = ix.get(ISessionMetadata);
    await a.ready;
    const context = makeSessionContext({ sessionId: 's2', workspaceId: 'wd_test', sessionDir: '/tmp/s2',
      sessionScope: 'sessions/wd_test/s2', metaScope: 'sessions/wd_test/s2', cwd: '/tmp/s2' });
    const child = disposables.add(ix.createChild(new ServiceCollection(
      [ISessionStateService, new SessionStateService()], [ISessionContext, context],
      [ISessionMetadata, new SyncDescriptor(SessionMetadata)],
    )));
    const b = child.get(ISessionMetadata);
    await b.ready;
    const store = ix.get(IAtomicDocumentStore);
    const original = store.set.bind(store);
    const entered = deferred();
    const gate = deferred();
    vi.spyOn(store, 'set').mockImplementation(async (...args) => {
      if (args[0] === context.metaScope) { entered.resolve(); await gate.promise; }
      return original(...args);
    });
    const writing = b.setTitle('blocked-b');
    await entered.promise;
    await a.update({ lastPrompt: 'durable-a' }, { deferPersistence: true });
    await a.drain();
    expect((await store.get<{ lastPrompt: string }>(META_SCOPE, 'state.json'))?.lastPrompt).toBe('durable-a');
    let closed = false;
    const shutdown = drainSessionMetadataWrites(false).then(() => { closed = true; });
    await ticks();
    expect(closed).toBe(false);
    gate.resolve();
    await writing;
    await shutdown;
    expect(closed).toBe(true);
  });

  it('coalesces recency and prompt metadata on an eight MiB registry without awaiting disk', async () => {
    const store = ix.get(IAtomicDocumentStore);
    const agents = Object.fromEntries(Array.from({ length: 822 }, (_, index) => [String(index), {
      taskId: `task-${index}`, status: 'completed', resultSummary: 'r'.repeat(10_240),
    }]));
    await store.set(META_SCOPE, 'state.json', { id: 's1', version: 2, createdAt: 1, updatedAt: 1,
      archived: false, agents, custom: {}, isCustomTitle: false });
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    const original = store.set.bind(store);
    const writes = vi.spyOn(store, 'set');
    for (let at = 10; at < 50; at += 1) {
      await meta.update({ activityUpdatedAt: at }, { touchUpdatedAt: false, deferPersistence: true });
    }
    expect(writes).not.toHaveBeenCalled();
    const gate = deferred();
    writes.mockImplementation(async (...args) => { await gate.promise; return original(...args); });
    const flushing = drainSessionMetadataWrites(false);
    await ticks();
    let admitted = false;
    const admission = applyPromptMetadataUpdate({ metadata: meta, sessionId: 's1', eventService: { publish: () => {} } as never },
      'new prompt').then(() => { admitted = true; });
    await ticks();
    expect(admitted).toBe(true);
    gate.resolve();
    await admission;
    await flushing;
    expect((await createFreshMetadata(ix).read())).toMatchObject({ activityUpdatedAt: 49, lastPrompt: 'new prompt' });
    expect(writes.mock.calls.filter(([, key]) => key === 'state.json').length).toBeLessThanOrEqual(2);
  });

  it('writes long outcomes separately and restores their full receipt after a restart', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    const store = ix.get(IAtomicDocumentStore);
    const receipt = 'complete receipt '.repeat(1024);
    await meta.registerAgent('child', { taskId: 'task-1', status: 'completed', resultSummary: receipt });
    const raw = await store.get<{ agents: Record<string, { resultSummary: string; outcomeRef: string }> }>(META_SCOPE, 'state.json');
    expect(raw?.agents['child']?.resultSummary).toHaveLength(2048);
    expect(raw?.agents['child']?.outcomeRef).toBeTruthy();
    expect((await createFreshMetadata(ix).read()).agents?.['child']?.resultSummary).toBe(receipt);
    const writes = vi.spyOn(store, 'set');
    await meta.updateAgent('child', (current) => ({ ...current, userLabel: 'renamed' }));
    expect(writes.mock.calls.map(([, key]) => key)).toEqual(['state.json']);
    await store.delete(META_SCOPE, raw!.agents['child']!.outcomeRef);
    const restored = createFreshMetadata(ix);
    expect((await restored.read()).agents?.['child']).toMatchObject({
      taskId: 'task-1', status: 'completed', resultSummary: receipt.slice(0, 2048),
    });
    const outcomes = await readCommittedAgentRunOutcomes(restored);
    expect(outcomes.ok).toBe(true);
    if (outcomes.ok) expect(outcomes.outcomes.get('task-1')).toMatchObject({ status: 'completed', finalOutput: receipt.slice(0, 2048) });
  });

  it('preserves the committed outcome when a sidecar write fails', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('child', { taskId: 'old-task', status: 'completed', resultSummary: 'old receipt' });
    const store = ix.get(IAtomicDocumentStore);
    const write = store.set.bind(store);
    const fail = vi.spyOn(store, 'set').mockImplementation(async (...args) => {
      if (args[1] !== 'state.json') throw new Error('sidecar unavailable');
      return write(...args);
    });
    await meta.updateAgent('child', (current) => ({ ...current, taskId: 'new-task', resultSummary: 'r'.repeat(8192) }));
    const restored = createFreshMetadata(ix);
    expect((await restored.read()).agents?.['child']).toMatchObject({ taskId: 'new-task', resultSummary: 'r'.repeat(8192) });
    const outcomes = await readCommittedAgentRunOutcomes(restored);
    expect(outcomes.ok).toBe(true);
    if (outcomes.ok) expect(outcomes.outcomes.get('new-task')).toMatchObject({ status: 'completed', finalOutput: 'r'.repeat(8192) });
    fail.mockRestore();
    await meta.updateAgent('child', (current) => ({ ...current, userLabel: 'retry sidecar' }));
    expect((await createFreshMetadata(ix).read()).agents?.['child']?.resultSummary).toHaveLength(8192);
  });

  it('creates an initial document on first read', async () => {
    const meta = ix.get(ISessionMetadata);
    expect(await meta.read()).toMatchObject({
      id: 's1',
      archived: false,
      agents: {},
      custom: {},
    });
    expect((await meta.read()).createdAt).toBeGreaterThan(0);
  });

  it('requires readiness for synchronous snapshots and detaches nested metadata', async () => {
    const documents = ix.get(IAtomicDocumentStore);
    const original = documents.get.bind(documents);
    const gate = deferred();
    vi.spyOn(documents, 'get').mockImplementation(async (...args) => { await gate.promise; return original(...args); });
    const meta = ix.get(ISessionMetadata);
    expect(() => meta.snapshot()).toThrow('requires ready');
    const oldRead = meta.read();
    gate.resolve();
    await meta.ready;
    expect(await oldRead).toMatchObject({ id: 's1' });
    await meta.registerAgent('child', { labels: { phase: 'before' }, status: 'completed' });
    await meta.update({ custom: { nested: { value: 'before' } } });
    const captured = meta.snapshot();
    expect(meta.snapshot()).toBe(captured);
    await meta.updateAgent('child', (agent) => ({ ...agent, labels: { phase: 'after' }, status: 'failed' }));
    await meta.update({ custom: { nested: { value: 'after' } } });
    expect(captured.agents?.['child']).toMatchObject({ labels: { phase: 'before' }, status: 'completed' });
    expect(captured.custom).toEqual({ nested: { value: 'before' } });
    expect(meta.snapshot()).not.toBe(captured);
    captured.custom!['nested'] = 'caller edit';
    expect((await meta.read()).custom).toEqual({ nested: { value: 'after' } });
  });

  it('returns undefined for a missing executor without reading metadata', async () => {
    const meta = ix.get(ISessionMetadata);
    const readSpy = vi.spyOn(meta, 'read');

    await expect(meta.getAgentExecutor('missing')).resolves.toBeUndefined();
    expect(readSpy).not.toHaveBeenCalled();
  });


  it('returns registered native and external executor ids', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('native-agent', { executor: 'native' });
    await meta.registerAgent('external-agent', { executor: 'external' });

    await expect(meta.getAgentExecutor('native-agent')).resolves.toBe('native');
    await expect(meta.getAgentExecutor('external-agent')).resolves.toBe('external');
  });

  it('keeps birth immutable through registration, agent updates, bulk patches and reload', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('child', { createdAt: 100, model: 'first' });
    await meta.registerAgent('child', { createdAt: 200, model: 'second' });
    await meta.updateAgent('child', () => ({ model: 'third' }));
    await meta.update({ agents: { child: { createdAt: 300, model: 'fourth' } } });
    expect((await meta.read()).agents?.['child']).toEqual({ createdAt: 100, model: 'fourth' });
    expect((await createFreshMetadata(ix).read()).agents?.['child']).toEqual({ createdAt: 100, model: 'fourth' });
  });


  it('does not backfill a legacy agent birth when loading or updating metadata', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', { id: 's1', version: 2, createdAt: 1, updatedAt: 2,
      archived: false, agents: { legacy: { model: 'old' } }, custom: {}, isCustomTitle: false });
    const writes = vi.spyOn(store, 'set');
    const meta = ix.get(ISessionMetadata);
    await meta.read();
    expect(writes).not.toHaveBeenCalled();
    await meta.registerAgent('legacy', { createdAt: 500, model: 'new' });
    await meta.updateAgent('legacy', (current) => ({ ...current, createdAt: 600 }));
    expect((await createFreshMetadata(ix).read()).agents?.['legacy']?.createdAt).toBeUndefined();
  });


  it('persists activity recency without rewriting main prompt time or custom title', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.update({ title: 'Custom title', titleKind: 'custom', lastPrompt: 'Main prompt', updatedAt: 1_000 });
    await meta.update({ activityUpdatedAt: 5_000 }, { touchUpdatedAt: false });
    await meta.update({ activityUpdatedAt: 3_000 }, { touchUpdatedAt: false });
    expect(await meta.read()).toMatchObject({ activityUpdatedAt: 5_000, updatedAt: 1_000, title: 'Custom title', lastPrompt: 'Main prompt' });
    expect(mirror.recorded.at(-1)?.updatedAt).toBe(5_000);
    expect(await createFreshMetadata(ix).read()).toMatchObject({ activityUpdatedAt: 5_000, updatedAt: 1_000 });
  });

  it('persists creator metadata and mirrors it for session-list reads', async () => {
    const meta = ix.get(ISessionMetadata);
    const custom = {
      [CREATED_BY_SESSION_ID_KEY]: 'source-session',
      [CREATED_BY_AGENT_ID_KEY]: 'main',
    };
    await meta.update({ custom }, { touchUpdatedAt: false });
    expect((await ix.get(IAtomicDocumentStore).get<{ custom: Record<string, unknown> }>(META_SCOPE, 'state.json'))?.custom)
      .toEqual(custom);
    expect(mirror.recorded).toEqual(expect.arrayContaining([expect.objectContaining({ custom })]));
    expect((await createFreshMetadata(ix).read()).custom).toEqual(custom);
  });

  it('persists persona-only changes and mirrors canonical identity ahead of conflicting legacy tags', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('main', { executor: 'native' });
    await meta.update({ custom: { bot_persona_id: 'other', room_persona_id: 'other' } });
    await meta.updateAgent('main', (current) => ({ ...current, personaId: 'example' }));
    expect((await createFreshMetadata(ix).read()).agents?.['main']?.personaId).toBe('example');
    expect(mirror.recorded.at(-1)).toMatchObject({ personaId: 'example', custom: { bot_persona_id: 'other', room_persona_id: 'other' } });
    await meta.updateAgent('main', (current) => ({ ...current, personaId: undefined }));
    expect((await createFreshMetadata(ix).read()).agents?.['main']?.personaId).toBeUndefined();
    expect(mirror.recorded.at(-1)?.personaId).toBeUndefined();
  });

  it('persists authentication-only and execution-generation-only agent changes and announces them', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('main', { executor: 'example-acp' });
    const changed = vi.fn();
    disposables.add(meta.onDidChangeMetadata(changed));
    const auth = { status: 'required' as const, source: 'acp.authentication_required' as const, scope: 'session' as const,
      executor_id: 'example-acp', descriptor_revision: 'r1', binding_fingerprint: 'a'.repeat(64), cwd: '/fixture/work', observed_at: 1000 };
    await meta.updateAgent('main', (current) => ({ ...current, executorAuth: auth }));
    expect(changed).toHaveBeenLastCalledWith({ changed: ['agents'] });
    expect((await createFreshMetadata(ix).read()).agents?.['main']?.executorAuth).toEqual(auth);
    const execution = { version: 1 as const, generation: 1, selection: { executor: 'example-acp' },
      effective: { allow_kiki_subagents: false, kiki_context: [] }, sources: {} };
    await meta.updateAgent('main', (current) => ({ ...current, execution }));
    await meta.updateAgent('main', (current) => ({ ...current, execution: { ...execution, generation: 2 } }));
    expect((await createFreshMetadata(ix).read()).agents?.['main']?.execution?.generation).toBe(2);
    await meta.updateAgent('main', (current) => ({ ...current, executorAuth: undefined }));
    expect((await createFreshMetadata(ix).read()).agents?.['main']?.executorAuth).toBeUndefined();
  });

  it('persists per-session handshake snapshots and restores them without a catalog lookup', async () => {
    const meta = ix.get(ISessionMetadata);
    const negotiated = { agentVersion: '1.2.3', image: false, audio: true, fork: true,
      nativeSteering: false, questionForm: true, planApproval: false };
    await meta.registerAgent('main', { executor: 'example-acp', negotiated });
    expect((await createFreshMetadata(ix).read()).agents?.['main']).toEqual({ executor: 'example-acp', negotiated });
    expect(mirror.recorded.at(-1)).toMatchObject({ executorId: 'example-acp', negotiated });
    await meta.registerAgent('main', { executor: 'example-acp', negotiated: { ...negotiated, image: true } });
    expect((await createFreshMetadata(ix).read()).agents?.['main']?.negotiated?.image).toBe(true);
    await meta.registerAgent('main', { executor: 'native' });
    expect((await createFreshMetadata(ix).read()).agents?.['main']?.negotiated).toBeUndefined();
  });

  it('preserves the higher activity recency after a later stale activity update', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.update({ title: 'Custom title', titleKind: 'custom', lastPrompt: 'Main prompt', updatedAt: 1_000 });
    await meta.update({ activityUpdatedAt: 5_000 }, { touchUpdatedAt: false });
    await meta.update({ activityUpdatedAt: 3_000 }, { touchUpdatedAt: false });
    expect(await meta.read()).toMatchObject({ activityUpdatedAt: 5_000, updatedAt: 1_000, title: 'Custom title', lastPrompt: 'Main prompt' });
    expect(mirror.recorded.at(-1)?.updatedAt).toBe(5_000);
    expect(await createFreshMetadata(ix).read()).toMatchObject({ activityUpdatedAt: 5_000, updatedAt: 1_000 });
  });

  it('keeps the first live usage record incomplete without a known baseline', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    meta.recordUsage('example-model', {
      inputOther: 3,
      output: 2,
      inputCacheRead: 1,
      inputCacheCreation: 0,
    });
    await drainSessionMetadataWrites();

    expect((await meta.read()).usage).toEqual({
      total: { inputOther: 3, output: 2, inputCacheRead: 1, inputCacheCreation: 0 },
      byModel: {
        'example-model': { inputOther: 3, output: 2, inputCacheRead: 1, inputCacheCreation: 0 },
      },
      wireComplete: undefined,
      accounting: {
        version: 2,
        usage: { inputOther: 3, output: 2, inputCacheRead: 1, inputCacheCreation: 0 },
        byModel: { 'example-model': { inputOther: 3, output: 2, inputCacheRead: 1, inputCacheCreation: 0 } },
        byModelMask: { 'example-model': { '7': { inputOther: 3, output: 2, inputCacheRead: 1, inputCacheCreation: 0 } } },
        records: 1, knownUsageRecords: 1, partial: false,
      },
    });
    const persisted = await ix
      .get(IAtomicDocumentStore)
      .get<{ usage?: { wireComplete?: boolean } }>(META_SCOPE, 'state.json');
    expect(persisted?.usage?.wireComplete).toBeUndefined();
    expect(mirror.recorded.at(-1)?.usage).toEqual((await meta.read()).usage);
  });

  it('keeps explicit unknown nonzero usage out of canonical known accounting while retaining legacy totals', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    meta.recordUsage('example-model', { inputOther: 10, output: 0, inputCacheRead: 0, inputCacheCreation: 0 }, true);
    meta.recordUsage('example-model', { inputOther: 7, output: 0, inputCacheRead: 0, inputCacheCreation: 0 }, false);
    await drainSessionMetadataWrites();
    const usage = (await meta.read()).usage;
    expect(usage?.total.inputOther).toBe(17);
    expect(usage?.accounting).toMatchObject({ version: 2, usage: { inputOther: 10 }, records: 2, knownUsageRecords: 1, partial: true });
    expect((await createFreshMetadata(ix).read()).usage?.accounting).toEqual(usage?.accounting);
  });

  it('flushes delayed usage during direct metadata disposal', async () => {
    const meta = ix.get(ISessionMetadata) as SessionMetadata;
    await meta.ready;
    meta.recordUsage('example-model', {
      inputOther: 1,
      output: 2,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });

    await meta.dispose();

    const persisted = await ix.get(IAtomicDocumentStore).get<{ usage?: { total?: { output?: number } } }>(META_SCOPE, 'state.json');
    expect(persisted?.usage?.total?.output).toBe(2);
  });

  it('propagates usage write failures from drain and retries them on direct disposal', async () => {
    const meta = ix.get(ISessionMetadata) as SessionMetadata;
    await meta.ready;
    const storage = ix.get(IFileSystemStorageService);
    const original = storage.write.bind(storage);
    storage.write = async (scope, key, data, options) => {
      if (key === 'state.json') throw new Error('injected usage write failure');
      return original(scope, key, data, options);
    };
    meta.recordUsage('example-model', {
      inputOther: 1,
      output: 2,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });

    await expect(drainSessionMetadataWrites(false)).rejects.toThrow('injected usage write failure');
    storage.write = original;
    await meta.dispose();
    const persisted = await ix.get(IAtomicDocumentStore).get<{ usage?: { total?: { output?: number } } }>(META_SCOPE, 'state.json');
    expect(persisted?.usage?.total?.output).toBe(2);
  });

  it('waits for an already queued usage flush during direct disposal', async () => {
    const meta = ix.get(ISessionMetadata) as SessionMetadata;
    await meta.ready;
    const storage = ix.get(IFileSystemStorageService);
    const original = storage.write.bind(storage);
    const entered = deferred();
    const release = deferred();
    let first = true;
    storage.write = async (scope, key, data, options) => {
      if (first && key === 'state.json') {
        first = false;
        entered.resolve();
        await release.promise;
      }
      return original(scope, key, data, options);
    };
    vi.useFakeTimers();
    const prior = meta.setTitle('already-writing');
    await entered.promise;
    meta.recordUsage('example-model', { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    let settled = false;
    const disposing = meta.dispose().then(() => { settled = true; });
    await ticks();
    expect(settled).toBe(false);
    release.resolve();
    await prior;
    await disposing;
    const persisted = await ix.get(IAtomicDocumentStore).get<{ usage?: { total?: { output?: number } } }>(META_SCOPE, 'state.json');
    expect(persisted?.usage?.total?.output).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates rejection from an in-flight usage timer through drain', async () => {
    const meta = ix.get(ISessionMetadata) as SessionMetadata;
    await meta.ready;
    const storage = ix.get(IFileSystemStorageService);
    const original = storage.write.bind(storage);
    const entered = deferred();
    const release = deferred();
    storage.write = async () => {
      entered.resolve();
      await release.promise;
      throw new Error('injected timer usage failure');
    };
    vi.useFakeTimers();
    meta.recordUsage('example-model', { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    await entered.promise;
    const draining = drainSessionMetadataWrites(false);
    await ticks();
    release.resolve();
    await expect(draining).rejects.toThrow('injected timer usage failure');
    expect(vi.getTimerCount()).toBe(0);
    storage.write = original;
    await drainSessionMetadataWrites(false);
    await meta.dispose();
  });

  it('writes one session document for several usage records', async () => {
    const storage = ix.get(IFileSystemStorageService);
    let stateWrites = 0;
    const original = storage.write.bind(storage);
    storage.write = async (scope, key, data, options) => {
      if (key === 'state.json') stateWrites += 1;
      return original(scope, key, data, options);
    };
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    const afterCreate = stateWrites;
    const usage = { inputOther: 1, output: 2, inputCacheRead: 0, inputCacheCreation: 0 };
    meta.recordUsage('example-model', usage);
    meta.recordUsage('example-model', usage);
    expect(stateWrites).toBe(afterCreate);
    expect((await meta.read()).usage?.total.output).toBe(4);
    await drainSessionMetadataWrites();
    expect(stateWrites).toBe(afterCreate + 1);
    const persisted = await ix.get(IAtomicDocumentStore).get<{ usage?: { total?: { output?: number } } }>(META_SCOPE, 'state.json');
    expect(persisted?.usage?.total?.output).toBe(4);
  });

  it('keeps an agent contextTokens snapshot apart from session usage totals', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    await meta.registerAgent('main', { executor: 'native' });
    await meta.updateAgent('main', (current) => ({ ...current, contextTokens: 424_458 }));
    meta.recordUsage('example-model', {
      inputOther: 3,
      output: 2,
      inputCacheRead: 1,
      inputCacheCreation: 0,
    });
    await drainSessionMetadataWrites();
    const persisted = await ix.get(IAtomicDocumentStore).get<{
      agents?: { main?: { contextTokens?: number } };
      usage?: { total?: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number } };
    }>(META_SCOPE, 'state.json');
    expect(persisted?.agents?.main?.contextTokens).toBe(424_458);
    expect(persisted?.usage?.total).toEqual({
      inputOther: 3,
      output: 2,
      inputCacheRead: 1,
      inputCacheCreation: 0,
    });
  });

  it('update merges fields and bumps updatedAt', async () => {
    const meta = ix.get(ISessionMetadata);
    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    await meta.update({ title: 'hello' });

    const next = await meta.read();
    expect(next.title).toBe('hello');
    expect(next.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('update with touchUpdatedAt:false keeps the previous updatedAt', async () => {
    const meta = ix.get(ISessionMetadata);
    const before = (await meta.read()).updatedAt;
    await meta.update({ title: 'quiet' }, { touchUpdatedAt: false });

    const next = await meta.read();
    expect(next.title).toBe('quiet');
    expect(next.updatedAt).toBe(before);
  });

  it('setTitle / setArchived write through', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.setTitle('t');
    await meta.setArchived(true);
    expect(await meta.read()).toMatchObject({ title: 't', titleKind: 'custom', archived: true });
  });

  it('sets a generated title while the metadata remains uncustomized', async () => {
    const meta = ix.get(ISessionMetadata);

    await expect(meta.setGeneratedTitleIfUncustomized('generated title')).resolves.toBe(true);
    await expect(meta.read()).resolves.toMatchObject({
      title: 'generated title',
      titleKind: 'generated',
    });
  });

  it('setTitle keeps updatedAt (rename must not reorder listings)', async () => {
    const meta = ix.get(ISessionMetadata);
    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    await meta.setTitle('renamed');

    const next = await meta.read();
    expect(next.title).toBe('renamed');
    expect(next.updatedAt).toBe(before);
  });

  it('setArchived records archivedAt without touching updatedAt; restore clears it', async () => {
    const meta = ix.get(ISessionMetadata);
    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));

    await meta.setArchived(true);
    const archived = await meta.read();
    expect(archived.archived).toBe(true);
    expect(archived.archivedAt).toBeGreaterThan(before);
    expect(archived.updatedAt).toBe(before);

    await meta.setArchived(false);
    const restored = await meta.read();
    expect(restored.archived).toBe(false);
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.updatedAt).toBe(before);
  });

  it('registerAgent never bumps updatedAt — the agents map is structural', async () => {
    const meta = ix.get(ISessionMetadata);
    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    await meta.registerAgent('main', { homedir: '/tmp/h', type: 'main' });

    const next = await meta.read();
    expect(next.agents?.['main']?.homedir).toBe('/tmp/h');
    expect(next.updatedAt).toBe(before);
  });

  it('an explicit patch.updatedAt always wins (fork inherits the source recency)', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.update({ title: 'fork', updatedAt: 1234 });

    const next = await meta.read();
    expect(next.title).toBe('fork');
    expect(next.updatedAt).toBe(1234);
  });

  it('reads a loaded document without the archived field as not-archived', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    expect(await meta.read()).toMatchObject({ id: 's1', archived: false });
  });

  it('mirrors a boolean archived to the read model even when the loaded document lacks the field', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    expect(mirror.recorded).toEqual([]);

    await meta.update({ title: 'x' });

    expect(mirror.recorded).toHaveLength(1);
    expect(mirror.recorded[0]).toMatchObject({ id: 's1', archived: false });
  });

  it('persists aggregate usage into metadata and the session-index mirror', async () => {
    const usage = {
      total: {
        inputOther: 15,
        output: 13,
        inputCacheRead: 13,
        inputCacheCreation: 13,
      },
      byModel: {
        'example-model': {
          inputOther: 15,
          output: 13,
          inputCacheRead: 13,
          inputCacheCreation: 13,
        },
      },
    };
    const meta = ix.get(ISessionMetadata);
    await meta.ready;

    await meta.update({ usage }, { touchUpdatedAt: false });

    expect((await meta.read()).usage).toEqual(usage);
    expect(mirror.recorded.at(-1)?.usage).toEqual(usage);
    expect((await createFreshMetadata(ix).read()).usage).toEqual(usage);
  });

  it('loads persisted incomplete usage without replaying agent wires', async () => {
    const usage = {
      total: { inputOther: 20, output: 10, inputCacheRead: 4, inputCacheCreation: 2 },
      byModel: {
        'example-model': {
          inputOther: 3,
          output: 2,
          inputCacheRead: 1,
          inputCacheCreation: 0,
        },
        'worker-model': {
          inputOther: 17,
          output: 8,
          inputCacheRead: 3,
          inputCacheCreation: 2,
        },
      },
    };
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      agents: { main: { type: 'main' }, worker: { type: 'sub' } },
      custom: {},
      usage,
    });
    const log = ix.get(IAppendLogStore);
    log.append('sessions/wd_test/s1/agents/main', AGENT_WIRE_RECORD_KEY, {
      type: 'usage.record',
      model: 'example-model',
      usage: { inputOther: 3, output: 2, inputCacheRead: 1, inputCacheCreation: 0 },
    });
    await log.flush();
    await ix.get(IFileSystemStorageService).write(
      'sessions/wd_test/s1/agents/worker',
      AGENT_WIRE_RECORD_KEY,
      new TextEncoder().encode('{broken\n'),
    );
    const readSpy = vi.spyOn(log, 'read');

    const meta = ix.get(ISessionMetadata);
    expect((await meta.read()).usage).toEqual(usage);
    expect(readSpy).not.toHaveBeenCalled();
    const persisted = await store.get<Record<string, unknown>>(META_SCOPE, 'state.json');
    expect(persisted?.['usage']).toEqual(usage);
  });

  it('keeps persisted usage when a usage record is structurally invalid during migration', async () => {
    const usage = {
      total: { inputOther: 20, output: 10, inputCacheRead: 4, inputCacheCreation: 2 },
      byModel: {
        'example-model': {
          inputOther: 20,
          output: 10,
          inputCacheRead: 4,
          inputCacheCreation: 2,
        },
      },
    };
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      agents: { main: { type: 'main' } },
      custom: {},
      usage,
    });
    const log = ix.get(IAppendLogStore);
    log.append('sessions/wd_test/s1/agents/main', AGENT_WIRE_RECORD_KEY, {
      type: 'usage.record',
      model: 'example-model',
      usage: { inputOther: 3, output: 2, inputCacheRead: 1, inputCacheCreation: 0 },
    });
    log.append('sessions/wd_test/s1/agents/main', AGENT_WIRE_RECORD_KEY, {
      type: 'usage.record',
      model: 'example-model',
      usage: { inputOther: 17, output: 8, inputCacheRead: 3 },
    });
    await log.flush();

    const meta = ix.get(ISessionMetadata);
    expect((await meta.read()).usage).toEqual(usage);
    const persisted = await store.get<Record<string, unknown>>(META_SCOPE, 'state.json');
    expect(persisted?.['usage']).toEqual(usage);
  });

  it('persists the authoritative document before recording to the mirror', async () => {
    const store = ix.get(IAtomicDocumentStore);
    const persistedAtRecord: Promise<Record<string, unknown> | undefined>[] = [];
    const baseRecord = mirror.record;
    mirror.record = (summary) => {
      persistedAtRecord.push(store.get<Record<string, unknown>>(META_SCOPE, 'state.json'));
      baseRecord(summary);
    };

    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    await meta.update({ title: 'durable-first' });

    expect(persistedAtRecord).toHaveLength(2);
    const [atCreate, atUpdate] = await Promise.all(persistedAtRecord);
    expect(atCreate).toMatchObject({ id: 's1', archived: false });
    expect(atUpdate).toMatchObject({ title: 'durable-first' });
  });

  it('a mirror failure degrades the read model but never fails the metadata mutation', async () => {
    mirror.record = () => {
      throw new Error('mirror down');
    };

    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    await meta.update({ title: 'still fine' });
    expect(await meta.read()).toMatchObject({ title: 'still fine' });

    const fresh = createFreshMetadata(ix);
    expect(await fresh.read()).toMatchObject({ title: 'still fine' });
  });

  it('updates the latest agent in the serialized queue and preserves unrelated fields', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('child', { type: 'sub', parentAgentId: 'main', delegator: { kind: 'agent', agentId: 'main' }, labels: { original: 'saved' } });
    const before = (await meta.read()).updatedAt;
    const store = ix.get(IAtomicDocumentStore);
    const set = store.set.bind(store);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(store, 'set').mockImplementationOnce(async (...args) => { entered(); await gate; await set(...args); });
    const first = meta.updateAgent('child', (current) => ({ ...current, labels: { ...current.labels, operation: 'accepted' } }));
    await writing;
    const second = meta.updateAgent('child', (current) => ({ ...current, status: 'completed', resultSummary: 'Original result' }));
    const third = meta.updateAgent('child', (current) => ({ ...current, model: 'example/target', labels: { ...current.labels, run: 'new-run' } }));
    release();
    await Promise.all([first, second, third]);
    expect((await createFreshMetadata(ix).read()).agents?.['child']).toEqual({ type: 'sub', parentAgentId: 'main',
      delegator: { kind: 'agent', agentId: 'main' }, labels: { original: 'saved', operation: 'accepted', run: 'new-run' },
      status: 'completed', resultSummary: 'Original result', model: 'example/target' });
    expect((await meta.read()).updatedAt).toBe(before);
  });

  it('does not recreate an unregistered agent or write an unchanged update', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('child', { labels: { saved: 'state' } });
    const set = vi.spyOn(ix.get(IAtomicDocumentStore), 'set');
    await meta.updateAgent('child', (current) => current);
    expect(set).not.toHaveBeenCalled();
    await meta.unregisterAgent?.('child');
    set.mockClear();
    const updater = vi.fn((current: import('#/session/sessionMetadata/sessionMetadata').AgentMeta) => ({ ...current, status: 'completed' as const }));
    await meta.updateAgent('child', updater);
    expect(updater).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect((await createFreshMetadata(ix).read()).agents?.['child']).toBeUndefined();
  });

  it('keeps the old agent on updater or Store failure and retries the actual Store write', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('child', { model: 'example/old', labels: { saved: 'state' } });
    await expect(meta.updateAgent('child', (current) => { (current as { model: string }).model = 'mutated'; throw new Error('updater failed'); })).rejects.toThrow('updater failed');
    expect((await meta.read()).agents?.['child']?.model).toBe('example/old');
    const store = ix.get(IAtomicDocumentStore);
    const set = store.set.bind(store);
    const write = vi.spyOn(store, 'set').mockRejectedValueOnce(new Error('Store failed')).mockImplementation(set);
    const updater = (current: import('#/session/sessionMetadata/sessionMetadata').AgentMeta) => ({ ...current, model: 'example/target' });
    await expect(meta.updateAgent('child', updater)).rejects.toThrow('Store failed');
    expect((await meta.read()).agents?.['child']?.model).toBe('example/old');
    await meta.updateAgent('child', updater);
    expect(write).toHaveBeenCalledTimes(2);
    expect((await createFreshMetadata(ix).read()).agents?.['child']).toMatchObject({ model: 'example/target', labels: { saved: 'state' } });
  });

  it('persists across instances', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.update({ title: 'persisted' });

    const fresh = createFreshMetadata(ix);
    expect(await fresh.read()).toMatchObject({ id: 's1', title: 'persisted' });
  });

  it('backfills and persists missing agents/custom maps on a pre-fix document', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
    });

    const meta = ix.get(ISessionMetadata);
    expect(await meta.read()).toMatchObject({ agents: {}, custom: {} });

    const fresh = createFreshMetadata(ix);
    const healed = await fresh.read();
    expect(healed.agents).toEqual({});
    expect(healed.custom).toEqual({});
    expect(healed.updatedAt).toBe(1700000000000);
  });

  it('normalizes the legacy customTitle field before callers read metadata', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      customTitle: 'legacy title',
    });

    const meta = ix.get(ISessionMetadata);
    await expect(meta.read()).resolves.toMatchObject({
      title: 'legacy title',
      titleKind: 'custom',
    });

    const fresh = createFreshMetadata(ix);
    await expect(fresh.read()).resolves.toMatchObject({
      title: 'legacy title',
      titleKind: 'custom',
    });
  });

  it('trusts modern custom title state over a stale legacy customTitle', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      title: 'renamed title',
      isCustomTitle: true,
      customTitle: 'legacy custom title',
    });

    const meta = ix.get(ISessionMetadata);
    await expect(meta.read()).resolves.toMatchObject({
      title: 'renamed title',
      titleKind: 'custom',
    });

    await meta.update({ archived: true });
    const fresh = createFreshMetadata(ix);
    await expect(fresh.read()).resolves.toMatchObject({
      title: 'renamed title',
      titleKind: 'custom',
      archived: true,
    });
    const persisted = await store.get<Record<string, unknown>>(META_SCOPE, 'state.json');
    expect(persisted).toMatchObject({ isCustomTitle: true });
    expect(persisted).not.toHaveProperty('customTitle');
  });

  it('migrates a legacy non-custom title to replaceable title state', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      title: 'prompt title',
      isCustomTitle: false,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);

    await expect(meta.read()).resolves.toMatchObject({
      title: 'prompt title',
      titleKind: 'replaceable',
    });
    const persisted = await store.get<Record<string, unknown>>(META_SCOPE, 'state.json');
    expect(persisted).toMatchObject({
      title: 'prompt title',
      titleKind: 'replaceable',
      isCustomTitle: false,
    });
  });

  it('honors a legacy writer custom marker over the stale titleKind it left behind', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      title: '用户手工标题',
      titleKind: 'replaceable',
      isCustomTitle: true,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    await expect(meta.read()).resolves.toMatchObject({
      title: '用户手工标题',
      titleKind: 'custom',
    });

    const persisted = await store.get<Record<string, unknown>>(META_SCOPE, 'state.json');
    expect(persisted).toMatchObject({ titleKind: 'custom', isCustomTitle: true });

    const fresh = createFreshMetadata(ix);
    await expect(fresh.read()).resolves.toMatchObject({
      title: '用户手工标题',
      titleKind: 'custom',
    });
    await expect(fresh.setGeneratedTitleIfUncustomized('generated title')).resolves.toBe(false);
  });

  it('double-writes the derived isCustomTitle marker for v1 readers', async () => {
    const store = ix.get(IAtomicDocumentStore);
    const meta = ix.get(ISessionMetadata);

    await meta.setGeneratedTitleIfUncustomized('generated title');
    await expect(store.get<Record<string, unknown>>(META_SCOPE, 'state.json')).resolves.toMatchObject(
      { titleKind: 'generated', isCustomTitle: false },
    );

    await meta.setTitle('user title');
    await expect(store.get<Record<string, unknown>>(META_SCOPE, 'state.json')).resolves.toMatchObject(
      { titleKind: 'custom', isCustomTitle: true },
    );
  });

  it('does not downgrade a modern titleKind on a legacy false marker', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      title: 'generated title',
      titleKind: 'generated',
      isCustomTitle: false,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    await expect(meta.read()).resolves.toMatchObject({
      title: 'generated title',
      titleKind: 'generated',
    });
  });

  it.each([
    [{ isCustomTitle: true, titleKind: 'generated' as const }, 'custom'],
    [{ isCustomTitle: true, titleKind: 'replaceable' as const }, 'custom'],
    [{ isCustomTitle: true }, 'custom'],
    [{ isCustomTitle: false, titleKind: 'custom' as const }, 'custom'],
    [{ isCustomTitle: false, titleKind: 'generated' as const }, 'generated'],
    [{ isCustomTitle: false }, 'replaceable'],
    [{ titleKind: 'generated' as const }, 'generated'],
    [{ customTitle: 'legacy title' }, 'custom'],
    [{}, 'replaceable'],
  ])('normalizes title state %j to titleKind %s', async (fields, expectedKind) => {
    const store = ix.get(IAtomicDocumentStore);
    const title = 'customTitle' in fields ? undefined : 'some title';
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      ...(title === undefined ? {} : { title }),
      ...fields,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    expect((await meta.read()).titleKind).toBe(expectedKind);
  });

  it('migrates the title state once, not on every load', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      title: '用户手工标题',
      titleKind: 'replaceable',
      isCustomTitle: true,
      agents: {},
      custom: {},
    });

    const first = ix.get(ISessionMetadata);
    await first.ready;
    const setSpy = vi.spyOn(store, 'set');
    const fresh = createFreshMetadata(ix);
    await fresh.ready;

    expect(setSpy).not.toHaveBeenCalled();
    expect((await fresh.read()).titleKind).toBe('custom');
  });

  it('keeps a queued custom title when a generated title is enqueued afterward', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    const store = ix.get(IAtomicDocumentStore);
    const set = store.set.bind(store);
    let releaseWrite: (() => void) | undefined;
    let markWriteStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let shouldBlock = true;
    vi.spyOn(store, 'set').mockImplementation(async (scope, key, value) => {
      if (shouldBlock) {
        shouldBlock = false;
        markWriteStarted?.();
        await writeReleased;
      }
      await set(scope, key, value);
    });

    const priorWrite = meta.update({ lastPrompt: 'hello' });
    await writeStarted;
    const rename = meta.setTitle('user title');
    const generated = meta.setGeneratedTitleIfUncustomized('generated title');
    releaseWrite?.();

    await priorWrite;
    await rename;
    await expect(generated).resolves.toBe(false);
    await expect(meta.read()).resolves.toMatchObject({
      title: 'user title',
      titleKind: 'custom',
    });
  });

  it('leaves existing agents/custom maps untouched', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      agents: { main: { homedir: '/tmp/sessions/wd_test/s1/agents/main', type: 'main' } },
      custom: { cwd: '/tmp/work' },
    });

    const meta = ix.get(ISessionMetadata);
    expect(await meta.read()).toMatchObject({
      agents: { main: { homedir: '/tmp/sessions/wd_test/s1/agents/main', type: 'main' } },
      custom: { cwd: '/tmp/work' },
    });
  });

  it('fires onDidChangeMetadata with the changed keys after update', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    let fired = 0;
    let captured: { readonly changed: readonly string[] } | undefined;
    const sub = meta.onDidChangeMetadata((e) => {
      fired++;
      captured = e;
    });
    await meta.update({ title: 'x' });
    expect(fired).toBe(1);
    expect(captured).toEqual({ changed: ['title'] });
    sub.dispose();
  });

  it('preserves every concurrently registered agent', async () => {
    const meta = ix.get(ISessionMetadata);

    await Promise.all([
      meta.registerAgent('agent-0', {
        labels: { workItem: 'src/a.ts' },
      }),
      meta.registerAgent('agent-1', {
        labels: { workItem: 'src/b.ts' },
      }),
    ]);

    expect(Object.keys((await meta.read()).agents ?? {}).sort()).toEqual([
      'agent-0',
      'agent-1',
    ]);
  });

  it('persists terminal agent fields across restart and keeps legacy agent records readable', async () => {
    const meta = ix.get(ISessionMetadata);
    const legacyAgent = { type: 'sub' as const, displayName: 'explore', labels: { workItem: 'example' } };
    await meta.registerAgent('legacy', legacyAgent);
    const before = (await meta.read()).updatedAt;
    await meta.registerAgent('terminal', {
      ...legacyAgent,
      status: 'completed',
      completedAt: 1_700_000_000_000,
      resultSummary: 'Complete',
      contextTokens: 21,
      usage: { inputOther: 2, output: 3, inputCacheRead: 0, inputCacheCreation: 0 },
      toolCallCount: 0,
    });
    const fresh = createFreshMetadata(ix);
    expect((await fresh.read()).agents?.['legacy']).toEqual(legacyAgent);
    expect((await fresh.read()).agents?.['terminal']).toMatchObject({
      labels: legacyAgent.labels,
      status: 'completed',
      completedAt: 1_700_000_000_000,
      resultSummary: 'Complete',
      contextTokens: 21,
      toolCallCount: 0,
    });
    expect((await fresh.read()).updatedAt).toBe(before);

    await fresh.registerAgent('terminal', { ...(await fresh.read()).agents?.['terminal'], status: 'failed' });
    expect((await fresh.read()).agents?.['terminal']?.status).toBe('failed');
  });

  it('persists and reloads an agent model binding symmetrically', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('agent-model', {
      type: 'sub',
      displayName: 'explore',
      model: 'provider/subagent-model',
      thinkingEffort: 'high',
    });

    const fresh = createFreshMetadata(ix);

    expect((await fresh.read()).agents?.['agent-model']).toEqual({
      type: 'sub',
      displayName: 'explore',
      model: 'provider/subagent-model',
      thinkingEffort: 'high',
    });
  });

  it('treats re-registering an unchanged agent as a no-op', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('main', {
      homedir: '/tmp/sessions/wd_test/s1/agents/main',
      type: 'main',
      parentAgentId: undefined,
      forkedFrom: undefined,
      labels: undefined,
    });

    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));

    let fired = 0;
    const sub = meta.onDidChangeMetadata(() => {
      fired++;
    });
    await meta.registerAgent('main', {
      homedir: '/tmp/sessions/wd_test/s1/agents/main',
      type: 'main',
      parentAgentId: undefined,
      forkedFrom: undefined,
      labels: undefined,
    });

    expect(fired).toBe(0);
    expect((await meta.read()).updatedAt).toBe(before);
    sub.dispose();
  });

  it('stays a no-op when re-registering against a persisted document', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      agents: {
        main: {
          homedir: '/tmp/sessions/wd_test/s1/agents/main',
          type: 'main',
          parentAgentId: null,
        },
      },
    });

    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('main', {
      homedir: '/tmp/sessions/wd_test/s1/agents/main',
      type: 'main',
      parentAgentId: undefined,
      forkedFrom: undefined,
      labels: undefined,
    });

    expect((await meta.read()).updatedAt).toBe(1700000000000);
  });

  it('updates changed fields on re-registration without bumping updatedAt', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('main', {
      homedir: '/tmp/sessions/wd_test/s1/agents/main',
      type: 'main',
    });
    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));

    await meta.registerAgent('main', {
      homedir: '/tmp/sessions/wd_test/s1/agents/main',
      type: 'main',
      labels: { workItem: 'src/a.ts' },
    });

    const next = await meta.read();
    expect(next.agents?.['main']?.labels).toEqual({ workItem: 'src/a.ts' });
    expect(next.updatedAt).toBe(before);
  });

  it('treats the delegator union as durable agent metadata', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('external-child', {
      type: 'independent',
      delegator: { kind: 'external', delegationId: 'delegation_a' },
    });
    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));

    await meta.registerAgent('external-child', {
      type: 'independent',
      delegator: { kind: 'external', delegationId: 'delegation_b' },
    });

    const next = await meta.read();
    expect(next.agents?.['external-child']?.delegator).toEqual({
      kind: 'external',
      delegationId: 'delegation_b',
    });
    expect(next.updatedAt).toBe(before);
  });

  it('unregisters one agent atomically without changing other persisted metadata', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('agent-remove', { type: 'sub', labels: { collaborationTaskName: 'retryable' } });
    await meta.registerAgent('agent-keep', { type: 'sub', labels: { collaborationTaskName: 'durable' } });

    await meta.unregisterAgent?.('agent-remove');

    const stored = await meta.read();
    expect(stored.agents?.['agent-remove']).toBeUndefined();
    expect(stored.agents?.['agent-keep']?.labels?.['collaborationTaskName']).toBe('durable');
  });

  it('records the fresh summary into the session index mirror on update', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    expect(mirror.recorded).toHaveLength(1);

    await meta.update({ title: 'mirrored' });

    expect(mirror.recorded).toHaveLength(2);
    expect(mirror.recorded[1]).toMatchObject({
      id: 's1',
      workspaceId: 'wd_test',
      title: 'mirrored',
      archived: false,
    });
    expect(mirror.recorded[1]?.updatedAt).toBe((await meta.read()).updatedAt);
  });

  it('does not re-record when loading an existing document', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    expect(mirror.recorded).toEqual([]);

    await meta.setArchived(true);
    expect(mirror.recorded).toHaveLength(1);
    expect(mirror.recorded[0]?.archived).toBe(true);
  });
});
