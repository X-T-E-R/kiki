import { Disposable, DisposableMap } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { AgentMessageOrigin, ContextMessage } from '#/agent/contextMemory/types';
import { IAgentExecutionService } from '#/agent/execution/execution';
import { IWireService } from '#/wire/wire';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
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
  private readonly claimed = new Map<string, ClaimedAgentMessage>();

  constructor(
    @IAgentCollaborationMessageStore private readonly store: IAgentCollaborationMessageStore,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
  ) {
    super();
    for (const handle of lifecycle.list()) this.attach(handle);
    this._register(lifecycle.onDidCreate((handle) => this.attach(handle)));
    this._register(lifecycle.onDidDispose((agentId) => this.subscriptions.deleteAndDispose(agentId)));
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
  }): Promise<AgentMessageAcceptance> {
    const { waitForRunningDelivery, ...messageInput } = input;
    const storedInput = { sessionId: this.session.sessionId, ...messageInput };
    const acceptance = await this.store.accept(storedInput);
    if (acceptance.delivery === 'delivered' || acceptance.payloadConflict) return acceptance;
    const handle = this.lifecycle.get(input.targetAgentId);
    if (handle === undefined) return acceptance;
    const delivery = this.serializeDelivery(handle.id, () => this.deliverRunning(handle));
    if (waitForRunningDelivery !== true) {
      void delivery.catch(() => {});
      return acceptance;
    }
    await delivery;
    const refreshed = await this.store.accept(storedInput);
    return { ...acceptance, delivery: refreshed.delivery };
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
    const execution = handle.accessor.get(IAgentExecutionService);
    this.subscriptions.set(handle.id, execution.hooks.onWillRun.register(
      DELIVERY_HOOK_ID,
      async (_context, next) => {
        await this.serializeDelivery(handle.id, () => this.deliverBeforeRun(handle));
        await next();
      },
    ));
  }

  private async deliverRunning(handle: IAgentScopeHandle): Promise<void> {
    const execution = handle.accessor.get(IAgentExecutionService);
    const steer = execution.steer?.bind(execution);
    if (execution.status().state !== 'running' || steer === undefined) return;
    await this.deliver(handle, steer);
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

  private serializeDelivery(agentId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.deliveryTails.get(agentId) ?? Promise.resolve();
    const current = previous.then(task);
    const tail = current.then(() => {}, () => {});
    this.deliveryTails.set(agentId, tail);
    void tail.then(() => {
      if (this.deliveryTails.get(agentId) === tail) this.deliveryTails.delete(agentId);
    });
    return current;
  }
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
