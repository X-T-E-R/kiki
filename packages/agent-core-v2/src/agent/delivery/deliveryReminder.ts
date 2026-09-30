import { z } from 'zod';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Event2, registerEvent2Class } from '#/app/event/event2';
import type { SessionDeliveryMode } from '#/session/delivery/delivery';

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
