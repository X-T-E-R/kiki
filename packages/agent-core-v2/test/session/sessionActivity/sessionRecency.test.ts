import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IEventBus } from '#/app/event/eventBus';
import { IEventService } from '#/app/event/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionIndex, ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { readSessionSummaryResult } from '#/app/sessionIndex/sessionIndexSource';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetadata, drainSessionMetadataWrites } from '#/session/sessionMetadata/sessionMetadataService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { activityParentId, ISessionRecencyStore } from '#/session/sessionActivity/sessionRecency';
import { SessionRecencyStore } from '#/session/sessionActivity/sessionRecencyStore';
import { ISessionRecencyService, SessionRecencyService } from '#/session/sessionActivity/sessionRecencyService';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { AgentActivityUpdated } from '#/agent/activityView/activityView';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { stubBootstrap } from '../../app/bootstrap/stubs';
import { stubSessionIndexMirror } from '../../app/sessionIndex/stubs';
import { stubLog } from '../../_base/log/stubs';

async function readSessionSummary(docs: IAtomicDocumentStore, scope: string, workspace: string, id: string) {
  const result = await readSessionSummaryResult(docs, scope, workspace, id);
  return result.kind === 'found' ? result.summary : undefined;
}

describe('session activity recency', () => {
  let ix: TestInstantiationService;
  let docs: IAtomicDocumentStore;
  let mirror: ReturnType<typeof stubSessionIndexMirror>;
  let publish: ReturnType<typeof vi.fn<IEventService['publish']>>;
  beforeEach(() => {
    ix = new TestInstantiationService();
    docs = new JsonAtomicDocumentStore(new InMemoryStorageService());
    mirror = stubSessionIndexMirror();
    publish = vi.fn();
    ix.stub(IAtomicDocumentStore, docs);
    ix.stub(ISessionIndexMirror, mirror);
    ix.stub(IBootstrapService, stubBootstrap());
    ix.stub(ILogService, stubLog());
    ix.stub(IEventService, { publish });
    ix.stub(ISessionManager, { get: () => undefined, withLifecycleSerialization: async (_id, work) => work({ archive: async () => {}, restore: async () => undefined }) });
    ix.stub(ISessionIndex, { get: (id) => readSessionSummary(docs, 'sessions', 'ws', id) });
    ix.set(ISessionRecencyStore, new SyncDescriptor(SessionRecencyStore));
  });
  afterEach(async () => { await drainSessionMetadataWrites(); ix.dispose(); vi.restoreAllMocks(); });
  async function seed(id: string, custom = {}, activityUpdatedAt?: number) {
    await docs.set(`sessions/ws/${id}`, 'state.json', { id, version: 2, createdAt: 1, updatedAt: 10, activityUpdatedAt, archived: false, title: 'Explicit title', titleKind: 'custom', lastPrompt: 'Main prompt', agents: {}, custom } satisfies SessionMeta);
  }
  it('recognizes session children, not ordinary agent metadata or plain forks', () => {
    expect(activityParentId('child', { parent_session_id: 'parent', child_session_kind: 'child' })).toBe('parent');
    expect(activityParentId('child', { created_by_session_id: 'parent' })).toBe('parent');
    expect(activityParentId('child', { parent_session_id: 'parent' })).toBeUndefined();
    expect(activityParentId('child', { parentAgentId: 'agent-0' })).toBeUndefined();
    expect(activityParentId('child', { created_by_session_id: 'child' })).toBeUndefined();
    expect(activityParentId('child', { created_by_session_id: '../other' })).toBeUndefined();
    expect(activityParentId('child', { created_by_session_id: '..\\other' })).toBeUndefined();
  });
  it('persists cold ancestor recency and reads the same source after restart without resuming them', async () => {
    await seed('parent', { created_by_session_id: 'root' });
    await seed('root', { created_by_session_id: 'child' });
    await ix.get(ISessionRecencyStore).propagate('parent', 100, new Set(['child']));
    expect((await readSessionSummary(docs, 'sessions', 'ws', 'parent'))?.updatedAt).toBe(100);
    expect((await readSessionSummary(docs, 'sessions', 'ws', 'root'))?.updatedAt).toBe(100);
    expect(await docs.get('sessions/ws/parent', 'state.json')).toMatchObject({ updatedAt: 10, activityUpdatedAt: 100, lastPrompt: 'Main prompt', title: 'Explicit title' });
    expect(mirror.recorded.map((entry) => [entry.id, entry.updatedAt])).toEqual([['parent', 100], ['root', 100]]);
    await ix.get(ISessionRecencyStore).propagate('parent', 50, new Set(['child']));
    expect(mirror.recorded).toHaveLength(2);
    expect(publish).toHaveBeenCalledTimes(2);
  });
  it('updates live parent metadata through its serialized owner', async () => {
    await seed('parent');
    ix.stub(ISessionContext, makeSessionContext({ sessionId: 'parent', workspaceId: 'ws', sessionDir: '/test', sessionScope: 'sessions/ws/parent', cwd: '/example' }));
    ix.set(ISessionStateService, new SyncDescriptor(SessionStateService));
    ix.set(ISessionMetadata, new SyncDescriptor(SessionMetadata));
    const metadata = ix.get(ISessionMetadata);
    ix.stub(ISessionManager, { get: () => ({ accessor: { get: () => metadata } }) as never, isEphemeral: () => false,
      withLifecycleSerialization: async (_id, work) => work({ archive: async () => {}, restore: async () => undefined }) });
    await ix.get(ISessionRecencyStore).propagate('parent', 300, new Set(['child']));
    expect(await metadata.read()).toMatchObject({ updatedAt: 10, activityUpdatedAt: 300 });
    expect(mirror.recorded.at(-1)?.updatedAt).toBe(300);
  });
  it('records real turns including subagent turns without touching the main prompt timestamp, and ignores idle restores', async () => {
    await seed('child', { parent_session_id: 'parent', child_session_kind: 'child' });
    await seed('parent');
    const handlers = new Map<string, (event: unknown) => void>();
    const bus = { subscribe: (type: { type: string }, handler: (event: unknown) => void) => {
      handlers.set(type.type, handler); return { dispose: () => handlers.delete(type.type) };
    } };
    const handle = { id: 'agent-0', accessor: { get: (token: unknown) => token === IEventBus ? bus : undefined } } as IAgentScopeHandle;
    ix.stub(IAgentLifecycleService, { list: () => [handle], onDidCreate: Event.None as Event<IAgentScopeHandle>, onDidDispose: Event.None as Event<string> });
    ix.stub(ISessionContext, makeSessionContext({ sessionId: 'child', workspaceId: 'ws', sessionDir: '/test', sessionScope: 'sessions/ws/child', cwd: '/example' }));
    ix.set(ISessionStateService, new SyncDescriptor(SessionStateService));
    ix.set(ISessionMetadata, new SyncDescriptor(SessionMetadata));
    ix.set(ISessionRecencyService, new SyncDescriptor(SessionRecencyService));
    ix.get(ISessionRecencyService);
    expect(handlers.has(AgentActivityUpdated.type)).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    vi.spyOn(Date, 'now').mockReturnValue(400);
    handlers.get(TurnStarted.type)?.({ turnId: 1 });
    await drainSessionMetadataWrites();
    expect((await readSessionSummary(docs, 'sessions', 'ws', 'parent'))?.updatedAt).toBe(400);
    vi.spyOn(Date, 'now').mockReturnValue(500);
    handlers.get(TurnEnded.type)?.({ turnId: 1, reason: 'completed' });
    await drainSessionMetadataWrites();
    expect(await ix.get(ISessionMetadata).read()).toMatchObject({ updatedAt: 10, activityUpdatedAt: 500, lastPrompt: 'Main prompt' });
    expect((await readSessionSummary(docs, 'sessions', 'ws', 'parent'))?.updatedAt).toBe(500);
  });
  it('drains metadata inside a lifecycle lock without waiting on propagation queued behind that lock', async () => {
    await seed('child', { created_by_session_id: 'parent' });
    await seed('parent');
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    ix.stub(ISessionManager, { get: () => undefined, withLifecycleSerialization: async (_id, work) => {
      await lock;
      return work({ archive: async () => {}, restore: async () => undefined });
    } });
    const handlers = new Map<string, (event: unknown) => void>();
    const bus = { subscribe: (type: { type: string }, handler: (event: unknown) => void) => {
      handlers.set(type.type, handler); return { dispose: () => { handlers.delete(type.type); } };
    } };
    const handle = { id: 'main', accessor: { get: (token: unknown) => token === IEventBus ? bus : undefined } } as IAgentScopeHandle;
    ix.stub(IAgentLifecycleService, { list: () => [handle], onDidCreate: Event.None as Event<IAgentScopeHandle>, onDidDispose: Event.None as Event<string> });
    ix.stub(ISessionContext, makeSessionContext({ sessionId: 'child', workspaceId: 'ws', sessionDir: '/test', sessionScope: 'sessions/ws/child', cwd: '/example' }));
    ix.set(ISessionStateService, new SyncDescriptor(SessionStateService));
    ix.set(ISessionMetadata, new SyncDescriptor(SessionMetadata));
    ix.set(ISessionRecencyService, new SyncDescriptor(SessionRecencyService));
    ix.get(ISessionRecencyService);
    vi.spyOn(Date, 'now').mockReturnValue(600);
    handlers.get(TurnStarted.type)?.({ turnId: 1 });
    let drained = false;
    const closing = drainSessionMetadataWrites(false).then(() => { drained = true; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(drained).toBe(true);
      expect(await ix.get(ISessionMetadata).read()).toMatchObject({ activityUpdatedAt: 600 });
      expect((await readSessionSummary(docs, 'sessions', 'ws', 'parent'))?.updatedAt).toBe(10);
    } finally {
      const parentMeta = await docs.get<SessionMeta>('sessions/ws/parent', 'state.json');
      await docs.set('sessions/ws/parent', 'state.json', { ...parentMeta, archived: true, archivedAt: 550 });
      release();
      await closing;
      await drainSessionMetadataWrites();
    }
    expect(await readSessionSummary(docs, 'sessions', 'ws', 'parent')).toMatchObject({ updatedAt: 600, archived: true, archivedAt: 550 });
    expect(await docs.get('sessions/ws/parent', 'state.json')).toMatchObject({ activityUpdatedAt: 600, updatedAt: 10, title: 'Explicit title', archived: true });
  });
});
