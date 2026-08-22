import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { Event, Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { TestInstantiationService } from '#/_base/di/test';
import { LifecycleScope } from '#/app/scopes';
import type { IAgentScopeHandle, ISessionScopeHandle } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { HomeRuntimeError } from '#/app/runtimeHost/errors';
import { IConfigService } from '#/app/config/config';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import {
  IThreadCommunicationService,
  type ThreadRef,
} from '#/app/threadCommunication/threadCommunication';
import { ThreadCommunicationService } from '#/app/threadCommunication/threadCommunicationService';
import { MiniDbMailboxBackend } from '#/app/threadCommunication/miniDbThreadMailboxStore';
import { ThreadMailboxBacklogError } from '#/app/threadCommunication/mailboxErrors';
import {
  SEND_PEER_THREAD_MESSAGE,
  peerSendCapability,
} from '#/app/threadCommunication/peerThreadCapability';
import {
  IThreadMailboxStore,
  type AcceptedThreadMessage,
  type ThreadDeliveryClaim,
} from '#/app/threadCommunication/threadMailboxStore';
import { IAgentPromptService, type PromptHandle } from '#/agent/prompt/prompt';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  ISessionActivityView,
  type SessionActivityChangedEvent,
} from '#/session/sessionActivity/sessionActivity';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type {
  SessionArchivedEvent,
  SessionClosedEvent,
  SessionCreatedEvent,
} from '#/workspace/sessionLifecycle/sessionLifecycle';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { WireRecord } from '#/wire/record';
import { stubLog } from '../../_base/log/stubs';
import { ErrorCodes } from '#/errors';

const summaries: Record<string, SessionSummary> = {
  source: {
    id: 'source',
    workspaceId: 'workspace-a',
    cwd: '/workspace-a',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
  },
  target: {
    id: 'target',
    workspaceId: 'workspace-b',
    cwd: '/workspace-b',
    createdAt: 3,
    updatedAt: 4,
    archived: false,
  },
};

describe('ThreadCommunicationService', () => {
  let homeDir: string;
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let globalEnabled: boolean;
  let workspaceOverrides: Map<string, boolean>;
  let events: string[];
  let deliveredMessage: AcceptedThreadMessage | undefined;
  let deliveryState: 'pending' | 'delivering' | 'delivered';
  let promptState: PromptHandle['state'];
  let promptEnqueue: Mock<IAgentPromptService['enqueue']>;
  let promptInject: ReturnType<typeof vi.fn>;
  let resume: ReturnType<typeof vi.fn>;
  let activityEvents: Array<{
    seq: number;
    epoch: string;
    kind: 'terminal' | 'attention' | 'lifecycle' | 'message_undeliverable';
    at: number;
    reason: string;
  }>;
  let wireRecords: WireRecord[];
  let acceptError: Error | undefined;
  let mailboxClose: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let listPendingTargets: ReturnType<
    typeof vi.fn<IThreadMailboxStore['listPendingTargets']>
  >;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'thread-service-'));
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    globalEnabled = true;
    workspaceOverrides = new Map();
    events = [];
    activityEvents = [];
    wireRecords = [];
    acceptError = undefined;
    deliveryState = 'delivered';
    mailboxClose = vi.fn(async () => {});
    listPendingTargets = vi
      .fn<IThreadMailboxStore['listPendingTargets']>()
      .mockResolvedValue([]);
    promptState = 'running';
    promptInject = vi.fn();
    promptEnqueue = vi.fn(async (input) => {
      events.push('enqueue');
      const launched = promptState === 'pending' ? new Promise<undefined>(() => {}) : Promise.resolve(undefined);
      const handle = {
        id: input.id,
        userMessageId: input.id,
        createdAt: new Date().toISOString(),
        get state() {
          return promptState;
        },
        message: input.message,
        launched,
        completion: new Promise(() => {}),
      } as PromptHandle;
      return handle;
    });
    const prompt = { enqueue: promptEnqueue, inject: promptInject } as unknown as IAgentPromptService;
    const agent: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: accessor([[IAgentPromptService, prompt]]),
      dispose: () => {},
    };
    const agents = {
      create: async () => agent,
      get: () => agent,
      list: () => [agent],
    } as unknown as IAgentLifecycleService;
    const session: ISessionScopeHandle = {
      id: 'target',
      kind: LifecycleScope.Session,
      accessor: accessor([[IAgentLifecycleService, agents]]),
      dispose: () => {},
    };
    resume = vi.fn(async () => {
      events.push('resume');
      return session;
    });

    ix.stub(IBootstrapService, {
      homeDir,
      storeDir: join(homeDir, 'store'),
      scope: (name: string) => name,
    });
    ix.stub(IConfigService, {
      ready: Promise.resolve(),
      get: <T>() => ({ enabled: globalEnabled }) as T,
    });
    ix.stub(ISessionIndex, {
      get: async (id: string) => summaries[id],
      listRecent: async () => ({ items: Object.values(summaries) }),
    });
    ix.set(ISessionManager, {
      _serviceBrand: undefined,
      resume,
      get: () => undefined,
      list: () => [],
      onDidCreateSession: Event.None,
      onDidForkSession: Event.None,
      onDidArchiveSession: Event.None,
      onDidCloseSession: Event.None,
    } as unknown as ISessionManager);
    ix.stub(IAppendLogStore, {
      read: <R>() =>
        (async function* (): AsyncGenerator<R> {
          for (const record of wireRecords) yield record as R;
        })(),
    });
    ix.stub(ILogService, stubLog());
    ix.stub(IThreadMailboxStore, {
      acceptMessage: async (input) => {
        if (acceptError !== undefined) throw acceptError;
        events.push('persist');
        deliveredMessage = {
          ...input,
          messageId: 'message-1',
          acceptedAt: 10,
          targetSeq: 1,
        };
        deliveryState = 'pending';
        return {
          message: deliveredMessage,
          deduplicated: false,
          delivery: 'pending',
          payloadConflict: false,
        };
      },
      claimNext: async (input) => {
        if (deliveredMessage === undefined || deliveryState !== 'pending') return undefined;
        deliveryState = 'delivering';
        return {
          message: deliveredMessage,
          consumerId: input.consumerId,
          fence: 1,
          leaseUntil: Date.now() + input.leaseMs,
          hostEpoch: 1,
        };
      },
      acknowledgeDelivery: async () => {
        if (deliveryState !== 'delivering') return false;
        deliveryState = 'delivered';
        events.push('ack');
        return true;
      },
      markUndeliverable: async () => true,
      listPendingTargets,
      appendActivity: async (input) => {
        const activity = {
          seq: activityEvents.length + 1,
          epoch: 'epoch',
          kind: input.kind,
          at: Date.now(),
          reason: input.reason,
        };
        activityEvents.push(activity);
        return activity;
      },
      readActivity: async (_target, afterSeq, limit) => ({
        epoch: 'epoch',
        latestSeq: activityEvents.at(-1)?.seq ?? 0,
        activities: activityEvents.filter((activity) => activity.seq > afterSeq).slice(0, limit),
      }),
      getWorkspaceOverride: async (workspaceId: string) => workspaceOverrides.get(workspaceId),
      setWorkspaceOverride: async (workspaceId: string, enabled: boolean) => {
        workspaceOverrides.set(workspaceId, enabled);
      },
      clearWorkspaceOverride: async (workspaceId: string) => {
        workspaceOverrides.delete(workspaceId);
      },
      close: mailboxClose,
    });
    ix.set(IThreadCommunicationService, new SyncDescriptor(ThreadCommunicationService));
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('waits for startup mailbox recovery during shutdown', async () => {
    let markRecoveryStarted!: () => void;
    const recoveryStarted = new Promise<void>((resolve) => {
      markRecoveryStarted = resolve;
    });
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    listPendingTargets.mockImplementation(async () => {
      markRecoveryStarted();
      await recoveryGate;
      return [];
    });
    const service = ix.get(IThreadCommunicationService);
    await recoveryStarted;

    let shutdownSettled = false;
    const shutdown = service.shutdown().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    releaseRecovery();
    await shutdown;
    expect(shutdownSettled).toBe(true);
    await expect(service.shutdown()).resolves.toBeUndefined();
    expect(mailboxClose).not.toHaveBeenCalled();
  });

  it('retries transient startup recovery without poisoning public readiness', async () => {
    listPendingTargets
      .mockRejectedValueOnce(new HomeRuntimeError('runtime.timeout', 'startup timeout'))
      .mockRejectedValueOnce(new HomeRuntimeError('runtime.connection_failed', 'owner transition'))
      .mockResolvedValueOnce([]);
    const service = ix.get(IThreadCommunicationService);

    await expect(service.listThreads()).rejects.toMatchObject({ code: 'runtime.timeout' });
    await expect(service.listThreads()).rejects.toMatchObject({ code: 'runtime.connection_failed' });
    await expect(service.listThreads()).resolves.toMatchObject({ threads: expect.any(Array) });
    expect(listPendingTargets).toHaveBeenCalledTimes(3);
  });

  it('persists before cross-workspace resume and enqueue without injection', async () => {
    const service = ix.get(IThreadCommunicationService);
    const source = ref(service.hostId, 'workspace-a', 'source');
    const target = ref(service.hostId, 'workspace-b', 'target');
    const result = await peerSendCapability(service)[SEND_PEER_THREAD_MESSAGE]({
      source,
      target,
      content: 'hello',
      idempotencyKey: 'stable-key',
    });

    expect(events).toEqual(['persist', 'resume', 'enqueue', 'ack']);
    expect(result.delivery).toBe('delivered');
    expect(deliveredMessage?.producer).toEqual({ kind: 'peer_thread', source });
    expect(promptInject).not.toHaveBeenCalled();
    expect(promptEnqueue).toHaveBeenCalledWith({
      id: 'message-1',
      message: expect.objectContaining({
        role: 'user',
        origin: {
          kind: 'peer_thread',
          source,
          messageId: 'message-1',
          acceptedAt: 10,
        },
      }),
    });
    expect(resume).toHaveBeenCalledWith('target');
  });

  it('leaves an active target message queued and never injects it', async () => {
    promptState = 'pending';
    const service = ix.get(IThreadCommunicationService);
    const result = await peerSendCapability(service)[SEND_PEER_THREAD_MESSAGE]({
      source: ref(service.hostId, 'workspace-a', 'source'),
      target: ref(service.hostId, 'workspace-b', 'target'),
      content: 'queued',
      idempotencyKey: 'queued-key',
    });

    expect(result.delivery).toBe('pending');
    expect(events).toEqual(['persist', 'resume', 'enqueue']);
    expect(promptInject).not.toHaveBeenCalled();
    await expect(service.shutdown()).resolves.toBeUndefined();
    expect(events).toEqual(['persist', 'resume', 'enqueue']);
  });

  it('treats a raw external source claim as data outside the accepted authority shape', async () => {
    const service = ix.get(IThreadCommunicationService);
    const forged = ref(service.hostId, 'workspace-a', 'source');
    const result = await service.sendMessage({
      source: forged,
      target: ref(service.hostId, 'workspace-b', 'target'),
      content: 'external input',
      idempotencyKey: 'external-key',
    } as never);

    expect(result.delivery).toBe('delivered');
    expect((service as unknown as Record<string, unknown>)['sendPeerThreadMessage']).toBeUndefined();
    expect(deliveredMessage?.producer).toEqual({ kind: 'external_client' });
    expect(deliveredMessage).not.toHaveProperty('source');
    expect(promptEnqueue).toHaveBeenCalledWith({
      id: 'message-1',
      message: expect.objectContaining({
        role: 'user',
        origin: { kind: 'user' },
      }),
    });
    const prompt = promptEnqueue.mock.calls[0]![0].message;
    wireRecords = [
      { type: 'turn.prompt', input: prompt.content, origin: prompt.origin },
      { type: 'turn.ended', turnId: 0, reason: 'completed' },
    ];
    const read = await service.readThread({
      thread: ref(service.hostId, 'workspace-b', 'target'),
      limit: 10,
    });
    expect(read.turns).toEqual([
      expect.objectContaining({ origin: 'user', input: 'external input' }),
    ]);
    expect(read.turns[0]?.peer).toBeUndefined();
  });

  it('returns a coded limit error when the durable target backlog is full', async () => {
    acceptError = new ThreadMailboxBacklogError(2);
    const service = ix.get(IThreadCommunicationService);

    await expect(service.sendMessage({
      target: ref(service.hostId, 'workspace-b', 'target'),
      content: 'blocked by backlog',
      idempotencyKey: 'backlog-key',
    })).rejects.toMatchObject({
      code: ErrorCodes.THREAD_LIMIT_EXCEEDED,
      details: { limit: 2 },
    });
    expect(resume).not.toHaveBeenCalled();
  });

  it('applies global-off before workspace overrides and excludes disabled workspaces', async () => {
    const service = ix.get(IThreadCommunicationService);
    workspaceOverrides.set('workspace-b', false);
    const listed = await service.listThreads();
    expect(listed.threads.map((thread) => thread.ref.workspaceId)).toEqual(['workspace-a']);
    globalEnabled = false;
    workspaceOverrides.set('workspace-b', true);
    expect(await service.isWorkspaceEnabled('workspace-b')).toBe(false);
    expect(await service.listThreads()).toEqual({ threads: [] });
  });

  it('paginates every enabled session when the requested limit is smaller than the index page', async () => {
    const rows: SessionSummary[] = [
      summary('page-a', 'workspace-a', 5),
      summary('page-disabled', 'workspace-disabled', 4),
      summary('page-b', 'workspace-a', 3),
      summary('page-c', 'workspace-a', 2),
    ];
    workspaceOverrides.set('workspace-disabled', false);
    ix.stub(ISessionIndex, {
      get: async (id: string) => rows.find((row) => row.id === id),
      listRecent: async (query) => {
        const start = query.before === undefined
          ? 0
          : Math.max(0, rows.findIndex((row) => row.id === query.before) + 1);
        const items = rows.slice(start, start + (query.limit ?? rows.length));
        return {
          items,
          nextCursor: start + items.length < rows.length ? items.at(-1)?.id : undefined,
        };
      },
    });
    const service = ix.get(IThreadCommunicationService);

    const first = await service.listThreads({ limit: 2 });
    expect(first.threads.map((thread) => thread.ref.sessionId)).toEqual(['page-a', 'page-b']);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.listThreads({ limit: 2, cursor: first.nextCursor });
    expect(second.threads.map((thread) => thread.ref.sessionId)).toEqual(['page-c']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('reads only completed displayable main turns from a cold thread', async () => {
    const service = ix.get(IThreadCommunicationService);
    const peerSource = ref(service.hostId, 'workspace-a', 'source');
    wireRecords = [
      { type: 'turn.prompt', time: 10, input: [{ type: 'text', text: 'user input' }], origin: { kind: 'user' } },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', stepUuid: 'step-0', turnId: '0', part: { type: 'text', text: 'answer' } },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.call', stepUuid: 'step-0', turnId: '0', toolCallId: 'tool-1', name: 'Read' },
      },
      { type: 'turn.ended', time: 20, turnId: 0, reason: 'completed' },
      { type: 'turn.prompt', time: 30, input: [{ type: 'text', text: 'internal' }], origin: { kind: 'system_trigger', name: 'goal_continuation' } },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', stepUuid: 'step-1', turnId: '1', part: { type: 'text', text: 'hidden' } },
      },
      { type: 'turn.ended', time: 40, turnId: 1, reason: 'completed' },
      {
        type: 'turn.prompt',
        time: 50,
        input: [{ type: 'text', text: 'peer input' }],
        origin: { kind: 'peer_thread', source: peerSource, messageId: 'peer-1', acceptedAt: 49 },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', stepUuid: 'step-2', turnId: '2', part: { type: 'text', text: 'peer answer' } },
      },
      { type: 'turn.ended', time: 60, turnId: 2, reason: 'failed' },
    ];

    const result = await service.readThread({
      thread: ref(service.hostId, 'workspace-b', 'target'),
      limit: 10,
    });

    expect(result.turns).toEqual([
      expect.objectContaining({ turnId: 0, origin: 'user', input: 'user input', output: 'answer' }),
      expect.objectContaining({
        turnId: 2,
        origin: 'peer',
        input: 'peer input',
        output: 'peer answer',
        peer: { source: peerSource, messageId: 'peer-1' },
      }),
    ]);
    expect(resume).not.toHaveBeenCalled();
  });

  it('reconstructs queued cancellation holes with the authoritative turn clock', async () => {
    const service = ix.get(IThreadCommunicationService);
    wireRecords = [
      { type: 'turn.prompt', input: [{ type: 'text', text: 'zero' }], origin: { kind: 'user' } },
      { type: 'turn.ended', turnId: 0, reason: 'completed' },
      { type: 'turn.cancel', turnId: 2, target: 'queued' },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'one' }], origin: { kind: 'user' } },
      { type: 'turn.ended', turnId: 1, reason: 'completed' },
      { type: 'turn.cancel', turnId: 3, target: 'queued' },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'four' }], origin: { kind: 'user' } },
      { type: 'turn.ended', turnId: 4, reason: 'failed' },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', stepUuid: 'legacy', turnId: '5', part: { type: 'text', text: 'legacy' } },
      },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'six' }], origin: { kind: 'user' } },
      { type: 'turn.ended', turnId: 6, reason: 'completed' },
    ];

    const result = await service.readThread({
      thread: ref(service.hostId, 'workspace-b', 'target'),
      limit: 10,
    });
    expect(result.turns.map((turn) => ({ turnId: turn.turnId, input: turn.input }))).toEqual([
      { turnId: 0, input: 'zero' },
      { turnId: 1, input: 'one' },
      { turnId: 4, input: 'four' },
      { turnId: 6, input: 'six' },
    ]);
  });

  it('baselines a missing activity cursor and suppresses repeated terminal output', async () => {
    const service = ix.get(IThreadCommunicationService);
    const thread = ref(service.hostId, 'workspace-b', 'target');
    activityEvents.push({
      seq: 1,
      epoch: 'epoch',
      kind: 'terminal',
      at: 1,
      reason: 'completed',
    });
    const baseline = await service.waitThreads({ threads: [{ thread }], timeoutMs: 0 });
    expect(baseline).toMatchObject({ timedOut: true, threads: [{ activities: [] }] });
    activityEvents.push({
      seq: 2,
      epoch: 'epoch',
      kind: 'terminal',
      at: 2,
      reason: 'failed',
    });
    const woke = await service.waitThreads({
      threads: [{ thread, cursor: baseline.threads[0]!.cursor }],
      timeoutMs: 0,
    });
    expect(woke).toMatchObject({ timedOut: false, threads: [{ activities: [{ seq: 2 }] }] });
    const repeated = await service.waitThreads({
      threads: [{ thread, cursor: woke.threads[0]!.cursor }],
      timeoutMs: 0,
    });
    expect(repeated).toMatchObject({ timedOut: true, threads: [{ activities: [] }] });
  });

  it('waits on long workspace and session identities without leaving teardown operations', async () => {
    ix.stub(IThreadMailboxStore, mailboxFromBackend(new MiniDbMailboxBackend(join(homeDir, 'long-ref-mailbox'))));
    const service = ix.get(IThreadCommunicationService);
    const thread = ref(service.hostId, `workspace-${'w'.repeat(300)}`, `session-${'s'.repeat(300)}`);

    const woke = await service.waitThreads({ threads: [{ thread }], timeoutMs: 0 });
    expect(woke).toMatchObject({
      timedOut: false,
      threads: [{ thread, activities: [{ kind: 'lifecycle', reason: 'deleted' }] }],
    });
    const repeated = await service.waitThreads({
      threads: [{ thread, cursor: woke.threads[0]!.cursor }],
      timeoutMs: 0,
    });
    expect(repeated).toMatchObject({ timedOut: true, threads: [{ activities: [] }] });
  });

  it('rejects a wait cursor older than retained activity with a resync cursor', async () => {
    const mailbox = new MiniDbMailboxBackend(join(homeDir, 'stale-cursor-mailbox'), {
      activityBacklogLimit: 2,
    });
    ix.stub(IThreadMailboxStore, mailboxFromBackend(mailbox));
    const service = ix.get(IThreadCommunicationService);
    const thread = ref(service.hostId, 'workspace-b', 'target');
    const baseline = await service.waitThreads({ threads: [{ thread }], timeoutMs: 0 });
    for (let index = 0; index < 3; index++) {
      await mailbox.appendActivity({
        target: thread,
        kind: 'terminal',
        reason: `event-${index}`,
      });
    }

    await expect(service.waitThreads({
      threads: [{ thread, cursor: baseline.threads[0]!.cursor }],
      timeoutMs: 0,
    })).rejects.toMatchObject({
      code: ErrorCodes.THREAD_CURSOR_INVALID,
      details: { resyncCursor: expect.any(String) },
    });
  });

  it.each([
    { transition: 'close' as const, lifecycleReason: 'closed' },
    { transition: 'archive' as const, lifecycleReason: 'archived' },
  ])('detaches $transition session activity and reattaches exactly once after restore', async ({
    transition,
    lifecycleReason,
  }) => {
    const created = new Emitter<SessionCreatedEvent>();
    const closed = new Emitter<SessionClosedEvent>();
    const archived = new Emitter<SessionArchivedEvent>();
    const firstActivity = new Emitter<SessionActivityChangedEvent>();
    const resumedActivity = new Emitter<SessionActivityChangedEvent>();
    const firstHandle = observedSessionHandle('observed', 'workspace-b', firstActivity);
    const resumedHandle = observedSessionHandle('observed', 'workspace-b', resumedActivity);
    const live = new Map<string, ISessionScopeHandle>([['observed', firstHandle]]);
    ix.stub(ISessionManager, {
      _serviceBrand: undefined,
      resume,
      list: () => [...live.values()],
      get: (sessionId: string) => live.get(sessionId),
      onDidCreateSession: created.event,
      onDidForkSession: Event.None,
      onDidArchiveSession: archived.event,
      onDidCloseSession: closed.event,
    } as unknown as ISessionManager);
    const service = ix.get(IThreadCommunicationService);

    live.delete('observed');
    if (transition === 'close') closed.fire({ sessionId: 'observed' });
    else archived.fire({ sessionId: 'observed' });
    await vi.waitFor(() =>
      expect(activityEvents.map((event) => event.reason)).toEqual([lifecycleReason]),
    );
    const baseline = await service.waitThreads({
      threads: [{ thread: ref(service.hostId, 'workspace-b', 'observed') }],
      timeoutMs: 0,
    });
    const beforeOldActivity = activityEvents.length;
    firstActivity.fire({
      cause: 'turn_ended',
      state: { busy: false, mainTurnActive: false, pendingInteraction: 'none', lastTurnReason: 'completed' },
    });
    await Promise.resolve();
    expect(activityEvents).toHaveLength(beforeOldActivity);

    live.set('observed', resumedHandle);
    created.fire({ sessionId: 'observed', handle: resumedHandle, source: 'resume' });
    created.fire({ sessionId: 'observed', handle: resumedHandle, source: 'resume' });
    resumedActivity.fire({
      cause: 'turn_ended',
      state: { busy: false, mainTurnActive: false, pendingInteraction: 'none', lastTurnReason: 'failed' },
    });
    await vi.waitFor(() => expect(activityEvents).toHaveLength(beforeOldActivity + 1));
    const woke = await service.waitThreads({
      threads: [{
        thread: ref(service.hostId, 'workspace-b', 'observed'),
        cursor: baseline.threads[0]!.cursor,
      }],
      timeoutMs: 0,
    });
    expect(woke).toMatchObject({
      timedOut: false,
      threads: [{ activities: [{ kind: 'terminal', reason: 'failed' }] }],
    });
  });
});

function ref(hostId: string, workspaceId: string, sessionId: string): ThreadRef {
  return { hostId, workspaceId, sessionId };
}

function summary(id: string, workspaceId: string, updatedAt: number): SessionSummary {
  return { id, workspaceId, cwd: `/${workspaceId}`, createdAt: updatedAt, updatedAt, archived: false };
}

function observedSessionHandle(
  sessionId: string,
  workspaceId: string,
  activity: Emitter<SessionActivityChangedEvent>,
): ISessionScopeHandle {
  const state = { busy: false, mainTurnActive: false, pendingInteraction: 'none' as const };
  return {
    id: sessionId,
    kind: LifecycleScope.Session,
    accessor: accessor([
      [ISessionContext, {
        _serviceBrand: undefined,
        sessionId,
        workspaceId,
        sessionDir: sessionId,
        metaScope: sessionId,
        cwd: `/${workspaceId}`,
        scope: () => sessionId,
      }],
      [ISessionActivityView, {
        _serviceBrand: undefined,
        state: () => state,
        onDidChange: activity.event,
      }],
    ]),
    dispose: () => {},
  };
}

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

function mailboxFromBackend(backend: MiniDbMailboxBackend): IThreadMailboxStore {
  const attempts = new Map<string, { readonly attemptId: string; readonly claim: ThreadDeliveryClaim }>();
  return {
    _serviceBrand: undefined,
    acceptMessage: (input) => backend.acceptMessage(input),
    claimNext: async (input) => {
      const pending = (await backend.listPendingDeliveries())
        .filter((message) => threadIdentity(message.target) === threadIdentity(input.target))
        .toSorted((left, right) => left.targetSeq - right.targetSeq);
      for (const message of pending) {
        const attempt = await backend.beginDelivery(message.messageId);
        if (attempt === undefined) continue;
        const claim: ThreadDeliveryClaim = {
          message: attempt.message,
          consumerId: input.consumerId,
          fence: attempt.attempt,
          leaseUntil: Date.now() + input.leaseMs,
          hostEpoch: 0,
        };
        attempts.set(message.messageId, { attemptId: attempt.attemptId, claim });
        return claim;
      }
      return undefined;
    },
    acknowledgeDelivery: async (claim) => {
      const attempt = attempts.get(claim.message.messageId);
      if (attempt === undefined || attempt.claim !== claim) return false;
      attempts.delete(claim.message.messageId);
      return backend.acknowledgeDelivery(claim.message.messageId, attempt.attemptId);
    },
    markUndeliverable: async (claim, reason) => {
      const attempt = attempts.get(claim.message.messageId);
      if (attempt === undefined || attempt.claim !== claim) return false;
      attempts.delete(claim.message.messageId);
      return backend.markUndeliverable(claim.message.messageId, attempt.attemptId, reason);
    },
    listPendingTargets: async () => {
      const targets = new Map<string, ThreadRef>();
      for (const message of await backend.listPendingDeliveries()) {
        targets.set(threadIdentity(message.target), message.target);
      }
      return [...targets.values()];
    },
    appendActivity: (input) => backend.appendActivity(input),
    readActivity: (target, afterSeq, limit) => backend.readActivity(target, afterSeq, limit),
    getWorkspaceOverride: (workspaceId) => backend.getWorkspaceOverride(workspaceId),
    setWorkspaceOverride: (workspaceId, enabled) => backend.setWorkspaceOverride(workspaceId, enabled),
    clearWorkspaceOverride: (workspaceId) => backend.clearWorkspaceOverride(workspaceId),
    close: async () => {},
  };
}

function threadIdentity(thread: ThreadRef): string {
  return `${thread.hostId}\u0000${thread.workspaceId}\u0000${thread.sessionId}`;
}
