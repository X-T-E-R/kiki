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
} from './messageMailbox';

const DELIVERY_HOOK_ID = 'agent-collaboration-message-delivery';
const MISSING_TARGET_REASON = 'target agent is not registered in the session';

export class AgentCollaborationMessagingService extends Disposable implements IAgentCollaborationMessagingService {
  declare readonly _serviceBrand: undefined;
  private readonly subscriptions = this._register(new DisposableMap<string>());

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

  send(input: {
    readonly sourceAgentId: string;
    readonly sourceTaskName: string;
    readonly targetAgentId: string;
    readonly targetTaskName: string;
    readonly content: string;
    readonly idempotencyKey: string;
  }): Promise<AgentMessageAcceptance> {
    return this.store.accept({ sessionId: this.session.sessionId, ...input });
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
        await this.deliver(handle);
        await next();
      },
    ));
  }

  private async deliver(handle: IAgentScopeHandle): Promise<void> {
    const memory = handle.accessor.get(IAgentContextMemoryService);
    const wire = handle.accessor.get(IWireService);
    for (;;) {
      const queued = await this.store.nextQueued(this.session.sessionId, handle.id);
      if (queued === undefined) return;
      const { message, claim } = queued;
      const alreadyApplied = memory.get().some((entry) =>
        entry.origin?.kind === 'agent_message' && entry.origin.messageId === message.messageId,
      );
      if (!alreadyApplied) {
        const origin: AgentMessageOrigin = {
          kind: 'agent_message',
          messageId: message.messageId,
          senderAgentId: message.sourceAgentId,
          senderTaskName: message.sourceTaskName,
        };
        const contextMessage: ContextMessage = {
          id: message.messageId,
          role: 'user',
          content: [{ type: 'text', text: visibleAgentMessage(message) }],
          toolCalls: [],
          origin,
        };
        memory.append(contextMessage);
      }
      await wire.flush();
      await this.store.markDelivered(claim);
    }
  }
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
