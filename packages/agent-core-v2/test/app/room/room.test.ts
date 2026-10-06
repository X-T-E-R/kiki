import { createHash } from 'node:crypto';
import { onTestFinished, describe, expect, it } from 'vitest';
import { TestInstantiationService } from '#/_base/di/test';
import { Error2, ErrorCodes } from '#/errors';

import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IAppendLogStore, type AppendLogWrite } from '#/persistence/interface/appendLogStore';
import { IConfigService } from '#/app/config/config';
import { IPersonaStore } from '#/app/persona/personaStore';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { IThreadCommunicationService, type ThreadRef } from '#/app/threadCommunication/threadCommunication';
import type { ISessionMetadata, SessionMeta, SessionMetadataChangedEvent } from '#/session/sessionMetadata/sessionMetadata';
import { Event } from '#/_base/event';

import { renderRoomPrompt, RoomService } from '#/app/room/roomService';
import { IRoomService, type RoomDocument, type RoomLogEntry, type RoomMessage } from '#/app/room/room';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { ISessionMetadata as SessionMetadataId } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionActivityView, type SessionActivityState } from '#/session/sessionActivity/sessionActivity';

class MemoryDocuments implements IAtomicDocumentStore {
  readonly _serviceBrand = undefined;
  private readonly values = new Map<string, unknown>();

  constructor(private readonly flatListing = false) {}

  async get<T>(scope: string, key: string): Promise<T | undefined> {
    return this.values.get(`${scope}\0${key}`) as T | undefined;
  }

  async set<T>(scope: string, key: string, value: T): Promise<void> {
    this.values.set(`${scope}\0${key}`, value);
  }

  async update<T>(scope: string, key: string, updater: (current: T | undefined) => T | undefined): Promise<T | undefined> {
    const next = updater(await this.get<T>(scope, key));
    if (next === undefined) this.values.delete(`${scope}\0${key}`);
    else this.values.set(`${scope}\0${key}`, next);
    return next;
  }

  async delete(scope: string, key: string): Promise<void> {
    this.values.delete(`${scope}\0${key}`);
  }

  async list(scope: string, prefix = ''): Promise<readonly string[]> {
    if (this.flatListing) return [...this.values.keys()].filter((key) => key.startsWith(`${scope}\0${prefix}`)).map((key) => key.slice(scope.length + 1));
    const paths = [...this.values.keys()].map((key) => key.replace('\0', '/'));
    return [...new Set(paths.filter((path) => path.startsWith(`${scope}/`)).map((path) => path.slice(scope.length + 1).split('/')[0]!))].filter((key) => key.startsWith(prefix));
  }
  watch(): Event<void> { return Event.None as Event<void>; }
  acquire(): { dispose(): void } { return { dispose: () => {} }; }
}

class MemoryAppendLog implements IAppendLogStore {
  readonly _serviceBrand = undefined;
  readonly onDidWrite = Event.None as Event<AppendLogWrite>;
  private readonly values = new Map<string, RoomLogEntry[]>();
  reads = 0;

  append<R>(scope: string, key: string, record: R): void {
    const id = `${scope}\0${key}`;
    const records = this.values.get(id) ?? [];
    records.push(record as RoomLogEntry);
    this.values.set(id, records);
  }

  async *read<R>(scope: string, key: string): AsyncIterable<R> {
    this.reads++;
    for (const record of this.values.get(`${scope}\0${key}`) ?? []) yield record as R;
  }

  async rewrite<R>(scope: string, key: string, records: readonly R[]): Promise<void> {
    this.values.set(`${scope}\0${key}`, [...records] as RoomLogEntry[]);
  }

  async flush(): Promise<void> {}
  async close(): Promise<void> {}
  acquire(): { dispose(): void } { return { dispose: () => {} }; }
  async drainRetirements(): Promise<void> {}
}

interface FakeSession extends ISessionScopeHandle {
  readonly metadata: ISessionMetadata;
}

function fakeMeta(id: string): ISessionMetadata {
  let value: SessionMeta = {
    id,
    version: 2,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    custom: {},
  };
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeMetadata: Event.None as Event<SessionMetadataChangedEvent>,
    read: async () => value,
    usage: () => undefined,
    recordUsage: () => {},
    update: async () => {},
    setTitle: async () => {},
    setGeneratedTitleIfUncustomized: async () => false,
    setArchived: async () => {},
    registerAgent: async () => {},
    updateAgent: async (agentId, updater) => {
      const current = value.agents?.[agentId];
      if (current !== undefined) value = { ...value, agents: { ...value.agents, [agentId]: updater(structuredClone(current)) } };
    },
  };
}

function setup(enabled = true, wakeError?: Error, flatListing = false, personaReadDelayMs = 0): {
  service: IRoomService;
  calls: Array<{ target: ThreadRef; content: string; id: string }>;
  release(messageId: string): void;
  fail(messageId: string, error: Error): void;
  deletePointer(roomId: string, messageId: string): Promise<void>;
  closeMember(sessionId: string): void;
  setActivity(sessionId: string, state: SessionActivityState): void;
  setActivePrompt(sessionId: string, promptId: string | undefined): void;
  personaReads(): number;
  sessionIndexReads(): number;
  readonly roomDeliveryCancellations: readonly (number | undefined)[];
  readonly archivedSessions: readonly string[];
  readonly abortedPrompts: readonly string[];
  legacyReads(): number;
  botEnabled(): boolean;
  seedRoom(room: RoomDocument): Promise<void>;
  room: Promise<RoomDocument>;
} {
  const documents = new MemoryDocuments(flatListing);
  const logs = new MemoryAppendLog();
  const sessions = new Map<string, FakeSession>();
  const activities = new Map<string, SessionActivityState>();
  const activePrompts = new Map<string, string>();
  const abortedPrompts: string[] = [];
  const archivedSessions: string[] = [];
  const roomDeliveryCancellations: Array<number | undefined> = [];
  let personaReadCount = 0;
  let sessionIndexReadCount = 0;
  const summaries = new Map<string, { id: string; workspaceId: string; cwd: string; createdAt: number; updatedAt: number; archived: boolean; usage: { total: { inputOther: number; inputCacheRead: number; inputCacheCreation: number; output: number } } }>();
  const calls: Array<{ target: ThreadRef; content: string; id: string }> = [];
  const waiters = new Map<string, { resolve(): void; reject(error: Error): void }>();
  const released = new Set<string>();
  const failures = new Map<string, Error>();
  let sequence = 0;
  const personaStates = new Map(['alpha', 'bravo', 'charlie'].map((id) => [id, { version: 1 as const, archived: false }]));
  const personas = {
    _serviceBrand: undefined,
    onDidChange: Event.None,
    get: async (id: string) => {
      personaReadCount++;
      if (personaReadDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, personaReadDelayMs));
      return {
        definition: {
          id,
          name: id === 'alpha' ? 'Alpha' : id === 'bravo' ? 'Bravo' : '阿澈',
          greeting: id === 'alpha' ? 'Alpha 原始开场白。' : id === 'charlie' ? '阿澈 原始开场白。' : undefined,
          job: `${id} job`,
          description: `${id} persona`,
        },
        revision: 'r1',
      };
    },
    list: async () => [],
    getState: async (id: string) => personaStates.get(id) ?? { version: 1 as const, archived: false },
    updateState: async (id: string, patch: { readonly archived?: boolean }) => {
      const next = { ...(personaStates.get(id) ?? { version: 1 as const, archived: false }), ...patch };
      personaStates.set(id, next);
      return next;
    },
  } as unknown as IPersonaStore;
  const sessionManager = {
    _serviceBrand: undefined,
    create: async (options: { sessionId?: string }): Promise<ISessionScopeHandle> => {
      const id = options.sessionId!;
      const metadata = fakeMeta(id);
      const prompt = {
        list: () => ({ active: activePrompts.has(id) ? { id: activePrompts.get(id)! } : undefined }),
        abort: (promptId: string) => {
          abortedPrompts.push(`${id}:${promptId}`);
          activePrompts.delete(id);
          return true;
        },
      } as unknown as IAgentPromptService;
      const agent = { accessor: { get: <T>(service: unknown) => service === IAgentPromptService ? prompt as T : undefined as T } };
      const lifecycle = { list: () => activePrompts.has(id) ? [agent] : [] } as unknown as IAgentLifecycleService;
      const session: FakeSession = {
        id,
        kind: 'session',
        metadata,
        accessor: {
          get: <T>(service: unknown) => service === SessionMetadataId
            ? metadata as T
            : service === ISessionActivityView
              ? { state: () => activities.get(id) ?? { busy: false, mainTurnActive: false, pendingInteraction: 'none' } } as T
              : service === IAgentLifecycleService ? lifecycle as T : undefined as T,
        },
        dispose: () => {},
      } as unknown as FakeSession;
      sessions.set(id, session);
      summaries.set(id, {
        id,
        workspaceId: 'workspace',
        cwd: '/workspace',
        createdAt: 1,
        updatedAt: 1,
        archived: false,
        usage: { total: { inputOther: 50, inputCacheRead: 20, inputCacheCreation: 0, output: 10 } },
      });
      return session;
    },
    archive: async (id: string) => { archivedSessions.push(id); sessions.delete(id); },
    close: async (id: string) => { sessions.delete(id); },
    delete: async (id: string) => { sessions.delete(id); },
    get: (id: string) => sessions.get(id),
    list: () => [...sessions.values()],
  } as unknown as ISessionManager;
  const thread = {
    _serviceBrand: undefined,
    hostId: 'test-host',
    isWorkspaceEnabled: async () => true,
    sendRoomMessage: async (input: { target: ThreadRef; content: string }) => {
      const id = `delivery-${++sequence}`;
      calls.push({ target: input.target, content: input.content, id });
      return { messageId: id, targetSeq: sequence, acceptedAt: sequence, deduplicated: false, delivery: 'pending' as const };
    },
    waitRoomDelivery: async (input: { messageId: string }) => {
      if (wakeError !== undefined) throw wakeError;
      const failure = failures.get(input.messageId);
      if (failure !== undefined) throw failure;
      if (released.delete(input.messageId)) return;
      await new Promise<void>((resolve, reject) => waiters.set(input.messageId, { resolve, reject }));
    },
    cancelRoomDeliveries: async (input: { generation?: number }) => { roomDeliveryCancellations.push(input.generation); },
  } as unknown as IThreadCommunicationService;
  const config = {
    _serviceBrand: undefined,
    get: <T>(domain: string) => (domain === 'bot' ? { enabled, roomBudget: 12 } as T : undefined as T),
  } as unknown as IConfigService;
  const ix = new TestInstantiationService();
  ix.set(IConfigService, config);
  ix.set(IAtomicDocumentStore, documents);
  ix.set(IAppendLogStore, logs);
  ix.set(IPersonaStore, personas);
  ix.set(ISessionManager, sessionManager);
  ix.stub(ISessionIndex, {
    get: async (id: string) => {
      sessionIndexReadCount++;
      return summaries.get(id) ?? {
        id,
        workspaceId: 'workspace',
        createdAt: 1,
        updatedAt: 1,
        archived: false,
        usage: { total: { inputOther: 50, inputCacheRead: 20, inputCacheCreation: 0, output: 10 } },
      };
    },
  });
  ix.set(IThreadCommunicationService, thread);
  ix.set(IRoomService, new SyncDescriptor(RoomService));
  const service = ix.get(IRoomService);
  onTestFinished(() => ix.dispose());
  const room = service.create({
    id: 'release-room',
    name: 'Release',
    workspace: '/workspace',
    members: [{ personaId: 'alpha' }, { personaId: 'bravo' }, { personaId: 'charlie' }],
  });
  return {
    service,
    calls,
    closeMember: (sessionId) => { sessions.delete(sessionId); },
    setActivity: (sessionId, state) => { activities.set(sessionId, state); },
    setActivePrompt: (sessionId, promptId) => {
      if (promptId === undefined) activePrompts.delete(sessionId);
      else activePrompts.set(sessionId, promptId);
    },
    personaReads: () => personaReadCount,
    sessionIndexReads: () => sessionIndexReadCount,
    roomDeliveryCancellations,
    archivedSessions,
    abortedPrompts,
    legacyReads: () => logs.reads,
    botEnabled: () => enabled,
    seedRoom: (value) => documents.set(`rooms/${value.id}`, 'room.json', value),
    release: (messageId) => {
      const waiter = waiters.get(messageId);
      if (waiter === undefined) released.add(messageId);
      else {
        waiters.delete(messageId);
        waiter.resolve();
      }
    },
    fail: (messageId, error) => {
      const waiter = waiters.get(messageId);
      if (waiter === undefined) failures.set(messageId, error);
      else {
        waiters.delete(messageId);
        waiter.reject(error);
      }
    },
    deletePointer: (roomId, messageId) => documents.delete(`rooms/${roomId}`, `log-pointers/${encodeURIComponent(messageId)}.json`),
    room,
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !predicate(); index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(predicate()).toBe(true);
}

describe('RoomService', () => {
  it('persists pin, archive and rename without changing the read high-water or classification', async () => {
    const { service, room, legacyReads } = setup();
    const created = await room;
    const before = (await service.listItems())[0]!;
    expect(before).toMatchObject({ kind: 'room', id: created.id, title: 'Release', workspace: '/workspace', memberCount: 3, pinned: false, archived: false, busy: false, needsYou: false, failed: false });
    await service.update(created.id, { name: ' Renamed ', pinned: true, archived: true });
    const after = (await service.listItems())[0]!;
    expect(after).toMatchObject({ title: 'Renamed', pinned: true, archived: true, updatedAt: before.updatedAt, lastSeq: before.lastSeq });
    expect((await service.get(created.id))?.members).toEqual(created.members);
    await service.update(created.id, { pinned: false, archived: false });
    expect((await service.listItems())[0]).toMatchObject({ pinned: false, archived: false, title: 'Renamed' });
    await expect(service.update(created.id, { name: ' ' })).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
    await expect(service.update('missing', { pinned: true })).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
    expect(legacyReads()).toBe(0);
  });

  it('skips persona card loading and member materialization for metadata-only archive updates', async () => {
    const fixture = setup(true, undefined, false, 5);
    const created = await fixture.room;
    const before = { personaReads: fixture.personaReads(), sessionIndexReads: fixture.sessionIndexReads() };
    await fixture.service.update(created.id, { name: 'Archived release', pinned: true, archived: true });
    expect({ personaReads: fixture.personaReads(), sessionIndexReads: fixture.sessionIndexReads() }).toEqual(before);
    expect(fixture.roomDeliveryCancellations).toEqual([0]);
    expect((await fixture.service.get(created.id))?.members).toEqual(created.members);
  });

  it('cancels and stops an archived room without archiving members, then allows a fresh wake after restore', async () => {
    const fixture = setup();
    const created = await fixture.room;
    await fixture.service.postUserMessage(created.id, { text: 'Start the current turn.' });
    await eventually(() => fixture.calls.length === 1);
    const member = created.members[0]!;
    fixture.setActivePrompt(member.sessionId, 'room-prompt');
    const archived = await fixture.service.update(created.id, { archived: true });
    expect(archived.members).toEqual(created.members);
    expect(fixture.roomDeliveryCancellations).toEqual([0, 1]);
    expect(fixture.abortedPrompts).toEqual([`${member.sessionId}:room-prompt`]);
    expect(fixture.archivedSessions).toEqual([]);
    fixture.release(fixture.calls[0]!.id);
    await fixture.service.drain(created.id);
    await fixture.service.update(created.id, { archived: false });
    await fixture.service.postUserMessage(created.id, { text: 'Resume after restore.' });
    await eventually(() => fixture.calls.length === 2);
    fixture.release(fixture.calls[1]!.id);
    await fixture.service.drain(created.id);
    const independent = await fixture.service.createFromThreads({ id: 'independent-thread-room', name: 'Independent', workspace: '/workspace', sessionIds: ['thread-a', 'thread-b'] });
    await fixture.service.update(independent.id, { archived: true });
    expect(fixture.archivedSessions).toEqual([]);
  });

  it('returns only the observed page high-water and does not count metadata as new activity', async () => {
    const { service, room } = setup();
    const created = await room;
    await service.update(created.id, { members: created.members.map((member) => ({ ...member, muted: true })) });
    const before = (await service.listItems())[0]!;
    await service.postUserMessage(created.id, { text: 'New message', idempotencyKey: 'example-message' });
    await service.postUserMessage(created.id, { text: 'New message', idempotencyKey: 'example-message' });
    const after = (await service.listItems())[0]!;
    expect(after.lastSeq).toBe(before.lastSeq + 1);
    const first = await service.log(created.id, { limit: 1 });
    expect(first.nextCursor).toBeDefined();
    expect(first.lastSeq).toBeLessThan(after.lastSeq);
    const rest = await service.log(created.id, { afterId: first.nextCursor });
    expect(rest.lastSeq).toBe(after.lastSeq);
    await service.update(created.id, { name: 'Only metadata', pinned: true });
    expect((await service.listItems())[0]).toMatchObject({ lastSeq: after.lastSeq, updatedAt: after.updatedAt });
    expect((await service.log(created.id)).lastSeq).toBe(after.lastSeq);
  });

  it('reads live member work and approval facts without resuming cold members', async () => {
    const { service, room, setActivity, closeMember } = setup();
    const created = await room;
    const member = created.members[0]!.sessionId;
    setActivity(member, { busy: true, mainTurnActive: true, pendingInteraction: 'approval' });
    expect((await service.listItems())[0]).toMatchObject({ busy: true, needsYou: true, pendingInteraction: 'approval' });
    setActivity(member, { busy: true, mainTurnActive: true, pendingInteraction: 'none' });
    expect((await service.listItems())[0]).toMatchObject({ busy: true, needsYou: false, pendingInteraction: 'none' });
    closeMember(member);
    expect((await service.listItems())[0]).toMatchObject({ busy: false, needsYou: false, pendingInteraction: 'none' });
  });

  it('projects budget and question attention without treating manual pause as attention', async () => {
    const { service, room, seedRoom } = setup();
    const created = await room;
    await seedRoom({ ...created, paused: true, pauseReason: 'budget' });
    expect((await service.listItems())[0]).toMatchObject({ needsYou: true, pendingInteraction: 'none' });
    await seedRoom({ ...created, paused: true, pauseReason: 'manual' });
    expect((await service.listItems())[0]).toMatchObject({ needsYou: false, busy: false });
    await seedRoom({ ...created, questionQueue: [{ id: 'question', sessionId: created.members[0]!.sessionId, status: 'active', enqueuedAt: 1 }] });
    expect((await service.listItems())[0]).toMatchObject({ needsYou: true, pendingInteraction: 'question' });
  });

  it.each([false, true])('deletes its projections and broadcasts deletion, without leaking an old log into a reused id (flat listing: %s)', async (flatListing) => {
    const { service, room } = setup(true, undefined, flatListing);
    const created = await room;
    const changes: boolean[] = [];
    service.onDidChange((event) => { if (event.deleted) changes.push(event.deleted); });
    await service.delete(created.id);
    expect(await service.get(created.id)).toBeUndefined();
    expect(await service.listItems()).toEqual([]);
    expect(changes).toEqual([true]);
    await expect(service.delete(created.id)).rejects.toMatchObject({ code: ErrorCodes.REQUEST_INVALID });
    await service.create({ id: created.id, name: 'Fresh', workspace: '/fresh', members: [{ personaId: 'bravo' }, { personaId: 'bravo-two' }] });
    expect((await service.log(created.id)).entries).toEqual([]);
    expect((await service.listItems())[0]).toMatchObject({ lastSeq: 0, title: 'Fresh', workspace: '/fresh' });
  });

  it.each([
    [new Error2(ErrorCodes.AUTH_LOGIN_REQUIRED, 'Sign in to the model provider.', { details: { provider: 'example-provider' } }), 'auth.login_required', false],
    [new Error('Unexpected delivery failure'), 'internal', false],
    [new Error2(ErrorCodes.PROVIDER_CONNECTION_ERROR, 'Provider offline'), 'provider.connection_error', true],
  ] as const)('records actionable wake failure metadata without advancing the cursor (%s)', async (error, code, retryable) => {
    const { service, room } = setup(true, error);
    const created = await room;
    const source = await service.postUserMessage(created.id, { text: 'Please review this release' });
    await service.drain(created.id);
    const entries = (await service.log(created.id)).entries;
    const failure = entries.find((entry) => entry.kind === 'system' && entry.event === 'wake_failed');
    expect(failure).toMatchObject({
      text: expect.stringContaining(error.message),
      data: { memberId: 'alpha', sourceMessageId: source.id, reason_code: code, reason: error.message, name: error.name, retryable },
    });
    if (code === 'auth.login_required') expect(failure).toMatchObject({ data: { provider: 'example-provider' } });
    expect((await service.get(created.id))?.cursors).toEqual(created.cursors);
    expect((await service.get(created.id))?.pendingWakes).toHaveLength(1);
    expect((await service.listItems())[0]).toMatchObject({ failed: true, busy: false });
  });

  it.each(['APIEmptyResponseError', 'APIStreamError'])('keeps the %s identity and only safe provider diagnostics', async (name) => {
    const streamDiagnostics = {
      schemaVersion: 1, protocol: 'openai_responses', endSource: 'sdk_error', terminalStatus: null,
      terminalTextParts: null, terminalTextChars: null, terminalToolCalls: null,
      emittedTextChars: 0, emittedToolHeaders: 0, eventCount: 1, textDeltaCount: 0, textDoneCount: 0,
      contentPartAddedCount: 0, outputItemAddedCount: 0, outputItemDoneCount: 0, terminalEventCount: 0, errorEventCount: 1,
    };
    const error = new Error2(ErrorCodes.PROVIDER_API_ERROR, 'Request failed', { name, details: {
      provider: 'example-provider', errorSource: 'provider_stream', upstreamErrorType: 'server_error',
      upstreamErrorCode: 'stream_failed', requestId: 'request-1', traceId: null,
      streamDiagnostics: { ...streamDiagnostics, responseBody: 'private body', headers: { authorization: 'private' } },
      body: 'private body', headers: { authorization: 'private' }, responseHash: 'private hash',
    } });
    const { service, room } = setup(true, error);
    const created = await room;
    await service.postUserMessage(created.id, { text: 'Review' });
    await service.drain(created.id);
    const failure = (await service.log(created.id)).entries.find((entry) => entry.kind === 'system' && entry.event === 'wake_failed');
    expect(failure?.kind).toBe('system');
    if (failure?.kind !== 'system') throw new Error('Expected wake failure');
    expect(failure.data).toMatchObject({ name, reason_code: 'provider.api_error', provider: 'example-provider' });
    expect(failure.data?.['providerFailure']).toEqual({
      errorSource: 'provider_stream', upstreamErrorType: 'server_error', upstreamErrorCode: 'stream_failed',
      requestId: 'request-1', traceId: null, streamDiagnostics,
    });
    expect(JSON.stringify(failure.data)).not.toContain('private');
    expect((await service.get(created.id))!.cursors).toEqual(created.cursors);
    expect((await service.get(created.id))!.pendingWakes).toHaveLength(1);
  });

  it('does not confirm or retire a previous generation after it completes', async () => {
    const { service, calls, release, seedRoom, room: personas } = setup();
    await personas;
    const room = await service.createFromThreads({ id: 'generation-room', name: 'Generation', workspace: '/workspace', sessionIds: ['thread-a', 'thread-b'] });
    const a = await service.postUserMessage(room.id, { text: '@thread-b A' });
    await eventually(() => calls.length === 1);
    const latest = (await service.get(room.id))!;
    await seedRoom({ ...latest, generation: room.generation + 1 });
    release(calls[0]!.id);
    await service.drain(room.id);
    expect((await service.get(room.id))!.cursors['thread-b']).toBeUndefined();
    expect((await service.get(room.id))!.pendingWakes).toEqual([{ sessionId: 'thread-b', sourceMessageId: a.id, generation: room.generation }]);
    const b = await service.postUserMessage(room.id, { text: '@thread-b B in new generation' });
    await eventually(() => calls.length === 2);
    expect(calls[1]!.content).toContain(a.id);
    expect(calls[1]!.content).toContain(b.id);
    release(calls[1]!.id);
    await service.drain(room.id);
  });

  it.each([false, true])('retires covered notifications without another turn when a system tail exists=%s', async (systemTail) => {
    const { service, calls, release, room: personas } = setup();
    await personas;
    const room = await service.createFromThreads({ id: 'coverage-room', name: 'Coverage', workspace: '/workspace', sessionIds: ['thread-a', 'thread-b'] });
    await service.postUserMessage(room.id, { text: '@thread-b Blocker' });
    await eventually(() => calls.length === 1);
    const a = await service.postUserMessage(room.id, { text: '@thread-b A' });
    const b = await service.postUserMessage(room.id, { text: '@thread-b B' });
    const c = await service.postUserMessage(room.id, { text: '@thread-b C' });
    release(calls[0]!.id);
    await eventually(() => calls.length === 2);
    expect(calls[1]!.content).toContain(`selected for room message ${a.id}`);
    expect(calls[1]!.content).toContain(b.id);
    expect(calls[1]!.content).toContain(c.id);
    expect((await service.get(room.id))!.pendingWakes).toHaveLength(3);
    if (systemTail) await service.update(room.id, { name: 'Coverage renamed' });
    for (let index = 2; index <= 4; index++) release(`delivery-${index}`);
    await service.drain(room.id);
    expect(calls).toHaveLength(2);
    expect((await service.get(room.id))!.pendingWakes).toEqual([]);
    expect((await service.get(room.id))!.cursors['thread-b']).toBe(c.id);
    const d = await service.postUserMessage(room.id, { text: '@thread-b D after the snapshot' });
    await eventually(() => calls.length === 3);
    expect(calls[2]!.content).toContain(d.id);
    expect(calls[2]!.content).not.toContain(b.id);
    if (systemTail) expect(calls[2]!.content).toContain('[system room_renamed]');
    release(calls[2]!.id);
    await service.drain(room.id);
    expect((await service.get(room.id))!.cursors['thread-b']).toBe(d.id);
  });

  it('keeps a new mention queued after an in-flight snapshot', async () => {
    const { service, calls, release, room: personas } = setup();
    await personas;
    const room = await service.createFromThreads({ id: 'fresh-room', name: 'Fresh', workspace: '/workspace', sessionIds: ['thread-a', 'thread-b'] });
    const a = await service.postUserMessage(room.id, { text: '@thread-b A' });
    await eventually(() => calls.length === 1);
    const d = await service.postUserMessage(room.id, { text: '@thread-b D' });
    expect(calls[0]!.content).not.toContain(d.id);
    release(calls[0]!.id);
    await eventually(() => calls.length === 2);
    expect(calls[1]!.content).toContain(`since="${a.id}"`);
    expect(calls[1]!.content).toContain(d.id);
    release(calls[1]!.id);
    await service.drain(room.id);
  });

  it.each([
    new Error2(ErrorCodes.PROVIDER_CONNECTION_ERROR, 'Provider offline'),
    new Error2(ErrorCodes.EXECUTOR_CANCELLED, 'Prompt cancelled'),
  ])('does not confirm a failed or cancelled batch (%s)', async (error) => {
    const { service, calls, release, fail, room: personas } = setup();
    await personas;
    const room = await service.createFromThreads({ id: 'failed-batch-room', name: 'Failure', workspace: '/workspace', sessionIds: ['thread-a', 'thread-b'] });
    await service.postUserMessage(room.id, { text: '@thread-b Blocker' });
    await eventually(() => calls.length === 1);
    const a = await service.postUserMessage(room.id, { text: '@thread-b A' });
    const b = await service.postUserMessage(room.id, { text: '@thread-b B' });
    release(calls[0]!.id);
    await eventually(() => calls.length === 2);
    const confirmed = (await service.get(room.id))!.cursors['thread-b'];
    expect(calls[1]!.content).toContain(b.id);
    fail(calls[1]!.id, error);
    await eventually(() => calls.length === 3);
    const afterFailure = (await service.get(room.id))!;
    expect(afterFailure.cursors['thread-b']).toBe(confirmed);
    expect(afterFailure.pendingWakes?.map((wake) => wake.sourceMessageId)).toEqual([a.id, b.id]);
    expect(calls[2]!.content).toContain(a.id);
    expect(calls[2]!.content).toContain(b.id);
    expect(calls[2]!.content).toContain('[system wake_failed]');
    release(calls[2]!.id);
    await service.drain(room.id);
  });

  it.each(['source', 'cursor'] as const)('delivers conservatively when the %s pointer is unknown', async (missing) => {
    const { service, calls, release, deletePointer, room: personas } = setup();
    await personas;
    const room = await service.createFromThreads({ id: 'unknown-pointer-room', name: 'Unknown', workspace: '/workspace', sessionIds: ['thread-a', 'thread-b'] });
    await service.postUserMessage(room.id, { text: '@thread-b Blocker' });
    await eventually(() => calls.length === 1);
    await service.postUserMessage(room.id, { text: '@thread-b A' });
    const b = await service.postUserMessage(room.id, { text: '@thread-b B' });
    const c = await service.postBotMessage(room.id, { sessionId: 'thread-a', toolCallId: 'tail', text: 'Unmentioned tail' });
    release(calls[0]!.id);
    await eventually(() => calls.length === 2);
    expect(calls[1]!.content).toContain(b.id);
    await deletePointer(room.id, missing === 'source' ? b.id : c!.id);
    release(calls[1]!.id);
    await eventually(() => calls.length === 3);
    expect(calls[2]!.content).toContain(`selected for room message ${b.id}`);
    release(calls[2]!.id);
    await service.drain(room.id);
  });

  it('retires only the covered member and generation notification', async () => {
    const { service, calls, release, seedRoom, room: personas } = setup();
    await personas;
    const room = await service.createFromThreads({ id: 'scoped-coverage-room', name: 'Scoped', workspace: '/workspace', sessionIds: ['thread-a', 'thread-b'] });
    await service.postUserMessage(room.id, { text: '@thread-b Blocker' });
    await eventually(() => calls.length === 1);
    await service.postUserMessage(room.id, { text: '@thread-b A' });
    const b = await service.postUserMessage(room.id, { text: '@thread-a @thread-b B' });
    await eventually(() => calls.length === 2);
    expect(calls[1]!.target.sessionId).toBe('thread-a');
    release(calls[0]!.id);
    await eventually(() => calls.length === 3);
    expect(calls[2]!.target.sessionId).toBe('thread-b');
    const latest = (await service.get(room.id))!;
    const otherGeneration = { sessionId: 'thread-b', sourceMessageId: b.id, generation: room.generation + 1 };
    await seedRoom({ ...latest, pendingWakes: [...latest.pendingWakes!, otherGeneration] });
    release(calls[2]!.id);
    release('delivery-4');
    let retired = false;
    const listener = service.onDidChange((event) => { if (event.roomId === room.id && event.room.pendingWakes?.length === 2) retired = true; });
    onTestFinished(() => { listener.dispose(); });
    await eventually(() => retired);
    expect(calls).toHaveLength(3);
    const after = (await service.get(room.id))!;
    expect(after.pendingWakes).toEqual([
      { sessionId: 'thread-a', sourceMessageId: b.id, generation: room.generation },
      otherGeneration,
    ]);
    expect(after.cursors['thread-a']).toBeUndefined();
    release(calls[1]!.id);
    await service.drain(room.id);
    expect((await service.get(room.id))!.pendingWakes).toEqual([otherGeneration]);
  });

  it('wakes the thread host for a message that mentions no one and keeps other threads for their next wake', async () => {
    const { service, calls, release, room: personas } = setup();
    await personas;
    const room = await service.createFromThreads({ id: 'thread-room', name: 'Thread room', workspace: '/classification', sessionIds: ['thread-a', 'thread-b'] });
    expect(room.members).toEqual(['thread-a', 'thread-b'].map((sessionId) => ({ kind: 'thread', sessionId, muted: false, joinedAt: expect.any(String), queueWhenBusy: true })));
    await service.postUserMessage(room.id, { text: 'Not mentioned yet' });
    await service.postBotMessage(room.id, { sessionId: 'thread-a', toolCallId: 'untargeted', text: 'Member broadcast' });
    await eventually(() => calls.length === 1);
    expect(calls[0]!.target).toMatchObject({ sessionId: 'thread-a', workspaceId: 'workspace' });
    expect(calls[0]!.content).toContain('Not mentioned yet');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map((call) => call.target.sessionId)).toEqual(['thread-a']);
    release(calls[0]!.id);
    await service.drain(room.id);
    await service.postUserMessage(room.id, { text: '@thread-b Please review' });
    await eventually(() => calls.length === 2);
    expect(calls[1]!.target).toMatchObject({ sessionId: 'thread-b', workspaceId: 'workspace' });
    expect(calls[1]!.content).toContain('Not mentioned yet');
    expect(calls[1]!.content).toContain('Member broadcast');
    expect(calls[1]!.content).toContain('Ordinary assistant text is NOT posted');
    expect(calls[1]!.content).toContain('ThreadSend({room: "thread-room"');
    expect(calls[1]!.content).toContain('Your room send without mentions is logged but wakes no one');
    expect(calls[1]!.content).toContain('Only a user room message without mentions wakes the host');
    expect(calls[1]!.content).toContain('Your existing workspace and permissions are unchanged');
    release(calls[1]!.id);
    await service.drain(room.id);
    const cursor = (await service.get(room.id))!.cursors['thread-b'];
    await service.postBotMessage(room.id, { sessionId: 'thread-b', toolCallId: 'own', text: 'My own speech' });
    await service.postBotMessage(room.id, { sessionId: 'thread-a', toolCallId: 'targeted', text: 'Next item', mentions: ['thread-b'] });
    await eventually(() => calls.length === 3);
    expect(calls[2]!.content).toContain(`since="${cursor}"`);
    expect(calls[2]!.content).toContain('Next item');
    expect(calls[2]!.content).not.toContain('Not mentioned yet');
    expect(calls[2]!.content).not.toContain('My own speech');
    release(calls[2]!.id);
    await service.drain(room.id);
  });
  it('delivers to each thread member on its own lane and records joins and leaves', async () => {
    const { service, calls, release, room: personas } = setup();
    await personas;
    const room = await service.createFromThreads({ id: 'lane-room', name: 'Lanes', workspace: '/classification', sessionIds: ['thread-a', 'thread-b'] });
    await service.postUserMessage(room.id, { text: '@thread-a first' });
    await eventually(() => calls.length === 1);
    await service.postUserMessage(room.id, { text: '@thread-b second' });
    await eventually(() => calls.length === 2);
    expect(calls.map((call) => call.target.sessionId)).toEqual(['thread-a', 'thread-b']);
    expect(calls[1]!.content).toContain('mentions must use these exact member IDs, not display names: [&quot;thread-a&quot;]');
    await service.addMember(room.id, { kind: 'thread', sessionId: 'thread-c' });
    await service.removeMember(room.id, 'thread-a');
    const events = (await service.log(room.id)).entries.flatMap((entry) => entry.kind === 'system' ? [[entry.event, entry.data?.['memberId']]] : []);
    expect(events).toEqual([
      ['member_joined', 'thread-a'], ['member_joined', 'thread-b'], ['member_joined', 'thread-c'], ['member_left', 'thread-a'], ['host_changed', undefined],
    ]);
    expect((await service.get(room.id))!.host).toBe('thread-b');
    for (const call of calls) release(call.id);
    await service.drain(room.id);
  });

  it('wakes exactly the mentioned thread and not the unmentioned thread host', async () => {
    const { service, calls, release, room: personas } = setup();
    await personas;
    const room = await service.createFromThreads({ id: 'mention-room', name: 'Mentions', workspace: '/classification', sessionIds: ['thread-a', 'thread-b'] });
    expect(room.host).toBe('thread-a');
    await service.postUserMessage(room.id, { text: '@thread-b Please review the contract' });
    await eventually(() => calls.length === 1);
    expect(calls[0]!.target).toMatchObject({ sessionId: 'thread-b', workspaceId: 'workspace' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map((call) => call.target.sessionId)).toEqual(['thread-b']);

    await service.postUserMessage(room.id, { text: '@thread-a you own this room' });
    await eventually(() => calls.length === 2);
    expect(calls[1]!.target).toMatchObject({ sessionId: 'thread-a' });
    for (const call of calls) release(call.id);
    await service.drain(room.id);
  });

  it('leaves an unmentioned user message unwoken when the room has no host member', async () => {
    const { service, calls, seedRoom, room: roomPromise } = setup();
    const room = await roomPromise;
    await seedRoom({ ...room, host: 'ghost-persona' });
    const posted = await service.postUserMessage(room.id, { text: 'Anyone here?' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(0);
    expect((await service.log(room.id)).entries.some((entry) => entry.kind === 'message' && entry.id === posted.id)).toBe(true);
  });

  it('keeps an unmentioned user message unwoken when the host is muted', async () => {
    const { service, calls, room: roomPromise } = setup();
    const room = await roomPromise;
    const muted = await service.update(room.id, {
      members: room.members.flatMap((member) => member.kind === 'persona' ? [{ kind: 'persona' as const, personaId: member.personaId, muted: true }] : []),
    });
    expect(muted.host).toBe(room.host);
    await service.postUserMessage(room.id, { text: 'Anyone awake?' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(0);
  });

  it('keeps persisted usage visible when member sessions are cold', async () => {
    const { service, closeMember, room: roomPromise } = setup();
    const room = await roomPromise;
    for (const member of room.members) closeMember(member.sessionId);
    expect((await service.usage(room.id)).members.map((member) => member.usage)).toEqual(room.members.map(() => ({ total: { inputOther: 50, inputCacheRead: 20, inputCacheCreation: 0, output: 10 } })));
  });

  it('resolves a cold member thread workspace from the session index', async () => {
    const { service, calls, closeMember, release, room: roomPromise } = setup();
    const room = await roomPromise;
    for (const member of room.members) closeMember(member.sessionId);

    await service.postUserMessage(room.id, { text: '@Alpha please review' });
    await eventually(() => calls.length === 1);

    expect(calls[0]!.target.workspaceId).toBe('workspace');
    release(calls[0]!.id);
    await service.drain(room.id);
  });

  it('emits each persona greeting once at create and join', async () => {
    const { service, room: roomPromise } = setup();
    const room = await roomPromise;
    expect((await service.log(room.id)).entries.filter((entry) => entry.kind === 'message' && entry.idempotencyKey === `greeting:${room.members[0]!.sessionId}`)).toHaveLength(1);
    const reduced = await service.update(room.id, { members: [{ personaId: 'alpha' }, { personaId: 'bravo' }] });
    const joined = await service.update(reduced.id, { members: [{ personaId: 'alpha' }, { personaId: 'bravo' }, { personaId: 'charlie' }] });
    const greetings = (await service.log(joined.id)).entries.filter((entry): entry is RoomMessage => entry.kind === 'message' && entry.idempotencyKey !== undefined && entry.idempotencyKey.startsWith('greeting:'));
    expect(greetings).toHaveLength(3);
    expect(greetings.filter((entry) => entry.idempotencyKey === `greeting:${joined.members[0]!.sessionId}`)).toHaveLength(1);
  });

  it('uses room indexes for log, usage, catch-up, and idempotency hot paths', async () => {
    const { service, legacyReads, release, room: roomPromise } = setup();
    const room = await roomPromise;
    await service.log(room.id);
    await service.usage(room.id);
    const first = await service.postUserMessage(room.id, { text: 'indexed', idempotencyKey: 'indexed' });
    release('delivery-1');
    await service.drain(room.id);
    const duplicate = await service.postUserMessage(room.id, { text: 'indexed', idempotencyKey: 'indexed' });

    expect(duplicate.id).toBe(first.id);
    expect(legacyReads()).toBe(0);
  });

  it('drains wakes added by a running member before reporting idle', async () => {
    const { service, calls, release, room: roomPromise } = setup();
    const room = await roomPromise;
    await service.postUserMessage(room.id, { text: 'Start' });
    await eventually(() => calls.length === 1);
    let drained = false;
    const drain = service.drain(room.id).then(() => { drained = true; });
    await service.postBotMessage(room.id, { sessionId: room.members[0]!.sessionId, toolCallId: 'delegate', text: '@Bravo please continue' });
    release(calls[0]!.id);
    await eventually(() => calls.length === 2);
    expect(drained).toBe(false);
    release(calls[1]!.id);
    await drain;
    expect(drained).toBe(true);
  });

  it('changes workspace classification without rebuilding even active member sessions', async () => {
    const { service, calls, release, room: roomPromise } = setup();
    const room = await roomPromise;
    await service.postUserMessage(room.id, { text: '@Alpha please review' });
    await eventually(() => calls.length === 1);
    const classified = await service.update(room.id, { workspace: '/another-workspace' });
    expect(classified.members).toEqual(room.members);
    expect(classified.generation).toBe((await service.get(room.id))?.generation);
    expect(classified.workspace).toBe('/another-workspace');
    expect((await service.update(room.id, { name: 'Renamed' })).members).toEqual(room.members);
    release(calls[0]!.id);
    await service.drain(room.id);
    expect((await service.log(room.id)).entries.some((entry) => entry.kind === 'system' && entry.event === 'workspace_changed')).toBe(true);
  });

  it('reclaims an active persisted question after a cold restart', async () => {
    const { service, seedRoom, room: roomPromise } = setup();
    const room = await roomPromise;
    const member = room.members[0]!;
    await seedRoom({ ...room, questionQueue: [{ id: 'stale-question', sessionId: member.sessionId, status: 'active', enqueuedAt: 1 }] });
    await expect(service.runQuestion(room.id, member.sessionId, async () => 'recovered', new AbortController().signal)).resolves.toBe('recovered');
    expect((await service.get(room.id))?.questionQueue).toBeUndefined();
  });

  it('shows one question at a time and removes cancelled queued questions', async () => {
    const { service, room: roomPromise } = setup();
    const room = await roomPromise;
    const shown: string[] = [];
    let answer!: () => void;
    const first = service.runQuestion(room.id, room.members[0]!.sessionId, async () => {
      shown.push('first');
      await new Promise<void>((resolve) => { answer = resolve; });
      return 'answered';
    }, new AbortController().signal);
    await eventually(() => shown.length === 1);
    const cancelled = new AbortController();
    const second = service.runQuestion(room.id, room.members[1]!.sessionId, async () => { shown.push('cancelled'); return ''; }, cancelled.signal);
    const secondRejected = expect(second).rejects.toThrow();
    const third = service.runQuestion(room.id, room.members[2]!.sessionId, async () => { shown.push('third'); return 'done'; }, new AbortController().signal);
    await eventually(() => shown.length === 1);
    expect((await service.usage(room.id)).questions).toEqual({ activeSessionId: room.members[0]!.sessionId, queued: 2 });
    cancelled.abort();
    await secondRejected;
    expect(shown).toEqual(['first']);
    answer();
    expect(await first).toBe('answered');
    expect(await third).toBe('done');
    expect(shown).toEqual(['first', 'third']);
    expect((await service.usage(room.id)).questions?.queued).toBe(0);
  });
  it('creates a legal persona room without requiring the bot feature gate', async () => {
    const { room, botEnabled } = setup(false);
    const created = await room;
    expect(botEnabled()).toBe(false);
    expect(created).toMatchObject({ id: 'release-room', name: 'Release', workspace: '/workspace', host: 'alpha', legacyBotGate: false });
    expect(created.members.filter((member) => member.kind === 'persona').map((member) => member.personaId)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('recognizes mentions immediately before full-width punctuation', async () => {
    const { service, calls, release, room: roomPromise } = setup();
    const room = await roomPromise;
    await service.postUserMessage(room.id, { text: '@阿澈：在吗？' });
    await eventually(() => calls.length === 1);
    expect(calls[0]!.target.sessionId).toContain('_charlie_');
    release(calls[0]!.id);
    await service.drain(room.id);
  });

  it('keeps the persona host as the unmentioned fallback and wakes only mentioned personas', async () => {
    const { service, calls, release, room: roomPromise } = setup();
    const room = await roomPromise;
    await service.postUserMessage(room.id, { text: '@Bravo please check the changelog' });
    await eventually(() => calls.length === 1);
    expect(calls[0]!.target.sessionId).toContain('_bravo_');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map((call) => call.target.sessionId)).toEqual([room.members[1]!.sessionId]);
    release(calls[0]!.id);
    await service.drain(room.id);

    await service.postUserMessage(room.id, { text: 'Thanks — who signs off?' });
    await eventually(() => calls.length === 2);
    expect(calls[1]!.target.sessionId).toContain('_alpha_');
    release(calls[1]!.id);
    await service.drain(room.id);
  });

  it('wakes only the host for an unmentioned user and serializes mentioned members', async () => {
    const { service, calls, release, room: roomPromise } = setup();
    const room = await roomPromise;
    await service.postUserMessage(room.id, { text: 'Can we ship this?' });
    await eventually(() => calls.length === 1);
    expect(calls[0]!.target.sessionId).toContain('_alpha_');

    await service.postBotMessage(room.id, {
      sessionId: room.members[0]!.sessionId,
      toolCallId: 'alpha-1',
      text: 'I will ask @bravo and @charlie.',
      to: '@bravo',
    });
    release(calls[0]!.id);
    await eventually(() => calls.length === 2);
    expect(calls[1]!.target.sessionId).toContain('_bravo_');
    expect(calls[1]!.content).toContain('I will ask');

    await service.postBotMessage(room.id, {
      sessionId: room.members[1]!.sessionId,
      toolCallId: 'bravo-1',
      text: 'Bravo checked the changelog.',
    });
    release(calls[1]!.id);
    await eventually(() => calls.length === 3);
    expect(calls[2]!.target.sessionId).toContain('_charlie_');
    expect(calls[2]!.content).toContain('Bravo checked the changelog.');
    release(calls[2]!.id);
    await service.drain(room.id);

    await service.postBotMessage(room.id, {
      sessionId: room.members[2]!.sessionId,
      toolCallId: 'charlie-1',
      text: 'No one is tagged here.',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(3);
  });

  it('cancels queued wakes on user interruption and steers the active member', async () => {
    const { service, calls, release, room: roomPromise } = setup();
    const room = await roomPromise;
    await service.postUserMessage(room.id, { text: '@bravo @charlie investigate this' });
    await eventually(() => calls.length === 1);
    expect(calls[0]!.target.sessionId).toContain('_bravo_');

    await service.postUserMessage(room.id, { text: '@charlie use the latest request' });
    await eventually(() => calls.length === 2);
    expect(calls[1]!.target.sessionId).toContain('_bravo_');
    release(calls[0]!.id);
    release(calls[1]!.id);
    await eventually(() => calls.length === 3);
    expect(calls[2]!.target.sessionId).toContain('_charlie_');
    release(calls[2]!.id);
    await service.drain(room.id);
  });

  it('lets an active member finish while manually paused without re-waking others', async () => {
    const { service, calls, release, room: roomPromise } = setup();
    const room = await roomPromise;
    await service.postUserMessage(room.id, { text: 'Start the current turn.' });
    await eventually(() => calls.length === 1);
    await service.pause(room.id);
    const activeOutput = await service.postBotMessage(room.id, {
      sessionId: room.members[0]!.sessionId,
      toolCallId: 'active-paused',
      text: 'The active turn is complete.',
    });
    expect(activeOutput?.text).toBe('The active turn is complete.');
    expect((await service.log(room.id)).entries.some((entry) => entry.kind === 'message' && entry.text === 'The active turn is complete.')).toBe(true);
    release(calls[0]!.id);
    await service.drain(room.id);
    expect(calls).toHaveLength(1);
  });

  it('continues persisted queued wakes after a budget pause', async () => {
    const { service, calls, release, room: roomPromise } = setup();
    const initial = await roomPromise;
    const room = await service.update(initial.id, { budget: { botMessagesPerUserMessage: 2 } });
    await service.postUserMessage(room.id, { text: 'Start' });
    await eventually(() => calls.length === 1);
    await service.postBotMessage(room.id, {
      sessionId: room.members[0]!.sessionId,
      toolCallId: 'host-two',
      text: 'I will ask @bravo and @charlie.',
    });
    release(calls[0]!.id);
    await eventually(() => calls.length === 2);
    await service.postBotMessage(room.id, {
      sessionId: room.members[1]!.sessionId,
      toolCallId: 'bravo-two',
      text: 'Bravo has finished.',
    });
    release(calls[1]!.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.continue(room.id);
    await eventually(() => calls.length === 3);
    expect(calls[2]!.target.sessionId).toContain('_charlie_');
    release(calls[2]!.id);
    await service.drain(room.id);
  });

  it('keeps the frozen room prefix hash stable across ten catchup rounds', async () => {
    const { room: roomPromise } = setup();
    const room = await roomPromise;
    const prefix = renderRoomPrompt({ name: room.name, host: room.host, members: room.members });
    const expected = createHash('sha256').update(prefix).digest('hex');
    const trace = Array.from({ length: 10 }, () => createHash('sha256').update(prefix).digest('hex'));
    expect(trace).toHaveLength(10);
    expect(new Set(trace)).toEqual(new Set([expected]));
  });

  it('pauses at the visible budget and continue resets it', async () => {
    const { service, calls, release, room: roomPromise } = setup();
    const initial = await roomPromise;
    const room = await service.update(initial.id, { budget: { botMessagesPerUserMessage: 1 } });
    await service.postUserMessage(room.id, { text: 'Start' });
    await eventually(() => calls.length === 1);
    await service.postBotMessage(room.id, {
      sessionId: room.members[0]!.sessionId,
      toolCallId: 'one',
      text: 'One answer',
    });
    const paused = await service.get(room.id);
    expect(paused?.paused).toBe(true);
    expect((await service.log(room.id)).entries.some((entry) => entry.kind === 'system' && entry.event === 'budget_exhausted')).toBe(true);
    release(calls[0]!.id);
    await service.continue(room.id);
    expect((await service.get(room.id))?.budgetUsed).toBe(0);
  });
});
