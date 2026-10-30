import { Disposable, DisposableMap, DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { isPromiseLike } from '#/_base/lifecycle/disposer';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { abortable } from '#/_base/utils/abort';
import { harnessCapabilities } from '#/app/agentExecutor/harnessMcp';
import { LifecycleScope } from '#/app/scopes';
import { ILogService } from '#/_base/log/log';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { HomeRuntimeError } from '#/app/runtimeHost/errors';
import { ScopeActivation, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { AgentMessageOrigin, ContextMessage } from '#/agent/contextMemory/types';
import { brokenOriginalResumeRefusal, IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLoopService } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { IAgentProfileService } from '#/agent/profile/profile';
import { TaskNotified } from '#/agent/task/taskOps';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentStateService } from '#/agent/state/agentState';
import { agentMessageMaterializationsKey, agentMessageReceiptsKey } from './messageReceiptState';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { IWireService } from '#/wire/wire';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { COLLABORATION_TASK_NAME_LABEL } from '#/session/agentCollaboration/registry';
import {
  ISessionDispatchService,
  type DispatchChild,
} from '#/session/dispatch/dispatch';
import { ISessionMetadata, isExternalClientMain } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { AgentRunRequest } from '#/session/subagent/subagent';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import {
  IAgentCollaborationMessageStore,
  IAgentCollaborationMessagingService,
  type AgentMessageAcceptance,
  type AgentMessageReceipt,
  type QueuedAgentMessage,
} from './messageMailbox';
import { AgentMessageDelivered } from './messageEvents';

const DELIVERY_HOOK_ID = 'agent-collaboration-message-delivery';
const MISSING_TARGET_REASON = 'target agent is not registered in the session';
const AGENT_SEND_BLOCKED_TRIGGER = 'agent_send_blocked';
const ACKNOWLEDGEMENT_RETRY_MS = 30_000;
const MAILBOX_RECOVERY_DELAYS_MS = [250, 1_000, 4_000, 16_000, 30_000, 30_000, 30_000] as const;

function isRecoverableMailboxRuntimeError(error: unknown): error is HomeRuntimeError {
  return error instanceof HomeRuntimeError && [
    'runtime.timeout', 'runtime.owner_gone', 'runtime.connection_failed', 'runtime.detached',
    'runtime.epoch_stale', 'runtime.epoch_future', 'runtime.duplicate_request',
  ].includes(error.code);
}

interface ClaimedAgentMessage {
  readonly queued: QueuedAgentMessage;
  flushed: boolean;
}

interface PendingDeliveryReceipt {
  readonly messageId: string;
  readonly sourceAgentId: string;
  readonly targetAgentId: string;
  readonly deliveredAt: string;
}

interface PreparedExternalDelivery {
  readonly messageId: string;
  readonly request: AgentRunRequest;
}

type WakeAttempt = 'landed' | 'other' | 'skipped';

function continuationFailureCode(error: unknown): string {
  if (isError2(error)) return error.code;
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return ErrorCodes.INTERNAL;
}

function continuationFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return 'The continuation did not start.';
}

function originalSessionCannotResume(execution: IAgentExecutionService | undefined): boolean {
  if (execution?.status().state !== 'broken') return false;
  return !execution.canResumeBrokenOriginal() && !execution.canRetryBrokenExecution?.();
}

function continuationFailureNotice(input: {
  readonly messageId: string;
  readonly targetAgentId: string;
  readonly code: string;
  readonly reason: string;
  readonly unrecoverable: boolean;
}): string {
  return [
    'AgentSend continuation did not start.',
    `message_id: ${input.messageId}`,
    `target_agent_id: ${input.targetAgentId}`,
    `error_code: ${input.code}`,
    `reason: ${input.reason}`,
    input.unrecoverable
      ? `The executor is broken and the original remote session cannot be resumed. Message ${input.messageId} stays queued. Do not call AgentSend again. Do not open a new remote session.`
      : `Resume this same child with AgentRun. Set resume to ${input.targetAgentId}, set prompt to an empty string, and set description to a short label. Message ${input.messageId} stays queued and enters that resume. Do not call AgentSend again. Do not repeat the saved message in the prompt.`,
    ...(input.unrecoverable ? [] : ['Do not set new_window. Do not open a new remote session in place of this resume.']),
  ].join('\n');
}

function continuationBlocked(error: Error2, messageId: string, targetAgentId: string): Error2 {
  const details = error.details ?? {};
  const safe: Record<string, unknown> = { messageId, targetAgentId };
  for (const key of ['layer', 'current', 'limit', 'owner', 'agentId'] as const) {
    if (details[key] !== undefined) safe[key] = details[key];
  }
  return new Error2(error.code, error.message, { details: safe });
}

export class AgentCollaborationMessagingService extends Disposable implements IAgentCollaborationMessagingService {
  declare readonly _serviceBrand: undefined;
  private readonly subscriptions = this._register(new DisposableMap<string>());
  private readonly acknowledgementRetries = this._register(new DisposableMap<string>());
  private readonly deliveryTails = new Map<string, Promise<void>>();
  private readonly wakeTails = new Map<string, Promise<void>>();
  private readonly receiptTails = new Map<string, Promise<void>>();
  private readonly receiptFlights = new Set<string>();
  private readonly receiptRetries = this._register(new DisposableMap<string>());
  private readonly claimed = new Map<string, ClaimedAgentMessage>();
  private readonly acknowledged = new Set<string>();
  private readonly externalPrepared = new Map<string, string>();
  private readonly externalEpoch = new Map<string, number>();
  private readonly externalWaiters = new Map<string, Array<() => void>>();
  private readonly withheld = new Set<string>();

  constructor(
    @IAgentCollaborationMessageStore private readonly store: IAgentCollaborationMessageStore,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionDispatchService private readonly dispatch: ISessionDispatchService,
    @ISessionManager private readonly sessions: ISessionManager,
    @ILogService private readonly log: ILogService,
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
  ) {
    super();
    for (const handle of lifecycle.list()) this.attach(handle);
    this._register(lifecycle.onDidCreate((handle) => {
      this.attach(handle);
    }));
    this._register(lifecycle.onDidDispose((agentId) => {
      const result = this.subscriptions.deleteAndDispose(agentId);
      if (isPromiseLike(result)) result.catch(onUnexpectedError);
      const retry = this.acknowledgementRetries.deleteAndDispose(agentId);
      if (isPromiseLike(retry)) retry.catch(onUnexpectedError);
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

  async sendUserMessageReceipt(input: {
    readonly targetAgentId: string;
    readonly content: string;
    readonly idempotencyKey: string;
  }): Promise<AgentMessageReceipt> {
    const acceptance = await this.sendUserMessage(input);
    const { message, ...receipt } = acceptance;
    const { content: _content, ...accepted } = message;
    return { ...receipt, message: accepted };
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
    let child: DispatchChild | undefined;
    let handle = this.lifecycle.get(input.targetAgentId);
    if (handle === undefined && idleWake === 'owned-child') {
      child = await this.dispatch.resolveOwnedChild(
        { kind: 'agent', agentId: input.sourceAgentId },
        input.targetAgentId,
      );
      handle = child.agent;
    }
    if (handle !== undefined && !this.kikiMailEnabled(handle)) {
      throw new Error2(
        ErrorCodes.REQUEST_INVALID,
        `Agent "${input.targetAgentId}" does not accept Kiki mail while allow_kiki_subagents is false.`,
      );
    }
    const acceptance = await this.store.accept(storedInput);
    if (acceptance.delivery === 'delivered' || acceptance.payloadConflict) return acceptance;
    if (handle === undefined) return acceptance;
    if (waitForRunningDelivery !== true) {
      await this.armBackgroundDelivery(acceptance.message, idleWake, input.sourceAgentId, child);
      return acceptance;
    }
    const resumed = await this.deliverOrWake(
      handle,
      acceptance.message,
      idleWake,
      input.sourceAgentId,
      child,
      false,
    );
    const refreshed = await this.store.accept(storedInput);
    if (
      refreshed.delivery !== 'delivered' &&
      idleWake !== undefined &&
      !this.withheld.has(acceptance.message.messageId)
    ) {
      void this.armBackgroundDelivery(acceptance.message, idleWake, input.sourceAgentId, child).catch((error: unknown) => {
        this.reportContinuationFailure(input.sourceAgentId, acceptance.message.messageId, input.targetAgentId, error).catch(onUnexpectedError);
      });
    }
    return { ...acceptance, delivery: refreshed.delivery, resumed: resumed || undefined };
  }

  private async armBackgroundDelivery(
    message: AgentMessageAcceptance['message'],
    idleWake: 'owned-child' | 'parent' | undefined,
    sourceAgentId: string,
    child: DispatchChild | undefined,
  ): Promise<void> {
    const lease = await this.sessions.acquire?.(this.session.sessionId, 'agent-message-delivery');
    if (lease === undefined) return;
    try {
      const pinnedHandle = lease.handle.accessor.get(IAgentLifecycleService).get(message.targetAgentId);
      if (pinnedHandle === undefined) {
        await lease.dispose();
        return;
      }
      const delivery = this.deliverOrWake(
        pinnedHandle,
        message,
        idleWake,
        sourceAgentId,
        child?.agent === pinnedHandle ? child : undefined,
        true,
      );
      void (async () => {
        try {
          await delivery;
        } finally {
          await lease.dispose();
        }
      })().catch((error: unknown) => this.reportContinuationFailure(
        sourceAgentId,
        message.messageId,
        message.targetAgentId,
        error,
      )).catch(onUnexpectedError);
    } catch (error) {
      await lease.dispose();
      throw error;
    }
  }

  private async reportContinuationFailure(
    sourceAgentId: string,
    messageId: string,
    targetAgentId: string,
    error: unknown,
  ): Promise<void> {
    const code = continuationFailureCode(error);
    const reason = continuationFailureReason(error);
    this.log.warn('Agent message delivery did not finish', { messageId, targetAgentId, error });
    const sender = this.lifecycle.get(sourceAgentId);
    if (sender === undefined) return;
    const execution = this.lifecycle.get(targetAgentId)?.accessor.get(IAgentExecutionService);
    const text = continuationFailureNotice({
      messageId,
      targetAgentId,
      code,
      reason,
      unrecoverable: originalSessionCannotResume(execution),
    });
    try {
      if (isExternalClientMain(await this.metadata.read(), sourceAgentId)) {
        await sender.accessor.get(IEventDispatcher).dispatch(new TaskNotified({
          notificationType: code,
          title: 'AgentSend continuation did not start',
          body: text,
          severity: 'warning',
          sourceKind: 'agent_message',
          sourceId: messageId,
        }));
        return;
      }
      sender.accessor.get(IAgentLoopService).enqueue(new MessageStepRequest({
        role: 'user',
        content: [{ type: 'text', text }],
        toolCalls: [],
        origin: { kind: 'system_trigger', name: AGENT_SEND_BLOCKED_TRIGGER },
      }, {
        kind: AGENT_SEND_BLOCKED_TRIGGER,
        admission: 'activeOrNewTurn',
        mergeable: false,
        turnScoped: false,
      }));
    } catch (notifyError) {
      this.log.warn('Agent message startup failure could not reach the sender', {
        messageId,
        targetAgentId,
        error: notifyError,
      });
    }
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
    void this.recoverDeliveryReceipts(handle.id).catch((error: unknown) => {
      this.log.warn('Agent delivery receipt recovery failed', { agentId: handle.id, error });
      this.retryReceiptRecovery(handle.id);
    });
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
              () => this.recoverMailboxDelivery(handle.id, () => this.prepareExternalDelivery(handle, request), context.signal),
            );
            if (prepared !== undefined) {
              replaceRequest(prepared.request);
              afterStart(() => this.serializeDelivery(
                handle.id,
                () => this.recoverMailboxDelivery(handle.id, () => this.completeExternalDelivery(handle, prepared.messageId), context.signal),
              ));
            } else {
              afterStart(() => {
                this.bumpExternalEpoch(handle.id);
                return Promise.resolve();
              });
            }
            this.noteExternalPrepare(handle.id, prepared?.messageId);
          } else {
            this.noteExternalPrepare(handle.id, undefined);
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
    if (this.kikiMailEnabled(handle) && Object.keys(handle.accessor.get(IAgentStateService).get(agentMessageMaterializationsKey)).length > 0) {
      void this.serializeDelivery(handle.id, async () => {
        await this.recoverAppliedClaims(handle);
        if (!this.claimed.has(handle.id) && (await this.store.listPendingAgents(this.session.sessionId)).includes(handle.id)) {
          this.retryAcknowledgement(handle);
        }
      }).catch((error: unknown) => {
        this.log.warn('Agent message acknowledgement recovery failed; durable message retained', { agentId: handle.id, error });
        this.retryAcknowledgement(handle, error);
      });
    }
  }

  private async deliverOrWake(
    handle: IAgentScopeHandle,
    message: AgentMessageAcceptance['message'],
    idleWake: 'owned-child' | 'parent' | undefined,
    sourceAgentId: string,
    child: DispatchChild | undefined,
    followBusyCompletion: boolean,
  ): Promise<boolean> {
    if (!this.kikiMailEnabled(handle)) return false;
    let observedStart = false;
    let stall: string | undefined;
    for (;;) {
      const loop = handle.accessor.get(IAgentLoopService);
      if (!this.isExternalExecutor(handle) && loop.status().finalizing) {
        await loop.recoverPersistence({ throwOnFailure: true });
        if (loop.status().state === 'idle') await handle.accessor.get(IAgentExecutionService).settled();
      }
      const steered = await this.serializeDelivery(handle.id, async () => {
        if (!await this.recoverAppliedClaims(handle)) return 'stopped' as const;
        return this.deliverRunning(handle);
      });
      if (steered === 'unknown') return observedStart;
      if (this.messageLanded(handle, message.messageId) || idleWake === undefined) return observedStart;
      if (this.isStarting(handle)) {
        if (!this.isExternalExecutor(handle) || this.externalPrepared.get(handle.id) === message.messageId) return observedStart;
        const decision = await this.waitWhileExternalStarting(handle, message.messageId);
        if (decision === 'included' || this.messageLanded(handle, message.messageId)) return observedStart;
        continue;
      }
      if (this.admittedWorkWillRead(handle)) return observedStart;
      if (this.executionBusy(handle)) {
        if (!followBusyCompletion) return observedStart;
        const execution = handle.accessor.get(IAgentExecutionService);
        const loop = handle.accessor.get(IAgentLoopService);
        const settling = Promise.all([execution.settled(), loop.settled({ rejectOnPersistenceFailure: true })]);
        let finished = false;
        void settling.then(() => { finished = true; }, () => { finished = true; });
        for (let attempt = 0; attempt < 4 && !finished; attempt += 1) await Promise.resolve();
        const stillBusy = finished && this.executionBusy(handle);
        await settling;
        if (stillBusy) return observedStart;
        continue;
      }
      const outcome = await this.serializeWake(handle.id, async () => {
        if (this.messageLanded(handle, message.messageId)) return 'skipped' as const;
        if (this.isStarting(handle) || this.executionBusy(handle) || this.admittedWorkWillRead(handle)) return 'skipped' as const;
        return this.wakeWhenIdle(handle, message, idleWake, sourceAgentId, child);
      });
      if (outcome === 'landed' || outcome === 'other') observedStart = true;
      if (this.messageLanded(handle, message.messageId)) return observedStart;
      if (outcome === 'other') {
        const mark = `${this.claimed.get(handle.id)?.queued.message.messageId ?? ''}|${this.acknowledged.size}`;
        if (mark === stall) {
          throw new Error2(
            ErrorCodes.INTERNAL,
            `Saved message "${message.messageId}" did not enter agent "${handle.id}".`,
            { details: { messageId: message.messageId, targetAgentId: handle.id } },
          );
        }
        stall = mark;
        if (!followBusyCompletion && (this.isStarting(handle) || this.executionBusy(handle))) return observedStart;
        continue;
      }
      if (followBusyCompletion && (this.isStarting(handle) || this.executionBusy(handle))) continue;
      return observedStart;
    }
  }

  private async deliverRunning(handle: IAgentScopeHandle): Promise<'done' | 'stopped' | 'unknown'> {
    if (!this.kikiMailEnabled(handle)) return 'done';
    const execution = handle.accessor.get(IAgentExecutionService);
    const steer = execution.steer?.bind(execution);
    if (execution.status().state !== 'running' || steer === undefined) return 'done';
    return this.deliver(handle, async (message) => {
      const outcome = await steer(message);
      if (outcome === 'unknown') return 'unknown';
      return outcome === true;
    });
  }

  private async wakeWhenIdle(
    handle: IAgentScopeHandle,
    message: AgentMessageAcceptance['message'],
    idleWake: 'owned-child' | 'parent',
    sourceAgentId: string,
    child?: DispatchChild,
  ): Promise<WakeAttempt> {
    const execution = handle.accessor.get(IAgentExecutionService);
    const loop = handle.accessor.get(IAgentLoopService);
    let executionState = execution.status().state;
    if (executionState === 'broken') {
      if (execution.canRetryBrokenExecution?.()) {
        throw new Error2(ErrorCodes.INTERNAL,
          `Agent instance "${handle.id}" failed before a usable executor session remained. Resume the same child with AgentRun; the saved message stays queued.`,
          { details: { agentId: handle.id, messageId: message.messageId } });
      }
      if (execution.canResumeBrokenOriginal?.()) {
        throw new Error2(
          ErrorCodes.INTERNAL,
          `Agent instance "${handle.id}" is broken. Resume the original remote session with AgentRun; the saved message stays queued.`,
          { details: { agentId: handle.id, messageId: message.messageId } },
        );
      }
      throw brokenOriginalResumeRefusal(handle.id, message.messageId);
    }
    if (executionState !== 'idle' && executionState !== 'running') return 'skipped';
    if (executionState === 'running') {
      if (!this.isExternalExecutor(handle) && loop.status().state !== 'running') return 'skipped';
      await loop.settled({ rejectOnPersistenceFailure: true });
      await execution.settled();
      if (this.messageLanded(handle, message.messageId)) return 'skipped';
      executionState = execution.status().state;
    } else if (loop.status().state === 'running') {
      await loop.settled({ rejectOnPersistenceFailure: true });
      if (this.messageLanded(handle, message.messageId)) return 'skipped';
      executionState = execution.status().state;
    }
    if (executionState !== 'idle') return 'skipped';
    const loopStatus = loop.status();
    const prompts = handle.accessor.get(IAgentPromptService).list();
    if (
      loopStatus.state !== 'idle' ||
      loopStatus.pendingTurnIds.length > 0 ||
      loopStatus.hasPendingRequests ||
      prompts.pending.length > 0
    ) return 'skipped';
    if (isExternalClientMain(await this.metadata.read(), handle.id)) return 'skipped';
    return this.startWake(handle, message, idleWake, sourceAgentId, child);
  }

  private async startWake(
    handle: IAgentScopeHandle,
    message: AgentMessageAcceptance['message'],
    idleWake: 'owned-child' | 'parent',
    sourceAgentId: string,
    child?: DispatchChild,
  ): Promise<WakeAttempt> {
    for (;;) {
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
        await this.serializeDelivery(handle.id, () => this.recoverAppliedClaims(handle));
        return this.messageLanded(handle, message.messageId) ? 'landed' : 'other';
      } catch (error) {
        if (!isError2(error)) throw error;
        if (error.code === ErrorCodes.AGENT_ALREADY_RUNNING) return 'skipped';
        if (error.code !== ErrorCodes.DISPATCH_LIMIT_EXCEEDED) throw error;
        if (await this.awaitCapacityRelease(handle.id)) continue;
        throw continuationBlocked(error, message.messageId, handle.id);
      }
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
    if ((binding.executorId ?? 'native') === 'native') return true;
    return harnessCapabilities(binding).delegation !== false;
  }

  private isExternalExecutor(handle: IAgentScopeHandle): boolean {
    return (handle.accessor.get(IAgentProfileService).data().executorId ?? 'native') !== 'native';
  }

  private messageLanded(handle: IAgentScopeHandle, messageId: string): boolean {
    return this.acknowledged.has(messageId) || this.hasMessage(handle, messageId);
  }

  private admittedWorkWillRead(handle: IAgentScopeHandle): boolean {
    const loop = handle.accessor.get(IAgentLoopService).status();
    if (loop.pendingTurnIds.length > 0 || loop.hasPendingRequests) return true;
    return handle.accessor.get(IAgentPromptService).list().pending.length > 0;
  }

  private isStarting(handle: IAgentScopeHandle): boolean {
    return handle.accessor.get(IAgentExecutionService).status().state === 'starting';
  }

  private noteExternalPrepare(agentId: string, messageId: string | undefined): void {
    if (messageId === undefined) this.externalPrepared.delete(agentId);
    else this.externalPrepared.set(agentId, messageId);
    this.bumpExternalEpoch(agentId);
  }

  private bumpExternalEpoch(agentId: string): void {
    this.externalEpoch.set(agentId, (this.externalEpoch.get(agentId) ?? 0) + 1);
    const waiters = this.externalWaiters.get(agentId);
    if (waiters === undefined) return;
    this.externalWaiters.delete(agentId);
    for (const resolve of waiters) resolve();
  }

  private waitExternalEpoch(agentId: string, seen: number): Promise<void> {
    if ((this.externalEpoch.get(agentId) ?? 0) !== seen) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.externalWaiters.get(agentId) ?? [];
      waiters.push(resolve);
      this.externalWaiters.set(agentId, waiters);
    });
  }

  private async waitWhileExternalStarting(
    handle: IAgentScopeHandle,
    messageId: string,
  ): Promise<'included' | 'continue'> {
    const execution = handle.accessor.get(IAgentExecutionService);
    let sawSettledWhileStarting = false;
    for (;;) {
      if (!this.isStarting(handle)) return 'continue';
      if (this.externalPrepared.get(handle.id) === messageId) return 'included';
      const seen = this.externalEpoch.get(handle.id) ?? 0;
      const epochChanged = this.waitExternalEpoch(handle.id, seen);
      if (sawSettledWhileStarting) {
        await epochChanged;
        continue;
      }
      const winner = await Promise.race([
        epochChanged.then(() => 'epoch' as const),
        execution.settled().then(() => 'settled' as const),
      ]);
      if (
        winner === 'settled' &&
        this.isStarting(handle) &&
        (this.externalEpoch.get(handle.id) ?? 0) === seen
      ) {
        sawSettledWhileStarting = true;
      }
    }
  }

  private capacityHolders(targetAgentId: string): readonly { readonly id: string; readonly settled: () => Promise<void> }[] {
    const holders = [];
    for (const candidate of this.lifecycle.list()) {
      if (candidate.id === targetAgentId || candidate.id === MAIN_AGENT_ID) continue;
      const execution = candidate.accessor.get(IAgentExecutionService);
      const state = execution.status().state;
      if (state !== 'starting' && state !== 'running' && state !== 'cancelling') continue;
      holders.push({ id: candidate.id, settled: () => execution.settled() });
    }
    return holders;
  }

  private async awaitCapacityRelease(agentId: string): Promise<boolean> {
    const holders = this.capacityHolders(agentId);
    if (holders.length === 0) return false;
    const before = holders.map((holder) => holder.id).toSorted();
    await Promise.race(holders.map((holder) => holder.settled()));
    const after = this.capacityHolders(agentId).map((holder) => holder.id).toSorted();
    return before.length !== after.length || before.some((id, index) => id !== after[index]);
  }

  private executionBusy(handle: IAgentScopeHandle): boolean {
    const executionState = handle.accessor.get(IAgentExecutionService).status().state;
    return executionState === 'running' || executionState === 'cancelling' ||
      handle.accessor.get(IAgentLoopService).status().state === 'running';
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

  private async recoverAppliedClaims(handle: IAgentScopeHandle): Promise<boolean> {
    if (!this.kikiMailEnabled(handle)) return true;
    if (!this.claimed.has(handle.id) && Object.keys(handle.accessor.get(IAgentStateService).get(agentMessageMaterializationsKey)).length === 0) return true;
    for (;;) {
      const pending = await this.claimNext(handle);
      if (pending === undefined || !this.hasAppliedMessage(handle, pending)) return true;
      if (!await this.completeClaim(handle, pending)) return false;
    }
  }

  private retryAcknowledgement(handle: IAgentScopeHandle, error?: unknown): void {
    if (error !== undefined && !isRecoverableMailboxRuntimeError(error) &&
      (!isError2(error) || !['storage.disk_full', 'storage.io_failed', 'storage.locked'].includes(error.code))) return;
    if (this._store.isDisposed || !this.subscriptions.has(handle.id) || this.acknowledgementRetries.has(handle.id)) return;
    const timer = setTimeout(() => {
      const disposed = this.acknowledgementRetries.deleteAndDispose(handle.id);
      if (isPromiseLike(disposed)) disposed.catch(onUnexpectedError);
      void this.serializeDelivery(handle.id, () => {
        if (this._store.isDisposed || this.lifecycle.get(handle.id) !== handle) return Promise.resolve(true);
        return this.recoverAppliedClaims(handle);
      }).catch((error: unknown) => {
        this.log.warn('Agent message acknowledgement recovery failed; durable message retained', { agentId: handle.id, error });
        this.retryAcknowledgement(handle, error);
      });
    }, ACKNOWLEDGEMENT_RETRY_MS);
    const replaced = this.acknowledgementRetries.set(handle.id, toDisposable(() => { clearTimeout(timer); }));
    if (isPromiseLike(replaced)) replaced.catch(onUnexpectedError);
  }

  private async completeClaim(
    handle: IAgentScopeHandle,
    pending: ClaimedAgentMessage,
  ): Promise<boolean> {
    if (!pending.flushed) {
      try {
        await handle.accessor.get(IWireService).flush();
        pending.flushed = true;
      } catch (error) {
        this.retryAcknowledgement(handle, error);
        throw error;
      }
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
      this.retryAcknowledgement(handle, error);
      return false;
    }
    try {
      if (!await this.store.markDelivered(pending.queued.claim)) {
        if (this.claimed.get(handle.id) === pending) this.claimed.delete(handle.id);
        this.retryAcknowledgement(handle);
        return false;
      }
    } catch (error) {
      this.retryAcknowledgement(handle, error);
      throw error;
    }
    this.acknowledged.add(pending.queued.message.messageId);
    if (this.claimed.get(handle.id) === pending) this.claimed.delete(handle.id);
    const retry = this.acknowledgementRetries.deleteAndDispose(handle.id);
    if (isPromiseLike(retry)) retry.catch(onUnexpectedError);
    return true;
  }

  private receiptScope(sourceAgentId: string): string {
    return this.session.scope(`agent-message-receipts/${sourceAgentId}`);
  }

  private async recordDeliveryReceipt(message: AgentMessageAcceptance['message']): Promise<void> {
    if (message.senderKind === 'user') return;
    const scope = this.receiptScope(message.sourceAgentId);
    const receipt = await this.documents.get<PendingDeliveryReceipt>(scope, message.messageId) ?? {
      messageId: message.messageId,
      sourceAgentId: message.sourceAgentId,
      targetAgentId: message.targetAgentId,
      deliveredAt: new Date().toISOString(),
    };
    await this.documents.set(scope, message.messageId, receipt);
    this.projectDeliveryReceipt(receipt);
  }

  private async recoverDeliveryReceipts(sourceAgentId: string): Promise<void> {
    const scope = this.receiptScope(sourceAgentId);
    for (const key of await this.documents.list(scope)) {
      if (this._store.isDisposed) return;
      const receipt = await this.documents.get<PendingDeliveryReceipt>(scope, key);
      if (receipt !== undefined) this.projectDeliveryReceipt(receipt);
    }
  }

  private retryReceiptRecovery(sourceAgentId: string): void {
    const key = `source/${sourceAgentId}`;
    if (this._store.isDisposed || this.receiptRetries.has(key)) return;
    const timer = setTimeout(() => {
      void this.receiptRetries.deleteAndDispose(key);
      void this.recoverDeliveryReceipts(sourceAgentId).catch((error: unknown) => {
        this.log.warn('Agent delivery receipt recovery failed', { sourceAgentId, error });
        this.retryReceiptRecovery(sourceAgentId);
      });
    }, ACKNOWLEDGEMENT_RETRY_MS);
    timer.unref?.();
    this.receiptRetries.set(key, toDisposable(() => { clearTimeout(timer); }));
  }

  private projectDeliveryReceipt(receipt: PendingDeliveryReceipt): void {
    if (this._store.isDisposed || this.receiptFlights.has(receipt.messageId) ||
      this.lifecycle.get(receipt.sourceAgentId) === undefined) return;
    this.receiptFlights.add(receipt.messageId);
    void serializeForAgent(this.receiptTails, receipt.sourceAgentId, async () => {
      if (this._store.isDisposed) return;
      const sender = this.lifecycle.get(receipt.sourceAgentId);
      if (sender === undefined) return;
      const receipts = sender.accessor.get(IAgentStateService).get(agentMessageReceiptsKey);
      if (receipts[receipt.messageId] !== true) {
        await sender.accessor.get(IEventDispatcher).dispatch(new AgentMessageDelivered({
          messageId: receipt.messageId,
          targetAgentId: receipt.targetAgentId,
          status: 'delivered',
          deliveredAt: receipt.deliveredAt,
        }));
      }
      if (this._store.isDisposed) return;
      await sender.accessor.get(IWireService).flush();
      if (!this._store.isDisposed) await this.documents.delete(this.receiptScope(receipt.sourceAgentId), receipt.messageId);
    }).catch((error: unknown) => {
      this.log.warn('Agent delivery receipt projection failed; durable receipt retained', { messageId: receipt.messageId, error });
      this.retryReceiptRecovery(receipt.sourceAgentId);
    }).finally(() => { this.receiptFlights.delete(receipt.messageId); });
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
    if (pending?.queued.message.messageId !== messageId) {
      this.bumpExternalEpoch(handle.id);
      return;
    }
    if (!this.hasAppliedMessage(handle, pending)) {
      handle.accessor.get(IAgentContextMemoryService).appendObservable(
        toContextMessage(pending.queued.message),
      );
    }
    const completed = await this.completeClaim(handle, pending);
    if (completed && this.externalPrepared.get(handle.id) === messageId) this.externalPrepared.delete(handle.id);
    this.bumpExternalEpoch(handle.id);
  }

  private deliverBeforeRun(handle: IAgentScopeHandle, signal?: AbortSignal): Promise<void> {
    const memory = handle.accessor.get(IAgentContextMemoryService);
    return this.recoverMailboxDelivery(handle.id, async () => {
      await this.deliver(handle, async (message) => {
        memory.appendObservable(message);
        return true;
      }, signal);
    }, signal);
  }

  private async recoverMailboxDelivery<T>(agentId: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        return await run();
      } catch (error) {
        signal?.throwIfAborted();
        if (!isRecoverableMailboxRuntimeError(error)) throw error;
        this.log.warn('Agent mailbox delivery interrupted; durable message retained for recovery', {
          agentId, attempt: attempt + 1, error,
        });
        const delayMs = MAILBOX_RECOVERY_DELAYS_MS[attempt];
        if (delayMs === undefined) {
          throw new HomeRuntimeError(error.code,
            `Agent mailbox delivery is temporarily unavailable after ${attempt + 1} recovery attempts. Messages and delivery receipts are retained. Inspect preserved work, then resume the same agent; do not repeat unconfirmed external actions. Last failure: ${error.message}`,
            { cause: error });
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const wait = new Promise<void>((resolve) => { timer = setTimeout(resolve, delayMs); });
          await (signal === undefined ? wait : abortable(wait, signal));
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
    }
  }

  private async deliver(
    handle: IAgentScopeHandle,
    apply: (message: ContextMessage) => Promise<boolean | 'unknown'>,
    signal?: AbortSignal,
  ): Promise<'done' | 'stopped' | 'unknown'> {
    for (;;) {
      signal?.throwIfAborted();
      const pending = await this.claimNext(handle);
      signal?.throwIfAborted();
      if (pending === undefined) return 'done';
      const message = pending.queued.message;
      if (!this.hasAppliedMessage(handle, pending)) {
        if (this.externalPrepared.get(handle.id) === message.messageId) return 'stopped';
        const applied = await apply(toContextMessage(message));
        if (applied === 'unknown') {
          this.withheld.add(message.messageId);
          return 'unknown';
        }
        if (!applied) return 'stopped';
      }
      if (!await this.completeClaim(handle, pending)) return 'stopped';
      this.withheld.delete(message.messageId);
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
