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

class MemoryDocuments implements IAtomicDocumentStore {
  readonly _serviceBrand = undefined;
  private readonly values = new Map<string, unknown>();

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

  async list(): Promise<readonly string[]> { return []; }
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
  const value: SessionMeta = {
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
  };
}

function setup(enabled = true, wakeError?: unknown): {
  service: IRoomService;
  calls: Array<{ target: ThreadRef; content: string; id: string }>;
  release(messageId: string): void;
  closeMember(sessionId: string): void;
  legacyReads(): number;
  seedRoom(room: RoomDocument): Promise<void>;
  room: Promise<RoomDocument>;
} {
  const documents = new MemoryDocuments();
  const logs = new MemoryAppendLog();
  const sessions = new Map<string, FakeSession>();
  const summaries = new Map<string, { id: string; workspaceId: string; cwd: string; createdAt: number; updatedAt: number; archived: boolean; usage: { total: { inputOther: number; inputCacheRead: number; inputCacheCreation: number; output: number } } }>();
  const calls: Array<{ target: ThreadRef; content: string; id: string }> = [];
  const waiters = new Map<string, () => void>();
  const released = new Set<string>();
  let sequence = 0;
  const personas = {
    _serviceBrand: undefined,
    onDidChange: Event.None,
    get: async (id: string) => ({
      definition: {
        id,
        name: id === 'alpha' ? 'Alpha' : id === 'bravo' ? 'Bravo' : '阿澈',
        greeting: id === 'alpha' ? 'Alpha 原始开场白。' : id === 'charlie' ? '阿澈 原始开场白。' : undefined,
        job: `${id} job`,
        description: `${id} persona`,
      },
      revision: 'r1',
    }),
    list: async () => [],
  } as unknown as IPersonaStore;
  const sessionManager = {
    _serviceBrand: undefined,
    create: async (options: { sessionId?: string }): Promise<ISessionScopeHandle> => {
      const id = options.sessionId!;
      const metadata = fakeMeta(id);
      const session: FakeSession = {
        id,
        kind: 'session',
        metadata,
        accessor: { get: <T>(service: unknown) => (service === SessionMetadataId ? metadata : undefined as T) },
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
    archive: async (id: string) => { sessions.delete(id); },
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
      if (released.delete(input.messageId)) return;
      await new Promise<void>((resolve) => waiters.set(input.messageId, resolve));
    },
    cancelRoomDeliveries: async () => {},
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
    get: async (id: string) => summaries.get(id) ?? {
      id,
      workspaceId: 'workspace',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      usage: { total: { inputOther: 50, inputCacheRead: 20, inputCacheCreation: 0, output: 10 } },
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
    legacyReads: () => logs.reads,
    seedRoom: (value) => documents.set(`rooms/${value.id}`, 'room.json', value),
    release: (messageId) => {
      const resolve = waiters.get(messageId);
      if (resolve === undefined) released.add(messageId);
      else {
        waiters.delete(messageId);
        resolve();
      }
    },
    room,
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !predicate(); index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(predicate()).toBe(true);
}

describe('RoomService', () => {
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
      data: { memberId: 'alpha', sourceMessageId: source.id, reason_code: code, reason: error.message, retryable },
    });
    if (code === 'auth.login_required') expect(failure).toMatchObject({ data: { provider: 'example-provider' } });
    expect((await service.get(created.id))?.cursors).toEqual(created.cursors);
    expect((await service.get(created.id))?.pendingWakes).toHaveLength(1);
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
    expect(calls[1]!.content).toContain('mentions use member ids: thread-a');
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
  it('requires the bot feature gate before creating a room', async () => {
    const { room } = setup(false);
    await expect(room).rejects.toThrow('Bot mode is disabled');
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
