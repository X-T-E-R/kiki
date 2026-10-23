import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import {
  IAgentDeliveryReminderService,
  MESSAGE_DELIVERY_NEXT_TURN_GUIDANCE,
  MESSAGE_DELIVERY_REMINDER_VARIANT,
  SessionDeliveryChanged,
} from './deliveryReminder';
import { IEventService } from '#/app/event/event';

interface TurnDeliveryState {
  readonly triggered: boolean;
  readonly messageMode: boolean;
  sent: boolean;
}

export class DeliveryReminderService extends Service implements IAgentDeliveryReminderService {
  declare readonly _serviceBrand: undefined;
  private readonly turns = new Map<number, TurnDeliveryState>();

  constructor(
    @IEventBus events: IEventBus,
    @IAgentContextMemoryService context: IAgentContextMemoryService,
    @IAgentToolExecutorService tools: IAgentToolExecutorService,
    @ISessionDeliveryService delivery: ISessionDeliveryService,
    @IEventService eventService: IEventService,
    @IAgentScopeContext scope: IAgentScopeContext,
    @IAgentSystemReminderService reminders: IAgentSystemReminderService,
  ) {
    super();
    if (scope.agentId !== 'main') return;
    this._register(delivery.onDidChange((mode) => {
      eventService.publish(new SessionDeliveryChanged({ delivery: mode }));
    }));
    this._register(events.subscribe(TurnStarted, (event) => {
      delivery.beginTurn();
      this.turns.set(event.turnId, {
        triggered: shouldRemind(event.origin),
        messageMode: delivery.effectiveMode() === 'message',
        sent: false,
      });
    }));
    this._register(events.subscribe(TurnEnded, (event) => {
      const state = this.turns.get(event.turnId);
      this.turns.delete(event.turnId);
      if (
        state !== undefined && state.messageMode && state.triggered && !state.sent &&
        hasAssistantText(context.get())
      ) {
        reminders.appendSystemReminder(MESSAGE_DELIVERY_NEXT_TURN_GUIDANCE, {
          kind: 'injection',
          variant: MESSAGE_DELIVERY_REMINDER_VARIANT,
        });
      }
      delivery.endTurn();
    }));
    this._register(tools.hooks.onDidExecuteTool.register('message-delivery-reminder', async (event, next) => {
      await next();
      if (event.toolCall.name === 'SendMessage' && !event.result.isError) {
        const state = this.turns.get(event.turnId);
        if (state !== undefined) state.sent = true;
      }
    }));
  }
}

function shouldRemind(origin: PromptOrigin): boolean {
  return origin.kind === 'user' || origin.kind === 'peer_thread' || origin.kind === 'bridged_peer' || (origin.kind === 'room_message' && origin.targeted);
}

function hasAssistantText(messages: readonly { readonly role: string; readonly content: readonly { readonly type: string; readonly text?: string }[] }[]): boolean {
  const message = messages.at(-1);
  return message?.role === 'assistant' && message.content.some((part) => part.type === 'text' && (part.text?.length ?? 0) > 0);
}

registerScopedService(LifecycleScope.Agent, IAgentDeliveryReminderService, DeliveryReminderService, ScopeActivation.OnScopeCreated, 'deliveryReminder');
