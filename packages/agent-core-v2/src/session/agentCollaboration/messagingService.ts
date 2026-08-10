/**
 * `agentCollaboration` domain — safe-boundary named-agent message delivery.
 *
 * Persists before observing live state and only projects queued user messages
 * from Agent `onWillBeginStep` hooks. It never starts, steers, or interrupts a
 * turn.
 */

import { Disposable, DisposableMap } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { AgentMessageOrigin, ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IWireService } from '#/wire/wire';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import {
  IAgentCollaborationMessageStore,
  IAgentCollaborationMessagingService,
  type AgentMessageAcceptance,
} from './messageMailbox';

const DELIVERY_HOOK_ID = 'agent-collaboration-message-delivery';

export class AgentCollaborationMessagingService extends Disposable implements IAgentCollaborationMessagingService {
  declare readonly _serviceBrand: undefined;
  private readonly subscriptions = this._register(new DisposableMap<string>());

  constructor(
    @IAgentCollaborationMessageStore private readonly store: IAgentCollaborationMessageStore,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionContext private readonly session: ISessionContext,
  ) {
    super();
    for (const handle of lifecycle.list()) this.attach(handle);
    this._register(lifecycle.onDidCreate((handle) => this.attach(handle)));
    this._register(lifecycle.onDidDispose((agentId) => this.subscriptions.deleteAndDispose(agentId)));
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

  private attach(handle: IAgentScopeHandle): void {
    if (this.subscriptions.has(handle.id)) return;
    const loop = handle.accessor.get(IAgentLoopService);
    this.subscriptions.set(handle.id, loop.hooks.onWillBeginStep.register(
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
      const message = await this.store.nextQueued(this.session.sessionId, handle.id);
      if (message === undefined) return;
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
      await this.store.markDelivered(message.messageId);
    }
  }
}

function visibleAgentMessage(message: {
  readonly sourceAgentId: string;
  readonly sourceTaskName: string;
  readonly content: string;
}): string {
  return `Message from named agent "${message.sourceTaskName}" (${message.sourceAgentId}):\n\n${message.content}`;
}

registerScopedService(
  LifecycleScope.Session,
  IAgentCollaborationMessagingService,
  AgentCollaborationMessagingService,
  ScopeActivation.OnScopeCreated,
  'agentCollaborationMessagingService',
);
