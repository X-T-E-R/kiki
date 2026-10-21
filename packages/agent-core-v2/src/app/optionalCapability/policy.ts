import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { ConfigOrigin } from '#/app/config/config';

import type {
  CapabilityAdmission,
  CapabilityChoice,
  OptionalCapabilityId,
  ProfileToolsSource,
} from './admit';

export type CapabilityOrigin = ConfigOrigin | 'unreadable';
export type CapabilityApplies = 'next-model-request' | 'next-step';
export type CapabilitySource = 'session' | 'default' | 'off';

export interface OptionalCapabilityGlobalState {
  readonly allowed: boolean;
  readonly hostLocked: boolean;
  readonly defaultOn: boolean;
  readonly origin: CapabilityOrigin;
  readonly unresolved: boolean;
}

export interface OptionalCapabilityWireState {
  readonly allowed: boolean;
  readonly host_locked: boolean;
  readonly default_on: boolean;
  readonly origin: CapabilityOrigin;
  readonly unresolved: boolean;
}

export interface AgentCapabilityContext {
  readonly workspaceId: string;
  readonly agentKind: 'main' | 'child';
  readonly toolsSource?: ProfileToolsSource;
  readonly declaredTools?: readonly string[];
  readonly taskTools?: readonly string[];
}

export interface CapabilityAdmitRequest {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly agentId?: string;
}

export interface SessionCapabilityRow {
  readonly id: OptionalCapabilityId;
  readonly choice: CapabilityChoice;
  readonly effective: boolean;
  readonly source: CapabilitySource;
  readonly reason: string;
  readonly allowed: boolean;
  readonly hostLocked: boolean;
  readonly defaultOn: boolean;
  readonly unresolved: boolean;
  readonly applies: CapabilityApplies;
}

export interface SessionCapabilityView {
  readonly revision: number;
  readonly hostId: string;
  readonly rows: readonly SessionCapabilityRow[];
}

export interface IOptionalCapabilityPolicy {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<{ readonly sessionId?: string }>;
  globalState(id: OptionalCapabilityId): OptionalCapabilityGlobalState;
  wireProjection(): Record<OptionalCapabilityId, OptionalCapabilityWireState>;
  choice(sessionId: string, id: OptionalCapabilityId): CapabilityChoice;
  load(sessionId: string): Promise<void>;
  readSession(sessionId: string): Promise<SessionCapabilityView>;
  retain(sessionId: string, agentId: string, context: AgentCapabilityContext): void;
  release(sessionId: string, agentId: string): void;
  admit(id: OptionalCapabilityId, request: CapabilityAdmitRequest): CapabilityAdmission;
  setChoice(sessionId: string, id: OptionalCapabilityId, choice: CapabilityChoice): Promise<SessionCapabilityView>;
  anyMayUse(id: OptionalCapabilityId): boolean;
}

export const IOptionalCapabilityPolicy: ServiceIdentifier<IOptionalCapabilityPolicy> =
  createDecorator<IOptionalCapabilityPolicy>('optionalCapabilityPolicy');
