import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { ContinuationStepRequest } from '#/agent/loop/stepRequest';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { ISessionDeliveryService } from '#/session/delivery/delivery';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentDeliveryReminderService, SessionDeliveryChanged } from './deliveryReminder';
import { IEventService } from '#/app/event/event';

const REMINDER_TEXT = 'You have not sent a message this turn. Ordinary output is not visible to the user. If a reply is needed, call SendMessage; otherwise finish without sending.';
const REMINDER_NAME = 'message_delivery';

interface TurnDeliveryState {
  readonly triggered: boolean;
  readonly messageMode: boolean;
  sent: boolean;
  reminded: boolean;
}

export class DeliveryReminderService extends Service implements IAgentDeliveryReminderService {
  declare readonly _serviceBrand: undefined;
  private readonly turns = new Map<number, TurnDeliveryState>();

  constructor(
    @IEventBus events: IEventBus,
    @IAgentLoopService loop: IAgentLoopService,
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
        reminded: false,
      });
    }));
    this._register(events.subscribe(TurnEnded, (event) => {
      this.turns.delete(event.turnId);
      delivery.endTurn();
    }));
    this._register(tools.hooks.onDidExecuteTool.register('message-delivery-reminder', async (event, next) => {
      await next();
      if (event.toolCall.name === 'SendMessage' && !event.result.isError) {
        const state = this.turns.get(event.turnId);
        if (state !== undefined) state.sent = true;
      }
    }));
    this._register(loop.hooks.onDidFinishStep.register('message-delivery-reminder', async (event, next) => {
      await next();
      const state = this.turns.get(event.turnId);
      if (
        state === undefined || !state.messageMode || !state.triggered || state.sent || state.reminded ||
        event.finishReason === 'tool_calls' || loop.hasPendingRequests() || !hasAssistantText(context.get())
      ) return;
      state.reminded = true;
      reminders.appendSystemReminder(REMINDER_TEXT, { kind: 'injection', variant: REMINDER_NAME });
      loop.enqueue(new ContinuationStepRequest({ kind: REMINDER_NAME, mergeable: true, admission: 'activeOrNextTurn' }));
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
