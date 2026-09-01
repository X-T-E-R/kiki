import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Event, Emitter } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { HomeRuntimeError } from '#/app/runtimeHost/errors';
import { HomeRuntimeHostService } from '#/app/runtimeHost/runtimeHostService';
import { RuntimeThreadMailboxStore } from '#/app/threadCommunication/runtimeThreadMailboxStore';
import { ThreadMailboxBacklogError } from '#/app/threadCommunication/mailboxErrors';
import type {
  IThreadMailboxStore,
  ThreadDeliveryClaim,
} from '#/app/threadCommunication/threadMailboxStore';
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
import { AgentCollaborationMessageStoreAdapter } from '#/session/agentCollaboration/threadMailboxAdapter';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IWireService, type IWireService as Wire } from '#/wire/wire';

const signal = new AbortController().signal;
const tempDirs: string[] = [];
const runtimeMailboxes: Array<{
  readonly runtime: HomeRuntimeHostService;
  readonly store: RuntimeThreadMailboxStore;
}> = [];

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
    const service = new AgentCollaborationMessagingService(store, lifecycle.service, sessionContext());
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
    expect(target.operations).toEqual(['append', 'flush', 'append', 'flush']);
    expect(lifecycle.service.create).not.toHaveBeenCalled();
    service.dispose();
  });

  it('renders an external delegation sender distinctly at the next run boundary', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    const lifecycle = lifecycleHarness([target.handle]);
    const service = new AgentCollaborationMessagingService(store, lifecycle.service, sessionContext());

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
    const service = new AgentCollaborationMessagingService(adapter, lifecycle.service, sessionContext());

    await expect(target.execution.hooks.onWillRun.run({ signal })).rejects.toMatchObject({
      code: 'runtime.connection_failed',
    });
    expect(target.messages).toHaveLength(1);
    expect(target.operations).toEqual(['append', 'flush']);

    await target.execution.hooks.onWillRun.run({ signal });
    expect(target.messages).toHaveLength(1);
    expect(target.operations).toEqual(['append', 'flush']);
    expect(order).toEqual(['claim', 'ack-committed', 'ack-confirmed', 'claim']);
    expect(ackRequestIds).toHaveLength(2);
    expect(new Set(ackRequestIds).size).toBe(1);
    service.dispose();
  });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-message-mailbox-'));
  tempDirs.push(dir);
  return dir;
}

function mailboxStore(homeDir: string): AgentCollaborationMessageStoreAdapter {
  const seed = bootstrap(homeDir);
  const runtime = new HomeRuntimeHostService(seed);
  const store = new RuntimeThreadMailboxStore(seed, runtime, new HostFileSystem());
  runtimeMailboxes.push({ runtime, store });
  return new AgentCollaborationMessageStoreAdapter(store);
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

function lifecycleHarness(initial: readonly IAgentScopeHandle[]) {
  const handles = new Map(initial.map((handle) => [handle.id, handle]));
  const onDidCreate = new Emitter<IAgentScopeHandle>();
  const service: AgentLifecycle & { create: ReturnType<typeof vi.fn> } = {
    _serviceBrand: undefined,
    onWillCreate: Event.None as AgentLifecycle['onWillCreate'],
    onDidCreate: onDidCreate.event,
    onDidDispose: Event.None as AgentLifecycle['onDidDispose'],
    create: vi.fn(async () => { throw new Error('unexpected wake'); }),
    fork: vi.fn(async () => { throw new Error('unexpected fork'); }),
    get: (agentId) => handles.get(agentId),
    list: () => [...handles.values()],
    broadcastPermissionMode: () => {},
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
