import { Disposable, DisposableMap, DisposableStore } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { AgentMessageOrigin, ContextMessage } from '#/agent/contextMemory/types';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { IWireService } from '#/wire/wire';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { COLLABORATION_TASK_NAME_LABEL } from '#/session/agentCollaboration/registry';
import {
  ISessionDispatchService,
  type DispatchChild,
} from '#/session/dispatch/dispatch';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import {
  IAgentCollaborationMessageStore,
  IAgentCollaborationMessagingService,
  type AgentMessageAcceptance,
  type QueuedAgentMessage,
} from './messageMailbox';

const DELIVERY_HOOK_ID = 'agent-collaboration-message-delivery';
const MISSING_TARGET_REASON = 'target agent is not registered in the session';

interface ClaimedAgentMessage {
  readonly queued: QueuedAgentMessage;
  flushed: boolean;
}

export class AgentCollaborationMessagingService extends Disposable implements IAgentCollaborationMessagingService {
  declare readonly _serviceBrand: undefined;
  private readonly subscriptions = this._register(new DisposableMap<string>());
  private readonly deliveryTails = new Map<string, Promise<void>>();
  private readonly wakeTails = new Map<string, Promise<void>>();
  private readonly claimed = new Map<string, ClaimedAgentMessage>();

  constructor(
    @IAgentCollaborationMessageStore private readonly store: IAgentCollaborationMessageStore,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ISessionDispatchService private readonly dispatch: ISessionDispatchService,
  ) {
    super();
    for (const handle of lifecycle.list()) this.attach(handle);
    this._register(lifecycle.onDidCreate((handle) => {
      this.attach(handle);
    }));
    this._register(lifecycle.onDidDispose((agentId) => {
      this.subscriptions.deleteAndDispose(agentId);
    }));
    void this.discardUnregisteredTargetMessages().catch(() => {});
  }

  async send(input: {
    readonly sourceAgentId: string;
    readonly sourceTaskName: string;
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
    const delivery = this.deliverOrWake(
      handle,
      acceptance.message,
      idleWake,
      input.sourceAgentId,
      child,
    );
    if (waitForRunningDelivery !== true) {
      void delivery.catch(() => {});
      return acceptance;
    }
    const resumed = await delivery;
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
      async (_context, next) => {
        await this.serializeDelivery(handle.id, () => this.deliverBeforeRun(handle));
        await next();
      },
    ));
    const loop = handle.accessor.get(IAgentLoopService);
    subscriptions.add(loop.hooks.onWillBeginStep.register(
      DELIVERY_HOOK_ID,
      async (_context, next) => {
        await this.serializeDelivery(handle.id, () => this.deliverBeforeRun(handle));
        await next();
      },
    ));
    this.subscriptions.set(handle.id, subscriptions);
  }

  private async deliverOrWake(
    handle: IAgentScopeHandle,
    message: AgentMessageAcceptance['message'],
    idleWake: 'owned-child' | 'parent' | undefined,
    sourceAgentId: string,
    child?: DispatchChild,
  ): Promise<boolean> {
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
      if (loop.status().state !== 'running') return false;
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
      if (idleWake === 'owned-child') {
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

  private hasMessage(handle: IAgentScopeHandle, messageId: string): boolean {
    return handle.accessor.get(IAgentContextMemoryService).get().some((entry) =>
      entry.origin?.kind === 'agent_message' && entry.origin.messageId === messageId,
    );
  }

  private deliverBeforeRun(handle: IAgentScopeHandle): Promise<void> {
    const memory = handle.accessor.get(IAgentContextMemoryService);
    return this.deliver(handle, async (message) => {
      memory.appendObservable(message);
      return true;
    });
  }

  private async deliver(
    handle: IAgentScopeHandle,
    apply: (message: ContextMessage) => Promise<boolean>,
  ): Promise<void> {
    const memory = handle.accessor.get(IAgentContextMemoryService);
    const wire = handle.accessor.get(IWireService);
    for (;;) {
      let pending = this.claimed.get(handle.id);
      if (pending === undefined) {
        const queued = await this.store.nextQueued(this.session.sessionId, handle.id);
        if (queued === undefined) return;
        pending = { queued, flushed: false };
        this.claimed.set(handle.id, pending);
      }
      const { message, claim } = pending.queued;
      const alreadyApplied = memory.get().some((entry) =>
        entry.origin?.kind === 'agent_message' && entry.origin.messageId === message.messageId,
      );
      if (!alreadyApplied && !await apply(toContextMessage(message))) return;
      if (!pending.flushed) {
        await wire.flush();
        pending.flushed = true;
      }
      await this.store.markDelivered(claim);
      if (this.claimed.get(handle.id) === pending) this.claimed.delete(handle.id);
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

function toContextMessage(message: {
  readonly messageId: string;
  readonly sourceAgentId: string;
  readonly sourceTaskName: string;
  readonly content: string;
}): ContextMessage {
  const origin: AgentMessageOrigin = {
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
  readonly content: string;
}): string {
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
