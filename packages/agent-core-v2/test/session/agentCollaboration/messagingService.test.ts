import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AcpClientError } from '@kiki/acp-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readMailboxAuthority } from '#/persistence/backends/sqliteMailbox/authority';
import { CanonicalMailboxDatabase } from '#/persistence/backends/sqliteMailbox/database';
import { Event, Emitter } from '#/_base/event';
import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
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
import { createHooks } from '#/hooks';
import { IAgentContextMemoryService, type IAgentContextMemoryService as AgentContextMemory } from '#/agent/contextMemory/contextMemory';
import { computeUndoCut } from '#/agent/contextMemory/contextOps';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentModelSwitchService } from '#/agent/modelSwitch/modelSwitch';
import { IAgentStateService } from '#/agent/state/agentState';
import { agentMessageMaterializationsKey } from '#/session/agentCollaboration/messageReceiptState';
import {
  IAgentExecutionService,
  type AgentExecutionRunContext,
  type IAgentExecutionService as AgentExecution,
} from '#/agent/execution/execution';
import { IAgentLoopService, type IAgentLoopService as AgentLoop } from '#/agent/loop/loop';
import { executeTool } from '../../tools/fixtures/execute-tool';
import {
  IAgentLLMRequesterService,
  type AgentLLMRequestFinish,
} from '#/agent/llmRequester/llmRequester';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISubagentTool, SubagentToolInputSchema } from '#/agent/tools/agent/agent';
import { SubagentTool } from '#/agent/tools/agent/agentTool';
import { AgentSendTool } from '#/agent/tools/agent-send/agentSendTool';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IAgentLifecycleService, type IAgentLifecycleService as AgentLifecycle } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentCollaborationRegistry, COLLABORATION_LATEST_TASK_LABEL, COLLABORATION_TASK_NAME_LABEL } from '#/session/agentCollaboration/registry';
import {
  ISessionDispatchService,
  type DispatchChild,
  type DispatchRun,
} from '#/session/dispatch/dispatch';
import { SessionDispatchService } from '#/session/dispatch/dispatchService';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { AgentCollaborationMessagingService } from '#/session/agentCollaboration/messagingService';
import { AgentMessageMailboxFullError } from '#/session/agentCollaboration/messageMailbox';
import { IAgentCollaborationMessageStore, IAgentCollaborationMessagingService } from '#/session/agentCollaboration/messageMailbox';
import {
  AgentCollaborationMailboxCleanup,
  AgentCollaborationMessageStoreAdapter,
  MAILBOX_HOST_ID,
} from '#/session/agentCollaboration/threadMailboxAdapter';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { stubLog } from '../../_base/log/stubs';
import { Error2, ErrorCodes } from '#/errors';
import type { AgentRunRequest, RunAgentOptions } from '#/session/subagent/subagent';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService, type IWireService as Wire } from '#/wire/wire';
import { agentService, createTestAgent, InMemoryWireRecordPersistence } from '../../harness';
import { TurnPrompt, TurnSteer } from '#/agent/loop/turnOps';
import { PromptEnqueued, PromptLaunchCommitted } from '#/agent/prompt/promptService';
import { PromptOutcomeCommitted } from '#/agent/prompt/promptReplay';
import { IFileSystemStorageService, StorageError, StorageErrors } from '#/persistence/interface/storage';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

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

    const caught = await store.accept(messageInput('overflow', 'overflow')).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AgentMessageMailboxFullError);
    expect(caught).toMatchObject({ limit: 100_000 });
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
    expect(lstatSync(join(homeDir, 'store', 'agent-collaboration-mailbox-v2')).isFile()).toBe(true);
    expect(lstatSync(join(homeDir, 'store', 'thread-mailbox-v3')).isFile()).toBe(true);
    expect(await readMailboxAuthority(homeDir)).toMatchObject({ backend: 'sqlite' });
  });
});

describe('agent collaboration safe-boundary delivery', () => {
  it('keeps idle delivery queued when the sender does not request a wakeup', async () => {
    const store = mailboxStore(tempDir());
    const lifecycle = lifecycleHarness([]);
    const service = messagingService(store, lifecycle.service, sessionContext(), metadataHarness({ 'agent-target': {} }));
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
    await service.dispose();
  });

  it('forwards one queued external mailbox message into the next ordinary run before acknowledging it', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target', { executorId: 'fake-external' });
    const service = messagingService(
      store,
      lifecycleHarness([target.handle]).service,
      sessionContext(),
      metadataHarness({ 'agent-target': {} }),
    );

    await expect(service.send(sendInput('external backlog', 'external-backlog')))
      .resolves.toMatchObject({ delivery: 'queued' });
    expect(target.remoteRequests).toEqual([]);

    await target.execution.run(
      { kind: 'prompt', prompt: 'ordinary resume' },
      { signal },
    );

    expect(target.remoteRequests).toEqual([{
      kind: 'prompt',
      prompt: 'Message from agent "root" (main):\n\nexternal backlog\n\nordinary resume',
    }]);
    expect(target.messages).toContainEqual(expect.objectContaining({
      origin: expect.objectContaining({
        kind: 'agent_message',
        senderAgentId: 'main',
      }),
    }));
    expect(await store.nextQueued('session-1', 'agent-target')).toBeUndefined();
    await service.dispose();
  });

  it('consumes an external backlog of two saved messages on the same binding without a manual resume', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target', { executorId: 'fake-external' });
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch = dispatchHarness(async (child, request, options) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const started = target.execution.run(request as AgentRunRequest, { signal: options.signal }).finally(() => {
        inFlight -= 1;
      });
      return {
        child,
        request: request as DispatchRun['request'],
        started,
      };
    });
    const service = messagingService(
      store,
      lifecycleHarness([target.handle]).service,
      sessionContext(),
      metadataHarness({ 'agent-target': {} }),
      dispatch,
    );

    await expect(service.send(sendInput('older external mail', 'external-older')))
      .resolves.toMatchObject({ delivery: 'queued' });
    await expect(service.send({
      ...sendInput('newer external mail', 'external-newer'),
      idleWake: 'owned-child',
    })).resolves.toMatchObject({ delivery: 'delivered', resumed: true });

    expect(target.remoteRequests.map((request) => request.kind === 'mailbox' ? request.prompt : request)).toEqual([
      'Message from agent "root" (main):\n\nolder external mail',
      'Message from agent "root" (main):\n\nnewer external mail',
    ]);
    expect(maxInFlight).toBe(1);
    expect(await store.nextQueued('session-1', 'agent-target')).toBeUndefined();
    await service.dispose();
  });

  it('delivers external mail that arrives after prepare while that run is still starting', async () => {
    const store = mailboxStore(tempDir());
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    let markPrepared!: () => void;
    const prepared = new Promise<void>((resolve) => { markPrepared = resolve; });
    const target = agentHandle('agent-target', {
      executorId: 'fake-external',
      pauseAfterWillRun: async () => {
        markPrepared();
        await startGate;
        target.setRunning(false);
      },
    });
    const dispatch = dispatchHarness(async (child, request, options) => ({
      child,
      request: request as DispatchRun['request'],
      started: target.execution.run(request as AgentRunRequest, { signal: options.signal }),
    }));
    const service = messagingService(
      store,
      lifecycleHarness([target.handle]).service,
      sessionContext(),
      metadataHarness({ 'agent-target': {} }),
      dispatch,
    );

    const first = service.send({
      ...sendInput('first external mail', 'external-starting-first'),
      waitForRunningDelivery: false,
      idleWake: 'owned-child',
    });
    await prepared;
    const second = service.send({
      ...sendInput('second external mail', 'external-starting-second'),
      waitForRunningDelivery: false,
      idleWake: 'owned-child',
    });
    await vi.waitFor(() => { expect(target.remoteRequests).toHaveLength(1); });
    expect(dispatch.runOnExisting).toHaveBeenCalledTimes(1);
    releaseStart();
    await first;
    await second;
    await vi.waitFor(() => { expect(target.remoteRequests).toHaveLength(2); });
    expect(target.remoteRequests[0]).toMatchObject({
      kind: 'mailbox',
      prompt: 'Message from agent "root" (main):\n\nfirst external mail',
    });
    expect(target.remoteRequests[1]).toMatchObject({
      kind: 'mailbox',
      prompt: 'Message from agent "root" (main):\n\nsecond external mail',
    });
    expect(await store.nextQueued('session-1', 'agent-target')).toBeUndefined();
    expect(dispatch.runOnExisting).toHaveBeenCalledTimes(2);
    await service.dispose();
  });

  it.each(['fail', 'cancel'] as const)(
    'releases the next external message when a prepared start %s before afterStart',
    async (mode) => {
      const store = mailboxStore(tempDir());
      let markPrepared!: () => void;
      const prepared = new Promise<void>((resolve) => { markPrepared = resolve; });
      const target = agentHandle('agent-target', {
        executorId: 'codex-acp',
        holdAfterPrepare: true,
        onPrepareHeld: () => { markPrepared(); },
      });
      const lifecycle = lifecycleHarness([target.handle]);
      const residency = residencyHarness(lifecycle.service);
      const dispatch = dispatchHarness(async (child, request, options) => ({
        child,
        request: request as DispatchRun['request'],
        started: target.execution.run(request as AgentRunRequest, { signal: options.signal }),
      }));
      const service = messagingService(
        store,
        lifecycle.service,
        sessionContext(),
        metadataHarness({ 'agent-target': {} }),
        dispatch,
        residency.manager,
      );
      const settled = vi.spyOn(target.execution, 'settled');
      const first = service.send({
        ...sendInput('message A', 'external-start-a'),
        waitForRunningDelivery: false,
        idleWake: 'owned-child',
      });
      await prepared;
      await first;
      const second = service.send({
        ...sendInput('message B', 'external-start-b'),
        waitForRunningDelivery: false,
        idleWake: 'owned-child',
      });
      await vi.waitFor(() => { expect(residency.pins()).toBe(2); });
      await vi.waitFor(() => { expect(settled).toHaveBeenCalled(); });
      expect(target.execution.status().state).toBe('starting');
      expect((await store.accept(messageInput('message A', 'external-start-a'))).delivery).toBe('queued');
      expect((await store.accept(messageInput('message B', 'external-start-b'))).delivery).toBe('queued');

      if (mode === 'fail') {
        target.failHeldStart(new AcpClientError(
          'executor.session_open_failed',
          'The requested external session cannot be resumed or loaded',
        ));
      } else {
        target.cancelHeldStart();
      }

      await vi.waitFor(() => { expect(residency.pins()).toBe(0); });
      expect((await store.accept(messageInput('message A', 'external-start-a'))).delivery).toBe('delivered');
      expect((await store.accept(messageInput('message B', 'external-start-b'))).delivery).toBe('delivered');
      expect(await store.nextQueued('session-1', 'agent-target')).toBeUndefined();
      expect(target.execution.status().state).toBe('idle');
      await second;
      await service.dispose();
    },
  );

  it('continues a saved message after another child releases dispatch capacity', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    const holder = agentHandle('holder');
    holder.setRunning(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(holder.execution, 'settled').mockImplementation(() => gate.then(() => {
      holder.setRunning(false);
    }));
    const limit = new Error2(
      ErrorCodes.DISPATCH_LIMIT_EXCEEDED,
      'Subagent direct limit reached (1/1). No agent was started; wait for an active run to finish before dispatching again.',
      { details: { layer: 'direct', current: 1, limit: 1, owner: 'main' } },
    );
    let attempts = 0;
    const dispatch = dispatchHarness(async (child, request, options) => {
      attempts += 1;
      if (attempts === 1) throw limit;
      await target.execution.hooks.onWillRun.run({ signal: options.signal });
      return {
        child,
        request: request as DispatchRun['request'],
        started: Promise.resolve({
          agentId: child.agentId,
          turn: {} as never,
          completion: Promise.resolve({ summary: 'done' }),
        }),
      };
    });
    const service = messagingService(
      store,
      lifecycleHarness([target.handle, holder.handle]).service,
      sessionContext(),
      metadataHarness({ 'agent-target': {}, holder: {} }),
      dispatch,
    );
    const accepted = await service.send({
      ...sendInput('after capacity', 'capacity-release'),
      waitForRunningDelivery: false,
      idleWake: 'owned-child',
    });
    expect(accepted).toMatchObject({ delivery: 'queued' });
    expect(accepted.resumed).toBeUndefined();
    await vi.waitFor(() => { expect(attempts).toBe(1); });
    expect(target.messages).toEqual([]);
    release();
    await vi.waitFor(() => { expect(attempts).toBe(2); });
    await vi.waitFor(async () => {
      expect((await store.accept(messageInput('after capacity', 'capacity-release'))).delivery).toBe('delivered');
    });
    expect(target.messages).toHaveLength(1);
    await service.dispose();
  });

  it('retries dispatch when one of two holders finishes and the other stays running', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    const holderA = agentHandle('holder-a');
    const holderB = agentHandle('holder-b');
    const main = agentHandle('main', { dispatcher: { dispatch: async () => {} } });
    holderA.setRunning(true);
    holderB.setRunning(true);
    main.setRunning(true);
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    const mainSettled = vi.spyOn(main.execution, 'settled').mockImplementation(() => new Promise(() => {}));
    vi.spyOn(holderB.execution, 'settled').mockImplementation(() => new Promise(() => {}));
    vi.spyOn(holderA.execution, 'settled').mockImplementation(() => gateA.then(() => {
      holderA.setRunning(false);
    }));
    const limit = new Error2(
      ErrorCodes.DISPATCH_LIMIT_EXCEEDED,
      'Subagent direct limit reached (2/2). No agent was started; wait for an active run to finish before dispatching again.',
      { details: { layer: 'direct', current: 2, limit: 2, owner: 'main' } },
    );
    let attempts = 0;
    const dispatch = dispatchHarness(async (child, request, options) => {
      attempts += 1;
      if (attempts === 1) throw limit;
      await target.execution.hooks.onWillRun.run({ signal: options.signal });
      return {
        child,
        request: request as DispatchRun['request'],
        started: Promise.resolve({
          agentId: child.agentId,
          turn: {} as never,
          completion: Promise.resolve({ summary: 'done' }),
        }),
      };
    });
    const service = messagingService(
      store,
      lifecycleHarness([target.handle, holderA.handle, holderB.handle, main.handle]).service,
      sessionContext(),
      metadataHarness({ 'agent-target': {}, 'holder-a': {}, 'holder-b': {} }),
      dispatch,
    );
    const accepted = await service.send({
      ...sendInput('after one holder', 'two-holder-release'),
      waitForRunningDelivery: false,
      idleWake: 'owned-child',
    });
    expect(accepted).toMatchObject({ delivery: 'queued' });
    expect(accepted.resumed).toBeUndefined();
    await vi.waitFor(() => { expect(attempts).toBe(1); });
    expect(target.messages).toEqual([]);
    releaseA();
    await vi.waitFor(() => { expect(attempts).toBe(2); });
    expect(holderB.execution.status().state).toBe('running');
    expect(main.execution.status().state).toBe('running');
    expect(mainSettled).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      expect((await store.accept(messageInput('after one holder', 'two-holder-release'))).delivery).toBe('delivered');
    });
    expect(target.messages).toHaveLength(1);
    await service.dispose();
  });

  it('reports a dispatch limit, tells the sender to resume, and still delivers the original message when capacity returns', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    const log = stubLog();
    const warn = vi.spyOn(log, 'warn');
    const limit = new Error2(
      ErrorCodes.DISPATCH_LIMIT_EXCEEDED,
      'Subagent direct limit reached (1/1). No agent was started; wait for an active run to finish before dispatching again.',
      { details: { layer: 'direct', current: 1, limit: 1, owner: 'main' } },
    );
    let blocked = true;
    const dispatch = dispatchHarness(async (child, request, options) => {
      if (blocked) throw limit;
      await target.execution.hooks.onWillRun.run({ signal: options.signal });
      return {
        child,
        request: request as DispatchRun['request'],
        started: Promise.resolve({
          agentId: child.agentId,
          turn: {} as never,
          completion: Promise.resolve({ summary: 'done' }),
        }),
      };
    });
    const senderNotices: ContextMessage[] = [];
    const sender = agentHandle('main', {
      enqueued: senderNotices,
      dispatcher: { dispatch: async () => {} },
    });
    const lifecycle = lifecycleHarness([target.handle, sender.handle]);
    const service = messagingService(
      store,
      lifecycle.service,
      sessionContext(),
      metadataHarness({ 'agent-target': {}, main: {} }),
      dispatch,
      residencyHarness(lifecycle.service).manager,
      log,
    );
    const accepted = await service.send({
      ...sendInput('kept for retry', 'capacity-block'),
      waitForRunningDelivery: false,
      idleWake: 'owned-child',
    });
    expect(accepted).toMatchObject({ delivery: 'queued' });
    expect(accepted.resumed).toBeUndefined();
    await vi.waitFor(() => { expect(senderNotices.length).toBeGreaterThan(0); });
    const capacityNotice = noticeText(senderNotices.at(-1)!);
    expect(capacityNotice).toContain(accepted.message.messageId);
    expect(capacityNotice).toContain('agent-target');
    expect(capacityNotice).toContain('dispatch.limit_exceeded');
    expect(capacityNotice).toContain('AgentRun');
    expect(capacityNotice).toContain('empty string');
    expect(capacityNotice).toContain('Do not call AgentSend again');
    expect(capacityNotice).toContain('Do not set new_window');
    expect(capacityNotice).toContain('new remote session');
    expect(capacityNotice).not.toContain('idempotency');
    expect(warn).toHaveBeenCalled();
    const payload = warn.mock.calls.at(-1)?.[1] as { messageId: string; error: Error2 };
    expect(payload.messageId).toBe(accepted.message.messageId);
    expect(payload.error).toMatchObject({
      code: 'dispatch.limit_exceeded',
      message: 'Subagent direct limit reached (1/1). No agent was started; wait for an active run to finish before dispatching again.',
      details: { messageId: accepted.message.messageId, targetAgentId: 'agent-target', layer: 'direct', current: 1, limit: 1 },
    });
    expect((await store.accept(messageInput('kept for retry', 'capacity-block'))).delivery).toBe('queued');

    const synchronous = await service.send({
      ...sendInput('sync block', 'capacity-sync'),
      idleWake: 'owned-child',
    }).then(() => undefined, (error: unknown) => error);
    expect(synchronous).toMatchObject({
      code: 'dispatch.limit_exceeded',
      message: expect.stringContaining('No agent was started'),
      details: { targetAgentId: 'agent-target', layer: 'direct', limit: 1 },
    });
    const synchronousMessageId = (synchronous as Error2).details?.['messageId'];
    expect(synchronousMessageId).toEqual(expect.any(String));
    expect(synchronousMessageId).not.toBe(accepted.message.messageId);
    expect((await store.accept(messageInput('kept for retry', 'capacity-block'))).delivery).toBe('queued');
    expect((await store.accept(messageInput('sync block', 'capacity-sync'))).delivery).toBe('queued');

    blocked = false;
    await expect(service.send({
      ...sendInput('kept for retry', 'capacity-block'),
      idleWake: 'owned-child',
    })).resolves.toMatchObject({
      deduplicated: true,
      delivery: 'delivered',
      resumed: true,
      message: { messageId: accepted.message.messageId },
    });
    await service.dispose();
  });

  it('tells the AgentSend caller when an external resume fails, and an empty-prompt resume consumes the saved message', async () => {
    const senderCtx = createTestAgent();
    const source: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: { get: <T>(id: ServiceIdentifier<T>): T => senderCtx.get(id) },
      dispose: () => {},
    };
    const target = agentHandle('agent-target', { executorId: 'codex-acp' });
    const store = mailboxStore(tempDir());
    const resumeFailure = new AcpClientError(
      'executor.session_open_failed',
      'The requested external session cannot be resumed or loaded',
      { details: { resumeSupported: false, loadSupported: false } },
    );
    let opened = 0;
    const dispatch = dispatchHarness(async (child, request, options) => {
      opened += 1;
      let current = request as DispatchRun['request'];
      await child.agent.accessor.get(IAgentExecutionService).hooks.onWillRun.run({
        signal: options.signal,
        request: current,
        replaceRequest: (replacement) => { current = replacement; },
        afterStart: () => {},
      });
      const started = Promise.reject(resumeFailure);
      void started.catch(() => {});
      return { child, request: current, started };
    });
    const metadata = metadataHarness({
      main: { type: 'main' },
      'agent-target': {
        type: 'sub',
        delegator: { kind: 'agent', agentId: 'main' },
        executor: 'codex-acp',
        labels: { [COLLABORATION_TASK_NAME_LABEL]: 'researcher' },
      },
    });
    const service = messagingService(
      store,
      lifecycleHarness([source, target.handle]).service,
      sessionContext(),
      metadata,
      dispatch,
    );
    const tool = new AgentSendTool({ agentId: 'main' } as IAgentScopeContext, metadata, service);
    const saved = {
      sessionId: 'session-1',
      sourceAgentId: 'main',
      sourceTaskName: 'root',
      targetAgentId: 'agent-target',
      targetTaskName: 'researcher',
      content: 'continue the open session',
      idempotencyKey: 'toolu_resume_1',
    };
    senderCtx.mockNextResponse({ type: 'text', text: 'saw the blocked continuation' });
    try {
      const first = await executeTool(tool, {
        turnId: 0,
        toolCallId: 'toolu_resume_1',
        args: { target: 'researcher', message: 'continue the open session' },
        signal,
      });
      expect(first.isError).toBeFalsy();
      const queued = JSON.parse(toolOutput(first)) as {
        message_id: string;
        status: string;
        deduplicated: boolean;
        resumed?: boolean;
      };
      expect(queued).toMatchObject({ status: 'queued', deduplicated: false });
      expect(queued.resumed).toBeUndefined();
      await vi.waitFor(() => { expect(contextText(senderCtx)).toContain(queued.message_id); });
      const notice = contextText(senderCtx);
      expect(notice).toContain('agent-target');
      expect(notice).toContain('executor.session_open_failed');
      expect(notice).toContain('The requested external session cannot be resumed or loaded');
      expect(notice).toContain('Set resume to agent-target');
      expect(notice).toContain('empty string');
      expect(SubagentToolInputSchema.safeParse({
        resume: 'agent-target',
        prompt: '',
        description: 'resume saved message',
      }).success).toBe(true);
      expect(notice).toContain('Do not call AgentSend again');
      expect(notice).toContain('Do not set new_window');
      expect(notice).toContain('new remote session');
      expect(notice).not.toContain('idempotency');
      expect(opened).toBe(1);
      expect(target.remoteRequests).toEqual([]);
      expect((await store.accept(saved)).delivery).toBe('queued');

      await target.execution.run({ kind: 'prompt', prompt: '' }, { signal });
      expect(target.remoteRequests).toEqual([{
        kind: 'prompt',
        prompt: 'Message from agent "root" (main):\n\ncontinue the open session\n\n',
      }]);
      expect(await store.nextQueued('session-1', 'agent-target')).toBeUndefined();
      expect((await store.accept(saved)).delivery).toBe('delivered');
      expect(opened).toBe(1);
      await senderCtx.get(IAgentLoopService).settled();
    } finally {
      await service.dispose();
      await senderCtx.dispose();
    }
  });

  it('consumes the saved message once through AgentRun resume with an empty prompt', async () => {
    const senderCtx = createTestAgent();
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const target = agentHandle('agent-target', { executorId: 'codex-acp' });
    const agents: Record<string, AgentMeta> = {
      main: { type: 'main' },
      'agent-target': {
        type: 'sub',
        delegator: { kind: 'agent', agentId: 'main' },
        executor: 'codex-acp',
        labels: { [COLLABORATION_TASK_NAME_LABEL]: 'researcher' },
      },
    };
    const metadata: ISessionMetadata = {
      ...metadataHarness(() => agents),
      updateAgent: async (agentId, update) => {
        const current = agents[agentId];
        if (current !== undefined) agents[agentId] = update(current);
      },
    };
    let lifecycle!: AgentLifecycle;
    const main: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: {
        get: <T>(id: ServiceIdentifier<T>): T => {
          if (id === ISessionMetadata) return metadata as T;
          if (id === IAgentLifecycleService) return lifecycle as T;
          if (id === ISessionSubagentService) return ix.get(ISessionSubagentService) as T;
          return senderCtx.get(id);
        },
      },
      dispose: () => {},
    };
    lifecycle = lifecycleHarness([main, target.handle]).service;
    ix.stub(IAgentLifecycleService, lifecycle);
    ix.stub(ISessionMetadata, metadata);
    ix.stub(ISessionSubagentService, {
      hooks: createHooks(['onWillStartAgentTask']),
      notifyAgentTaskStopped: () => {},
      run: async (_agentId: string, request: AgentRunRequest, options: { signal: AbortSignal }) =>
        target.execution.run(request, { signal: options.signal }),
    });
    ix.stub(ISessionAgentProfileCatalog, {
      ready: Promise.resolve(),
      list: () => [],
      listRoutes: () => [],
      get: () => undefined,
    });
    ix.stub(IAgentCollaborationRegistry, { commit: () => {}, release: () => {} });
    ix.stub(IConfigService, { get: (() => undefined) as IConfigService['get'] });
    ix.stub(IModelCatalog, {});
    ix.stub(IModelService, {});
    ix.stub(ILogService, { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} });
    ix.stub(IAgentScopeContext, {
      _serviceBrand: undefined,
      agentId: 'main',
      scope: (key?: string) => `agent/main/${key ?? ''}`,
    });
    ix.stub(IAgentTaskService, senderCtx.get(IAgentTaskService));
    ix.stub(IAgentProfileService, senderCtx.get(IAgentProfileService));
    ix.stub(IAgentToolPolicyService, {
      isToolActive: () => true,
      isToolActiveForDisclosure: () => true,
      isToolActiveForProfile: () => true,
      setSessionDisabledTools: async () => {},
    });
    ix.stub(ISessionWorkspaceContext, { workDir: 'cwd' });
    ix.stub(IAgentRuntimeService, senderCtx.get(IAgentRuntimeService));
    ix.set(ISessionDispatchService, new SyncDescriptor(SessionDispatchService));
    ix.set(ISubagentTool, new SyncDescriptor(SubagentTool));
    const store = mailboxStore(tempDir());
    const service = messagingService(
      store,
      lifecycle,
      sessionContext(),
      metadata,
      ix.get(ISessionDispatchService),
    );
    try {
      const saved = await service.send({
        ...sendInput('saved body', 'saved-body'),
        waitForRunningDelivery: false,
      });
      expect(saved).toMatchObject({ delivery: 'queued' });
      expect(saved.resumed).toBeUndefined();
      expect(target.remoteRequests).toEqual([]);

      const result = await executeTool(ix.get(ISubagentTool), {
        turnId: 2,
        toolCallId: 'toolu_resume_empty',
        args: {
          resume: 'agent-target',
          prompt: '',
          description: 'resume saved message',
          background: true,
        },
        signal,
      });
      expect(result.isError).toBeFalsy();
      expect(target.remoteRequests).toEqual([{
        kind: 'prompt',
        prompt: 'Message from agent "root" (main):\n\nsaved body\n\n',
        promptId: 'resume-prompt:resume:main:2:toolu_resume_empty',
      }]);
      expect((await store.accept(messageInput('saved body', 'saved-body'))).delivery).toBe('delivered');
      expect(await store.nextQueued('session-1', 'agent-target')).toBeUndefined();
      expect(result.output).not.toContain('saved body');
    } finally {
      await service.dispose();
      await disposables.dispose();
      await senderCtx.dispose();
    }
  });

  it('notifies an external-client sender when resume cannot open, without a new session', async () => {
    const dispatched: Array<{ notificationType?: string; body?: string; sourceId?: string; sourceKind?: string }> = [];
    const senderNotices: ContextMessage[] = [];
    const sender = agentHandle('main', {
      enqueued: senderNotices,
      dispatcher: {
        dispatch: async (event: { notificationType?: string; body?: string; sourceId?: string; sourceKind?: string }) => {
          dispatched.push(event);
        },
      },
    });
    const target = agentHandle('agent-target', { executorId: 'codex-acp' });
    const store = mailboxStore(tempDir());
    const dispatch = dispatchHarness(async (child, request) => {
      const started = Promise.reject(new AcpClientError(
        'executor.session_open_failed',
        'The requested external session cannot be resumed or loaded',
        { details: { resumeSupported: false, loadSupported: false } },
      ));
      void started.catch(() => {});
      return { child, request: request as DispatchRun['request'], started };
    });
    const service = messagingService(
      store,
      lifecycleHarness([sender.handle, target.handle]).service,
      sessionContext(),
      metadataHarness(
        { main: { type: 'main' }, 'agent-target': { type: 'sub', executor: 'codex-acp' } },
        {
          custom: {
            externalClient: {
              connectionId: 'conn',
              clientName: 'grok',
              sessionRef: 'sess',
              driver: 'external',
            },
          },
        },
      ),
      dispatch,
    );
    try {
      const accepted = await service.send({
        ...sendInput('resume the external session', 'external-open-failed'),
        waitForRunningDelivery: false,
        idleWake: 'owned-child',
      });
      expect(accepted).toMatchObject({ delivery: 'queued' });
      await vi.waitFor(() => { expect(dispatched).toHaveLength(1); });
      expect(senderNotices).toEqual([]);
      expect(target.remoteRequests).toEqual([]);
      expect(dispatch.runOnExisting).toHaveBeenCalledOnce();
      expect(dispatched[0]).toMatchObject({
        notificationType: 'executor.session_open_failed',
        sourceKind: 'agent_message',
        sourceId: accepted.message.messageId,
      });
      expect(dispatched[0]?.body).toContain(accepted.message.messageId);
      expect(dispatched[0]?.body).toContain('agent-target');
      expect(dispatched[0]?.body).toContain('Set resume to agent-target');
      expect(dispatched[0]?.body).toContain('empty string');
      expect(dispatched[0]?.body).toContain('Do not call AgentSend again');
      expect(dispatched[0]?.body).toContain('Do not set new_window');
      expect(dispatched[0]?.body).toContain('new remote session');
      expect(dispatched[0]?.body).not.toContain('idempotency');
      expect((await store.accept(messageInput('resume the external session', 'external-open-failed'))).delivery).toBe('queued');
    } finally {
      await service.dispose();
    }
  });

  it.each(['claim', 'recipient-flush'] as const)(
    'settles a cancelled real turn during mailbox %s without late application, early ack or cancelling the next prompt', async (stage) => {
      const ctx = createTestAgent();
      const main: IAgentScopeHandle = {
        id: 'main', kind: LifecycleScope.Agent,
        accessor: { get: <T>(id: ServiceIdentifier<T>): T => ctx.get(id) }, dispose: () => {},
      };
      const adapter = mailboxStore(tempDir());
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let gated = false;
      const markDelivered = vi.fn((claim: ThreadDeliveryClaim) => adapter.markDelivered(claim));
      const store = wrapStore(adapter, {
        markDelivered,
        nextQueued: async (sessionId, agentId) => {
          const queued = await adapter.nextQueued(sessionId, agentId);
          if (stage === 'claim' && queued !== undefined && !gated) {
            gated = true;
            enter();
            await gate;
          }
          return queued;
        },
      });
      const messageId = (await adapter.accept({
        ...messageInput('queued update', `stop-${stage}`),
        sourceAgentId: 'agent-sender', sourceTaskName: 'sender', targetAgentId: 'main', targetTaskName: 'root',
      })).message.messageId;
      const materializations = () => ctx.context.get().filter((message) =>
        message.origin?.kind === 'agent_message' && message.origin.messageId === messageId);
      const flush = ctx.wire.flush.bind(ctx.wire);
      if (stage === 'recipient-flush') vi.spyOn(ctx.wire, 'flush').mockImplementation(async () => {
        await flush();
        if (!gated && materializations().length > 0) {
          gated = true;
          enter();
          await gate;
        }
      });
      const service = messagingService(store, lifecycleHarness([main]).service,
        sessionContext(), metadataHarness({ main: {} }));
      const controller = new AbortController();
      const prompt = ctx.get(IAgentPromptService);
      const first = await prompt.enqueue({ id: `first-${stage}`, signal: controller.signal,
        message: { role: 'user', content: [{ type: 'text', text: 'first' }], toolCalls: [], origin: { kind: 'user' } } });
      const turn = await first.launched;
      let terminal = false;
      void first.completion.then(() => { terminal = true; });
      try {
        await entered;
        const next = await prompt.enqueue({ id: `next-${stage}`,
          message: { role: 'user', content: [{ type: 'text', text: 'independent next prompt' }], toolCalls: [], origin: { kind: 'user' } } });
        ctx.mockNextResponse({ type: 'text', text: 'next prompt handled' });
        controller.abort(new Error('stop first run'));
        expect(turn!.signal.aborted).toBe(true);
        await vi.waitFor(() => { expect(terminal).toBe(true); });
        expect((await first.completion).state).toBe('cancelled');
        const nextTurn = await next.launched;
        expect(nextTurn!.id).not.toBe(turn!.id);
        expect(nextTurn!.signal.aborted).toBe(false);
        expect((await next.completion).state).toBe('completed');
        expect(materializations()).toHaveLength(stage === 'claim' ? 0 : 1);
        expect(markDelivered).not.toHaveBeenCalled();
        const pendingDelivery = (service as unknown as { deliveryTails: Map<string, Promise<void>> }).deliveryTails.get('main');
        expect(pendingDelivery).toBeDefined();
        release();
        await pendingDelivery;
        expect(materializations()).toHaveLength(stage === 'claim' ? 0 : 1);
        expect(markDelivered).toHaveBeenCalledTimes(stage === 'claim' ? 0 : 1);
        ctx.mockNextResponse({ type: 'text', text: 'message handled once' });
        const resumed = await ctx.get(IAgentExecutionService).run(
          { kind: 'prompt', prompt: 'after cancellation' }, { signal: new AbortController().signal });
        await resumed.completion;
        expect(materializations()).toHaveLength(1);
        expect(markDelivered).toHaveBeenCalledOnce();
        expect((await adapter.accept({
          ...messageInput('queued update', `stop-${stage}`),
          sourceAgentId: 'agent-sender', sourceTaskName: 'sender', targetAgentId: 'main', targetTaskName: 'root',
        })).delivery).toBe('delivered');
        await ctx.expectResumeMatches();
      } finally {
        release();
        await first.completion;
        await service.dispose();
        await ctx.dispose();
      }
    },
  );

  it('cancels native run admission waiting for a claim and retains that claim for the next run', async () => {
    const ctx = createTestAgent();
    const main: IAgentScopeHandle = {
      id: 'main', kind: LifecycleScope.Agent,
      accessor: { get: <T>(id: ServiceIdentifier<T>): T => ctx.get(id) }, dispose: () => {},
    };
    const adapter = mailboxStore(tempDir());
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let gated = false;
    const markDelivered = vi.fn((claim: ThreadDeliveryClaim) => adapter.markDelivered(claim));
    const store = wrapStore(adapter, {
      markDelivered,
      nextQueued: async (sessionId, agentId) => {
        const queued = await adapter.nextQueued(sessionId, agentId);
        if (queued !== undefined && !gated) { gated = true; enter(); await gate; }
        return queued;
      },
    });
    const input = { ...messageInput('admission update', 'cancel-run-admission'),
      sourceAgentId: 'agent-sender', targetAgentId: 'main', targetTaskName: 'root' };
    const messageId = (await adapter.accept(input)).message.messageId;
    const service = messagingService(store, lifecycleHarness([main]).service,
      sessionContext(), metadataHarness({ main: {} }));
    const controller = new AbortController();
    const execution = ctx.get(IAgentExecutionService);
    const admitted = execution.run({ kind: 'prompt', prompt: 'cancel before start' }, { signal: controller.signal });
    const cancelled = expect(admitted).rejects.toThrow('cancel admission');
    try {
      await entered;
      controller.abort(new Error('cancel admission'));
      await cancelled;
      expect(ctx.get(IAgentLoopService).status().state).toBe('idle');
      expect(markDelivered).not.toHaveBeenCalled();
      expect(ctx.context.get().some((message) => message.origin?.kind === 'agent_message')).toBe(false);
      const pendingDelivery = (service as unknown as { deliveryTails: Map<string, Promise<void>> }).deliveryTails.get('main');
      expect(pendingDelivery).toBeDefined();
      release();
      await pendingDelivery;
      expect(ctx.context.get().some((message) => message.origin?.kind === 'agent_message')).toBe(false);
      expect(markDelivered).not.toHaveBeenCalled();
      ctx.mockNextResponse({ type: 'text', text: 'handled after resume' });
      const resumed = await execution.run({ kind: 'prompt', prompt: 'new run' }, { signal: new AbortController().signal });
      await resumed.completion;
      expect(ctx.context.get().filter((message) => message.origin?.kind === 'agent_message' && message.origin.messageId === messageId)).toHaveLength(1);
      expect(markDelivered).toHaveBeenCalledOnce();
      expect((await adapter.accept(input)).delivery).toBe('delivered');
      await ctx.expectResumeMatches();
    } finally {
      release();
      await cancelled;
      await service.dispose();
      await ctx.dispose();
    }
  });

  it('delivers a queued child notification to main through a real interactive prompt turn', async () => {
    const ctx = createTestAgent();
    const main: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: {
        get: <T>(id: ServiceIdentifier<T>): T => ctx.get(id),
      },
      dispose: () => {},
    };
    const service = messagingService(
      mailboxStore(tempDir()),
      lifecycleHarness([main]).service,
      sessionContext(),
      metadataHarness({ main: {} }),
    );
    try {
      await service.send({
        sourceAgentId: 'agent-child',
        sourceTaskName: 'worker',
        targetAgentId: 'main',
        targetTaskName: 'root',
        content: 'parent update',
        idempotencyKey: 'notify-main',
      });
      ctx.mockNextResponse({ type: 'text', text: 'acknowledged' });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
      await ctx.get(IAgentLoopService).settled();

      expect(ctx.context.get()).toContainEqual(expect.objectContaining({
        origin: expect.objectContaining({
          kind: 'agent_message',
          senderAgentId: 'agent-child',
          senderTaskName: 'worker',
        }),
      }));
      expect(ctx.llmCalls.at(-1)?.history.some((message) =>
        message.role === 'user' && message.content.some((part) =>
          part.type === 'text' && part.text.includes('Message from agent "worker" (agent-child)'),
        ),
      )).toBe(true);
    } finally {
      await service.dispose();
      await ctx.dispose();
    }
  });

  it('starts a follow-up main turn when a running turn ends before another safe boundary', async () => {
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    let resolveFirst!: (value: AgentLLMRequestFinish) => void;
    const first = new Promise<AgentLLMRequestFinish>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    const response = (text: string): AgentLLMRequestFinish => ({
      message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
      usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
    });
    const requester: IAgentLLMRequesterService = {
      _serviceBrand: undefined,
      prepareTurnConfig: () => ({ thinkingEffort: 'off' }),
      invalidatePromptSnapshots: () => 0,
      armAnthropicResponseCapture: () => { throw new Error('response capture is unused in this fixture'); },
      anthropicResponseCaptureStatus: async () => null,
      stopAnthropicResponseCapture: () => { throw new Error('response capture is unused in this fixture'); },
      request: async () => {
        calls += 1;
        if (calls === 1) {
          resolveEntered();
          return first;
        }
        return response('follow-up handled');
      },
      start(overrides, onPart, requestSignal) {
        return {
          trace: { traceId: undefined },
          result: this.request(overrides, onPart, requestSignal),
        };
      },
    };
    const ctx = createTestAgent(agentService(IAgentLLMRequesterService, requester));
    const main: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: {
        get: <T>(id: ServiceIdentifier<T>): T => ctx.get(id),
      },
      dispose: () => {},
    };
    const dispatch = dispatchHarness(async (child, request, options) => ({
      child,
      request: request as DispatchRun['request'],
      started: child.agent.accessor.get(IAgentExecutionService).run(
        request as DispatchRun['request'],
        { signal: options.signal },
      ),
    }));
    const service = messagingService(
      mailboxStore(tempDir()),
      lifecycleHarness([main]).service,
      sessionContext(),
      metadataHarness({ main: {} }),
      dispatch,
    );
    try {
      const initial = ctx.rpc.prompt({ input: [{ type: 'text', text: 'finish without another step' }] });
      await entered;
      await service.send({
        sourceAgentId: 'agent-child',
        sourceTaskName: 'worker',
        targetAgentId: 'main',
        targetTaskName: 'root',
        content: 'follow up after this turn',
        idempotencyKey: 'notify-running-main',
        idleWake: 'parent',
      });

      resolveFirst(response('initial done'));
      await initial;
      await vi.waitFor(() => {
        expect(calls).toBe(2);
      });
      await ctx.get(IAgentLoopService).settled();
      expect(ctx.context.get()).toContainEqual(expect.objectContaining({
        origin: expect.objectContaining({
          kind: 'agent_message',
          senderAgentId: 'agent-child',
        }),
      }));
    } finally {
      resolveFirst(response('cleanup'));
      await service.dispose();
      await ctx.dispose();
    }
  });

  it('does not block a completion sender while an external main is busy with its native loop idle', async () => {
    const target = agentHandle('main', { executorId: 'grok-acp' });
    target.setRunning(true);
    const loop = target.handle.accessor.get(IAgentLoopService);
    vi.spyOn(loop, 'status').mockReturnValue({ state: 'idle', activeTurnId: undefined, pendingTurnIds: [], hasPendingRequests: false });
    let release!: () => void;
    const settled = new Promise<void>((resolve) => { release = resolve; });
    const observed = vi.spyOn(target.execution, 'settled').mockReturnValue(settled);
    const dispatch = dispatchHarness(async (child, request, options) => ({ child,
      request: request as DispatchRun['request'], started: target.execution.run(request as DispatchRun['request'], { signal: options.signal }) }));
    const service = messagingService(mailboxStore(tempDir()), lifecycleHarness([target.handle]).service,
      sessionContext(), metadataHarness({ main: { type: 'main', executor: 'grok-acp' } }), dispatch);
    try {
      const accepted = await service.send({ sourceAgentId: 'agent-child', sourceTaskName: 'worker', targetAgentId: 'main',
        targetTaskName: 'root', content: 'child completed', idempotencyKey: 'external-parent-completion', idleWake: 'parent' });
      expect(accepted.delivery).toBe('queued');
      await vi.waitFor(() => expect(observed).toHaveBeenCalledOnce());
      expect(target.remoteRequests).toEqual([]);
      target.setRunning(false);
      release();
      await vi.waitFor(() => expect(target.remoteRequests).toHaveLength(1));
      expect(target.remoteRequests[0]).toMatchObject({ kind: 'mailbox', prompt: expect.stringContaining('child completed') });
      expect(dispatch.recordDelegatedRun).not.toHaveBeenCalled();
    } finally { release(); await service.dispose(); }
  });

  it('does not wake an external-client main agent from mailbox idle-wake', async () => {
    const target = agentHandle('main');
    const dispatch = dispatchHarness();
    const service = messagingService(
      mailboxStore(tempDir()),
      lifecycleHarness([target.handle]).service,
      sessionContext(),
      metadataHarness({
        main: {
          type: 'main',
          ...({ custom: { externalClient: {
            connectionId: 'conn-1', clientName: 'Example Client', sessionRef: 'session-1', driver: 'external',
          } } } as unknown as AgentMeta),
        },
      }),
      dispatch,
    );
    try {
      const accepted = await service.send({
        sourceAgentId: 'agent-child',
        sourceTaskName: 'worker',
        targetAgentId: 'main',
        targetTaskName: 'root',
        content: 'external completion',
        idempotencyKey: 'external-main-idle-wake',
        idleWake: 'parent',
      });
      expect(accepted.delivery).toBe('queued');
      expect(dispatch.runOnExisting).not.toHaveBeenCalled();
      expect(target.remoteRequests).toEqual([]);
    } finally {
      await service.dispose();
    }
  });

  it('wakes an idle main agent and starts a real mailbox-triggered run', async () => {
    const ctx = createTestAgent();
    const main: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: {
        get: <T>(id: ServiceIdentifier<T>): T => ctx.get(id),
      },
      dispose: () => {},
    };
    const dispatch = dispatchHarness(async (child, request, options) => ({
      child,
      request: request as DispatchRun['request'],
      started: child.agent.accessor.get(IAgentExecutionService).run(
        request as DispatchRun['request'],
        { signal: options.signal },
      ),
    }));
    const service = messagingService(
      mailboxStore(tempDir()),
      lifecycleHarness([main]).service,
      sessionContext(),
      metadataHarness({ main: {} }),
      dispatch,
    );
    try {
      ctx.mockNextResponse({ type: 'text', text: 'parent handled update' });
      const accepted = await service.send({
        sourceAgentId: 'agent-child',
        sourceTaskName: 'worker',
        targetAgentId: 'main',
        targetTaskName: 'root',
        content: 'wake parent',
        idempotencyKey: 'wake-main',
        idleWake: 'parent',
      });

      expect(accepted.delivery).toBe('queued');
      await vi.waitFor(() => {
        expect(ctx.llmCalls).toHaveLength(1);
      });
      await ctx.get(IAgentLoopService).settled();
      expect(dispatch.runOnExisting).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'main' }),
        expect.objectContaining({ kind: 'mailbox' }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(dispatch.recordDelegatedRun).not.toHaveBeenCalled();
      expect(ctx.context.get()).toContainEqual(expect.objectContaining({
        origin: expect.objectContaining({ kind: 'agent_message', messageId: expect.any(String) }),
      }));
    } finally {
      await service.dispose();
      await ctx.dispose();
    }
  });

  it('notifies the parent after each AgentSend wakeup finishes under a distinct task id', async () => {
    const ctx = createTestAgent();
    const disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    const target = agentHandle('agent-target');
    const agents: Record<string, AgentMeta> = {
      main: { type: 'main' },
      'agent-target': {
        type: 'sub',
        parentAgentId: 'main',
        delegator: { kind: 'agent', agentId: 'main' },
        labels: {},
      },
    };
    const metadata: ISessionMetadata = {
      ...metadataHarness(() => agents),
      registerAgent: async (agentId, meta) => { agents[agentId] = meta; },
      updateAgent: async (agentId, update) => { if (agents[agentId] !== undefined) agents[agentId] = update(agents[agentId]); },
    };
    let lifecycle!: AgentLifecycle;
    const main: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: {
        get: <T>(id: ServiceIdentifier<T>): T => {
          if (id === ISessionMetadata) return metadata as T;
          if (id === IAgentLifecycleService) return lifecycle as T;
          if (id === ISessionSubagentService) return ix.get(ISessionSubagentService) as T;
          return ctx.get(id);
        },
      },
      dispose: () => {},
    };
    lifecycle = lifecycleHarness([main, target.handle]).service;
    const completions: Array<(summary: string) => void> = [];
    ix.stub(IAgentLifecycleService, lifecycle);
    ix.stub(ISessionMetadata, metadata);
    ix.stub(ISessionSubagentService, {
      run: async (agentId, _request, options) => {
        await target.execution.hooks.onWillRun.run({ signal: options.signal });
        return {
          agentId,
          turn: {} as never,
          completion: new Promise<{ summary: string }>((resolve) => {
            completions.push((summary) => { resolve({ summary }); });
          }),
        };
      },
      notifyAgentTaskStopped: () => {},
    });
    ix.stub(ISessionAgentProfileCatalog, {});
    ix.stub(IAgentCollaborationRegistry, {});
    ix.stub(IConfigService, { get: (() => undefined) as IConfigService['get'] });
    ix.stub(IModelCatalog, {});
    ix.stub(IModelService, {});
    ix.stub(ILogService, { warn: () => {} });
    ix.set(ISessionDispatchService, new SyncDescriptor(SessionDispatchService));
    const tasks = ctx.get(IAgentTaskService);
    const service = messagingService(
      mailboxStore(tempDir()),
      lifecycle,
      sessionContext(),
      metadata,
      ix.get(ISessionDispatchService),
    );
    try {
      const taskIds: string[] = [];
      for (const [index, text] of ['first update', 'second update'].entries()) {
        ctx.mockNextResponse({ type: 'text', text: `parent read ${String(index)}` });
        const accepted = await service.send({
          ...sendInput(text, `wake-${String(index)}`),
          idleWake: 'owned-child',
        });
        expect(accepted).toMatchObject({ delivery: 'delivered', resumed: true });
        const task = tasks.list(false).find((item) => item.kind === 'agent' && item.agentId === 'agent-target' && item.status === 'running');
        expect(task).toBeDefined();
        const taskId = task!.taskId;
        taskIds.push(taskId);
        expect(agents['agent-target']?.labels?.[COLLABORATION_LATEST_TASK_LABEL]).toBe(taskId);
        completions[index]!(`result ${String(index)}`);
        await tasks.wait(taskId, 1000);
        await vi.waitFor(() => {
          expect(ctx.context.get()).toContainEqual(expect.objectContaining({
            content: [expect.objectContaining({
              type: 'text',
              text: expect.stringContaining(`result ${String(index)}`),
            })],
            origin: expect.objectContaining({ kind: 'task', taskId, status: 'completed' }),
          }));
        });
        await ctx.get(IAgentLoopService).settled();
      }
      expect(new Set(taskIds).size).toBe(2);
      expect(ctx.llmCalls).toHaveLength(2);
    } finally {
      await service.dispose();
      await disposables.dispose();
      await ctx.dispose();
    }
  });

  it('resumes an idle live child through dispatch and delivers the mailbox message before the run', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    const lifecycle = lifecycleHarness([target.handle]);
    const runOnExisting: ISessionDispatchService['runOnExisting'] = async (child, request, options) => {
      expect(options.requesterAgentId).toBeUndefined();
      expect(request).toMatchObject({
        kind: 'mailbox',
        prompt: 'Message from agent "root" (main):\n\nwake now',
      });
      await target.execution.hooks.onWillRun.run({ signal: options.signal });
      return {
        child,
        request: request as DispatchRun['request'],
        started: Promise.resolve({
          agentId: child.agentId,
          turn: {} as never,
          completion: Promise.resolve({ summary: 'done' }),
        }),
      };
    };
    const dispatch = dispatchHarness(runOnExisting);
    const service = messagingService(
      store,
      lifecycle.service,
      sessionContext(),
      metadataHarness({ 'agent-target': {} }),
      dispatch,
    );

    const result = await service.send({
      ...sendInput('wake now', 'wake-idle'),
      idleWake: 'owned-child',
    });

    expect(result).toMatchObject({ delivery: 'delivered', resumed: true });
    expect(target.messages.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'Message from agent "root" (main):\n\nwake now' },
    ]);
    expect(dispatch.runOnExisting).toHaveBeenCalledTimes(1);
    expect(dispatch.recordDelegatedRun).toHaveBeenCalledWith('main', 'agent-target');
    await service.dispose();
  });

  it('recreates and resumes a cold idle child through the normal dispatch path', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    const lifecycle = lifecycleHarness([]);
    const child: DispatchChild = {
      agent: target.handle,
      agentId: 'agent-target',
      profileName: 'test',
      thinkingEffort: 'off',
      meta: { type: 'sub', delegator: { kind: 'agent', agentId: 'main' } },
    };
    const dispatch = dispatchHarness(
      async (_child, request, options) => {
        await target.execution.hooks.onWillRun.run({ signal: options.signal });
        return {
          child,
          request: request as DispatchRun['request'],
          started: Promise.resolve({
            agentId: child.agentId,
            turn: {} as never,
            completion: Promise.resolve({ summary: 'done' }),
          }),
        };
      },
      async (delegator, ref) => {
        expect(delegator).toEqual({ kind: 'agent', agentId: 'main' });
        expect(ref).toBe('agent-target');
        lifecycle.add(target.handle);
        return child;
      },
    );
    const service = messagingService(
      store,
      lifecycle.service,
      sessionContext(),
      metadataHarness({ 'agent-target': child.meta! }),
      dispatch,
    );

    const result = await service.send({
      ...sendInput('cold wake', 'cold-wake'),
      idleWake: 'owned-child',
    });

    expect(result).toMatchObject({ delivery: 'delivered', resumed: true });
    expect(dispatch.resolveOwnedChild).toHaveBeenCalledTimes(1);
    expect(dispatch.runOnExisting).toHaveBeenCalledTimes(1);
    expect(dispatch.recordDelegatedRun).toHaveBeenCalledWith('main', 'agent-target');
    await service.dispose();
  });

  it('delivers a user-authored mailbox message to a cold external child without entering the native loop', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target', { executorId: 'grok-acp' });
    const lifecycle = lifecycleHarness([]);
    const meta = { type: 'sub' as const, parentAgentId: 'main', displayName: 'external', executor: 'grok-acp' };
    const child: DispatchChild = {
      agent: target.handle, agentId: 'agent-target', profileName: 'external', thinkingEffort: 'off', meta,
    };
    const dispatch = dispatchHarness(
      async (_child, request, options) => ({
        child,
        request: request as AgentRunRequest,
        started: target.execution.run(request as AgentRunRequest, options),
      }),
      async (delegator, ref) => {
        expect(delegator).toEqual({ kind: 'agent', agentId: 'main' });
        expect(ref).toBe('agent-target');
        lifecycle.add(target.handle);
        return child;
      },
    );
    const service = messagingService(store, lifecycle.service, sessionContext(), metadataHarness({ 'agent-target': meta }), dispatch);
    const result = await service.sendUserMessage({ targetAgentId: 'agent-target', content: 'continue', idempotencyKey: 'user-message' });
    expect(result).toMatchObject({ delivery: 'delivered', resumed: true });
    expect(target.remoteRequests).toMatchObject([{ kind: 'mailbox', prompt: 'continue', message: { origin: { kind: 'user' } } }]);
    expect(target.messages).toMatchObject([{ role: 'user', content: [{ type: 'text', text: 'continue' }], origin: { kind: 'user' } }]);
    expect(dispatch.recordDelegatedRun).not.toHaveBeenCalled();
    await expect(service.sendUserMessage({ targetAgentId: 'agent-target', content: 'continue', idempotencyKey: 'user-message' }))
      .resolves.toMatchObject({ deduplicated: true, delivery: 'delivered' });
    await service.dispose();
  });

  it('rejects user-authored mailbox messages to native, main, and unknown agents before storage', async () => {
    const store = mailboxStore(tempDir());
    const service = messagingService(store, lifecycleHarness([]).service, sessionContext(), metadataHarness({
      native: { type: 'sub', parentAgentId: 'main', executor: 'native' },
      main: { type: 'main', executor: 'grok-acp' },
    }));
    for (const targetAgentId of ['native', 'main', 'missing']) {
      await expect(service.sendUserMessage({ targetAgentId, content: 'continue', idempotencyKey: targetAgentId }))
        .rejects.toMatchObject({ code: 'request.invalid' });
      expect(await store.nextQueued('session-1', targetAgentId)).toBeUndefined();
    }
    await service.dispose();
  });

  it('does not steer the external opening message while its acknowledgement is still pending', async () => {
    const store = mailboxStore(tempDir());
    let releaseRunning!: () => void;
    const running = new Promise<void>((resolve) => { releaseRunning = resolve; });
    const target = agentHandle('agent-target', {
      executorId: 'example-acp',
      acceptExternalSteer: true,
      pauseWhileRunning: () => running,
    });
    const dispatch = dispatchHarness(async (child, request, options) => ({
      child,
      request: request as AgentRunRequest,
      started: target.execution.run(request as AgentRunRequest, { signal: options.signal }),
    }));
    const service = messagingService(store, lifecycleHarness([target.handle]).service, sessionContext(),
      metadataHarness({ 'agent-target': { type: 'sub', parentAgentId: 'main', executor: 'example-acp' } }), dispatch);
    const first = service.send({
      ...sendInput('opening mail', 'external-opening'),
      waitForRunningDelivery: false,
      idleWake: 'owned-child',
    });
    await vi.waitFor(() => { expect(target.remoteRequests).toHaveLength(1); });
    const second = service.send({
      ...sendInput('later mail', 'external-later'),
      waitForRunningDelivery: false,
      idleWake: 'owned-child',
    });
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(target.steeredTexts()).toEqual([]);
    expect(target.remoteRequests).toHaveLength(1);
    releaseRunning();
    await first;
    await second;
    expect(target.steeredTexts().some((text) => text.includes('opening mail'))).toBe(false);
    expect(target.remoteRequests.filter((request) => request.kind !== 'retry' && request.prompt.includes('opening mail'))).toHaveLength(1);
    await service.dispose();
  });

  it('delivers mail when an external execution binding leaves delegation at the harness default', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target', {
      executorId: 'example-acp',
      allowKikiSubagents: false,
      delegationSource: 'harness-default',
    });
    const dispatch = dispatchHarness(async (child, request, options) => ({
      child,
      request: request as AgentRunRequest,
      started: target.execution.run(request as AgentRunRequest, { signal: options.signal }),
    }));
    const service = messagingService(store, lifecycleHarness([target.handle]).service, sessionContext(),
      metadataHarness({ 'agent-target': { type: 'sub', parentAgentId: 'main', executor: 'example-acp' } }), dispatch);
    await expect(service.send({
      ...sendInput('default delegation', 'external-default-delegation'),
      idleWake: 'owned-child',
    })).resolves.toMatchObject({ delivery: 'delivered', resumed: true });
    expect(target.remoteRequests.map((request) => request.kind === 'retry' ? '' : request.prompt).join('\n')).toContain('default delegation');
    await service.dispose();
  });

  it('rejects mail when the external profile explicitly turns delegation off', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target', {
      executorId: 'example-acp',
      allowKikiSubagents: false,
      delegationSource: 'profile',
    });
    const dispatch = dispatchHarness();
    const service = messagingService(store, lifecycleHarness([target.handle]).service, sessionContext(),
      metadataHarness({ 'agent-target': { type: 'sub', parentAgentId: 'main', executor: 'example-acp' } }), dispatch);
    await expect(service.send({
      ...sendInput('blocked delegation', 'external-blocked-delegation'),
      idleWake: 'owned-child',
    })).rejects.toMatchObject({
      code: 'request.invalid',
      message: expect.stringContaining('allow_kiki_subagents'),
    });
    expect(dispatch.runOnExisting).not.toHaveBeenCalled();
    expect(await store.nextQueued('session-1', 'agent-target')).toBeUndefined();
    await service.dispose();
  });

  it('continues user-authored mail on the same external binding after a missed steer', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target', { executorId: 'grok-acp' });
    target.setRunning(true);
    let release!: () => void;
    const settled = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(target.execution, 'settled').mockReturnValue(settled);
    const dispatch = dispatchHarness(async (child, request, options) => ({
      child,
      request: request as AgentRunRequest,
      started: target.execution.run(request as AgentRunRequest, options),
    }));
    const service = messagingService(store, lifecycleHarness([target.handle]).service, sessionContext(),
      metadataHarness({ 'agent-target': { type: 'sub', parentAgentId: 'main', executor: 'grok-acp' } }), dispatch);

    await expect(service.sendUserMessage({ targetAgentId: 'agent-target', content: 'next step', idempotencyKey: 'running-user' }))
      .resolves.toMatchObject({ delivery: 'queued', resumed: undefined });
    expect(target.pendingSteers()).toBe(0);
    expect(dispatch.runOnExisting).not.toHaveBeenCalled();
    target.setRunning(false);
    release();
    await vi.waitFor(() => { expect(target.remoteRequests).toHaveLength(1); });
    expect(target.remoteRequests).toEqual([{
      kind: 'mailbox',
      prompt: 'next step',
      message: expect.objectContaining({ origin: { kind: 'user' }, content: [{ type: 'text', text: 'next step' }] }),
    }]);
    expect(dispatch.runOnExisting).toHaveBeenCalledTimes(1);
    expect(target.messages).toMatchObject([{ origin: { kind: 'user' }, content: [{ type: 'text', text: 'next step' }] }]);
    expect(await store.nextQueued('session-1', 'agent-target')).toBeUndefined();
    await service.dispose();
  });

  it('does not continue a user message whose external steer outcome is unknown', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target', { executorId: 'claude-acp', externalSteerResult: 'unknown' });
    target.setRunning(true);
    let release!: () => void;
    const settled = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(target.execution, 'settled').mockReturnValue(settled);
    const dispatch = dispatchHarness(async (child, request, options) => ({
      child,
      request: request as AgentRunRequest,
      started: target.execution.run(request as AgentRunRequest, options),
    }));
    const service = messagingService(store, lifecycleHarness([target.handle]).service, sessionContext(),
      metadataHarness({ 'agent-target': { type: 'sub', parentAgentId: 'main', executor: 'claude-acp' } }), dispatch);
    await expect(service.sendUserMessage({ targetAgentId: 'agent-target', content: 'maybe sent', idempotencyKey: 'unknown-user' }))
      .resolves.toMatchObject({ delivery: 'queued' });
    target.setRunning(false);
    release();
    await drain();
    expect(dispatch.runOnExisting).not.toHaveBeenCalled();
    await target.execution.run({ kind: 'prompt', prompt: 'explicit resume' }, { signal });
    expect(target.remoteRequests).toEqual([{ kind: 'prompt', prompt: 'maybe sent\n\nexplicit resume' }]);
    expect(await store.nextQueued('session-1', 'agent-target')).toBeUndefined();
    await service.dispose();
  });

  it('keeps one complete 4.5 MB user body in the mailbox while the compact receipt omits it', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target', { executorId: 'grok-acp' });
    target.setRunning(true);
    const service = messagingService(store, lifecycleHarness([target.handle]).service, sessionContext(),
      metadataHarness({
        'agent-target': { type: 'sub', parentAgentId: 'main', displayName: 'external', executor: 'grok-acp' },
      }));
    const content = '文'.repeat(1_500_000);
    const input = { targetAgentId: 'agent-target', content, idempotencyKey: 'long-user-message' };
    const first = await service.sendUserMessageReceipt(input);
    expect(first).toMatchObject({
      deduplicated: false,
      delivery: 'queued',
      payloadConflict: false,
      message: {
        sessionId: 'session-1',
        sourceAgentId: 'main',
        senderKind: 'user',
        targetAgentId: 'agent-target',
        targetTaskName: 'external',
      },
    });
    expect('content' in first.message).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(1024);
    expect(first.resumed).toBeUndefined();

    const full = await service.sendUserMessage(input);
    expect(full).toMatchObject({ deduplicated: true, delivery: 'queued', payloadConflict: false });
    expect(full.message).toMatchObject({ messageId: first.message.messageId });
    expect(full.message.content).toBe(content);
    expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(4 * 1024 * 1024);

    const conflict = await service.sendUserMessageReceipt({ ...input, content: 'changed' });
    expect(conflict).toMatchObject({
      deduplicated: true,
      delivery: 'queued',
      payloadConflict: true,
      message: { messageId: first.message.messageId },
    });
    expect('content' in conflict.message).toBe(false);

    target.setRunning(false);
    await target.execution.run({ kind: 'prompt', prompt: 'ordinary resume' }, { signal });
    expect(target.remoteRequests).toEqual([{ kind: 'prompt', prompt: `${content}\n\nordinary resume` }]);
    expect(target.messages).toHaveLength(1);
    expect(target.messages[0]?.content).toEqual([{ type: 'text', text: content }]);
    expect(await store.nextQueued('session-1', 'agent-target')).toBeUndefined();
    await service.dispose();
  });

  it('fails meaningfully when an idle child executor is permanently broken', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    target.setExecutionState('broken');
    const service = messagingService(
      store,
      lifecycleHarness([target.handle]).service,
      sessionContext(),
      metadataHarness({ 'agent-target': {} }),
    );

    await expect(service.send({
      ...sendInput('cannot wake', 'broken-wake'),
      idleWake: 'owned-child',
    })).rejects.toMatchObject({
      code: 'internal',
      message: 'Agent instance "agent-target" is broken and its original remote session cannot be resumed. The saved message stays queued. Do not call AgentSend again. Do not open a new remote session.',
    });
    await service.dispose();
  });

  it.each(['original', 'construction'] as const)('distinguishes %s recovery from an unrecoverable broken continuation', async (recovery) => {
    const store = mailboxStore(tempDir());
    const recoverableTarget = agentHandle('agent-target', {
      recoverableBroken: recovery === 'original',
      retryableBroken: recovery === 'construction',
    });
    const recoveryReason = recovery === 'original'
      ? 'Agent instance "agent-target" is broken. Resume the original remote session with AgentRun; the saved message stays queued.'
      : 'Agent instance "agent-target" failed before a usable executor session remained. Resume the same child with AgentRun; the saved message stays queued.';
    recoverableTarget.setExecutionState('broken');
    const recoverableSender: ContextMessage[] = [];
    const sender = agentHandle('main', { enqueued: recoverableSender });
    const lifecycle = lifecycleHarness([recoverableTarget.handle, sender.handle]);
    const recoverable = messagingService(
      store,
      lifecycle.service,
      sessionContext(),
      metadataHarness({ 'agent-target': {}, main: {} }),
      dispatchHarness(),
      residencyHarness(lifecycle.service).manager,
    );
    await expect(recoverable.send({
      ...sendInput('recover original', 'broken-recoverable'),
      idleWake: 'owned-child',
    })).rejects.toMatchObject({
      code: 'internal',
      message: recoveryReason,
    });
    const accepted = await recoverable.send({
      ...sendInput('recover original', 'broken-recoverable'),
      waitForRunningDelivery: false,
      idleWake: 'owned-child',
    });
    await vi.waitFor(() => { expect(recoverableSender.length).toBeGreaterThan(0); });
    const recoverNotice = noticeText(recoverableSender.at(-1)!);
    expect(recoverNotice).toContain(accepted.message.messageId);
    expect(recoverNotice).toContain(recoveryReason);
    expect(recoverNotice).toContain('Set resume to agent-target');
    expect(recoverNotice).toContain('empty string');
    expect(recoverNotice).toContain('Do not set new_window');
    expect(recoverNotice).not.toContain('original remote session cannot be resumed');
    await recoverable.dispose();

    const refusedSender: ContextMessage[] = [];
    const refusedTarget = agentHandle('agent-target');
    refusedTarget.setExecutionState('broken');
    const refusedMain = agentHandle('main', { enqueued: refusedSender });
    const refusedLifecycle = lifecycleHarness([refusedTarget.handle, refusedMain.handle]);
    const refused = messagingService(
      mailboxStore(tempDir()),
      refusedLifecycle.service,
      sessionContext(),
      metadataHarness({ 'agent-target': {}, main: {} }),
      dispatchHarness(),
      residencyHarness(refusedLifecycle.service).manager,
    );
    const queued = await refused.send({
      ...sendInput('stay queued', 'broken-unrecoverable'),
      waitForRunningDelivery: false,
      idleWake: 'owned-child',
    });
    await vi.waitFor(() => { expect(refusedSender.length).toBeGreaterThan(0); });
    const refusedNotice = noticeText(refusedSender.at(-1)!);
    expect(refusedNotice).toContain(queued.message.messageId);
    expect(refusedNotice).toContain('original remote session cannot be resumed');
    expect(refusedNotice).toContain('Do not call AgentSend again');
    expect(refusedNotice).toContain('Do not open a new remote session');
    expect(refusedNotice).not.toContain('Set resume to');
    expect(refusedNotice).not.toContain('empty string');
    expect(refusedNotice).not.toContain('new_window');
    await refused.dispose();
  });

  it.each(['starting', 'cancelling'] as const)(
    'keeps delivery queued without restarting a %s child',
    async (state) => {
      const store = mailboxStore(tempDir());
      const target = agentHandle('agent-target');
      target.setExecutionState(state);
      const dispatch = dispatchHarness();
      const service = messagingService(
        store,
        lifecycleHarness([target.handle]).service,
        sessionContext(),
        metadataHarness({ 'agent-target': {} }),
        dispatch,
      );

      await expect(service.send({
        ...sendInput(`during ${state}`, `wake-${state}`),
        idleWake: 'owned-child',
      })).resolves.toMatchObject({ delivery: 'queued' });
      expect(dispatch.runOnExisting).not.toHaveBeenCalled();
      await service.dispose();
    },
  );

  it('holds an independent lease after background send returns until running delivery settles', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    target.setRunning(true);
    const lifecycle = lifecycleHarness([target.handle]);
    const residency = residencyHarness(lifecycle.service);
    const service = messagingService(store, lifecycle.service, sessionContext(), metadataHarness({ 'agent-target': {} }), dispatchHarness(), residency.manager);

    const acceptance = await service.send({
      ...sendInput('background delivery', 'background-delivery'),
      waitForRunningDelivery: false,
    });
    await waitUntil(() => target.pendingSteers() === 1);
    expect(acceptance.delivery).toBe('queued');
    expect(residency.acquire).toHaveBeenCalledWith('session-1', 'agent-message-delivery');
    expect(residency.pins()).toBe(1);
    expect(await residency.manager.evictIfIdle?.('session-1')).toBe(false);
    expect((await store.accept(messageInput('background delivery', 'background-delivery'))).delivery).toBe('queued');

    await target.beginStepBoundary(1);
    await waitUntil(() => residency.pins() === 0);
    expect((await store.accept(messageInput('background delivery', 'background-delivery'))).delivery).toBe('delivered');
    expect(await residency.manager.evictIfIdle?.('session-1')).toBe(true);
    await service.dispose();
  });

  it('releases a background delivery lease on cancellation and leaves the message queued', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    target.setRunning(true);
    const lifecycle = lifecycleHarness([target.handle]);
    const residency = residencyHarness(lifecycle.service);
    const dispatch = dispatchHarness();
    const service = messagingService(store, lifecycle.service, sessionContext(), metadataHarness({ 'agent-target': {} }), dispatch, residency.manager);

    const acceptance = await service.send({
      ...sendInput('cancelled delivery', 'cancelled-delivery'),
      waitForRunningDelivery: false,
    });
    await waitUntil(() => target.pendingSteers() === 1);
    expect(residency.pins()).toBe(1);
    target.setExecutionState('cancelling');
    target.releaseSteers(false);
    await waitUntil(() => residency.pins() === 0);
    expect((await store.accept(messageInput('cancelled delivery', 'cancelled-delivery'))).delivery).toBe('queued');
    expect(acceptance.delivery).toBe('queued');
    expect(dispatch.runOnExisting).not.toHaveBeenCalled();
    expect(await residency.manager.evictIfIdle?.('session-1')).toBe(true);
    await service.dispose();
  });

  it('releases a background delivery lease when the mailbox claim fails', async () => {
    const persisted = mailboxStore(tempDir());
    const failure = new Error('claim failed');
    let attempt = 0;
    const store = wrapStore(persisted, {
      nextQueued: async () => { attempt++; throw failure; },
    });
    const target = agentHandle('agent-target');
    target.setRunning(true);
    const lifecycle = lifecycleHarness([target.handle]);
    const residency = residencyHarness(lifecycle.service);
    const service = messagingService(store, lifecycle.service, sessionContext(), metadataHarness({ 'agent-target': {} }), dispatchHarness(), residency.manager);

    const accepted = await service.send({
      ...sendInput('failed claim', 'failed-claim'),
      waitForRunningDelivery: false,
    });
    expect(accepted.delivery).toBe('queued');
    await waitUntil(() => attempt === 1 && residency.pins() === 0);
    expect((await persisted.accept(messageInput('failed claim', 'failed-claim'))).delivery).toBe('queued');
    expect(await residency.manager.evictIfIdle?.('session-1')).toBe(true);
    await service.dispose();
  });

  it.each(['resolve', 'reject'] as const)('awaits asynchronous background lease release before reporting a failure (%s)', async (outcome) => {
    const persisted = mailboxStore(tempDir());
    const claimFailure = new Error('claim failed');
    const releaseFailure = new Error('lease release failed');
    const store = wrapStore(persisted, {
      nextQueued: async () => { throw claimFailure; },
    });
    const target = agentHandle('agent-target');
    target.setRunning(true);
    const lifecycle = lifecycleHarness([target.handle]);
    const residency = residencyHarness(lifecycle.service);
    let finishRelease!: () => void;
    const gate = new Promise<void>((resolve) => { finishRelease = resolve; });
    const release = vi.fn(async () => {
      await gate;
      if (outcome === 'reject') throw releaseFailure;
    });
    const manager: ISessionManager = {
      ...residency.manager,
      acquire: async (sessionId, reason) => {
        const lease = await residency.acquire(sessionId, reason);
        return {
          ...lease,
          dispose: async () => {
            try {
              await release();
            } finally {
              lease.dispose();
            }
          },
        };
      },
    };
    const log = stubLog();
    const warn = vi.spyOn(log, 'warn');
    const service = messagingService(store, lifecycle.service, sessionContext(), metadataHarness({ 'agent-target': {} }), dispatchHarness(), manager, log);
    try {
      const accepted = await service.send({
        ...sendInput('asynchronous release', 'asynchronous-release'),
        waitForRunningDelivery: false,
      });
      expect(accepted.delivery).toBe('queued');
      await vi.waitFor(() => { expect(release).toHaveBeenCalledOnce(); });
      expect(residency.pins()).toBe(1);
      expect(warn).not.toHaveBeenCalled();
      finishRelease();
      await vi.waitFor(() => {
        expect(residency.pins()).toBe(0);
        expect(warn).toHaveBeenCalledWith('Agent message delivery did not finish', {
          messageId: accepted.message.messageId,
          targetAgentId: 'agent-target',
          error: outcome === 'reject' ? releaseFailure : claimFailure,
        });
      });
      expect((await persisted.accept(messageInput('asynchronous release', 'asynchronous-release'))).delivery).toBe('queued');
    } finally {
      finishRelease();
      await service.dispose();
    }
  });

  it('persists sender receipts after recipient materialization and flush, before mailbox acknowledgement', async () => {
    const sender = createTestAgent();
    const source: IAgentScopeHandle = {
      id: 'main', kind: LifecycleScope.Agent,
      accessor: { get: <T>(id: ServiceIdentifier<T>): T => sender.get(id) },
      dispose: () => {},
    };
    const target = agentHandle('agent-target');
    target.setRunning(true);
    const adapter = mailboxStore(tempDir());
    const acknowledged: string[] = [];
    const store = wrapStore(adapter, {
      markDelivered: async (claim) => {
        expect(target.operations.at(-1)).toBe('flush');
        expect(await receipts()).toContainEqual(expect.objectContaining({ messageId: claim.message.messageId }));
        const changed = await adapter.markDelivered(claim);
        acknowledged.push(claim.message.messageId);
        return changed;
      },
    });
    const service = messagingService(store, lifecycleHarness([source, target.handle]).service,
      sessionContext(), metadataHarness({ main: {}, 'agent-target': {} }));
    const receipts = async () => {
      const records = [];
      for await (const record of sender.wire.readJournal()) {
        if (record.type === 'agent_message.delivered') records.push(record);
      }
      return records;
    };
    try {
      const accepted = await service.send({ ...sendInput('one', 'receipt-one'), waitForRunningDelivery: false });
      await waitUntil(() => target.pendingSteers() === 1);
      expect(accepted.delivery).toBe('queued');
      expect(await receipts()).toEqual([]);
      await target.beginStepBoundary(1);
      await vi.waitFor(async () => { expect(await receipts()).toHaveLength(1); });
      await vi.waitFor(() => { expect(acknowledged).toEqual([accepted.message.messageId]); });
      expect(await receipts()).toEqual([expect.objectContaining({
        messageId: accepted.message.messageId, targetAgentId: 'agent-target', status: 'delivered',
        deliveredAt: expect.any(String),
      })]);
      const duplicate = await service.send({ ...sendInput('one', 'receipt-one'), waitForRunningDelivery: false });
      expect(duplicate).toMatchObject({ deduplicated: true, delivery: 'delivered' });
      expect(await receipts()).toHaveLength(1);
      const raced = await service.send({ ...sendInput('race', 'receipt-race'), waitForRunningDelivery: false });
      await waitUntil(() => target.pendingSteers() === 1);
      target.setRunning(false);
      await drain();
      expect((await adapter.accept(messageInput('race', 'receipt-race'))).delivery).toBe('queued');
      expect(await receipts()).toHaveLength(1);
      expect(acknowledged).not.toContain(raced.message.messageId);
      await target.execution.hooks.onWillRun.run({ signal });
      expect(await receipts()).toHaveLength(2);
    } finally {
      await service.dispose();
      await sender.dispose();
    }
  });

  it.each(['recipient-flush', 'mailbox-ack', 'stale-claim'] as const)(
    'retains the queued message when %s fails and receipts only a flushed recipient', async (failure) => {
      const sender = createTestAgent();
      const source: IAgentScopeHandle = {
        id: 'main', kind: LifecycleScope.Agent,
        accessor: { get: <T>(id: ServiceIdentifier<T>): T => sender.get(id) }, dispose: () => {},
      };
      const target = agentHandle('agent-target');
      const adapter = mailboxStore(tempDir());
      const markDelivered = vi.fn(async (_claim: ThreadDeliveryClaim) => {
        if (failure === 'mailbox-ack') throw new Error('ack failed');
        return false;
      });
      if (failure === 'recipient-flush') {
        vi.spyOn(target.handle.accessor.get(IWireService), 'flush').mockRejectedValue(new Error('flush failed'));
      }
      const service = messagingService(wrapStore(adapter, { markDelivered }),
        lifecycleHarness([source, target.handle]).service, sessionContext(), metadataHarness({ main: {}, 'agent-target': {} }));
      try {
        await adapter.accept(messageInput('pending', `failure-${failure}`));
        const run = target.execution.hooks.onWillRun.run({ signal });
        if (failure === 'stale-claim') await run;
        else await expect(run).rejects.toThrow(failure === 'recipient-flush' ? 'flush failed' : 'ack failed');
        if (failure === 'recipient-flush') expect(markDelivered).not.toHaveBeenCalled();
        const records = [];
        for await (const record of sender.wire.readJournal()) records.push(record);
        expect(records.some((record) => record.type === 'agent_message.delivered')).toBe(failure !== 'recipient-flush');
        expect((await adapter.accept(messageInput('pending', `failure-${failure}`))).delivery).toBe('queued');
      } finally {
        await service.dispose();
        await sender.dispose();
      }
    },
  );

  it('keeps the claim recoverable until its durable receipt outbox is written', async () => {
    const adapter = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    const service = messagingService(adapter, lifecycleHarness([target.handle]).service, sessionContext(), metadataHarness({ 'agent-target': {} }));
    const storage = receiptStorage.get(adapter)!;
    const write = vi.spyOn(storage, 'write').mockRejectedValueOnce(new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'outbox full'));
    try {
      const accepted = await service.send(sendInput('canonical first', 'outbox-full'));
      await target.execution.hooks.onWillRun.run({ signal });
      expect((await adapter.accept(messageInput('canonical first', 'outbox-full'))).delivery).toBe('queued');
      expect(target.messages.filter(message => message.id === accepted.message.messageId)).toHaveLength(1);
      expect(await storage.list(sessionContext().scope('agent-message-receipts/main'))).toHaveLength(0);
      write.mockRestore();
      await target.execution.hooks.onWillRun.run({ signal });
      expect((await adapter.accept(messageInput('canonical first', 'outbox-full'))).delivery).toBe('delivered');
      expect(target.messages.filter(message => message.id === accepted.message.messageId)).toHaveLength(1);
      expect(await storage.list(sessionContext().scope('agent-message-receipts/main'))).toHaveLength(1);
    } finally { await service.dispose(); }
  });

  it('retains a cold sender receipt until that sender is materialized without restoring or running it', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const sender = createTestAgent({ persistence });
    const target = agentHandle('agent-target');
    const lifecycle = lifecycleHarness([target.handle]);
    lifecycle.service.create.mockImplementation(() => new Promise(() => {}));
    const adapter = mailboxStore(tempDir());
    const service = messagingService(adapter, lifecycle.service, sessionContext(),
      metadataHarness({ 'agent-sender': {}, 'agent-target': {} }));
    try {
      const input = { ...sendInput('restore', 'restore-receipt'), sourceAgentId: 'agent-sender' };
      const accepted = await service.send(input);
      const next = vi.fn(async () => {});
      await target.execution.hooks.onWillRun.run({ signal }, next);
      await target.handle.accessor.get(IAgentLoopService).hooks.onWillBeginStep.run({ turnId: 1, step: 1, firstStepOfTurn: false, signal }, next);
      expect(next).toHaveBeenCalledTimes(2);
      expect(lifecycle.service.create).not.toHaveBeenCalled();
      expect((await adapter.accept({ ...input, sessionId: 'session-1' })).delivery).toBe('delivered');
      expect(persistence.records.filter(record => record.type === 'agent_message.delivered')).toHaveLength(0);
      lifecycle.add(testAgentHandle(sender, 'agent-sender'));
      await vi.waitFor(() => { expect(persistence.records.filter(record => record.type === 'agent_message.delivered')).toEqual([
        expect.objectContaining({ messageId: accepted.message.messageId, targetAgentId: 'agent-target' }),
      ]); });
      expect(sender.llmCalls).toEqual([]);
    } finally {
      await service.dispose();
      await sender.dispose();
    }
  });

  it.each(['cold-sender', 'sender-flush', 'receipt-delete'] as const)('releases the recipient and recovers exactly one delivered receipt after restart with %s blocked', async (failure) => {
    const adapter = mailboxStore(tempDir());
    const targetPersistence = new InMemoryWireRecordPersistence();
    const senderPersistence = new InMemoryWireRecordPersistence();
    let target = createTestAgent({ persistence: targetPersistence });
    let sender = createTestAgent({ persistence: senderPersistence });
    const lifecycle = lifecycleHarness(failure === 'cold-sender'
      ? [testAgentHandle(target, 'agent-target')]
      : [testAgentHandle(target, 'agent-target'), testAgentHandle(sender, 'main')]);
    lifecycle.service.create.mockImplementation(() => new Promise(() => {}));
    let release!: () => void;
    if (failure === 'sender-flush') vi.spyOn(sender.wire, 'flush').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const metadata = metadataHarness({ main: {}, 'agent-target': {} });
    let service = messagingService(adapter, lifecycle.service, sessionContext(), metadata);
    const storage = receiptStorage.get(adapter)!;
    if (failure === 'receipt-delete') vi.spyOn(storage, 'delete').mockRejectedValue(new Error('delete failed'));
    try {
      const accepted = await service.send(sendInput('durable recipient', `restart-${failure}`));
      const next = vi.fn(async () => {});
      await target.get(IAgentExecutionService).hooks.onWillRun.run({ signal }, next);
      await target.get(IAgentLoopService).hooks.onWillBeginStep.run({ turnId: 1, step: 1, firstStepOfTurn: false, signal }, next);
      expect(next).toHaveBeenCalledTimes(2);
      expect(targetPersistence.records).toContainEqual(expect.objectContaining({ type: 'context.append_message',
        message: expect.objectContaining({ id: accepted.message.messageId }) }));
      expect((await adapter.accept(messageInput('durable recipient', `restart-${failure}`))).delivery).toBe('delivered');
      expect(lifecycle.service.create).not.toHaveBeenCalled();
      await vi.waitFor(async () => { expect(await storage.list(sessionContext().scope('agent-message-receipts/main'))).toHaveLength(1); });
      if (failure !== 'cold-sender') await vi.waitFor(() => {
        expect(senderPersistence.records.filter(record => record.type === 'agent_message.delivered')).toHaveLength(1);
      });
      await service.dispose();
      if (failure === 'sender-flush') release();
      vi.restoreAllMocks();
      await target.dispose();
      await sender.dispose();
      target = createTestAgent({ persistence: targetPersistence });
      target.get(IAgentExecutionService);
      await target.restorePersisted();
      sender = createTestAgent({ persistence: senderPersistence });
      sender.get(IAgentExecutionService);
      await sender.restorePersisted();
      service = messagingService(adapter, lifecycleHarness([testAgentHandle(target, 'agent-target'), testAgentHandle(sender, 'main')]).service,
        sessionContext(), metadata);
      await vi.waitFor(async () => { expect(await storage.list(sessionContext().scope('agent-message-receipts/main'))).toHaveLength(0); });
      expect(senderPersistence.records.filter(record => record.type === 'agent_message.delivered')).toHaveLength(1);
      expect(target.context.get().filter(message => message.id === accepted.message.messageId)).toHaveLength(1);
      expect(target.llmCalls).toHaveLength(0);
      expect(sender.llmCalls).toHaveLength(0);
    } finally {
      await service.dispose();
      await target.dispose();
      await sender.dispose();
    }
  });

  it.each(['sender-flush', 'mailbox-ack'] as const)('does not duplicate a persisted receipt after %s retry and service rebuild', async (failure) => {
    const sender = createTestAgent();
    const source: IAgentScopeHandle = {
      id: 'main', kind: LifecycleScope.Agent,
      accessor: { get: <T>(id: ServiceIdentifier<T>): T => sender.get(id) }, dispose: () => {},
    };
    const target = agentHandle('agent-target');
    const lifecycle = lifecycleHarness([source, target.handle]);
    const { adapter, thread } = rawMailbox(tempDir());
    const claimNext = thread.claimNext.bind(thread);
    vi.spyOn(thread, 'claimNext').mockImplementation((input, options) => claimNext({ ...input, leaseMs: 1 }, options));
    const metadata = metadataHarness({ main: {}, 'agent-target': {} });
    let attempts = 0;
    const store = wrapStore(adapter, { markDelivered: async (claim) => {
      if (failure === 'mailbox-ack' && attempts++ === 0) throw new Error('ack failed');
      return adapter.markDelivered(claim);
    } });
    const flush = sender.wire.flush.bind(sender.wire);
    if (failure === 'sender-flush') vi.spyOn(sender.wire, 'flush').mockImplementation(async () => {
      await flush();
      if (attempts++ === 0) throw new Error('flush response lost');
    });
    let service = messagingService(store, lifecycle.service, sessionContext(), metadata);
    try {
      const accepted = await service.send(sendInput('retry', `retry-receipt-${failure}`));
      const first = target.execution.hooks.onWillRun.run({ signal });
      if (failure === 'mailbox-ack') await expect(first).rejects.toThrow('ack failed');
      else await first;
      expect((await adapter.accept(messageInput('retry', `retry-receipt-${failure}`))).delivery).toBe(failure === 'mailbox-ack' ? 'queued' : 'delivered');
      await service.dispose();
      service = messagingService(store, lifecycle.service, sessionContext(), metadata);
      await target.execution.hooks.onWillRun.run({ signal });
      await target.execution.hooks.onWillRun.run({ signal });
      expect(target.messages.filter((message) => message.id === accepted.message.messageId)).toHaveLength(1);
      expect((await adapter.accept(messageInput('retry', `retry-receipt-${failure}`))).delivery).toBe('delivered');
      const records = [];
      for await (const record of sender.wire.readJournal()) records.push(record);
      expect(records.filter((record) => record.type === 'agent_message.delivered')).toHaveLength(1);
    } finally {
      await service.dispose();
      await sender.dispose();
    }
  });

  it('injects AgentSend into a running target at its next step boundary before acknowledging delivery', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    target.setRunning(true);
    const lifecycle = lifecycleHarness([target.handle]);
    const service = messagingService(store, lifecycle.service, sessionContext(), metadataHarness({ 'agent-target': {} }));

    const delivery = service.send({
      ...sendInput('running steer', 'running-steer'),
      idleWake: 'owned-child',
    });
    await waitUntil(() => target.pendingSteers() === 1);
    let settled = false;
    void delivery.then(() => { settled = true; });
    await drain();

    expect(settled).toBe(false);
    expect(target.messages).toEqual([]);
    await target.beginStepBoundary(1);

    await expect(delivery).resolves.toMatchObject({ delivery: 'delivered' });
    expect(target.messages.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'Message from agent "root" (main):\n\nrunning steer' },
    ]);
    expect(target.operations).toEqual(['appendObservable', 'flush']);
    expect(await store.nextQueued('session-1', 'agent-target')).toBeUndefined();
    await service.dispose();
  });

  it('does not wait behind a future steer when two messages precede one step boundary', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    target.setRunning(true);
    const service = messagingService(
      store,
      lifecycleHarness([target.handle]).service,
      sessionContext(),
      metadataHarness({ 'agent-target': {} }),
    );

    const first = service.send({
      ...sendInput('first running message', 'running-first'),
      idleWake: 'owned-child',
    });
    await waitUntil(() => target.pendingSteers() === 1);
    const second = service.send({
      ...sendInput('second running message', 'running-second'),
      idleWake: 'owned-child',
    });
    await drain();

    await target.beginStepBoundary(1);
    await waitUntil(() => target.pendingSteers() === 1);
    await target.beginStepBoundary(2);
    await expect(first).resolves.toMatchObject({ delivery: 'delivered' });
    await expect(second).resolves.toMatchObject({ delivery: 'delivered' });

    expect(target.messages.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'Message from agent "root" (main):\n\nfirst running message' },
      { type: 'text', text: 'Message from agent "root" (main):\n\nsecond running message' },
    ]);
    expect(target.operations).toEqual([
      'appendObservable',
      'flush',
      'appendObservable',
      'flush',
    ]);
    await service.dispose();
  });

  it('continues a child whose run ends before the running delivery lands', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    target.setRunning(true);
    const lifecycle = lifecycleHarness([target.handle]);
    const dispatch = dispatchHarness(async (child, request, options) => {
      expect(request).toMatchObject({
        kind: 'mailbox',
        prompt: 'Message from agent "root" (main):\n\nafter race',
      });
      await target.execution.hooks.onWillRun.run({ signal: options.signal });
      return {
        child,
        request: request as DispatchRun['request'],
        started: Promise.resolve({
          agentId: child.agentId,
          turn: {} as never,
          completion: new Promise<{ summary: string }>(() => {}),
        }),
      };
    });
    const service = messagingService(
      store,
      lifecycle.service,
      sessionContext(),
      metadataHarness({ 'agent-target': {} }),
      dispatch,
    );

    const delivery = service.send({
      ...sendInput('after race', 'running-race-continues'),
      idleWake: 'owned-child',
    });
    await waitUntil(() => target.pendingSteers() === 1);
    target.setRunning(false);

    await expect(delivery).resolves.toMatchObject({ delivery: 'delivered', resumed: true });
    expect(dispatch.runOnExisting).toHaveBeenCalledTimes(1);
    expect(dispatch.recordDelegatedRun).toHaveBeenCalledWith('main', 'agent-target');
    expect(target.messages.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'Message from agent "root" (main):\n\nafter race' },
    ]);
    expect(await store.nextQueued('session-1', 'agent-target')).toBeUndefined();
    await service.dispose();
  });

  it('recovers a timed-out claim at the same safe boundary without waiting for another model step', async () => {
    const { adapter, thread } = rawMailbox(tempDir());
    const accepted = await adapter.accept(messageInput('recover timeout', 'recover-timeout'));
    const target = agentHandle('agent-target');
    const log = stubLog();
    const warn = vi.spyOn(log, 'warn');
    const service = messagingService(adapter, lifecycleHarness([target.handle]).service, sessionContext(),
      metadataHarness({ 'agent-target': {} }), dispatchHarness(), undefined, log);
    const internal = thread as unknown as RuntimeMailboxCaller;
    const original = thread.claimNext.bind(thread);
    const ids: string[] = [];
    thread.claimNext = async (input, options) => {
      ids.push(options?.requestId ?? '');
      const value = await internal.call(THREAD_MAILBOX_RUNTIME_METHODS.claim, input, options, 50);
      return value === null ? undefined : value as ThreadDeliveryClaim;
    };
    const gate = blockFirstTargetBatch();
    const next = vi.fn(async () => {});
    try {
      const run = target.execution.hooks.onWillRun.run({ signal }, next);
      await gate.entered;
      await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
      expect(next).not.toHaveBeenCalled();
      gate.release();
      await run;
      expect(next).toHaveBeenCalledOnce();
      expect(target.messages.filter((message) => message.id === accepted.message.messageId)).toHaveLength(1);
      expect(ids[1]).toBe(ids[0]);
      expect((await adapter.accept(messageInput('recover timeout', 'recover-timeout'))).delivery).toBe('delivered');
    } finally { gate.restore(); thread.claimNext = original; await service.dispose(); }
  });

  it.each([false, true])('waits through nearly two minutes of mailbox saturation and preserves a bounded diagnostic, recovered=%s', async (recovered) => {
    const adapter = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    const timeout = new HomeRuntimeError('runtime.timeout', 'ownerPhase=claim_read');
    const claim = vi.spyOn(adapter, 'nextQueued').mockRejectedValue(timeout);
    vi.spyOn(adapter, 'listPendingAgents').mockResolvedValue([]);
    const service = messagingService(adapter, lifecycleHarness([target.handle]).service, sessionContext(), metadataHarness({ 'agent-target': {} }));
    const next = vi.fn(async () => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const run = target.execution.hooks.onWillRun.run({ signal }, next);
      const settled = vi.fn();
      void run.then(settled, settled);
      const result = recovered ? expect(run).resolves.toBeUndefined() : expect(run).rejects.toMatchObject({
        code: 'runtime.timeout', cause: timeout, message: expect.stringContaining('after 8 recovery attempts'),
      });
      await vi.advanceTimersByTimeAsync(111_249);
      expect(claim).toHaveBeenCalledTimes(7);
      expect(settled).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      if (recovered) claim.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(claim).toHaveBeenCalledTimes(8);
      expect(next).toHaveBeenCalledTimes(recovered ? 1 : 0);
    } finally { vi.useRealTimers(); await service.dispose(); }
  });

  it.each([0, 81_250])('cancels recovery backoff at %sms and does not retry permanent mailbox failures', async (elapsed) => {
    const adapter = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    const log = stubLog();
    const warn = vi.spyOn(log, 'warn');
    const claim = vi.spyOn(adapter, 'nextQueued').mockRejectedValue(new HomeRuntimeError('runtime.timeout', 'temporary'));
    vi.spyOn(adapter, 'listPendingAgents').mockResolvedValue([]);
    const service = messagingService(adapter, lifecycleHarness([target.handle]).service, sessionContext(),
      metadataHarness({ 'agent-target': {} }), dispatchHarness(), undefined, log);
    const controller = new AbortController();
    const cancellation = new Error('cancel recovery');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const run = target.execution.hooks.onWillRun.run({ signal: controller.signal });
      const rejected = expect(run).rejects.toBe(cancellation);
      await vi.advanceTimersByTimeAsync(elapsed);
      const attempts = elapsed === 0 ? 1 : 7;
      expect(warn).toHaveBeenCalledTimes(attempts);
      controller.abort(cancellation);
      await rejected;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(claim).toHaveBeenCalledTimes(attempts);
      const invalid = new HomeRuntimeError('runtime.invalid_request', 'invalid payload');
      claim.mockRejectedValue(invalid);
      await expect(target.execution.hooks.onWillRun.run({ signal })).rejects.toBe(invalid);
      expect(claim).toHaveBeenCalledTimes(attempts + 1);
    } finally { vi.useRealTimers(); await service.dispose(); }
  });

  it('keeps a cancelling child queued until cancellation settles, then continues it once', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    target.setExecutionState('cancelling');
    vi.spyOn(target.execution, 'settled').mockImplementation(async () => {
      target.setRunning(false);
    });
    const dispatch = dispatchHarness(async (child, request, options) => {
      await target.execution.hooks.onWillRun.run({ signal: options.signal });
      return {
        child,
        request: request as DispatchRun['request'],
        started: Promise.resolve({
          agentId: child.agentId,
          turn: {} as never,
          completion: Promise.resolve({ summary: 'done' }),
        }),
      };
    });
    const service = messagingService(store, lifecycleHarness([target.handle]).service, sessionContext(),
      metadataHarness({ 'agent-target': {} }), dispatch);
    const accepted = await service.send({
      ...sendInput('after cancel', 'cancel-continue'),
      waitForRunningDelivery: false,
      idleWake: 'owned-child',
    });
    expect(accepted).toMatchObject({ delivery: 'queued' });
    expect(accepted.resumed).toBeUndefined();
    await vi.waitFor(() => { expect(dispatch.runOnExisting).toHaveBeenCalledTimes(1); });
    await vi.waitFor(async () => {
      expect((await store.accept(messageInput('after cancel', 'cancel-continue'))).delivery).toBe('delivered');
    });
    expect(dispatch.recordDelegatedRun).toHaveBeenCalledWith('main', 'agent-target');
    await service.dispose();
  });

  it('leaves a saved message for an already admitted next turn', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    vi.spyOn(target.handle.accessor.get(IAgentLoopService), 'status').mockReturnValue({
      state: 'idle', activeTurnId: undefined, pendingTurnIds: [2], hasPendingRequests: false,
    });
    const dispatch = dispatchHarness();
    const service = messagingService(store, lifecycleHarness([target.handle]).service, sessionContext(),
      metadataHarness({ 'agent-target': {} }), dispatch);
    await expect(service.send({
      ...sendInput('for the next turn', 'admitted-next'),
      idleWake: 'owned-child',
    })).resolves.toMatchObject({ delivery: 'queued' });
    expect(dispatch.runOnExisting).not.toHaveBeenCalled();
    await target.execution.hooks.onWillRun.run({ signal });
    expect(target.messages.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'Message from agent "root" (main):\n\nfor the next turn' },
    ]);
    expect(await store.nextQueued('session-1', 'agent-target')).toBeUndefined();
    await service.dispose();
  });

  it('accepts an external steer without copying the message locally or starting another run', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target', { executorId: 'grok-acp' });
    target.setRunning(true);
    vi.spyOn(target.execution, 'steer').mockResolvedValue(true);
    const dispatch = dispatchHarness();
    const service = messagingService(store, lifecycleHarness([target.handle]).service, sessionContext(),
      metadataHarness({ 'agent-target': {} }), dispatch);
    await expect(service.send({
      ...sendInput('during the external run', 'external-steer'),
      idleWake: 'owned-child',
    })).resolves.toMatchObject({ delivery: 'delivered' });
    expect(target.messages).toEqual([]);
    expect(dispatch.runOnExisting).not.toHaveBeenCalled();
    await service.dispose();
  });

  it('continues a running external child after its current run settles', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target', { executorId: 'grok-acp' });
    target.setRunning(true);
    let release!: () => void;
    const settled = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(target.execution, 'settled').mockReturnValue(settled);
    const dispatch = dispatchHarness(async (child, request, options) => ({
      child,
      request: request as DispatchRun['request'],
      started: target.execution.run(request as AgentRunRequest, options),
    }));
    const service = messagingService(store, lifecycleHarness([target.handle]).service, sessionContext(),
      metadataHarness({ 'agent-target': { type: 'sub', executor: 'grok-acp' } }), dispatch);
    const accepted = await service.send({
      ...sendInput('after this external run', 'external-follow'),
      waitForRunningDelivery: false,
      idleWake: 'owned-child',
    });
    expect(accepted).toMatchObject({ delivery: 'queued' });
    expect(accepted.resumed).toBeUndefined();
    expect(dispatch.runOnExisting).not.toHaveBeenCalled();
    target.setRunning(false);
    release();
    await vi.waitFor(() => { expect(target.remoteRequests).toHaveLength(1); });
    expect(target.remoteRequests[0]).toMatchObject({
      kind: 'mailbox',
      prompt: 'Message from agent "root" (main):\n\nafter this external run',
    });
    expect(dispatch.runOnExisting).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('retries one saved message without starting a second continuation', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    let runs = 0;
    const dispatch = dispatchHarness(async (child, request, options) => {
      runs += 1;
      await target.execution.hooks.onWillRun.run({ signal: options.signal });
      return {
        child,
        request: request as DispatchRun['request'],
        started: Promise.resolve({ agentId: child.agentId, turn: {} as never, completion: Promise.resolve({ summary: 'done' }) }),
      };
    });
    const service = messagingService(store, lifecycleHarness([target.handle]).service, sessionContext(),
      metadataHarness({ 'agent-target': {} }), dispatch);
    const input = { ...sendInput('same body', 'same-message'), waitForRunningDelivery: false, idleWake: 'owned-child' as const };
    const [first, second] = await Promise.all([service.send(input), service.send(input)]);
    expect(second.message.messageId).toBe(first.message.messageId);
    expect(second.deduplicated).toBe(true);
    await vi.waitFor(() => { expect(runs).toBe(1); });
    await vi.waitFor(async () => {
      expect((await store.accept(messageInput('same body', 'same-message'))).delivery).toBe('delivered');
    });
    expect(runs).toBe(1);
    await service.dispose();
  });

  it('does not overlap continuations when two messages arrive together', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch = dispatchHarness(async (child, request, options) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await target.execution.hooks.onWillRun.run({ signal: options.signal });
      inFlight -= 1;
      return {
        child,
        request: request as DispatchRun['request'],
        started: Promise.resolve({ agentId: child.agentId, turn: {} as never, completion: Promise.resolve({ summary: 'done' }) }),
      };
    });
    const service = messagingService(store, lifecycleHarness([target.handle]).service, sessionContext(),
      metadataHarness({ 'agent-target': {} }), dispatch);
    await Promise.all([
      service.send({ ...sendInput('one', 'concurrent-one'), waitForRunningDelivery: false, idleWake: 'owned-child' }),
      service.send({ ...sendInput('two', 'concurrent-two'), waitForRunningDelivery: false, idleWake: 'owned-child' }),
    ]);
    await vi.waitFor(async () => {
      expect(await store.nextQueued('session-1', 'agent-target')).toBeUndefined();
    });
    expect(maxInFlight).toBe(1);
    expect(target.messages).toHaveLength(2);
    await service.dispose();
  });

  it('keeps an accepted message when continuation fails and reports that failure', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    target.setExecutionState('broken');
    const log = stubLog();
    const warn = vi.spyOn(log, 'warn');
    const lifecycle = lifecycleHarness([target.handle]);
    const service = messagingService(store, lifecycle.service, sessionContext(),
      metadataHarness({ 'agent-target': {} }), dispatchHarness(), residencyHarness(lifecycle.service).manager, log);
    const accepted = await service.send({
      ...sendInput('kept', 'broken-async'),
      waitForRunningDelivery: false,
      idleWake: 'owned-child',
    });
    expect(accepted.delivery).toBe('queued');
    expect(accepted.message.messageId).toEqual(expect.any(String));
    await vi.waitFor(() => { expect(warn).toHaveBeenCalled(); });
    expect((await store.nextQueued('session-1', 'agent-target'))?.message.messageId).toBe(accepted.message.messageId);
    await service.dispose();
  });

  it('runs AgentSend through the real asynchronous messaging path', async () => {
    const store = mailboxStore(tempDir());
    const sender = createTestAgent();
    const source: IAgentScopeHandle = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: { get: <T>(id: ServiceIdentifier<T>): T => sender.get(id) },
      dispose: () => {},
    };
    const target = agentHandle('agent-target');
    const agents: Record<string, AgentMeta> = {
      main: { type: 'main' },
      'agent-target': {
        type: 'sub',
        parentAgentId: 'main',
        delegator: { kind: 'agent', agentId: 'main' },
        labels: { [COLLABORATION_TASK_NAME_LABEL]: 'chart_owner' },
      },
    };
    const metadata = metadataHarness(agents);
    let runs = 0;
    const dispatch = dispatchHarness(async (child, request, options) => {
      runs += 1;
      expect(options.requesterAgentId).toBeUndefined();
      expect(request).toMatchObject({ kind: 'mailbox' });
      await target.execution.hooks.onWillRun.run({ signal: options.signal });
      return {
        child,
        request: request as DispatchRun['request'],
        started: Promise.resolve({
          agentId: child.agentId,
          turn: {} as never,
          completion: new Promise<{ summary: string }>(() => {}),
        }),
      };
    });
    const lifecycle = lifecycleHarness([source, target.handle]);
    const service = messagingService(store, lifecycle.service, sessionContext(), metadata, dispatch);
    const tool = new AgentSendTool({ agentId: 'main' } as IAgentScopeContext, metadata, service);
    const args = { target: 'chart_owner', message: '纵轴单位应为mm，数据不变。' };
    try {
      const saved = await executeTool(tool, { turnId: 1, toolCallId: 'tool-send-1', args, signal });
      expect(saved.isError).toBeFalsy();
      const receipt = JSON.parse(toolOutput(saved)) as { message_id: string; status: string; resumed?: boolean; deduplicated: boolean };
      expect(receipt).toMatchObject({ status: 'queued', deduplicated: false });
      expect(receipt.resumed).toBeUndefined();
      expect(receipt.message_id).toEqual(expect.any(String));
      await vi.waitFor(() => { expect(runs).toBe(1); });
      await vi.waitFor(async () => {
        expect((await store.accept(toolMessage(args.message, 'tool-send-1'))).delivery).toBe('delivered');
      });
      expect(target.messages.map((message) => message.content[0])).toEqual([
        { type: 'text', text: 'Message from agent "root" (main):\n\n纵轴单位应为mm，数据不变。' },
      ]);
      expect(runs).toBe(1);
      const again = await executeTool(tool, { turnId: 1, toolCallId: 'tool-send-1', args, signal });
      const retry = JSON.parse(toolOutput(again)) as { status: string; deduplicated: boolean; message_id: string };
      expect(retry).toMatchObject({ status: 'delivered', deduplicated: true, message_id: receipt.message_id });
      expect(runs).toBe(1);

      target.setRunning(true);
      const running = await executeTool(tool, {
        turnId: 2,
        toolCallId: 'tool-send-2',
        args: { target: 'chart_owner', message: '补一条运行中的输入' },
        signal,
      });
      const runningReceipt = JSON.parse(toolOutput(running)) as { status: string; resumed?: boolean };
      expect(runningReceipt).toMatchObject({ status: 'queued' });
      expect(runningReceipt.resumed).toBeUndefined();
      await waitUntil(() => target.pendingSteers() === 1);
      expect(runs).toBe(1);
      await target.beginStepBoundary(1);
      await vi.waitFor(async () => {
        expect((await store.accept(toolMessage('补一条运行中的输入', 'tool-send-2'))).delivery).toBe('delivered');
      });
      expect(runs).toBe(1);
      expect(target.messages.map((message) => message.content[0])).toEqual([
        { type: 'text', text: 'Message from agent "root" (main):\n\n纵轴单位应为mm，数据不变。' },
        { type: 'text', text: 'Message from agent "root" (main):\n\n补一条运行中的输入' },
      ]);
    } finally {
      await service.dispose();
      await sender.dispose();
    }
  });

  it('resumes an interrupted claim while the original handler remains in flight', async () => {
    const homeDir = tempDir();
    const seed = bootstrap(homeDir);
    const runtime = new HomeRuntimeHostService(seed);
    const threadStore = new RuntimeThreadMailboxStore(seed, runtime);
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
    const service = messagingService(store, lifecycle.service, sessionContext(), metadataHarness({ 'agent-target': {} }));
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
      await service.dispose();
    }
  });

  it('renders an external delegation sender distinctly at the next run boundary', async () => {
    const store = mailboxStore(tempDir());
    const target = agentHandle('agent-target');
    const lifecycle = lifecycleHarness([target.handle]);
    const service = messagingService(store, lifecycle.service, sessionContext(), metadataHarness({ 'agent-target': {} }));

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
    await service.dispose();
  });

  it('confirms a pending adapter ack before claiming again within the same run', async () => {
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
      listPendingTargets: async () => [],
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
    const service = messagingService(adapter, lifecycle.service, sessionContext(), metadataHarness({ 'agent-target': {} }));

    await target.execution.hooks.onWillRun.run({ signal });
    expect(target.messages).toHaveLength(1);
    expect(target.operations).toEqual(['appendObservable', 'flush']);
    expect(order).toEqual(['claim', 'ack-committed', 'ack-confirmed', 'claim']);
    expect(ackRequestIds).toHaveLength(2);
    expect(new Set(ackRequestIds).size).toBe(1);
    await service.dispose();
  });
});

describe('agent collaboration consumed mailbox recovery', () => {
  it('materializes a first native mailbox run exactly once without an earlier delivery hook', async () => {
    const ctx = createTestAgent();
    const message = recoveredMailboxMessage('first-mailbox-message');
    try {
      ctx.mockNextResponse({ type: 'text', text: 'handled' });
      const run = await ctx.get(IAgentExecutionService).run({ kind: 'mailbox', prompt: 'first', message }, { signal });
      await run.completion;
      await ctx.wire.flush();
      expect(ctx.llmCalls).toHaveLength(1);
      expect(ctx.context.get().filter(entry => entry.id === message.id)).toEqual([expect.objectContaining(message)]);
    } finally {
      await ctx.dispose();
    }
  });

  it.each(['missing', 'same-message', 'other-sender'] as const)('materializes a hook-blocked mailbox input from actual context identity: %s', async (existing) => {
    const ctx = createTestAgent();
    const message = recoveredMailboxMessage('blocked-mailbox');
    if (existing !== 'missing') {
      ctx.context.appendObservable({ ...message, origin: existing === 'same-message' ? message.origin : {
        kind: 'agent_message', messageId: message.id!, senderAgentId: 'other-agent', senderTaskName: 'other-task',
      } });
    }
    ctx.get(IAgentPromptService).hooks.onBeforeSubmitPrompt.register('block-mailbox', async (context, next) => { context.block = true; await next(); });
    try {
      const prompt = await ctx.get(IAgentPromptService).enqueue({ message, alreadyMaterialized: true });
      expect((await prompt.completion).state).toBe('blocked');
      expect(ctx.context.get().filter(entry => entry.origin?.kind === 'agent_message' && entry.origin.senderAgentId === 'main' && entry.id === message.id))
        .toEqual([expect.objectContaining(message)]);
      expect(ctx.llmCalls).toHaveLength(0);
    } finally {
      await ctx.dispose();
    }
  });

  it.each([false, true])('retains an unconsumed durable mailbox prompt until explicit recovery, cancelled=%s', async (cancelled) => {
    const adapter = mailboxStore(tempDir());
    const accepted = await adapter.accept(messageInput('unconsumed message', `unconsumed-${cancelled}`));
    const ctx = createTestAgent();
    ctx.get(IAgentExecutionService);
    const message = recoveredMailboxMessage(accepted.message.messageId, 'Message from agent "root" (main):\n\nunconsumed message');
    const events = [new PromptEnqueued({ schemaVersion: 1, promptId: message.id!, userMessageId: message.id!,
      createdAt: new Date(0).toISOString(), message, alreadyMaterialized: true, appendTiming: 'agent_idle', revision: 0, queueIndex: 0 }).serialize()];
    if (cancelled) events.push(new PromptOutcomeCommitted({ terminal: { promptId: message.id!, state: 'cancelled' } }).serialize());
    await ctx.restore(events);
    const handle = testAgentHandle(ctx, 'agent-target');
    const dispatch = dispatchHarness();
    const service = messagingService(adapter, lifecycleHarness([handle]).service, sessionContext(), metadataHarness({ 'agent-target': {} }), dispatch);
    try {
      await drain(100);
      expect((await adapter.accept(messageInput('unconsumed message', `unconsumed-${cancelled}`))).delivery).toBe('queued');
      expect(ctx.get(IAgentStateService).get(agentMessageMaterializationsKey)[message.id!]).toBeUndefined();
      expect(ctx.context.get().filter(entry => entry.id === message.id)).toHaveLength(0);
      expect(ctx.llmCalls).toHaveLength(0);
      expect(dispatch.runOnExisting).not.toHaveBeenCalled();
      ctx.mockNextResponse({ type: 'text', text: 'recovered once' });
      if (cancelled) {
        await (await ctx.get(IAgentPromptService).enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'independent new run' }], toolCalls: [], origin: { kind: 'user' } } })).completion;
      } else {
        ctx.get(IAgentPromptService).resumeRecoveredQueue();
        await vi.waitFor(() => { expect(ctx.llmCalls).toHaveLength(1); });
        await ctx.get(IAgentLoopService).settled();
      }
      expect(ctx.context.get().filter(entry => entry.id === message.id)).toEqual([expect.objectContaining(message)]);
      expect((await adapter.accept(messageInput('unconsumed message', `unconsumed-${cancelled}`))).delivery).toBe('delivered');
      expect(ctx.llmCalls).toHaveLength(1);
    } finally {
      await service.dispose();
      await ctx.dispose();
    }
  });

  it.each(['pending', 'launch-committed', 'cancelled-unlaunched', 'failed-unlaunched', 'turn-prompt', 'turn-steer', 'completed', 'cancelled-turn'] as const)(
    'restores only consumed agent message evidence from %s', async (phase) => {
      const ctx = createTestAgent();
      const message = recoveredMailboxMessage('restore-evidence');
      const enqueued = new PromptEnqueued({ schemaVersion: 1, promptId: message.id!, userMessageId: message.id!,
        createdAt: new Date(0).toISOString(), message, alreadyMaterialized: true,
        appendTiming: 'agent_idle', revision: 0, queueIndex: 0 });
      const launched = ['turn-prompt', 'turn-steer', 'completed', 'cancelled-turn'].includes(phase);
      const events = [enqueued.serialize()];
      if (phase === 'launch-committed') events.push(new PromptLaunchCommitted({ launchId: 'launch', promptId: message.id!, revision: 0, committedAt: new Date(0).toISOString() }).serialize());
      if (launched) {
        const TurnInput = phase === 'turn-steer' ? TurnSteer : TurnPrompt;
        events.push(new TurnInput({ promptId: message.id, turnId: 3, input: message.content, origin: message.origin! }).serialize());
      }
      if (phase === 'completed' || phase === 'cancelled-turn' || phase === 'cancelled-unlaunched' || phase === 'failed-unlaunched') {
        events.push(new PromptOutcomeCommitted({ terminal: { promptId: message.id!,
          turnId: launched ? 3 : undefined,
          state: phase === 'completed' ? 'completed' : phase === 'failed-unlaunched' ? 'failed' : 'cancelled' } }).serialize());
      }
      try {
        await ctx.restore(events);
        expect(ctx.get(IAgentStateService).get(agentMessageMaterializationsKey)[message.id!]).toBe(launched ? true : undefined);
        expect(ctx.context.get().filter(entry => entry.id === message.id)).toHaveLength(0);
        expect(ctx.llmCalls).toHaveLength(0);
      } finally {
        await ctx.dispose();
      }
    },
  );

  it('completes a real native mailbox wake once, then recovers its failed receipt across restart without another run', async () => {
    const { adapter, thread } = rawMailbox(tempDir());
    const claimNext = thread.claimNext.bind(thread);
    vi.spyOn(thread, 'claimNext').mockImplementation((input, options) => claimNext({ ...input, leaseMs: 1 }, options));
    const targetPersistence = new InMemoryWireRecordPersistence();
    const senderPersistence = new InMemoryWireRecordPersistence();
    let target = createTestAgent({ persistence: targetPersistence });
    let sender = createTestAgent({ persistence: senderPersistence });
    let diskFull = true;
    const flush = sender.wire.flush.bind(sender.wire);
    vi.spyOn(sender.wire, 'flush').mockImplementation(async () => {
      await flush();
      if (diskFull) throw new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'simulated receipt ENOSPC');
    });
    const dispatch = dispatchHarness(async (child, request, options) => ({ child, request: request as DispatchRun['request'],
      started: child.agent.accessor.get(IAgentExecutionService).run(request as DispatchRun['request'], { signal: options.signal }) }));
    const metadata = metadataHarness({ main: {}, 'agent-target': {} });
    let service = messagingService(adapter, lifecycleHarness([testAgentHandle(sender, 'main'), testAgentHandle(target, 'agent-target')]).service,
      sessionContext(), metadata, dispatch);
    try {
      target.mockNextResponse({ type: 'text', text: 'mailbox wake completed' });
      const accepted = await service.send({ ...sendInput('native wake', 'wake-restart'), idleWake: 'owned-child', waitForRunningDelivery: true });
      await target.get(IAgentExecutionService).settled();
      await target.wire.flush();
      expect(target.llmCalls).toHaveLength(1);
      expect(target.context.get().filter(entry => entry.id === accepted.message.messageId)).toHaveLength(1);
      expect(dispatch.runOnExisting).toHaveBeenCalledTimes(1);
      expect(targetPersistence.records).toContainEqual(expect.objectContaining({ type: 'prompt.outcome_committed',
        terminal: expect.objectContaining({ promptId: accepted.message.messageId, state: 'completed' }) }));
      expect((await adapter.accept(messageInput('native wake', 'wake-restart'))).delivery).toBe('delivered');
      await vi.waitFor(async () => {
        expect(await receiptStorage.get(adapter)!.list(sessionContext().scope('agent-message-receipts/main'))).toHaveLength(1);
      });
      await service.dispose();
      await target.dispose();
      diskFull = false;
      await sender.dispose();
      target = createTestAgent({ persistence: targetPersistence });
      target.get(IAgentExecutionService);
      await target.restorePersisted();
      sender = createTestAgent({ persistence: senderPersistence });
      sender.get(IAgentExecutionService);
      await sender.restorePersisted();
      service = messagingService(adapter, lifecycleHarness([testAgentHandle(sender, 'main'), testAgentHandle(target, 'agent-target')]).service,
        sessionContext(), metadata, dispatch);
      await vi.waitFor(async () => { expect((await adapter.accept(messageInput('native wake', 'wake-restart'))).delivery).toBe('delivered'); });
      expect(target.context.get().filter(entry => entry.id === accepted.message.messageId)).toHaveLength(1);
      expect(target.llmCalls).toHaveLength(0);
      expect(sender.llmCalls).toHaveLength(0);
      expect(dispatch.runOnExisting).toHaveBeenCalledTimes(1);
      expect(senderPersistence.records.filter(record => record.type === 'agent_message.delivered')).toHaveLength(1);
    } finally {
      diskFull = false;
      await service.dispose();
      await target.dispose();
      await sender.dispose();
    }
  });

  it('acknowledges an old consumed claim after durable run completion and restart without appending or waking', async () => {
    const { adapter, thread } = rawMailbox(tempDir());
    const claimNext = thread.claimNext.bind(thread);
    vi.spyOn(thread, 'claimNext').mockImplementation((input, options) => claimNext({ ...input, leaseMs: 1 }, options));
    const accepted = await adapter.accept(messageInput('handled before restart', 'consumed-before-restart'));
    await adapter.nextQueued('session-1', 'agent-target');
    const persistence = new InMemoryWireRecordPersistence();
    let target = createTestAgent({ persistence });
    const message = recoveredMailboxMessage(accepted.message.messageId, 'handled before restart');
    const dispatcher = target.get(IEventDispatcher);
    await dispatcher.dispatch(new PromptEnqueued({ schemaVersion: 1, promptId: message.id!, userMessageId: message.id!,
      createdAt: new Date(0).toISOString(), message, alreadyMaterialized: true, appendTiming: 'agent_idle', revision: 0, queueIndex: 0 }));
    await dispatcher.dispatch(new TurnPrompt({ turnId: 3, promptId: message.id, input: message.content, origin: message.origin! }));
    await dispatcher.dispatch(new PromptOutcomeCommitted({ terminal: { promptId: message.id!, turnId: 3, state: 'completed', result: { type: 'completed', steps: 1, truncated: false } } }));
    await target.wire.flush();
    expect(persistence.records.some(record => record.type === 'prompt.outcome_committed')).toBe(true);
    expect(persistence.records.filter(record => record.type === 'context.append_message' && (record['message'] as ContextMessage)?.id === message.id)).toHaveLength(0);
    await target.dispose();
    target = createTestAgent({ persistence });
    target.get(IAgentExecutionService);
    await target.restorePersisted();
    const sender = createTestAgent();
    const dispatch = dispatchHarness();
    const lifecycle = lifecycleHarness([testAgentHandle(sender, 'main'), testAgentHandle(target, 'agent-target')]);
    const service = messagingService(adapter, lifecycle.service, sessionContext(), metadataHarness({ main: {}, 'agent-target': {} }), dispatch);
    try {
      await vi.waitFor(async () => {
        expect((await adapter.accept(messageInput('handled before restart', 'consumed-before-restart'))).delivery).toBe('delivered');
      });
      const retry = await service.send({ ...sendInput('handled before restart', 'consumed-before-restart'), idleWake: 'owned-child', waitForRunningDelivery: true });
      expect(retry).toMatchObject({ delivery: 'delivered', deduplicated: true });
      expect(dispatch.runOnExisting).not.toHaveBeenCalled();
      expect(target.llmCalls).toHaveLength(0);
      expect(sender.llmCalls).toHaveLength(0);
      expect(target.context.get().filter(entry => entry.id === message.id)).toHaveLength(0);
      const receipts = [];
      for await (const record of sender.wire.readJournal()) if (record.type === 'agent_message.delivered') receipts.push(record);
      expect(receipts).toEqual([expect.objectContaining({ messageId: message.id, targetAgentId: 'agent-target' })]);
      target.mockNextResponse({ type: 'text', text: 'unrelated new run' });
      await (await target.get(IAgentPromptService).enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'new request' }], toolCalls: [], origin: { kind: 'user' } } })).completion;
      expect(target.llmCalls).toHaveLength(1);
      expect(target.context.get().filter(entry => entry.id === message.id)).toHaveLength(0);
    } finally {
      await service.dispose();
      await target.dispose();
      await sender.dispose();
    }
  });

  it.each(['leased', 'stale-fence'] as const)('recovers an old consumed claim after %s clears without trusting a stale acknowledgement', async (failure) => {
    const adapter = mailboxStore(tempDir());
    const accepted = await adapter.accept(messageInput('consumed', `old-claim-${failure}`));
    const queued = await adapter.nextQueued('session-1', 'agent-target');
    if (queued === undefined) throw new Error('missing test claim');
    const senderPersistence = new InMemoryWireRecordPersistence();
    const sender = createTestAgent({ persistence: senderPersistence });
    const target = createTestAgent();
    const message = recoveredMailboxMessage(accepted.message.messageId);
    await target.get(IEventDispatcher).dispatch(new TurnPrompt({ turnId: 2, input: message.content, origin: message.origin! }));
    await target.wire.flush();
    let leased = failure === 'leased';
    let delivered = false;
    const nextQueued = vi.fn(async () => delivered || leased ? undefined : queued);
    const markDelivered = vi.fn(async () => {
      if (failure === 'stale-fence' && markDelivered.mock.calls.length === 1) return false;
      delivered = true;
      return true;
    });
    const store = wrapStore(adapter, { nextQueued, markDelivered, listPendingAgents: async () => delivered ? [] : ['agent-target'] });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const service = messagingService(store, lifecycleHarness([testAgentHandle(sender, 'main'), testAgentHandle(target, 'agent-target')]).service,
      sessionContext(), metadataHarness({ main: {}, 'agent-target': {} }));
    try {
      await drain(100);
      expect(delivered).toBe(false);
      leased = false;
      await vi.advanceTimersByTimeAsync(30_000);
      await drain(100);
      expect(delivered).toBe(true);
      expect(markDelivered).toHaveBeenCalledTimes(failure === 'leased' ? 1 : 2);
      expect(senderPersistence.records.filter(record => record.type === 'agent_message.delivered')).toHaveLength(1);
      expect(target.context.get().filter(entry => entry.id === message.id)).toHaveLength(0);
      expect(target.llmCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await service.dispose();
      await sender.dispose();
      await target.dispose();
    }
  });

  it.each([
    { disposed: false, failure: 'storage' },
    { disposed: true, failure: 'storage' },
    { disposed: false, failure: 'runtime' },
    { disposed: true, failure: 'runtime' },
  ])('retries only the consumed acknowledgement after $failure recovery and stops on disposal=$disposed', async ({ disposed, failure }) => {
    const adapter = mailboxStore(tempDir());
    const accepted = await adapter.accept(messageInput('consumed', `ack-timer-${failure}-${disposed}`));
    const queued = await adapter.nextQueued('session-1', 'agent-target');
    if (queued === undefined) throw new Error('missing test claim');
    const senderPersistence = new InMemoryWireRecordPersistence();
    const sender = createTestAgent({ persistence: senderPersistence });
    const target = createTestAgent();
    const message = recoveredMailboxMessage(accepted.message.messageId);
    await target.get(IEventDispatcher).dispatch(new TurnPrompt({ turnId: 2, input: message.content, origin: message.origin! }));
    await target.wire.flush();
    let unavailable = true;
    let delivered = false;
    const markDelivered = vi.fn(async () => {
      if (unavailable) throw failure === 'runtime'
        ? new HomeRuntimeError('runtime.timeout', 'ownerPhase=acknowledge')
        : new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'simulated ENOSPC');
      delivered = true;
      return true;
    });
    const store = wrapStore(adapter, { nextQueued: async () => delivered ? undefined : queued, markDelivered });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const service = messagingService(store, lifecycleHarness([testAgentHandle(sender, 'main'), testAgentHandle(target, 'agent-target')]).service,
      sessionContext(), metadataHarness({ main: {}, 'agent-target': {} }));
    try {
      await drain(100);
      expect(markDelivered).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(markDelivered).toHaveBeenCalledTimes(1);
      unavailable = false;
      if (disposed) await service.dispose();
      await vi.advanceTimersByTimeAsync(1);
      await drain(100);
      expect(delivered).toBe(!disposed);
      expect(markDelivered).toHaveBeenCalledTimes(disposed ? 1 : 2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(markDelivered).toHaveBeenCalledTimes(disposed ? 1 : 2);
      expect(senderPersistence.records.filter(record => record.type === 'agent_message.delivered')).toHaveLength(1);
      expect(target.context.get().filter(entry => entry.id === message.id)).toHaveLength(0);
      expect(target.llmCalls).toHaveLength(0);
      expect(sender.llmCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await service.dispose();
      await sender.dispose();
      await target.dispose();
    }
  });

  it.each(['sender-flush', 'mailbox-ack'] as const)('recovers a consumed claim after ENOSPC at %s with one receipt and no body or model replay', async (failure) => {
    const adapter = mailboxStore(tempDir());
    const accepted = await adapter.accept(messageInput('already consumed', `consumed-enospc-${failure}`));
    const target = createTestAgent();
    const senderPersistence = new InMemoryWireRecordPersistence();
    let sender = createTestAgent({ persistence: senderPersistence });
    const message = recoveredMailboxMessage(accepted.message.messageId);
    await target.get(IEventDispatcher).dispatch(new TurnPrompt({ turnId: 7, promptId: message.id, input: message.content, origin: message.origin! }));
    await target.wire.flush();
    let diskFull = true;
    const error = new StorageError(StorageErrors.codes.STORAGE_DISK_FULL, 'simulated ENOSPC', { details: { committed: true } });
    const flush = sender.wire.flush.bind(sender.wire);
    vi.spyOn(sender.wire, 'flush').mockImplementation(async () => { await flush(); if (failure === 'sender-flush' && diskFull) throw error; });
    const store = wrapStore(adapter, { markDelivered: async claim => { if (failure === 'mailbox-ack' && diskFull) throw error; return adapter.markDelivered(claim); } });
    let service = messagingService(store, lifecycleHarness([testAgentHandle(sender, 'main'), testAgentHandle(target, 'agent-target')]).service,
      sessionContext(), metadataHarness({ main: {}, 'agent-target': {} }));
    try {
      await drain(100);
      const attempt = target.get(IAgentExecutionService).hooks.onWillRun.run({ signal });
      if (failure === 'mailbox-ack') await expect(attempt).rejects.toMatchObject({ code: 'storage.disk_full' });
      else await attempt;
      expect((await adapter.accept(messageInput('already consumed', `consumed-enospc-${failure}`))).delivery).toBe(failure === 'mailbox-ack' ? 'queued' : 'delivered');
      expect(target.context.get().filter(entry => entry.id === message.id)).toHaveLength(0);
      expect(senderPersistence.records.filter(record => record.type === 'agent_message.delivered')).toHaveLength(1);
      diskFull = false;
      await target.get(IAgentExecutionService).hooks.onWillRun.run({ signal });
      await service.dispose();
      await sender.dispose();
      sender = createTestAgent({ persistence: senderPersistence });
      sender.get(IAgentExecutionService);
      await sender.restorePersisted();
      service = messagingService(store, lifecycleHarness([testAgentHandle(sender, 'main'), testAgentHandle(target, 'agent-target')]).service,
        sessionContext(), metadataHarness({ main: {}, 'agent-target': {} }));
      await target.get(IAgentExecutionService).hooks.onWillRun.run({ signal });
      expect((await adapter.accept(messageInput('already consumed', `consumed-enospc-${failure}`))).delivery).toBe('delivered');
      expect(senderPersistence.records.filter(record => record.type === 'agent_message.delivered')).toHaveLength(1);
      expect(target.context.get().filter(entry => entry.id === message.id)).toHaveLength(0);
      expect(target.llmCalls).toHaveLength(0);
      expect(sender.llmCalls).toHaveLength(0);
    } finally {
      diskFull = false;
      await service.dispose();
      await target.dispose();
      await sender.dispose();
    }
  });
});

function testAgentHandle(ctx: ReturnType<typeof createTestAgent>, id: string): IAgentScopeHandle {
  return { id, kind: LifecycleScope.Agent, accessor: { get: <T>(key: ServiceIdentifier<T>): T => ctx.get(key) }, dispose: () => {} };
}

function recoveredMailboxMessage(id: string, text = 'saved mailbox message'): ContextMessage {
  return { id, role: 'user', content: [{ type: 'text', text }], toolCalls: [],
    origin: { kind: 'agent_message', messageId: id, senderAgentId: 'main', senderTaskName: 'root' } };
}

describe('agent collaboration mailbox restart durability', () => {
  it('delivers queued messages FIFO after the service and store are rebuilt on the same home', async () => {
    const homeDir = tempDir();
    const firstStore = mailboxStore(homeDir);
    const firstService = messagingService(
      firstStore,
      lifecycleHarness([]).service,
      sessionContext(),
      metadataHarness({ 'agent-target': {} }),
    );
    const first = await firstService.send(sendInput('first', 'call-1'));
    const second = await firstService.send(sendInput('second', 'call-2'));
    await firstService.dispose();

    const reopened = mailboxStore(homeDir);
    const target = agentHandle('agent-target');
    const lifecycle = lifecycleHarness([target.handle]);
    const service = messagingService(
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
    await service.dispose();
  });

  it('discards queued messages for agents missing from the session registry and records the skip', async () => {
    const homeDir = tempDir();
    const { adapter, thread } = rawMailbox(homeDir);
    const orphan = await adapter.accept(messageInput('orphan', 'orphan-1'));
    const kept = await adapter.accept({ ...messageInput('kept', 'kept-1'), targetAgentId: 'main' });
    const lifecycle = lifecycleHarness([]);
    const service = messagingService(
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
    await service.dispose();
  });

  it('never discards queued messages for the main agent', async () => {
    const homeDir = tempDir();
    const { adapter, thread } = rawMailbox(homeDir);
    await adapter.accept(messageInput('orphan', 'orphan-2'));
    const mainMessage = await adapter.accept({
      ...messageInput('for main', 'main-1'),
      targetAgentId: 'main',
    });
    const service = messagingService(
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
    await service.dispose();
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
    const fresh = messagingService(
      adapter,
      lifecycleHarness([]).service,
      sessionContext(),
      metadataHarness({}, { createdByLoad: true, onCreatedByLoad: swept }),
    );

    await sweepChecked;
    await drain();

    expect(await pendingAgentIds(thread)).toEqual(['agent-target']);

    const existing = messagingService(
      adapter,
      lifecycleHarness([]).service,
      sessionContext(),
      metadataHarness({}),
    );
    await waitFor(async () => {
      const page = await thread.readActivity(target, 0, 10);
      return page.activities.some((activity) => activity.messageId === orphan.message.messageId);
    });
    const page = await thread.readActivity(target, 0, 10);
    expect(page.activities).toEqual([
      expect.objectContaining({
        kind: 'message_undeliverable',
        messageId: orphan.message.messageId,
        reason: 'target agent is not registered in the session',
      }),
    ]);
    await fresh.dispose();
    await existing.dispose();
  });

  it('re-reads the agent registry per pending target so a late registration is not discarded', async () => {
    const homeDir = tempDir();
    const { adapter, thread } = rawMailbox(homeDir);
    await adapter.accept(messageInput('late', 'late-1'));
    await adapter.accept({ ...messageInput('gone', 'gone-1'), targetAgentId: 'agent-ghost' });
    let registry: Readonly<Record<string, AgentMeta>> = {};
    const service = messagingService(
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
    await service.dispose();
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
    const service = messagingService(
      adapter,
      lifecycleHarness([target.handle]).service,
      sessionContext(),
      metadataHarness({ 'agent-target': {} }),
    );
    await target.execution.hooks.onWillRun.run({ signal });

    expect(target.messages.map((message) => message.id)).toEqual([accepted.message.messageId]);
    expect(await adapter.nextQueued('session-1', 'agent-target')).toBeUndefined();
    await cleanup.dispose();
    await service.dispose();
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

    await vi.waitFor(async () => {
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
    });
    await cleanup.dispose();
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
  const original = CanonicalMailboxDatabase.prototype.partitionBatch;
  let markEntered!: () => void;
  let releaseBatch!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseBatch = resolve;
  });
  let blockedOnce = false;
  CanonicalMailboxDatabase.prototype.partitionBatch = async function (...args: Parameters<typeof original>) {
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
      CanonicalMailboxDatabase.prototype.partitionBatch = original;
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
  const thread = new RuntimeThreadMailboxStore(seed, runtime);
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
    credentialsHomeDir: homeDir,
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

function noticeText(message: ContextMessage): string {
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('');
}

function contextText(sender: ReturnType<typeof createTestAgent>): string {
  return sender.context.get().map((message) => noticeText(message)).join('\n');
}

function toolOutput(result: { readonly output: string | readonly unknown[] }): string {
  expect(typeof result.output).toBe('string');
  return result.output as string;
}

function toolMessage(content: string, idempotencyKey: string) {
  return { ...messageInput(content, idempotencyKey), targetTaskName: 'chart_owner' };
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
    waitForRunningDelivery: true,
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
    readonly custom?: Record<string, unknown>;
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
      custom: options.custom,
      agents: typeof agents === 'function' ? agents() : agents,
    }),
    getAgentExecutor: async (agentId: string) => (typeof agents === 'function' ? agents() : agents)[agentId]?.executor,
    createdByLoad: () => {
      options.onCreatedByLoad?.();
      return options.createdByLoad ?? false;
    },
  } as unknown as ISessionMetadata;
}

function residencyHarness(lifecycle: AgentLifecycle) {
  let pins = 0;
  const acquire = vi.fn(async (_sessionId: string, _reason: string) => {
    pins++;
    return {
      handle: {
        id: 'session-1',
        kind: LifecycleScope.Session as const,
        accessor: {
          get: <T>(id: ServiceIdentifier<T>): T => {
            if (id === IAgentLifecycleService) return lifecycle as T;
            throw new Error('unexpected session service');
          },
        },
        dispose: () => {},
      },
      dispose: () => { pins--; },
    };
  });
  const manager = {
    acquire,
    evictIfIdle: async (_sessionId: string) => pins === 0,
  } as unknown as ISessionManager;
  return { manager, acquire, pins: () => pins };
}

const receiptStorage = new WeakMap<IAgentCollaborationMessageStore, InMemoryStorageService>();

function messagingService(
  store: IAgentCollaborationMessageStore,
  lifecycle: AgentLifecycle,
  session: ISessionContext,
  metadata: ISessionMetadata,
  dispatch: ISessionDispatchService = dispatchHarness(),
  manager: ISessionManager = residencyHarness(lifecycle).manager,
  log: ILogService = stubLog(),
): AgentCollaborationMessagingService {
  const ix = new TestInstantiationService();
  let storage = receiptStorage.get(store);
  if (storage === undefined) {
    storage = new InMemoryStorageService();
    receiptStorage.set(store, storage);
  }
  ix.set(IFileSystemStorageService, storage);
  ix.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
  ix.set(IAgentCollaborationMessageStore, store);
  ix.set(IAgentLifecycleService, lifecycle);
  ix.set(ISessionContext, session);
  ix.set(ISessionMetadata, metadata);
  ix.set(ISessionDispatchService, dispatch);
  ix.set(ISessionManager, manager);
  ix.set(ILogService, log);
  ix.set(IAgentCollaborationMessagingService, new SyncDescriptor(AgentCollaborationMessagingService));
  return ix.get(IAgentCollaborationMessagingService) as AgentCollaborationMessagingService;
}

function dispatchHarness(
  runOnExisting: ISessionDispatchService['runOnExisting'] = async () => {
    throw new Error('unexpected wake');
  },
  resolveOwnedChild: ISessionDispatchService['resolveOwnedChild'] = async () => {
    throw new Error('unexpected child resolution');
  },
): ISessionDispatchService {
  return {
    _serviceBrand: undefined,
    resolveOwnedChild: vi.fn(resolveOwnedChild),
    runOnExisting: vi.fn(runOnExisting),
    recordDelegatedRun: vi.fn(),
  } as unknown as ISessionDispatchService;
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

function agentHandle(
  agentId: string,
  options: {
    readonly executorId?: string;
    readonly pauseAfterWillRun?: () => Promise<void>;
    readonly holdAfterPrepare?: boolean;
    readonly onPrepareHeld?: () => void;
    readonly enqueued?: ContextMessage[];
    readonly dispatcher?: { dispatch: (event: { notificationType?: string; body?: string; sourceId?: string; sourceKind?: string }) => Promise<void> };
    readonly recoverableBroken?: boolean;
    readonly retryableBroken?: boolean;
    readonly acceptExternalSteer?: boolean;
    readonly externalSteerResult?: 'unknown';
    readonly pauseWhileRunning?: () => Promise<void>;
    readonly allowKikiSubagents?: boolean;
    readonly delegationSource?: 'harness-default' | 'profile' | 'session' | 'harness-settings';
  } = {},
) {
  const messages: ContextMessage[] = [];
  const materialized: Record<string, true> = {};
  const operations: string[] = [];
  const pendingSteers: Array<{
    readonly message: ContextMessage;
    readonly resolve: (delivered: boolean) => void;
  }> = [];
  const remoteRequests: AgentRunRequest[] = [];
  const steeredTexts: string[] = [];
  const executionHooks = createHooks<
    { onWillRun: AgentExecutionRunContext },
    'onWillRun'
  >(['onWillRun']);
  let state: 'idle' | 'starting' | 'running' | 'cancelling' | 'broken' = 'idle';
  let runsSettled = Promise.resolve();
  let rejectHeldStart: (error: unknown) => void = () => {};
  let abortHeldStart: () => void = () => {};
  let heldPrepare = false;
  const enrollRun = (): (() => void) => {
    let resolveRun!: () => void;
    const done = new Promise<void>((resolve) => { resolveRun = resolve; });
    const current = runsSettled;
    runsSettled = Promise.all([current, done]).then(() => undefined);
    return resolveRun;
  };
  const memory: AgentContextMemory = {
    _serviceBrand: undefined,
    get: () => messages,
    append: (...added) => { operations.push('append'); messages.push(...added); },
    appendObservable: (message) => {
      operations.push('appendObservable');
      messages.push(message);
      if (message.origin?.kind === 'agent_message') materialized[message.origin.messageId] = true;
    },
    appendManaged: (message, _delivery) => { operations.push('appendObservable'); messages.push(message); },
    appendLoopEvent: () => {},
    publishTrailingRemoval: () => false,
    hooks: { onDidClear: { register: () => ({ dispose() {} }), delete: () => false, run: async () => {} } },
    clear: async () => {},
    undo: () => { throw new Error('unexpected undo'); },
    undoAndReplace: async (count, replacementPrompt) => {
      const cut = computeUndoCut(messages, count);
      if (cut.cutIndex >= 0 && cut.removedCount >= count) {
        messages.splice(cut.cutIndex, messages.length - cut.cutIndex, replacementPrompt.message);
      }
      return cut;
    },
    applyCompaction: () => { throw new Error('unexpected compaction'); },
  };
  const execution = {
    _serviceBrand: undefined,
    attachLocalSession: async () => { throw new Error('unexpected local attachment'); },
    trackPromptRun: (_completion: Promise<unknown>, signal: AbortSignal) => signal,
    run: async (request: AgentRunRequest, runOptions: RunAgentOptions) => {
      if (options.executorId === undefined) throw new Error('unexpected run');
      const resolveRun = enrollRun();
      const afterStartCallbacks: Array<() => Promise<void>> = [];
      const context: AgentExecutionRunContext = {
        signal: runOptions.signal,
        request,
        replaceRequest: (replacement) => {
          context.request = replacement;
        },
        afterStart: (callback) => {
          afterStartCallbacks.push(callback);
        },
      };
      try {
        if (options.pauseAfterWillRun !== undefined || options.holdAfterPrepare === true) state = 'starting';
        await executionHooks.onWillRun.run(context);
        remoteRequests.push(context.request ?? request);
        if (options.pauseWhileRunning !== undefined) {
          state = 'running';
          await options.pauseWhileRunning();
        }
        if (options.holdAfterPrepare === true && !heldPrepare) {
          heldPrepare = true;
          await new Promise<void>((_resolve, reject) => {
            rejectHeldStart = reject;
            abortHeldStart = () => {
              state = 'cancelling';
              reject(new Error('The operation was aborted'));
            };
            options.onPrepareHeld?.();
          });
        }
        await options.pauseAfterWillRun?.();
        await Promise.allSettled(
          afterStartCallbacks.map(async (callback) => {
            await callback();
          }),
        );
        return {
          agentId,
          turn: { id: 1 } as never,
          completion: Promise.resolve({ summary: 'done' }),
        };
      } finally {
        if (state === 'starting' || state === 'cancelling') state = 'idle';
        resolveRun();
      }
    },
    status: () => state === 'running'
      ? { state: 'running' as const, turnId: 1 }
      : state === 'starting'
        ? { state: 'starting' as const }
        : state === 'cancelling'
          ? { state: 'cancelling' as const, turnId: 1 }
          : state === 'broken'
            ? { state: 'broken' as const }
            : { state: 'idle' as const },
    steer: (message: ContextMessage): Promise<boolean | 'unknown'> => {
      if (state !== 'running') return Promise.resolve(false);
      if (options.externalSteerResult === 'unknown') return Promise.resolve('unknown');
      if (options.acceptExternalSteer === true) {
        steeredTexts.push(message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n'));
        return Promise.resolve(true);
      }
      if (options.executorId !== undefined) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => pendingSteers.push({ message, resolve }));
    },
    cancel: () => {
      abortHeldStart();
      return state === 'cancelling';
    },
    settled: () => runsSettled,
    shutdown: () => Promise.resolve(),
    canResumeBrokenOriginal: () => options.recoverableBroken === true,
    canRetryBrokenExecution: () => options.retryableBroken === true,
    hooks: executionHooks,
  } as AgentExecution;
  const loop = {
    _serviceBrand: undefined,
    enqueue: (request: { resolveContextMessages: () => readonly ContextMessage[] }) => {
      if (options.enqueued === undefined) throw new Error('unexpected enqueue');
      options.enqueued.push(...request.resolveContextMessages());
      return { assigned: Promise.resolve({}), abort: () => false };
    },
    run: async () => ({ type: 'completed', steps: 0, truncated: false } as const),
    status: () => ({
      state: state === 'running' ? 'running' as const : 'idle' as const,
      activeTurnId: state === 'running' ? 1 : undefined,
      pendingTurnIds: [],
      hasPendingRequests: false,
    }),
    cancel: () => false,
    cancelFromUser: () => {},
    tryAcquireQuiescence: () => undefined,
    atStepBoundary: (run: (boundary: import('#/agent/loop/loop').StepBoundary | undefined) => Promise<void>) => run(undefined),
    settled: () => Promise.resolve(),
    recoverPersistence: async () => true,
    hasPendingRequests: () => false,
    registerLoopErrorHandler: () => ({ dispose: () => {} }),
    hooks: createHooks(['onWillBeginStep', 'onDidFinishStep']),
  } as unknown as AgentLoop;
  const prompt = {
    _serviceBrand: undefined,
    list: () => ({ active: undefined, pending: [] }),
  };
  const profile = {
    _serviceBrand: undefined,
    data: () => ({
      profileName: 'test',
      thinkingLevel: 'off',
      executorId: options.executorId,
      allowKikiSubagents: options.allowKikiSubagents,
      execution: options.delegationSource === undefined ? undefined : {
        sources: { allow_kiki_subagents: options.delegationSource },
        effective: { allow_kiki_subagents: options.allowKikiSubagents ?? false },
      },
    }),
    prepareResumeBinding: async () => ({ model: 'test-model', thinking: 'off', config: {}, assertCurrent: () => {}, syncMetadata: async () => {} }),
    getModel: () => 'test-model',
    getEffectiveThinkingLevel: () => 'off',
    republishStatus: () => {},
  };
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
        if (id === IAgentStateService) return { get: (key: unknown) => key === agentMessageMaterializationsKey ? materialized : {} } as T;
        if (id === IAgentExecutionService) return execution as T;
        if (id === IAgentLoopService) return loop as T;
        if (id === IAgentPromptService) return prompt as T;
        if (id === IAgentProfileService) return profile as T;
        if (id === IAgentToolPolicyService) return { isToolActive: () => false } as T;
        if (id === IAgentModelSwitchService) return { get: () => undefined, execute: async () => ({ state: 'completed' }) } as T;
        if (id === IAgentTokenCountingService) return { statusSize: () => 0 } as T;
        if (id === IWireService) return wire as T;
        if (id === IAgentLifecycleService) return undefined as T;
        if (id === IEventDispatcher && options.dispatcher !== undefined) return options.dispatcher as T;
        throw new Error('unexpected agent service');
      },
    },
    dispose: () => {},
  };
  return {
    handle,
    execution,
    messages,
    operations,
    remoteRequests,
    steeredTexts: () => steeredTexts,
    setRunning(running: boolean) {
      state = running ? 'running' : 'idle';
      if (!running) this.releaseSteers(false);
    },
    releaseSteers(accepted: boolean) {
      for (const pending of pendingSteers.splice(0)) {
        if (accepted) memory.appendObservable(pending.message);
        pending.resolve(accepted);
      }
    },
    setExecutionState(next: 'starting' | 'cancelling' | 'broken') {
      state = next;
    },
    failHeldStart(error: unknown) {
      rejectHeldStart(error);
    },
    cancelHeldStart() {
      abortHeldStart();
    },
    pendingSteers: () => pendingSteers.length,
    async beginStepBoundary(step: number) {
      const pending = pendingSteers.shift();
      if (pending !== undefined) {
        memory.appendObservable(pending.message);
        pending.resolve(true);
      }
      await loop.hooks.onWillBeginStep.run({
        turnId: 1,
        step,
        firstStepOfTurn: step === 1,
        signal,
      });
    },
  };
}
