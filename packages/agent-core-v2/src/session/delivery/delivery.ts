import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export type SessionDeliveryMode = 'reply' | 'message';

export const NON_PERSONA_DELIVERY_DEFAULT: SessionDeliveryMode = 'reply';
export const PERSONA_IMPLICIT_DELIVERY: SessionDeliveryMode = 'message';

export function isSessionDeliveryMode(value: unknown): value is SessionDeliveryMode {
  return value === 'reply' || value === 'message';
}

export function resolveCreateDeliveryMode(input: {
  readonly requested?: SessionDeliveryMode | undefined;
  readonly personaDelivery?: SessionDeliveryMode | undefined;
  readonly hasPersona: boolean;
}): SessionDeliveryMode {
  if (isSessionDeliveryMode(input.requested)) return input.requested;
  if (isSessionDeliveryMode(input.personaDelivery)) return input.personaDelivery;
  return input.hasPersona ? PERSONA_IMPLICIT_DELIVERY : NON_PERSONA_DELIVERY_DEFAULT;
}

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
