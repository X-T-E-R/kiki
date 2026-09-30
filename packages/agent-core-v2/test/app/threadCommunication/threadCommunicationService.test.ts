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
import { IHomeRuntimeService } from '#/app/runtimeHost/runtimeHost';
import { HomeRuntimeHostService } from '#/app/runtimeHost/runtimeHostService';
import { RuntimeThreadMailboxStore } from '#/app/threadCommunication/runtimeThreadMailboxStore';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IConfigService } from '#/app/config/config';
import { MEMORY_SECTION } from '#/app/memory/configSection';
import { ICapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshot';
import { CapabilitySnapshotService } from '#/app/capabilitySnapshot/capabilitySnapshotService';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import {
  IThreadCommunicationService,
  type ThreadRef,
} from '#/app/threadCommunication/threadCommunication';
import { ThreadCommunicationService } from '#/app/threadCommunication/threadCommunicationService';
import { threadDeliveryReasonCode } from '#/app/threadCommunication/deliveryFailure';
import {
  ThreadActivityCursorExpiredError,
  ThreadMailboxBacklogError,
} from '#/app/threadCommunication/mailboxErrors';
import {
  SEND_PEER_THREAD_MESSAGE,
  peerSendCapability,
} from '#/app/threadCommunication/peerThreadCapability';
import {
  IThreadMailboxStore,
  type AcceptedThreadMessage,
  type StoredThreadActivity,
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
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { WireRecord } from '#/wire/record';
import { stubLog } from '../../_base/log/stubs';
import { Error2, ErrorCodes } from '#/errors';
import { createTestAgent } from '../../harness';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';

const summaries: Record<string, SessionSummary> = {
  source: {
    id: 'source',
    workspaceId: 'workspace-a',
    cwd: '/workspace-a',
    title: 'Design review',
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

describe('thread delivery reason codes', () => {
  it.each([
    [ErrorCodes.THREAD_NOT_FOUND, 'thread_not_found'],
    [ErrorCodes.THREAD_ARCHIVED, 'thread_archived'],
    [ErrorCodes.THREAD_DISABLED, 'communication_disabled'],
    [ErrorCodes.THREAD_CROSS_HOST, 'cross_host'],
    [ErrorCodes.PROMPT_ID_CONFLICT, 'prompt_rejected'],
    [ErrorCodes.PROMPT_NOT_FOUND, 'prompt_rejected'],
    [ErrorCodes.REQUEST_INVALID, 'prompt_rejected'],
    [ErrorCodes.SESSION_CLOSED, 'session_unavailable'],
    [ErrorCodes.SESSION_INIT_FAILED, 'session_unavailable'],
    [ErrorCodes.WORKSPACE_NOT_FOUND, 'workspace_unavailable'],
    [ErrorCodes.EXECUTOR_DISCONNECTED, 'executor_unavailable'],
    [ErrorCodes.EXECUTOR_CANCELLED, 'cancelled'],
    [ErrorCodes.THREAD_DELIVERY_FAILED, 'delivery_failed'],
  ] as const)('classifies %s independently of the error text', (code, expected) => {
    expect(threadDeliveryReasonCode(new Error2(code, 'arbitrary diagnostic'))).toBe(expected);
  });

  it.each([new Error('untyped failure'), 'failure', undefined])('falls back for uncoded failures', (error) => {
    expect(threadDeliveryReasonCode(error)).toBe('delivery_failed');
  });
});

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
  let promptAbort: ReturnType<typeof vi.fn>;
  let promptSteer: ReturnType<typeof vi.fn>;
  let steerBehavior: 'success' | 'prompt-not-found';
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
    steerBehavior = 'success';
    promptInject = vi.fn();
    promptSteer = vi.fn(async (promptIds: readonly string[]) => {
      events.push(`steer:${promptIds.join(',')}`);
      if (steerBehavior === 'success') return promptIds.map((id) => ({ id, state: 'steered' }));
      throw new Error2(ErrorCodes.PROMPT_NOT_FOUND, 'no active turn to steer into');
    });
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
    promptAbort = vi.fn();
    const prompt = { enqueue: promptEnqueue, inject: promptInject, steer: promptSteer, abort: promptAbort } as unknown as IAgentPromptService;
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
      get: <T>(section: string) => (section === MEMORY_SECTION
        ? { enabled: false, approval: 'auto', workspaces: {} }
        : { enabled: globalEnabled }) as T,
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
    const receiptDocs = new Map<string, unknown>();
    ix.stub(IAtomicDocumentStore, {
      get: async <T>(_scope: string, key: string) => receiptDocs.get(key) as T | undefined,
      set: async (_scope: string, key: string, value: unknown) => { receiptDocs.set(key, value); },
      delete: async (_scope: string, key: string) => { receiptDocs.delete(key); },
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
      cancelProducer: async () => 0,
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
    ix.set(ICapabilitySnapshotService, new SyncDescriptor(CapabilitySnapshotService));
    ix.set(IThreadCommunicationService, new SyncDescriptor(ThreadCommunicationService));
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it.each([true, false])('delivers durable room input through a real prompt loop with queueWhenBusy=%s', async (queueWhenBusy) => {
    const ctx = createTestAgent();
    const prompts = ctx.get(IAgentPromptService);
    const loop = ctx.get(IAgentLoopService);
    const steer = vi.spyOn(prompts, 'steer');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const hook = loop.hooks.onWillBeginStep.register('hold-room-test-turn', async (_event, next) => {
      hook.dispose();
      await held;
      await next();
    }, { before: 'context-injector' });
    const agent: IAgentScopeHandle = { id: 'main', kind: LifecycleScope.Agent, accessor: { get: (id) => ctx.get(id) }, dispose: () => {} };
    const session: ISessionScopeHandle = { id: 'target', kind: LifecycleScope.Session,
      accessor: accessor([[IAgentLifecycleService, { create: async () => agent, get: () => agent }]]), dispose: () => {} };
    resume.mockResolvedValue(session);
    ix.stub(IBootstrapService, { homeDir, storeDir: join(homeDir, 'store'), platform: process.platform, getEnv: () => undefined, scope: (name: string) => name });
    ix.set(IHomeRuntimeService, new SyncDescriptor(HomeRuntimeHostService));
    ix.set(IHostFileSystem, new HostFileSystem());
    ix.set(IThreadMailboxStore, new SyncDescriptor(RuntimeThreadMailboxStore));
    const runtime = ix.get(IHomeRuntimeService);
    const mailbox = ix.get(IThreadMailboxStore);
    const service = ix.get(IThreadCommunicationService);
    const target: ThreadRef = { hostId: service.hostId, workspaceId: 'workspace-b', sessionId: 'target' };
    try {
      ctx.mockNextResponse({ type: 'text', text: 'Original work finished' });
      ctx.mockNextResponse({ type: 'text', text: 'Private room response' });
      const active = await prompts.enqueue({ id: 'original-task', message: { role: 'user', content: [{ type: 'text', text: 'Original work' }], toolCalls: [], origin: { kind: 'user' } } });
      await active.launched;
      const receipt = await service.sendRoomMessage({ target, roomId: 'room-example', content: 'Review the room contract', idempotencyKey: 'room-test', targeted: true, queueWhenBusy, requireCommunication: true });
      expect(resume).toHaveBeenCalledWith('target');
      if (queueWhenBusy) {
        expect(receipt.delivery).toBe('pending');
        expect(prompts.list().active?.id).toBe('original-task');
        expect(prompts.list().pending.map((item) => item.id)).toContain(receipt.messageId);
        expect(steer).not.toHaveBeenCalled();
        expect(ctx.get(IAgentContextMemoryService).get().some((message) => message.origin?.kind === 'room_message')).toBe(false);
      } else {
        expect(receipt.delivery).toBe('delivered');
        expect(steer).toHaveBeenCalledWith([receipt.messageId]);
      }
      release();
      expect((await active.completion).state).toBe('completed');
      await service.waitRoomDelivery({ target, messageId: receipt.messageId });
      await loop.settled();
      const history = ctx.get(IAgentContextMemoryService).get();
      expect(history.filter((message) => message.origin?.kind === 'room_message')).toHaveLength(1);
      const projected = await service.listMessages({ sessionId: 'target' });
      expect(projected.items).toMatchObject([{ messageId: receipt.messageId, source: { kind: 'room', roomId: 'room-example' }, delivery: 'delivered' }]);
      if (queueWhenBusy) expect(ctx.llmCalls).toHaveLength(2);
      await ctx.expectResumeMatches();
    } finally {
      release();
      await service.shutdown();
      await mailbox.close();
      await runtime.close();
      await ctx.dispose();
    }
  }, 60_000);

  it('projects real durable peer sends, failures, pair pages, archive and deletion without cross-workspace leakage', async () => {
    ix.stub(IBootstrapService, { homeDir, storeDir: join(homeDir, 'store'), platform: process.platform,
      getEnv: () => undefined, scope: (name: string) => name });
    ix.set(IHomeRuntimeService, new SyncDescriptor(HomeRuntimeHostService));
    ix.set(IHostFileSystem, new HostFileSystem());
    ix.set(IThreadMailboxStore, new SyncDescriptor(RuntimeThreadMailboxStore));
    const mailbox = ix.get(IThreadMailboxStore);
    const runtime = ix.get(IHomeRuntimeService);
    const service = ix.get(IThreadCommunicationService);
    const source: ThreadRef = { hostId: service.hostId, workspaceId: 'workspace-a', sessionId: 'source' };
    const target: ThreadRef = { hostId: service.hostId, workspaceId: 'workspace-b', sessionId: 'target' };
    const send = peerSendCapability(service);
    try {
      const first = await send[SEND_PEER_THREAD_MESSAGE]({ source, target, content: 'first handoff', idempotencyKey: 'one' });
      expect(first.delivery).toBe('delivered');
      const duplicate = await send[SEND_PEER_THREAD_MESSAGE]({ source, target, content: 'first handoff', idempotencyKey: 'one' });
      expect(duplicate).toMatchObject({ messageId: first.messageId, deduplicated: true });
      expect(promptEnqueue).toHaveBeenCalledTimes(1);
      expect(promptEnqueue.mock.calls[0]?.[0]).toMatchObject({
        id: first.messageId, message: { id: first.messageId, origin: { messageId: first.messageId } },
      });
      await send[SEND_PEER_THREAD_MESSAGE]({ source: target, target: source, content: 'reply', idempotencyKey: 'two' });
      resume.mockRejectedValueOnce(new Error('resume failed'));
      const failed = await send[SEND_PEER_THREAD_MESSAGE]({ source, target, content: 'failed handoff', idempotencyKey: 'three' });
      expect(failed.delivery).toBe('undeliverable');
      await expect(send[SEND_PEER_THREAD_MESSAGE]({ source, target: { ...target, sessionId: 'absent' },
        content: 'not accepted', idempotencyKey: 'absent' })).rejects.toMatchObject({ code: ErrorCodes.THREAD_NOT_FOUND });
      await expect(service.listMessages({ workspaceId: 'workspace-c' })).resolves.toEqual({ items: [], nextCursor: undefined, incomplete: undefined });
      const all = await service.listMessages({ workspaceId: 'workspace-a' });
      expect(all.items).toHaveLength(3);
      expect(all.items.find((message) => message.messageId === failed.messageId)).toMatchObject({
        content: 'failed handoff', delivery: 'undeliverable', reason: 'resume failed',
        reasonCode: 'delivery_failed', reasonDetail: 'resume failed',
        source: { kind: 'thread', thread: { ref: source, title: 'Design review', deleted: false } }, target: { ref: target },
      });
      const page1 = await service.listMessages({ sessionId: 'source', peerSessionId: 'target', limit: 1 });
      const page2 = await service.listMessages({ sessionId: 'source', peerSessionId: 'target', cursor: page1.nextCursor, limit: 1 });
      const page3 = await service.listMessages({ sessionId: 'source', peerSessionId: 'target', cursor: page2.nextCursor, limit: 1 });
      expect(new Set([...page1.items, ...page2.items, ...page3.items].map((message) => message.messageId)).size).toBe(3);
      expect(page3.nextCursor).toBeUndefined();
      await expect(service.listMessages({ sessionId: 'target', cursor: page1.nextCursor })).rejects.toMatchObject({ code: ErrorCodes.THREAD_CURSOR_INVALID });
      const inventory: Record<string, SessionSummary> = { ...summaries, source: { ...summaries['source']!, archived: true } };
      ix.stub(ISessionIndex, 'get', async (id: string) => inventory[id]);
      const archived = await service.listMessages({ sessionId: 'source' });
      expect(archived.items.find((message) => message.messageId === first.messageId)?.source).toMatchObject({ kind: 'thread', thread: { archived: true } });
      await service.setWorkspaceOverride(source.workspaceId, false);
      expect((await service.listMessages({ sessionId: 'source' })).items).toHaveLength(3);
      delete inventory['source'];
      const surviving = await service.listMessages({ sessionId: 'target' });
      expect(surviving.items.find((message) => message.messageId === first.messageId)?.source).toMatchObject({ kind: 'thread', thread: { deleted: true } });
      expect((await service.listMessages({ workspaceId: 'workspace-a' })).items).toEqual([]);
      delete inventory['target'];
      expect((await service.listMessages()).items).toEqual([]);
      inventory['source'] = summaries['source']!;
      await Promise.all(Array.from({ length: 501 }, (_, index) => mailbox.acceptMessage({
        producer: { kind: 'peer_thread', source }, target: { ...target, hostId: 'another-host' },
        content: 'foreign-host mailbox traffic', idempotencyKey: `foreign-${index}`,
      })));
      const budgetPage = await service.listMessages({ sessionId: 'source', limit: 1 });
      expect(budgetPage).toMatchObject({ items: [], incomplete: 'scan_budget', nextCursor: expect.any(String) });
      const continued = await service.listMessages({ sessionId: 'source', limit: 1, cursor: budgetPage.nextCursor });
      expect(continued.items).toHaveLength(1);
      expect(continued.items[0]?.target.ref.hostId).toBe(service.hostId);
    } finally {
      await service.shutdown();
      await mailbox.close();
      await runtime.close();
    }
  }, 30_000);
  it.each(['pending', 'running'] as const)('cancels only pending room prompts, not %s active work', async (initialState) => {
    promptState = initialState;
    let complete!: (value: Awaited<PromptHandle['completion']>) => void;
    const completion = new Promise<Awaited<PromptHandle['completion']>>((resolve) => { complete = resolve; });
    promptEnqueue.mockImplementationOnce(async (input) => ({
      id: input.id!, userMessageId: input.id!, createdAt: new Date().toISOString(),
      get state() { return promptState; }, message: input.message,
      launched: initialState === 'pending' ? new Promise(() => {}) : Promise.resolve(undefined), completion,
    }));
    promptAbort.mockImplementation((id: string) => { promptState = 'cancelled'; complete({ promptId: id, state: 'cancelled', result: undefined }); });
    const service = ix.get(IThreadCommunicationService);
    const target = { hostId: service.hostId, workspaceId: 'workspace-b', sessionId: 'target' };
    const receipt = await service.sendRoomMessage({ target, roomId: 'room-test', content: 'Room turn', idempotencyKey: 'cancel-room', targeted: true, generation: 2 });
    const waiting = service.waitRoomDelivery({ target, messageId: receipt.messageId });
    const observed = waiting.then(() => 'completed', () => 'cancelled');
    await service.cancelRoomDeliveries({ roomId: 'room-test' });
    if (initialState === 'pending') {
      expect(promptAbort).toHaveBeenCalledOnce();
      expect(await observed).toBe('cancelled');
    } else {
      expect(promptAbort).not.toHaveBeenCalled();
      complete({ promptId: receipt.messageId, state: 'completed', result: undefined });
      expect(await observed).toBe('completed');
    }
    await service.shutdown();
  });

  it('reads legacy string-only failed receipts with a stable delivery failure code', async () => {
    const service = ix.get(IThreadCommunicationService);
    const target = { hostId: service.hostId, workspaceId: 'workspace-b', sessionId: 'target' };
    await ix.get(IAtomicDocumentStore).set('thread-communication', 'legacy-room-message', {
      target: { target, roomId: 'room-test' }, status: 'failed', error: 'Legacy prompt failure',
    });
    await expect(service.waitRoomDelivery({ target, messageId: 'legacy-room-message' })).rejects.toMatchObject({ code: ErrorCodes.THREAD_DELIVERY_FAILED, message: 'Legacy prompt failure' });
    await service.shutdown();
  });

  it('preserves the failed prompt code, details and cause in live and persisted room receipts', async () => {
    let complete!: (value: Awaited<PromptHandle['completion']>) => void;
    const completion = new Promise<Awaited<PromptHandle['completion']>>((resolve) => { complete = resolve; });
    promptEnqueue.mockImplementationOnce(async (input) => ({
      id: input.id!, userMessageId: input.id!, createdAt: new Date().toISOString(),
      state: 'running', message: input.message, launched: Promise.resolve(undefined), completion,
    }));
    const service = ix.get(IThreadCommunicationService);
    const target = { hostId: service.hostId, workspaceId: 'workspace-b', sessionId: 'target' };
    const receipt = await service.sendRoomMessage({ target, roomId: 'room-test', content: 'Review', idempotencyKey: 'failed-room', targeted: true });
    const waiting = service.waitRoomDelivery({ target, messageId: receipt.messageId });
    const failure = new Error2(ErrorCodes.AUTH_LOGIN_REQUIRED, 'Model provider requires login.', {
      details: { provider: 'example-provider' }, cause: new Error('No token'),
    });
    const observed = expect(waiting).rejects.toMatchObject({ code: failure.code, message: failure.message, details: failure.details, cause: { message: 'No token' } });
    complete({ promptId: receipt.messageId, state: 'failed', result: { type: 'failed', steps: 0, error: failure } });
    await observed;
    await expect(service.waitRoomDelivery({ target, messageId: receipt.messageId })).rejects.toMatchObject({ code: failure.code, message: failure.message, details: failure.details, cause: { message: 'No token' } });
    await service.shutdown();
  });

  it('waits for actual room turn completion beyond the receipt retention duration', async () => {
    globalEnabled = false;
    let complete!: (value: Awaited<PromptHandle['completion']>) => void;
    const completion = new Promise<Awaited<PromptHandle['completion']>>((resolve) => { complete = resolve; });
    promptEnqueue.mockImplementationOnce(async (input) => ({
      id: input.id!, userMessageId: input.id!, createdAt: new Date().toISOString(),
      state: 'running', message: input.message, launched: Promise.resolve(undefined), completion,
    }));
    const service = ix.get(IThreadCommunicationService);
    const target = { hostId: service.hostId, workspaceId: 'workspace-b', sessionId: 'target' };
    await service.listThreads();
    vi.useFakeTimers();
    try {
      const receipt = await service.sendRoomMessage({ target, roomId: 'room-test', content: 'Room turn', idempotencyKey: 'room-1', targeted: false });
      expect(promptEnqueue.mock.calls[0]?.[0].message.origin).toMatchObject({ kind: 'room_message', targeted: false });
      let settled = false;
      const waited = service.waitRoomDelivery({ target, messageId: receipt.messageId }).then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(settled).toBe(false);
      complete({ promptId: receipt.messageId, state: 'completed', result: undefined });
      await waited;
      expect(settled).toBe(true);
      await service.shutdown();
    } finally { vi.useRealTimers(); }
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
    void service.listThreads().catch(() => {});
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

  it('does not initialize the mailbox when thread communication is disabled', async () => {
    globalEnabled = false;
    const service = ix.get(IThreadCommunicationService);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(listPendingTargets).not.toHaveBeenCalled();
    await service.shutdown();
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

  it('startup recovery leaves pending targets owned by other mailbox hosts untouched', async () => {
    const foreign = {
      hostId: 'agent-collaboration-v2',
      workspaceId: 'session-1',
      sessionId: 'agent-target',
    };
    const claimNext = vi.fn<IThreadMailboxStore['claimNext']>(async () => undefined);
    const markUndeliverable = vi.fn<IThreadMailboxStore['markUndeliverable']>(async () => true);
    listPendingTargets.mockResolvedValue([foreign]);
    ix.stub(IThreadMailboxStore, {
      acceptMessage: async () => {
        throw new Error('unexpected accept');
      },
      claimNext,
      acknowledgeDelivery: async () => false,
      markUndeliverable,
      listPendingTargets,
      appendActivity: async (input) => ({
        seq: 1,
        epoch: 'epoch',
        kind: input.kind,
        at: Date.now(),
        reason: input.reason,
      }),
      readActivity: async () => ({ epoch: 'epoch', latestSeq: 0, activities: [] }),
      getWorkspaceOverride: async () => undefined,
      setWorkspaceOverride: async () => {},
      clearWorkspaceOverride: async () => {},
      close: mailboxClose,
    });
    const service = ix.get(IThreadCommunicationService);
    void service.listThreads().catch(() => {});

    await vi.waitFor(() => expect(listPendingTargets).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(claimNext).not.toHaveBeenCalled();
    expect(markUndeliverable).not.toHaveBeenCalled();
    await service.shutdown();
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
        content: [{ type: 'text', text: 'Message from thread "Design review" (source):\n\nhello' }],
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

  it('steers a queued message into the running target turn and acks it', async () => {
    promptState = 'pending';
    const service = ix.get(IThreadCommunicationService);
    const result = await peerSendCapability(service)[SEND_PEER_THREAD_MESSAGE]({
      source: ref(service.hostId, 'workspace-a', 'source'),
      target: ref(service.hostId, 'workspace-b', 'target'),
      content: 'steered',
      idempotencyKey: 'steer-key',
    });

    expect(result.delivery).toBe('delivered');
    expect(events).toEqual(['persist', 'resume', 'enqueue', 'steer:message-1', 'ack']);
    expect(promptSteer).toHaveBeenCalledWith([result.messageId]);
    expect(promptEnqueue.mock.calls[0]?.[0]).toMatchObject({
      id: result.messageId, message: { id: result.messageId, origin: { messageId: result.messageId } },
    });
    expect(promptInject).not.toHaveBeenCalled();
    await expect(service.shutdown()).resolves.toBeUndefined();
    expect(events).toEqual(['persist', 'resume', 'enqueue', 'steer:message-1', 'ack']);
  });

  it('falls back to the queued delivery when the steer races a finished turn', async () => {
    promptState = 'pending';
    steerBehavior = 'prompt-not-found';
    const service = ix.get(IThreadCommunicationService);
    const result = await peerSendCapability(service)[SEND_PEER_THREAD_MESSAGE]({
      source: ref(service.hostId, 'workspace-a', 'source'),
      target: ref(service.hostId, 'workspace-b', 'target'),
      content: 'raced',
      idempotencyKey: 'race-key',
    });

    expect(result.delivery).toBe('pending');
    expect(events).toEqual(['persist', 'resume', 'enqueue', 'steer:message-1']);
    expect(promptInject).not.toHaveBeenCalled();
    await expect(service.shutdown()).resolves.toBeUndefined();
    expect(events).toEqual(['persist', 'resume', 'enqueue', 'steer:message-1']);
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
    const caller = { workspaceId: 'workspace-b', sessionId: 'caller' };
    ix.get(ICapabilitySnapshotService).memoryAvailable(caller.workspaceId, caller.sessionId);
    globalEnabled = false;
    workspaceOverrides.set('workspace-b', true);
    expect(await service.isWorkspaceEnabled('workspace-b', caller)).toBe(true);
    expect(await service.isWorkspaceEnabled('workspace-b')).toBe(false);
    ix.get(ICapabilitySnapshotService).refresh(caller.workspaceId, caller.sessionId);
    expect(await service.isWorkspaceEnabled('workspace-b', caller)).toBe(false);
    expect(await service.listThreads()).toEqual({ threads: [] });
  });

  it('uses the caller session snapshot for App-scoped Thread APIs', async () => {
    const service = ix.get(IThreadCommunicationService);
    const snapshots = ix.get(ICapabilitySnapshotService);
    await snapshots.ready;
    const a = { workspaceId: 'workspace-a', sessionId: 'session-a' };
    const b = { workspaceId: 'workspace-a', sessionId: 'session-b' };
    snapshots.memoryAvailable(a.workspaceId, a.sessionId);
    snapshots.memoryAvailable(b.workspaceId, b.sessionId);
    globalEnabled = false;
    snapshots.refresh(b.workspaceId, b.sessionId);
    expect(await service.isWorkspaceEnabled('workspace-a', a)).toBe(true);
    expect((await service.listThreads({ caller: a })).threads.length).toBeGreaterThan(0);
    expect(await service.isWorkspaceEnabled('workspace-a', b)).toBe(false);
    expect(await service.listThreads({ caller: b })).toEqual({ threads: [] });
    expect(await service.isWorkspaceEnabled('workspace-a')).toBe(false);
    snapshots.refresh(a.workspaceId, a.sessionId);
    expect(await service.isWorkspaceEnabled('workspace-a', a)).toBe(false);
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
    ix.stub(IThreadMailboxStore, inMemoryMailbox());
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
    const mailbox = inMemoryMailbox({ activityRetainedLimit: 2 });
    ix.stub(IThreadMailboxStore, mailbox);
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

function inMemoryMailbox(options: { readonly activityRetainedLimit?: number } = {}): IThreadMailboxStore {
  const retainedLimit = options.activityRetainedLimit ?? 256;
  const activityByThread = new Map<string, {
    readonly epoch: string;
    readonly activities: StoredThreadActivity[];
    nextSeq: number;
    minSeq: number;
  }>();
  const overrides = new Map<string, boolean>();
  const activityState = (target: ThreadRef) => {
    const key = threadIdentity(target);
    let state = activityByThread.get(key);
    if (state === undefined) {
      state = { epoch: `epoch-${activityByThread.size + 1}`, activities: [], nextSeq: 1, minSeq: 1 };
      activityByThread.set(key, state);
    }
    return state;
  };
  return {
    _serviceBrand: undefined,
    readMessages: async () => ({ items: [] }),
    acceptMessage: async () => { throw new Error('Unexpected mailbox accept.'); },
    claimNext: async () => undefined,
    acknowledgeDelivery: async () => false,
    markUndeliverable: async () => false,
    cancelProducer: async () => 0,
    listPendingTargets: async () => [],
    appendActivity: async (input) => {
      const state = activityState(input.target);
      const activity: StoredThreadActivity = {
        seq: state.nextSeq,
        epoch: state.epoch,
        kind: input.kind,
        at: Date.now(),
        reason: input.reason,
        turnId: input.turnId,
        messageId: input.messageId,
      };
      state.nextSeq++;
      state.activities.push(activity);
      while (state.activities.length > retainedLimit) state.activities.shift();
      state.minSeq = state.activities[0]?.seq ?? state.nextSeq;
      return activity;
    },
    readActivity: async (target, afterSeq, limit) => {
      const state = activityState(target);
      if (afterSeq !== Number.MAX_SAFE_INTEGER && afterSeq < state.minSeq - 1) {
        throw new ThreadActivityCursorExpiredError(state.epoch, state.minSeq, state.nextSeq - 1);
      }
      return {
        epoch: state.epoch,
        latestSeq: state.nextSeq - 1,
        activities: state.activities.filter((activity) => activity.seq > afterSeq).slice(0, limit),
      };
    },
    getWorkspaceOverride: async (workspaceId) => overrides.get(workspaceId),
    setWorkspaceOverride: async (workspaceId, enabled) => {
      overrides.set(workspaceId, enabled);
    },
    clearWorkspaceOverride: async (workspaceId) => {
      overrides.delete(workspaceId);
    },
    close: async () => {},
  };
}

function threadIdentity(thread: ThreadRef): string {
  return `${thread.hostId}\u0000${thread.workspaceId}\u0000${thread.sessionId}`;
}
