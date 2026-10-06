import { Disposable, DisposableMap, DisposableStore } from '#/_base/di/lifecycle';
import { isPromiseLike } from '#/_base/lifecycle/disposer';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { abortable } from '#/_base/utils/abort';
import { LifecycleScope } from '#/app/scopes';
import { ILogService } from '#/_base/log/log';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ScopeActivation, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { AgentMessageOrigin, ContextMessage } from '#/agent/contextMemory/types';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentStateService } from '#/agent/state/agentState';
import { agentMessageMaterializationsKey, agentMessageReceiptsKey } from './messageReceiptState';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { IWireService } from '#/wire/wire';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { delegatorRef, labelsFromAgentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { COLLABORATION_TASK_NAME_LABEL } from '#/session/agentCollaboration/registry';
import {
  ISessionDispatchService,
  type DispatchChild,
} from '#/session/dispatch/dispatch';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { AgentRunRequest } from '#/session/subagent/subagent';

import {
  IAgentCollaborationMessageStore,
  IAgentCollaborationMessagingService,
  type AgentMessageAcceptance,
  type QueuedAgentMessage,
} from './messageMailbox';
import { AgentMessageDelivered } from './messageEvents';

const DELIVERY_HOOK_ID = 'agent-collaboration-message-delivery';
const MISSING_TARGET_REASON = 'target agent is not registered in the session';

interface ClaimedAgentMessage {
  readonly queued: QueuedAgentMessage;
  flushed: boolean;
}

interface PreparedExternalDelivery {
  readonly messageId: string;
  readonly request: AgentRunRequest;
}

export class AgentCollaborationMessagingService extends Disposable implements IAgentCollaborationMessagingService {
  declare readonly _serviceBrand: undefined;
  private readonly subscriptions = this._register(new DisposableMap<string>());
  private readonly deliveryTails = new Map<string, Promise<void>>();
  private readonly wakeTails = new Map<string, Promise<void>>();
  private readonly receiptTails = new Map<string, Promise<void>>();
  private readonly claimed = new Map<string, ClaimedAgentMessage>();

  constructor(
    @IAgentCollaborationMessageStore private readonly store: IAgentCollaborationMessageStore,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionDispatchService private readonly dispatch: ISessionDispatchService,
    @ISessionManager private readonly sessions: ISessionManager,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    for (const handle of lifecycle.list()) this.attach(handle);
    this._register(lifecycle.onDidCreate((handle) => {
      this.attach(handle);
    }));
    this._register(lifecycle.onDidDispose((agentId) => {
      const result = this.subscriptions.deleteAndDispose(agentId);
      if (isPromiseLike(result)) result.catch(onUnexpectedError);
    }));
    this.discardUnregisteredTargetMessages().catch(onUnexpectedError);
  }

  async sendUserMessage(input: {
    readonly targetAgentId: string;
    readonly content: string;
    readonly idempotencyKey: string;
  }): Promise<AgentMessageAcceptance> {
    const meta = (await this.metadata.read()).agents?.[input.targetAgentId];
    const ownerId = meta?.parentAgentId ?? (meta?.delegator?.kind === 'agent' ? meta.delegator.agentId : undefined);
    if (meta?.type !== 'sub' || (meta.executor ?? 'native') === 'native' || !ownerId) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, `Agent "${input.targetAgentId}" is not an external subagent`);
    }
    return this.send({
      ...input,
      sourceAgentId: ownerId,
      sourceTaskName: 'user',
      senderKind: 'user',
      targetTaskName: meta.displayName ?? input.targetAgentId,
      idleWake: 'owned-child',
      waitForRunningDelivery: true,
    });
  }

  async send(input: {
    readonly sourceAgentId: string;
    readonly sourceTaskName: string;
    readonly senderKind?: 'user';
    readonly targetAgentId: string;
    readonly targetTaskName: string;
    readonly content: string;
    readonly idempotencyKey: string;
    readonly waitForRunningDelivery?: boolean;
    readonly idleWake?: 'owned-child' | 'parent';
  }): Promise<AgentMessageAcceptance> {
    const { waitForRunningDelivery, idleWake, ...messageInput } = input;
    const storedInput = { sessionId: this.session.sessionId, ...messageInput };
    const acceptance = await this.store.accept(storedInput);
    if (acceptance.delivery === 'delivered' || acceptance.payloadConflict) return acceptance;
    let child: DispatchChild | undefined;
    let handle = this.lifecycle.get(input.targetAgentId);
    if (handle === undefined && idleWake === 'owned-child') {
      child = await this.dispatch.resolveOwnedChild(
        { kind: 'agent', agentId: input.sourceAgentId },
        input.targetAgentId,
      );
      handle = child.agent;
    }
    if (handle === undefined) return acceptance;
    if (waitForRunningDelivery !== true) {
      const lease = await this.sessions.acquire?.(this.session.sessionId, 'agent-message-delivery');
      if (lease === undefined) return acceptance;
      try {
        const pinnedHandle = lease.handle.accessor.get(IAgentLifecycleService).get(input.targetAgentId);
        if (pinnedHandle === undefined) {
          await lease.dispose();
          return acceptance;
        }
        const delivery = this.deliverOrWake(
          pinnedHandle,
          acceptance.message,
          idleWake,
          input.sourceAgentId,
          child?.agent === pinnedHandle ? child : undefined,
        );
        delivery.then(
          () => {
            const result = lease.dispose();
            if (isPromiseLike(result)) result.catch(onUnexpectedError);
          },
          (error) => {
            const result = lease.dispose();
            if (isPromiseLike(result)) result.catch(onUnexpectedError);
            onUnexpectedError(error);
          },
        ).catch(onUnexpectedError);
        return acceptance;
      } catch (error) {
        await lease.dispose();
        throw error;
      }
    }
    const resumed = await this.deliverOrWake(
      handle,
      acceptance.message,
      idleWake,
      input.sourceAgentId,
      child,
    );
    const refreshed = await this.store.accept(storedInput);
    return { ...acceptance, delivery: refreshed.delivery, resumed: resumed || undefined };
  }

  private async discardUnregisteredTargetMessages(): Promise<void> {
    await this.metadata.ready;
    if (this.metadata.createdByLoad?.() !== false) return;
    const pending = await this.store.listPendingAgents(this.session.sessionId);
    const stale: string[] = [];
    for (const agentId of pending) {
      if (agentId === MAIN_AGENT_ID) continue;
      const agents = (await this.metadata.read()).agents ?? {};
      if (agents[agentId] === undefined) stale.push(agentId);
    }
    if (stale.length === 0) return;
    await this.store.discardPending({
      sessionId: this.session.sessionId,
      agentIds: stale,
      reason: MISSING_TARGET_REASON,
    });
  }

  private attach(handle: IAgentScopeHandle): void {
    if (this.subscriptions.has(handle.id)) return;
    const subscriptions = new DisposableStore();
    const execution = handle.accessor.get(IAgentExecutionService);
    subscriptions.add(execution.hooks.onWillRun.register(
      DELIVERY_HOOK_ID,
      async (context, next) => {
        if (!this.kikiMailEnabled(handle)) { await next(); return; }
        if (this.isExternalExecutor(handle)) {
          const request = context.request;
          const replaceRequest = context.replaceRequest;
          const afterStart = context.afterStart;
          if (request !== undefined && replaceRequest !== undefined && afterStart !== undefined) {
            const prepared = await this.serializeDelivery(
              handle.id,
              () => this.prepareExternalDelivery(handle, request),
            );
            if (prepared !== undefined) {
              replaceRequest(prepared.request);
              afterStart(() => this.serializeDelivery(
                handle.id,
                () => this.completeExternalDelivery(handle, prepared.messageId),
              ));
            }
          }
          await next();
          return;
        }
        context.signal.throwIfAborted();
        await abortable(this.serializeDelivery(handle.id, () => this.deliverBeforeRun(handle, context.signal)), context.signal);
        await next();
      },
    ));
    const loop = handle.accessor.get(IAgentLoopService);
    subscriptions.add(loop.hooks.onWillBeginStep.register(
      DELIVERY_HOOK_ID,
      async (context, next) => {
        context.signal.throwIfAborted();
        if (!this.isExternalExecutor(handle) && !this.deliveryTails.has(handle.id)) {
          await abortable(this.serializeDelivery(handle.id, () => this.deliverBeforeRun(handle, context.signal)), context.signal);
        }
        await next();
      },
    ));
    const result = this.subscriptions.set(handle.id, subscriptions);
    if (isPromiseLike(result)) result.catch(onUnexpectedError);
  }

  private async deliverOrWake(
    handle: IAgentScopeHandle,
    message: AgentMessageAcceptance['message'],
    idleWake: 'owned-child' | 'parent' | undefined,
    sourceAgentId: string,
    child?: DispatchChild,
  ): Promise<boolean> {
    if (!this.kikiMailEnabled(handle)) return false;
    const initialExecutionState = handle.accessor.get(IAgentExecutionService).status().state;
    const initiallyIdle =
      initialExecutionState === 'idle' &&
      handle.accessor.get(IAgentLoopService).status().state === 'idle';
    await this.serializeDelivery(handle.id, () => this.deliverRunning(handle));
    if (this.hasMessage(handle, message.messageId) || idleWake === undefined) return false;
    if (idleWake === 'owned-child' && !initiallyIdle && initialExecutionState !== 'broken') {
      return false;
    }
    return this.serializeWake(handle.id, async () => {
      if (this.hasMessage(handle, message.messageId)) return false;
      return this.wakeWhenIdle(handle, message, idleWake, sourceAgentId, child);
    });
  }

  private async deliverRunning(handle: IAgentScopeHandle): Promise<void> {
    if (!this.kikiMailEnabled(handle)) return;
    const execution = handle.accessor.get(IAgentExecutionService);
    const steer = execution.steer?.bind(execution);
    if (execution.status().state !== 'running' || steer === undefined) return;
    await this.deliver(handle, steer);
  }

  private async wakeWhenIdle(
    handle: IAgentScopeHandle,
    message: AgentMessageAcceptance['message'],
    idleWake: 'owned-child' | 'parent',
    sourceAgentId: string,
    child?: DispatchChild,
  ): Promise<boolean> {
    const execution = handle.accessor.get(IAgentExecutionService);
    const loop = handle.accessor.get(IAgentLoopService);
    let executionState = execution.status().state;
    if (executionState === 'broken') {
      throw new Error2(
        ErrorCodes.INTERNAL,
        `Agent instance "${handle.id}" cannot be resumed because its executor is broken`,
        { details: { agentId: handle.id } },
      );
    }
    if (executionState !== 'idle' && executionState !== 'running') return false;
    if (executionState === 'running') {
      if (!this.isExternalExecutor(handle) && loop.status().state !== 'running') return false;
      await loop.settled();
      await execution.settled();
      if (this.hasMessage(handle, message.messageId)) return false;
      executionState = execution.status().state;
    } else if (loop.status().state === 'running') {
      await loop.settled();
      if (this.hasMessage(handle, message.messageId)) return false;
      executionState = execution.status().state;
    }
    if (executionState !== 'idle') return false;
    const loopStatus = loop.status();
    const prompts = handle.accessor.get(IAgentPromptService).list();
    if (
      loopStatus.state !== 'idle' ||
      loopStatus.pendingTurnIds.length > 0 ||
      loopStatus.hasPendingRequests ||
      prompts.pending.length > 0
    ) return false;
    return this.startWake(handle, message, idleWake, sourceAgentId, child);
  }

  private async startWake(
    handle: IAgentScopeHandle,
    message: AgentMessageAcceptance['message'],
    idleWake: 'owned-child' | 'parent',
    sourceAgentId: string,
    child?: DispatchChild,
  ): Promise<boolean> {
    try {
      const contextMessage = toContextMessage(message);
      const run = await this.dispatch.runOnExisting(
        child ?? await this.dispatchChild(handle),
        { kind: 'mailbox', prompt: visibleAgentMessage(message), message: contextMessage },
        { signal: new AbortController().signal },
      );
      if (idleWake === 'owned-child' && message.senderKind !== 'user') {
        this.dispatch.recordDelegatedRun(sourceAgentId, handle.id);
      }
      const started = await run.started;
      void started.completion.catch(() => {});
      return true;
    } catch (error) {
      if (
        isError2(error) &&
        (error.code === ErrorCodes.AGENT_ALREADY_RUNNING ||
          error.code === ErrorCodes.DISPATCH_LIMIT_EXCEEDED)
      ) return false;
      throw error;
    }
  }

  private async dispatchChild(handle: IAgentScopeHandle): Promise<DispatchChild> {
    const meta = (await this.metadata.read()).agents?.[handle.id];
    const data = handle.accessor.get(IAgentProfileService).data();
    return {
      agent: handle,
      agentId: handle.id,
      name: meta?.labels?.[COLLABORATION_TASK_NAME_LABEL],
      profileName: data.profileName ?? meta?.displayName ?? handle.id,
      modelAlias: data.modelAlias,
      thinkingEffort: data.effectiveThinkingLevel ?? data.thinkingLevel,
      thinkingEffortSource: data.thinkingEffortSource,
      routeDetached: data.routeDetached,
      profileSource: data.profileSource,
      dispatchDecision: data.dispatchDecision,
      meta,
    };
  }

  private kikiMailEnabled(handle: IAgentScopeHandle): boolean {
    const binding = handle.accessor.get(IAgentProfileService).data();
    return binding.execution === undefined || (binding.executorId ?? 'native') === 'native' || binding.allowKikiSubagents === true;
  }

  private isExternalExecutor(handle: IAgentScopeHandle): boolean {
    return (handle.accessor.get(IAgentProfileService).data().executorId ?? 'native') !== 'native';
  }

  private hasMessage(handle: IAgentScopeHandle, messageId: string): boolean {
    return handle.accessor.get(IAgentStateService).get(agentMessageMaterializationsKey)[messageId] === true ||
      handle.accessor.get(IAgentContextMemoryService).get().some((entry) =>
        (entry.origin?.kind === 'agent_message' && entry.origin.messageId === messageId) ||
        (entry.origin?.kind === 'user' && entry.id === messageId),
      );
  }

  private hasAppliedMessage(handle: IAgentScopeHandle, pending: ClaimedAgentMessage): boolean {
    return (pending.flushed && pending.queued.message.senderKind === 'user') ||
      this.hasMessage(handle, pending.queued.message.messageId);
  }

  private async claimNext(handle: IAgentScopeHandle): Promise<ClaimedAgentMessage | undefined> {
    const existing = this.claimed.get(handle.id);
    if (existing !== undefined) return existing;
    const queued = await this.store.nextQueued(this.session.sessionId, handle.id);
    if (queued === undefined) return undefined;
    const pending = { queued, flushed: false };
    this.claimed.set(handle.id, pending);
    return pending;
  }

  private async completeClaim(
    handle: IAgentScopeHandle,
    pending: ClaimedAgentMessage,
  ): Promise<boolean> {
    if (!pending.flushed) {
      await handle.accessor.get(IWireService).flush();
      pending.flushed = true;
    }
    try {
      await this.recordDeliveryReceipt(pending.queued.message);
    } catch (error) {
      this.log.warn('Agent message receipt persistence failed; retaining the mailbox claim for recovery', {
        messageId: pending.queued.message.messageId,
        sourceAgentId: pending.queued.message.sourceAgentId,
        targetAgentId: handle.id,
        error,
      });
      return false;
    }
    await this.store.markDelivered(pending.queued.claim);
    if (this.claimed.get(handle.id) === pending) this.claimed.delete(handle.id);
    return true;
  }

  private async recordDeliveryReceipt(message: AgentMessageAcceptance['message']): Promise<void> {
    if (message.senderKind === 'user') return;
    await serializeForAgent(this.receiptTails, message.sourceAgentId, async () => {
      let sender = this.lifecycle.get(message.sourceAgentId);
      if (sender === undefined) {
        const meta = (await this.metadata.read()).agents?.[message.sourceAgentId];
        if (meta === undefined) return;
        sender = await this.lifecycle.create({
          agentId: message.sourceAgentId,
          forkedFrom: meta.forkedFrom,
          labels: labelsFromAgentMeta(meta),
          delegator: delegatorRef(meta),
        });
      }
      const receipts = sender.accessor.get(IAgentStateService).get(agentMessageReceiptsKey);
      if (receipts[message.messageId] !== true) {
        await sender.accessor.get(IEventDispatcher).dispatch(new AgentMessageDelivered({
          messageId: message.messageId,
          targetAgentId: message.targetAgentId,
          status: 'delivered',
          deliveredAt: new Date().toISOString(),
        }));
      }
      await sender.accessor.get(IWireService).flush();
    });
  }

  private async prepareExternalDelivery(
    handle: IAgentScopeHandle,
    request: AgentRunRequest,
  ): Promise<PreparedExternalDelivery | undefined> {
    for (;;) {
      const pending = await this.claimNext(handle);
      if (pending === undefined) return undefined;
      const message = pending.queued.message;
      if (this.hasAppliedMessage(handle, pending)) {
        if (!await this.completeClaim(handle, pending)) return undefined;
        continue;
      }
      const contextMessage = toContextMessage(message);
      return {
        messageId: message.messageId,
        request: withExternalMailboxMessage(request, contextMessage),
      };
    }
  }

  private async completeExternalDelivery(
    handle: IAgentScopeHandle,
    messageId: string,
  ): Promise<void> {
    const pending = this.claimed.get(handle.id);
    if (pending?.queued.message.messageId !== messageId) return;
    if (!this.hasAppliedMessage(handle, pending)) {
      handle.accessor.get(IAgentContextMemoryService).appendObservable(
        toContextMessage(pending.queued.message),
      );
    }
    await this.completeClaim(handle, pending);
  }

  private deliverBeforeRun(handle: IAgentScopeHandle, signal?: AbortSignal): Promise<void> {
    const memory = handle.accessor.get(IAgentContextMemoryService);
    return this.deliver(handle, async (message) => {
      memory.appendObservable(message);
      return true;
    }, signal);
  }

  private async deliver(
    handle: IAgentScopeHandle,
    apply: (message: ContextMessage) => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const pending = await this.claimNext(handle);
      signal?.throwIfAborted();
      if (pending === undefined) return;
      const message = pending.queued.message;
      if (!this.hasAppliedMessage(handle, pending) && !await apply(toContextMessage(message))) {
        return;
      }
      if (!await this.completeClaim(handle, pending)) return;
    }
  }

  private serializeDelivery<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    return serializeForAgent(this.deliveryTails, agentId, task);
  }

  private serializeWake<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    return serializeForAgent(this.wakeTails, agentId, task);
  }
}

function serializeForAgent<T>(
  tails: Map<string, Promise<void>>,
  agentId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(agentId) ?? Promise.resolve();
  const current = previous.then(task);
  const tail = current.then(() => {}, () => {});
  tails.set(agentId, tail);
  void tail.then(() => {
    if (tails.get(agentId) === tail) tails.delete(agentId);
  });
  return current;
}

function withExternalMailboxMessage(
  request: AgentRunRequest,
  message: ContextMessage,
): AgentRunRequest {
  if (request.kind === 'retry') return request;
  const prompt = message.content
    .filter((part): part is Extract<ContextMessage['content'][number], { type: 'text' }> =>
      part.type === 'text')
    .map((part) => part.text)
    .join('');
  if (request.kind === 'mailbox') {
    const requestOrigin = request.message.origin;
    const messageOrigin = message.origin;
    if (
      requestOrigin?.kind === 'agent_message' &&
      messageOrigin?.kind === 'agent_message' &&
      requestOrigin.messageId === messageOrigin.messageId
    ) return request;
    if (requestOrigin?.kind === 'user' && messageOrigin?.kind === 'user' &&
      request.message.id === message.id) return request;
    return { kind: 'mailbox', prompt, message };
  }
  return { ...request, prompt: `${prompt}\n\n${request.prompt}` };
}

function toContextMessage(message: {
  readonly messageId: string;
  readonly sourceAgentId: string;
  readonly sourceTaskName: string;
  readonly senderKind?: 'user';
  readonly content: string;
}): ContextMessage {
  const origin: AgentMessageOrigin | { kind: 'user' } = message.senderKind === 'user'
    ? { kind: 'user' }
    : {
        kind: 'agent_message',
        messageId: message.messageId,
        senderAgentId: message.sourceAgentId,
        senderTaskName: message.sourceTaskName,
      };
  return {
    id: message.messageId,
    role: 'user',
    content: [{ type: 'text', text: visibleAgentMessage(message) }],
    toolCalls: [],
    origin,
  };
}

function visibleAgentMessage(message: {
  readonly sourceAgentId: string;
  readonly sourceTaskName: string;
  readonly senderKind?: 'user';
  readonly content: string;
}): string {
  if (message.senderKind === 'user') return message.content;
  const sender = message.sourceAgentId.startsWith('external:')
    ? `external agent "${message.sourceTaskName}" (${message.sourceAgentId})`
    : `agent "${message.sourceTaskName}" (${message.sourceAgentId})`;
  return `Message from ${sender}:\n\n${message.content}`;
}

registerScopedService(
  LifecycleScope.Session,
  IAgentCollaborationMessagingService,
  AgentCollaborationMessagingService,
  ScopeActivation.OnScopeCreated,
  'agentCollaborationMessagingService',
);
