import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClusterDb } from '@kiki/minidb/cluster';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Event, Emitter } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { ISessionManager } from '#/app/sessionManager/sessionManager';
import { HomeRuntimeError } from '#/app/runtimeHost/errors';
import { HomeRuntimeHostService } from '#/app/runtimeHost/runtimeHostService';
import {
  RuntimeThreadMailboxStore,
  THREAD_MAILBOX_RUNTIME_METHODS,
} from '#/app/threadCommunication/runtimeThreadMailboxStore';
import { ThreadMailboxBacklogError } from '#/app/threadCommunication/mailboxErrors';
import type {
  IThreadMailboxStore,
  ThreadDeliveryClaim,
  ThreadMailboxMutationOptions,
} from '#/app/threadCommunication/threadMailboxStore';
import type { SessionArchivedEvent, SessionDeletedEvent } from '#/workspace/sessionLifecycle/sessionLifecycle';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { createHooks } from '#/hooks';
import { IAgentContextMemoryService, type IAgentContextMemoryService as AgentContextMemory } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  IAgentExecutionService,
  type IAgentExecutionService as AgentExecution,
} from '#/agent/execution/execution';
import { IAgentLifecycleService, type IAgentLifecycleService as AgentLifecycle } from '#/session/agentLifecycle/agentLifecycle';
import { AgentCollaborationMessagingService } from '#/session/agentCollaboration/messagingService';
import { AgentMessageMailboxFullError } from '#/session/agentCollaboration/messageMailbox';
import type { IAgentCollaborationMessageStore } from '#/session/agentCollaboration/messageMailbox';
import {
  AgentCollaborationMailboxCleanup,
  AgentCollaborationMessageStoreAdapter,
  MAILBOX_HOST_ID,
} from '#/session/agentCollaboration/threadMailboxAdapter';
import type { AgentMeta, ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IWireService, type IWireService as Wire } from '#/wire/wire';

const signal = new AbortController().signal;
const tempDirs: string[] = [];
const runtimeMailboxes: Array<{
  readonly runtime: HomeRuntimeHostService;
  readonly store: RuntimeThreadMailboxStore;
}> = [];

interface RuntimeMailboxCaller {
  call(
    method: string,
    payload: unknown,
    options: ThreadMailboxMutationOptions | undefined,
    timeoutMs: number,
  ): Promise<unknown>;
}

afterEach(async () => {
  const mailboxes = runtimeMailboxes.splice(0);
  await Promise.allSettled(mailboxes.map((item) => item.store.close()));
  await Promise.allSettled(mailboxes.map((item) => item.runtime.close()));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe('thread mailbox agent collaboration adapter', () => {
  it('keeps FIFO, idempotency, payload conflicts, and consumption across reopen', async () => {
    const homeDir = tempDir();
    const first = mailboxStore(homeDir);
    const one = await first.accept(messageInput('one', 'idem-one'));
    const two = await first.accept(messageInput('two', 'idem-two'));

    expect([one.message.targetSeq, two.message.targetSeq]).toEqual([1, 2]);
    expect(await first.accept(messageInput('one', 'idem-one'))).toMatchObject({
      message: { messageId: one.message.messageId },
      deduplicated: true,
      delivery: 'queued',
      payloadConflict: false,
    });
    expect(await first.accept(messageInput('changed', 'idem-one'))).toMatchObject({
      message: { messageId: one.message.messageId },
      deduplicated: true,
      payloadConflict: true,
    });
    const queuedOne = await first.nextQueued('session-1', 'agent-target');
    expect(queuedOne?.message.messageId).toBe(one.message.messageId);
    expect(await first.markDelivered(queuedOne!.claim)).toBe(true);

    const reopened = mailboxStore(homeDir);
    const queuedTwo = await reopened.nextQueued('session-1', 'agent-target');
    expect(queuedTwo?.message.messageId).toBe(two.message.messageId);
    expect(await reopened.markDelivered(queuedTwo!.claim)).toBe(true);
    expect(await reopened.nextQueued('session-1', 'agent-target')).toBeUndefined();
    expect(await reopened.accept(messageInput('one', 'idem-one'))).toMatchObject({
      message: { messageId: one.message.messageId },
      deduplicated: true,
      delivery: 'delivered',
    });
  });

  it('does not request a normal backlog limit and reports hard-guard overflow', async () => {
    const acceptMessage = vi.fn<IThreadMailboxStore['acceptMessage']>(async () => {
      throw new ThreadMailboxBacklogError(100_000);
    });
    const store = new AgentCollaborationMessageStoreAdapter({
      _serviceBrand: undefined,
      acceptMessage,
    } as unknown as IThreadMailboxStore);

    const error = await store.accept(messageInput('overflow', 'overflow')).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AgentMessageMailboxFullError);
    expect(error).toMatchObject({ limit: 100_000 });
    expect(acceptMessage).toHaveBeenCalledWith(expect.not.objectContaining({
      pendingLimit: expect.anything(),
    }));
  });

  it('reuses the per-target claim request id after a committed claim response is lost', async () => {
    const target = {
      hostId: 'agent-collaboration-v2',
      workspaceId: 'session-1',
      sessionId: 'agent-target',
    };
    const claim: ThreadDeliveryClaim = {
      message: {
        messageId: 'agent-claim',
        producer: {
          kind: 'peer_thread',
          source: { ...target, sessionId: 'main' },
        },
        target,
        content: JSON.stringify({
          v: 1,
          kind: 'agent_collaboration_message',
          sourceTaskName: 'root',
          targetTaskName: 'target',
          content: 'response lost',
        }),
        idempotencyKey: 'agent-claim',
        acceptedAt: 1,
        targetSeq: 1,
      },
      consumerId: 'agent-collaboration/session-1/agent-target',
      fence: 1,
      leaseUntil: Date.now() + 30_000,
      hostEpoch: 1,
    };
    let committedRequestId: string | undefined;
    const calls: Array<{ readonly sessionId: string; readonly requestId: string }> = [];
    const claimNext = vi.fn<IThreadMailboxStore['claimNext']>(async (input, options) => {
      const requestId = options?.requestId ?? '';
      calls.push({ sessionId: input.target.workspaceId, requestId });
      if (input.target.workspaceId === 'session-2') return undefined;
      if (committedRequestId === undefined) {
        committedRequestId = requestId;
        throw new HomeRuntimeError('runtime.connection_failed', 'simulated committed claim response loss');
      }
      return requestId === committedRequestId ? claim : undefined;
    });
    const store = new AgentCollaborationMessageStoreAdapter({
      _serviceBrand: undefined,
      claimNext,
    } as unknown as IThreadMailboxStore);

    await expect(store.nextQueued('session-1', 'agent-target')).rejects.toMatchObject({
      code: 'runtime.connection_failed',
    });
    await expect(store.nextQueued('session-2', 'agent-target')).resolves.toBeUndefined();
    await expect(store.nextQueued('session-1', 'agent-target')).resolves.toMatchObject({
      message: { messageId: 'agent-claim' },
      claim,
    });
    expect(calls[0]?.requestId).toBe(calls[2]?.requestId);
    expect(calls[1]?.requestId).not.toBe(calls[0]?.requestId);
  });

  it('uses the injected thread mailbox without creating an agent collaboration backend', async () => {
    const homeDir = tempDir();
    const store = mailboxStore(homeDir);
    const accepted = await store.accept(messageInput('shared mailbox', 'shared-mailbox'));

    expect(accepted.message.targetSeq).toBe(1);
    expect(existsSync(join(homeDir, 'store', 'agent-collaboration-mailbox-v2'))).toBe(false);
    expect(existsSync(join(homeDir, 'store', 'thread-mailbox-v3'))).toBe(true);
  });
});

describe('agent collaboration safe-boundary delivery', () => {
  it('does not wake an idle target and delivers FIFO before its next run', async () => {
    const store = mailboxStore(tempDir());
    const lifecycle = lifecycleHarness([]);
    const service = new AgentCollaborationMessagingService(store, lifecycle.service, sessionContext(), metadataHarness({ 'agent-target': {} }));
    const target = agentHandle('agent-target');

    await service.send(sendInput('first', 'call-1'));
    await service.send(sendInput('second', 'call-2'));
    expect(lifecycle.service.create).not.toHaveBeenCalled();
    expect(target.messages).toEqual([]);

    lifecycle.add(target.handle);
    expect(target.messages).toEqual([]);
    await target.execution.hooks.onWillRun.run({ signal });

    expect(target.messages.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'Message from agent "root" (main):\n\nfirst' },
      { type: 'text', text: 'Message from agent "root" (main):\n\nsecond' },
    ]);
    expect(target.messages.map((message) => message.origin)).toEqual([
      expect.objectContaining({ kind: 'agent_message', senderAgentId: 'main', senderTaskName: 'root' }),
      expect.objectContaining({ kind: 'agent_message', senderAgentId: 'main', senderTaskName: 'root' }),
    ]);
    expect(target.operations).toEqual([
      'appendObservable',
      'flush',
      'appendObservable',
      'flush',
    ]);
    expect(lifecycle.service.create).not.toHaveBeenCalled();
    service.dispose();
  });

  it('resumes an interrupted claim while the original handler remains in flight', async () => {
    const homeDir = tempDir();
    const seed = bootstrap(homeDir);
    const runtime = new HomeRuntimeHostService(seed);
    const threadStore = new RuntimeThreadMailboxStore(seed, runtime, new HostFileSystem());
    runtimeMailboxes.push({ runtime, store: threadStore });
    const store = new AgentCollaborationMessageStoreAdapter(threadStore);
    const accepted = await store.accept(messageInput('resume delivery', 'resume-delivery'));
    const gate = blockFirstTargetBatch();
    const requestIds: string[] = [];
    const originalCall = runtime.call.bind(runtime);
    runtime.call = (method, payload, options) => {
      if (method === THREAD_MAILBOX_RUNTIME_METHODS.claim) requestIds.push(options?.requestId ?? '');
      return originalCall(method, payload, options);
    };
    const internal = threadStore as unknown as RuntimeMailboxCaller;
    const originalClaimNext = threadStore.claimNext.bind(threadStore);
    const interruption = new Error('claim interrupted');
    const controller = new AbortController();
    let claimAttempt = 0;
    threadStore.claimNext = async (input, options) => {
      const value = await internal.call(
        THREAD_MAILBOX_RUNTIME_METHODS.claim,
        input,
        {
          requestId: options?.requestId,
          signal: claimAttempt++ === 0 ? controller.signal : options?.signal,
        },
        500,
      );
      return value === null ? undefined : value as ThreadDeliveryClaim;
    };
    const target = agentHandle('agent-target');
    const lifecycle = lifecycleHarness([target.handle]);
    const service = new AgentCollaborationMessagingService(store, lifecycle.service, sessionContext(), metadataHarness({ 'agent-target': {} }));
    try {
      const interruptedRun = target.execution.hooks.onWillRun.run({ signal });
      await gate.entered;
      controller.abort(interruption);
      await expect(interruptedRun).rejects.toBe(interruption);
      const resumedRun = target.execution.hooks.onWillRun.run({ signal });
      await waitUntil(() => requestIds.length >= 2);
      gate.release();
      await resumedRun;
      expect(target.messages).toHaveLength(1);
      expect(target.messages[0]?.id).toBe(accepted.message.messageId);
      expect(new Set(requestIds.slice(0, 3))).toEqual(new Set([requestIds[0]]));
      expect(requestIds.length).toBeGreaterThanOrEqual(3);
    } finally {
      threadStore.claimNext = originalClaimNext;
      gate.restore();
      service.dispose();
    }
  });

  it('renders an external delegation sender distinctly at the next run boundary', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    const lifecycle = lifecycleHarness([target.handle]);
    const service = new AgentCollaborationMessagingService(store, lifecycle.service, sessionContext(), metadataHarness({ 'agent-target': {} }));

    await service.send({
      sourceAgentId: 'external:delegation_test',
      sourceTaskName: 'external',
      targetAgentId: 'agent-target',
      targetTaskName: 'target',
      content: 'review the update',
      idempotencyKey: 'external-message',
    });
    expect(target.messages).toEqual([]);

    await target.execution.hooks.onWillRun.run({ signal });

    expect(target.messages[0]?.content[0]).toEqual({
      type: 'text',
      text: 'Message from external agent "external" (external:delegation_test):\n\nreview the update',
    });
    service.dispose();
  });

  it('confirms a pending adapter ack before claiming again on the next run', async () => {
    const targetRef = {
      hostId: 'agent-collaboration-v2',
      workspaceId: 'session-1',
      sessionId: 'agent-target',
    };
    const claim: ThreadDeliveryClaim = {
      message: {
        messageId: 'pending-agent-ack',
        producer: {
          kind: 'peer_thread',
          source: { ...targetRef, sessionId: 'main' },
        },
        target: targetRef,
        content: JSON.stringify({
          v: 1,
          kind: 'agent_collaboration_message',
          sourceTaskName: 'root',
          targetTaskName: 'target',
          content: 'pending ack',
        }),
        idempotencyKey: 'pending-agent-ack',
        acceptedAt: 1,
        targetSeq: 1,
      },
      consumerId: 'agent-collaboration/session-1/agent-target',
      fence: 1,
      leaseUntil: Date.now() + 30_000,
      hostEpoch: 1,
    };
    const order: string[] = [];
    const ackRequestIds: string[] = [];
    let claimed = false;
    let ackCommitted = false;
    const threadStore = {
      _serviceBrand: undefined,
      claimNext: vi.fn<IThreadMailboxStore['claimNext']>(async () => {
        order.push('claim');
        if (claimed) return undefined;
        claimed = true;
        return claim;
      }),
      acknowledgeDelivery: vi.fn<IThreadMailboxStore['acknowledgeDelivery']>(async (_claim, options) => {
        ackRequestIds.push(options?.requestId ?? '');
        if (!ackCommitted) {
          ackCommitted = true;
          order.push('ack-committed');
          throw new HomeRuntimeError('runtime.connection_failed', 'ack response lost');
        }
        order.push('ack-confirmed');
        return true;
      }),
    } as unknown as IThreadMailboxStore;
    const adapter = new AgentCollaborationMessageStoreAdapter(threadStore);
    const target = agentHandle('agent-target');
    const lifecycle = lifecycleHarness([target.handle]);
    const service = new AgentCollaborationMessagingService(adapter, lifecycle.service, sessionContext(), metadataHarness({ 'agent-target': {} }));

    await expect(target.execution.hooks.onWillRun.run({ signal })).rejects.toMatchObject({
      code: 'runtime.connection_failed',
    });
    expect(target.messages).toHaveLength(1);
    expect(target.operations).toEqual(['appendObservable', 'flush']);

    await target.execution.hooks.onWillRun.run({ signal });
    expect(target.messages).toHaveLength(1);
    expect(target.operations).toEqual(['appendObservable', 'flush']);
    expect(order).toEqual(['claim', 'ack-committed', 'ack-confirmed', 'claim']);
    expect(ackRequestIds).toHaveLength(2);
    expect(new Set(ackRequestIds).size).toBe(1);
    service.dispose();
  });
});

describe('agent collaboration mailbox restart durability', () => {
  it('delivers queued messages FIFO after the service and store are rebuilt on the same home', async () => {
    const homeDir = tempDir();
    const firstStore = mailboxStore(homeDir);
    const firstService = new AgentCollaborationMessagingService(
      firstStore,
      lifecycleHarness([]).service,
      sessionContext(),
      metadataHarness({ 'agent-target': {} }),
    );
    const first = await firstService.send(sendInput('first', 'call-1'));
    const second = await firstService.send(sendInput('second', 'call-2'));
    firstService.dispose();

    const reopened = mailboxStore(homeDir);
    const target = agentHandle('agent-target');
    const lifecycle = lifecycleHarness([target.handle]);
    const service = new AgentCollaborationMessagingService(
      reopened,
      lifecycle.service,
      sessionContext(),
      metadataHarness({ 'agent-target': {} }),
    );

    await target.execution.hooks.onWillRun.run({ signal });

    expect(target.messages.map((message) => message.id)).toEqual([
      first.message.messageId,
      second.message.messageId,
    ]);
    expect(target.messages.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'Message from agent "root" (main):\n\nfirst' },
      { type: 'text', text: 'Message from agent "root" (main):\n\nsecond' },
    ]);
    expect(await reopened.nextQueued('session-1', 'agent-target')).toBeUndefined();
    expect(lifecycle.service.create).not.toHaveBeenCalled();
    service.dispose();
  });

  it('discards queued messages for agents missing from the session registry and records the skip', async () => {
    const homeDir = tempDir();
    const { adapter, thread } = rawMailbox(homeDir);
    const orphan = await adapter.accept(messageInput('orphan', 'orphan-1'));
    const kept = await adapter.accept({ ...messageInput('kept', 'kept-1'), targetAgentId: 'main' });
    const lifecycle = lifecycleHarness([]);
    const service = new AgentCollaborationMessagingService(
      adapter,
      lifecycle.service,
      sessionContext(),
      metadataHarness({ main: {} }),
    );

    await waitFor(async () =>
      !(await thread.listPendingTargets()).some((target) =>
        target.hostId === MAILBOX_HOST_ID &&
        target.workspaceId === 'session-1' &&
        target.sessionId === 'agent-target',
      ),
    );

    const keptQueued = await adapter.nextQueued('session-1', 'main');
    expect(keptQueued?.message.messageId).toBe(kept.message.messageId);
    const page = await thread.readActivity(
      { hostId: MAILBOX_HOST_ID, workspaceId: 'session-1', sessionId: 'agent-target' },
      0,
      10,
    );
    expect(page.activities).toEqual([
      expect.objectContaining({
        kind: 'message_undeliverable',
        messageId: orphan.message.messageId,
        reason: 'target agent is not registered in the session',
      }),
    ]);
    service.dispose();
  });

  it('never discards queued messages for the main agent', async () => {
    const homeDir = tempDir();
    const { adapter, thread } = rawMailbox(homeDir);
    await adapter.accept(messageInput('orphan', 'orphan-2'));
    const mainMessage = await adapter.accept({
      ...messageInput('for main', 'main-1'),
      targetAgentId: 'main',
    });
    const service = new AgentCollaborationMessagingService(
      adapter,
      lifecycleHarness([]).service,
      sessionContext(),
      metadataHarness({}),
    );

    await waitFor(async () =>
      !(await thread.listPendingTargets()).some((target) =>
        target.hostId === MAILBOX_HOST_ID &&
        target.workspaceId === 'session-1' &&
        target.sessionId === 'agent-target',
      ),
    );

    const queued = await adapter.nextQueued('session-1', 'main');
    expect(queued?.message.messageId).toBe(mainMessage.message.messageId);
    service.dispose();
  });

  it('keeps queued messages while the session metadata document is created by this load', async () => {
    const homeDir = tempDir();
    const { adapter, thread } = rawMailbox(homeDir);
    const orphan = await adapter.accept(messageInput('orphan', 'fresh-1'));
    const target = { hostId: MAILBOX_HOST_ID, workspaceId: 'session-1', sessionId: 'agent-target' };
    let swept!: () => void;
    const sweepChecked = new Promise<void>((resolve) => {
      swept = resolve;
    });
    const fresh = new AgentCollaborationMessagingService(
      adapter,
      lifecycleHarness([]).service,
      sessionContext(),
      metadataHarness({}, { createdByLoad: true, onCreatedByLoad: swept }),
    );

    await sweepChecked;
    await drain();

    expect(await pendingAgentIds(thread)).toEqual(['agent-target']);

    const existing = new AgentCollaborationMessagingService(
      adapter,
      lifecycleHarness([]).service,
      sessionContext(),
      metadataHarness({}),
    );
    await waitFor(async () => !(await pendingAgentIds(thread)).includes('agent-target'));
    const page = await thread.readActivity(target, 0, 10);
    expect(page.activities).toEqual([
      expect.objectContaining({
        kind: 'message_undeliverable',
        messageId: orphan.message.messageId,
        reason: 'target agent is not registered in the session',
      }),
    ]);
    fresh.dispose();
    existing.dispose();
  });

  it('re-reads the agent registry per pending target so a late registration is not discarded', async () => {
    const homeDir = tempDir();
    const { adapter, thread } = rawMailbox(homeDir);
    await adapter.accept(messageInput('late', 'late-1'));
    await adapter.accept({ ...messageInput('gone', 'gone-1'), targetAgentId: 'agent-ghost' });
    let registry: Readonly<Record<string, AgentMeta>> = {};
    const service = new AgentCollaborationMessagingService(
      wrapStore(adapter, {
        listPendingAgents: async (sessionId) => {
          registry = { 'agent-target': {} };
          return adapter.listPendingAgents(sessionId);
        },
      }),
      lifecycleHarness([]).service,
      sessionContext(),
      metadataHarness(() => registry),
    );

    await waitFor(async () => !(await pendingAgentIds(thread)).includes('agent-ghost'));

    expect(await pendingAgentIds(thread)).toEqual(['agent-target']);
    service.dispose();
  });
});

describe('agent collaboration mailbox lifecycle cleanup', () => {
  it('keeps mailbox messages when a session is archived so a restored session still delivers them', async () => {
    const homeDir = tempDir();
    const { adapter } = rawMailbox(homeDir);
    const archivedEmitter = new Emitter<SessionArchivedEvent>();
    const sessions = {
      _serviceBrand: undefined,
      onDidArchiveSession: archivedEmitter.event,
      onDidDeleteSession: Event.None,
    } as unknown as ISessionManager;
    const discardPending = vi.fn(wrapStore(adapter).discardPending);
    const cleanup = new AgentCollaborationMailboxCleanup(
      sessions,
      wrapStore(adapter, { discardPending }),
    );
    const accepted = await adapter.accept(messageInput('survives archive', 'archive-1'));

    archivedEmitter.fire({ sessionId: 'session-1' });
    await drain();

    expect(discardPending).not.toHaveBeenCalled();
    const target = agentHandle('agent-target');
    const service = new AgentCollaborationMessagingService(
      adapter,
      lifecycleHarness([target.handle]).service,
      sessionContext(),
      metadataHarness({ 'agent-target': {} }),
    );
    await target.execution.hooks.onWillRun.run({ signal });

    expect(target.messages.map((message) => message.id)).toEqual([accepted.message.messageId]);
    expect(await adapter.nextQueued('session-1', 'agent-target')).toBeUndefined();
    cleanup.dispose();
    service.dispose();
  });

  it('discards mailbox messages and records the skip when the session is deleted', async () => {
    const homeDir = tempDir();
    const { adapter, thread } = rawMailbox(homeDir);
    const deletedEmitter = new Emitter<SessionDeletedEvent>();
    const sessions = {
      _serviceBrand: undefined,
      onDidArchiveSession: Event.None,
      onDidDeleteSession: deletedEmitter.event,
    } as unknown as ISessionManager;
    const cleanup = new AgentCollaborationMailboxCleanup(sessions, adapter);
    const accepted = await adapter.accept(messageInput('dropped', 'delete-1'));

    deletedEmitter.fire({ sessionId: 'session-1' });
    await waitFor(async () =>
      !(await thread.listPendingTargets()).some((target) =>
        target.hostId === MAILBOX_HOST_ID && target.workspaceId === 'session-1',
      ),
    );

    const page = await thread.readActivity(
      { hostId: MAILBOX_HOST_ID, workspaceId: 'session-1', sessionId: 'agent-target' },
      0,
      10,
    );
    expect(page.activities).toEqual([
      expect.objectContaining({
        kind: 'message_undeliverable',
        messageId: accepted.message.messageId,
        reason: 'session deleted',
      }),
    ]);
    cleanup.dispose();
  });

  it('only discards agent-collaboration messages of the named session', async () => {
    const homeDir = tempDir();
    const { adapter, thread } = rawMailbox(homeDir);
    await adapter.accept(messageInput('one', 'filter-1'));
    await adapter.accept(messageInput('two', 'filter-2'));
    const other = await adapter.accept({ ...messageInput('other', 'filter-3'), sessionId: 'session-2' });
    const threadTarget = {
      hostId: 'device-host',
      workspaceId: 'session-1',
      sessionId: 'agent-target',
    };
    const threadMessage = await thread.acceptMessage({
      producer: { kind: 'external_client' },
      target: threadTarget,
      content: 'thread message',
      idempotencyKey: 'thread-1',
    });

    expect(await adapter.listPendingAgents('session-1')).toEqual(['agent-target']);
    await expect(adapter.discardPending({
      sessionId: 'session-1',
      agentIds: ['agent-target'],
      reason: 'test discard',
    })).resolves.toEqual({ discarded: 2 });

    expect(await adapter.nextQueued('session-1', 'agent-target')).toBeUndefined();
    const otherQueued = await adapter.nextQueued('session-2', 'agent-target');
    expect(otherQueued?.message.messageId).toBe(other.message.messageId);
    const threadClaim = await thread.claimNext({
      target: threadTarget,
      consumerId: 'thread-communication/test',
      leaseMs: 30_000,
    });
    expect(threadClaim?.message.messageId).toBe(threadMessage.message.messageId);
  });

  it('reuses the per-target cleanup claim request id after a committed claim response is lost', async () => {
    const target = {
      hostId: MAILBOX_HOST_ID,
      workspaceId: 'session-1',
      sessionId: 'agent-target',
    };
    const claim: ThreadDeliveryClaim = {
      message: {
        messageId: 'cleanup-claim',
        producer: { kind: 'peer_thread', source: { ...target, sessionId: 'main' } },
        target,
        content: JSON.stringify({
          v: 1,
          kind: 'agent_collaboration_message',
          sourceTaskName: 'root',
          targetTaskName: 'target',
          content: 'cleanup retry',
        }),
        idempotencyKey: 'cleanup-claim',
        acceptedAt: 1,
        targetSeq: 1,
      },
      consumerId: 'agent-collaboration-cleanup/session-1/agent-target',
      fence: 1,
      leaseUntil: Date.now() + 30_000,
      hostEpoch: 1,
    };
    const requestIds: string[] = [];
    let committed: string | undefined;
    const markUndeliverable = vi.fn<IThreadMailboxStore['markUndeliverable']>(async () => true);
    const threadStore = {
      _serviceBrand: undefined,
      listPendingTargets: async () => [target],
      claimNext: vi.fn<IThreadMailboxStore['claimNext']>(async (_input, options) => {
        const requestId = options?.requestId ?? '';
        requestIds.push(requestId);
        if (committed === undefined) {
          committed = requestId;
          throw new HomeRuntimeError('runtime.connection_failed', 'simulated committed claim response loss');
        }
        return requestId === committed ? claim : undefined;
      }),
      markUndeliverable,
      appendActivity: vi.fn<IThreadMailboxStore['appendActivity']>(async (input) => ({
        seq: 1,
        epoch: 'epoch',
        kind: input.kind,
        at: Date.now(),
        reason: input.reason,
      })),
    } as unknown as IThreadMailboxStore;
    const adapter = new AgentCollaborationMessageStoreAdapter(threadStore);
    const discard = () => adapter.discardPending({
      sessionId: 'session-1',
      agentIds: ['agent-target'],
      reason: 'test cleanup',
    });

    await expect(discard()).rejects.toMatchObject({ code: 'runtime.connection_failed' });
    await expect(discard()).resolves.toEqual({ discarded: 1 });

    expect(requestIds[0]).toBe(requestIds[1]);
    expect(markUndeliverable).toHaveBeenCalledTimes(1);
  });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function pendingAgentIds(thread: RuntimeThreadMailboxStore, sessionId = 'session-1'): Promise<string[]> {
  return (await thread.listPendingTargets())
    .filter((target) => target.hostId === MAILBOX_HOST_ID && target.workspaceId === sessionId)
    .map((target) => target.sessionId)
    .toSorted();
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function blockFirstTargetBatch(): {
  readonly entered: Promise<void>;
  readonly release: () => void;
  readonly restore: () => void;
} {
  const original = ClusterDb.prototype.partitionBatch;
  let markEntered!: () => void;
  let releaseBatch!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseBatch = resolve;
  });
  let blockedOnce = false;
  ClusterDb.prototype.partitionBatch = async function (...args: Parameters<typeof original>) {
    const [partition] = args;
    if (!blockedOnce && partition.startsWith('t/')) {
      blockedOnce = true;
      markEntered();
      await blocked;
    }
    return original.apply(this, args);
  };
  return {
    entered,
    release: releaseBatch,
    restore: () => {
      releaseBatch();
      ClusterDb.prototype.partitionBatch = original;
    },
  };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-message-mailbox-'));
  tempDirs.push(dir);
  return dir;
}

function mailboxStore(homeDir: string): AgentCollaborationMessageStoreAdapter {
  return rawMailbox(homeDir).adapter;
}

function rawMailbox(homeDir: string): {
  readonly adapter: AgentCollaborationMessageStoreAdapter;
  readonly thread: RuntimeThreadMailboxStore;
} {
  const seed = bootstrap(homeDir);
  const runtime = new HomeRuntimeHostService(seed);
  const thread = new RuntimeThreadMailboxStore(seed, runtime, new HostFileSystem());
  runtimeMailboxes.push({ runtime, store: thread });
  return { adapter: new AgentCollaborationMessageStoreAdapter(thread), thread };
}

function bootstrap(homeDir: string): IBootstrapService {
  return {
    _serviceBrand: undefined,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    osHomeDir: tmpdir(),
    homeDir,
    configPath: join(homeDir, 'config.toml'),
    configReadOnly: false,
    userAgentProfileHomeDir: homeDir,
    modelAccountHomeDir: homeDir,
    configKey: 'config.toml',
    clientIdentity: { productName: 'test', version: '0', platform: 'test' },
    args: { requestHeaders: {} },
    sessionsDir: join(homeDir, 'sessions'),
    blobsDir: join(homeDir, 'blobs'),
    storeDir: join(homeDir, 'store'),
    cacheDir: join(homeDir, 'cache'),
    logsDir: join(homeDir, 'logs'),
    getEnv: () => undefined,
    scope: (name) => name,
  };
}

function messageInput(content: string, idempotencyKey: string) {
  return {
    sessionId: 'session-1',
    sourceAgentId: 'main',
    sourceTaskName: 'root',
    targetAgentId: 'agent-target',
    targetTaskName: 'target',
    content,
    idempotencyKey,
  };
}

function sendInput(content: string, idempotencyKey: string) {
  return {
    sourceAgentId: 'main',
    sourceTaskName: 'root',
    targetAgentId: 'agent-target',
    targetTaskName: 'target',
    content,
    idempotencyKey,
  };
}

function sessionContext(): ISessionContext {
  return {
    _serviceBrand: undefined,
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    sessionDir: 'session-dir',
    metaScope: 'session/scope',
    cwd: 'cwd',
    scope: (subKey) => subKey === undefined ? 'session/scope' : `session/scope/${subKey}`,
  };
}

function metadataHarness(
  agents: Readonly<Record<string, AgentMeta>> | (() => Readonly<Record<string, AgentMeta>>),
  options: {
    readonly createdByLoad?: boolean;
    readonly onCreatedByLoad?: () => void;
  } = {},
): ISessionMetadata {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    read: async () => ({
      id: 'session-1',
      createdAt: 0,
      updatedAt: 0,
      archived: false,
      agents: typeof agents === 'function' ? agents() : agents,
    }),
    createdByLoad: () => {
      options.onCreatedByLoad?.();
      return options.createdByLoad ?? false;
    },
  } as unknown as ISessionMetadata;
}

function wrapStore(
  adapter: AgentCollaborationMessageStoreAdapter,
  overrides: Partial<IAgentCollaborationMessageStore> = {},
): IAgentCollaborationMessageStore {
  return {
    _serviceBrand: undefined,
    accept: (input) => adapter.accept(input),
    nextQueued: (sessionId, agentId) => adapter.nextQueued(sessionId, agentId),
    markDelivered: (claim) => adapter.markDelivered(claim),
    listPendingAgents: (sessionId) => adapter.listPendingAgents(sessionId),
    discardPending: (input) => adapter.discardPending(input),
    ...overrides,
  };
}

async function drain(ticks = 25): Promise<void> {
  for (let index = 0; index < ticks; index++) await Promise.resolve();
}

function lifecycleHarness(initial: readonly IAgentScopeHandle[]) {
  const handles = new Map(initial.map((handle) => [handle.id, handle]));
  const onDidCreate = new Emitter<IAgentScopeHandle>();
  const service: AgentLifecycle & { create: ReturnType<typeof vi.fn> } = {
    _serviceBrand: undefined,
    onWillCreate: Event.None as AgentLifecycle['onWillCreate'],
    onDidCreate: onDidCreate.event,
    onDidDispose: Event.None as AgentLifecycle['onDidDispose'],
    create: vi.fn(async () => { throw new Error('unexpected wake'); }),
    commitCreate: () => { throw new Error('unexpected commit'); },
    discard: async () => { throw new Error('unexpected discard'); },
    fork: vi.fn(async () => { throw new Error('unexpected fork'); }),
    get: (agentId) => handles.get(agentId),
    list: () => [...handles.values()],
    broadcastPermissionMode: () => {},
    countPendingBackgroundTasks: () => {
      throw new Error('unexpected count pending background tasks');
    },
    drainBackgroundTasks: async () => {
      throw new Error('unexpected drain background tasks');
    },
    remove: async () => {},
  };
  return {
    service,
    add(target: IAgentScopeHandle) {
      handles.set(target.id, target);
      onDidCreate.fire(target);
    },
  };
}

function agentHandle(agentId: string) {
  const messages: ContextMessage[] = [];
  const operations: string[] = [];
  const memory: AgentContextMemory = {
    _serviceBrand: undefined,
    get: () => messages,
    append: (...added) => { operations.push('append'); messages.push(...added); },
    appendObservable: (message) => { operations.push('appendObservable'); messages.push(message); },
    appendLoopEvent: () => {},
    publishTrailingRemoval: () => false,
    clear: () => {},
    undo: () => { throw new Error('unexpected undo'); },
    applyCompaction: () => { throw new Error('unexpected compaction'); },
  };
  const execution = {
    _serviceBrand: undefined,
    run: async () => { throw new Error('unexpected run'); },
    status: () => ({ state: 'idle' as const }),
    cancel: () => false,
    settled: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    hooks: createHooks(['onWillRun']),
  } as AgentExecution;
  const wire = {
    _serviceBrand: undefined,
    flush: async () => { operations.push('flush'); },
  } as unknown as Wire;
  const handle: IAgentScopeHandle = {
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor: {
      get<T>(id: unknown): T {
        if (id === IAgentContextMemoryService) return memory as T;
        if (id === IAgentExecutionService) return execution as T;
        if (id === IWireService) return wire as T;
        if (id === IAgentLifecycleService) return undefined as T;
        throw new Error('unexpected agent service');
      },
    },
    dispose: () => {},
  };
  return { handle, execution, messages, operations };
}
