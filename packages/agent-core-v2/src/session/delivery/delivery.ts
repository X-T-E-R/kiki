import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export type SessionDeliveryMode = 'reply' | 'message';

export interface ISessionDeliveryService {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChange: Event<SessionDeliveryMode>;
  readonly onDidChangeEffective: Event<SessionDeliveryMode>;
  mode(): SessionDeliveryMode;
  effectiveMode(): SessionDeliveryMode;
  beginTurn(): void;
  endTurn(): void;
  set(mode: SessionDeliveryMode): Promise<void>;
}

export const ISessionDeliveryService: ServiceIdentifier<ISessionDeliveryService> =
  createDecorator<ISessionDeliveryService>('sessionDeliveryService');
