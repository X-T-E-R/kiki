import { z } from 'zod';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Event2, registerEvent2Class } from '#/app/event/event2';
import type { SessionDeliveryMode } from '#/session/delivery/delivery';

export const MESSAGE_DELIVERY_REMINDER_VARIANT = 'message_delivery';

export const MESSAGE_DELIVERY_NEXT_TURN_GUIDANCE = 'Message delivery applies to later replies. The previous ordinary reply already stands as the complete final answer for that turn; do not call SendMessage to send it again or rewrite it. When message delivery is active, call SendMessage with the complete new user-visible message. Do not split that message into sentences, and do not repeat it as ordinary text.';

export const MESSAGE_DELIVERY_SENT_GUIDANCE = 'The message has been delivered to the user. If the request is complete and no work remains, end the turn without another SendMessage or an ordinary-text confirmation. For future final answers, set SendMessage end_turn=true to skip the empty tool continuation after full delivery when it is the step’s only tool call. Do not send another message merely to close the turn. If this was a progress update and work remains, continue the required tools or pending work; omit end_turn for progress messages.';

export class SessionDeliveryChanged extends Event2<{ readonly delivery: SessionDeliveryMode }> {
  static override readonly type = 'session.delivery';
  static override readonly durable = true;
  static override readonly schema = z.object({ delivery: z.enum(['reply', 'message']) });
  declare readonly delivery: SessionDeliveryMode;
}

registerEvent2Class(SessionDeliveryChanged);

export interface IAgentDeliveryReminderService {
  readonly _serviceBrand: undefined;
}

export const IAgentDeliveryReminderService: ServiceIdentifier<IAgentDeliveryReminderService> =
  createDecorator<IAgentDeliveryReminderService>('agentDeliveryReminderService');
