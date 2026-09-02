import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export type InteractionKind = 'approval' | 'question' | 'user_tool';

export interface InteractionOrigin {
  readonly agentId?: string;
  readonly turnId?: number;
}

export interface InteractionRequest<TPayload = unknown> {
  readonly id?: string;
  readonly kind: InteractionKind;
  readonly payload: TPayload;
  readonly origin?: InteractionOrigin;
}

export interface Interaction<TPayload = unknown> {
  readonly id: string;
  readonly kind: InteractionKind;
  readonly payload: TPayload;
  readonly origin: InteractionOrigin;
  readonly createdAt: number;
}

export interface InteractionResolution {
  readonly id: string;
  readonly response: unknown;
}

export interface InteractionPendingChangedEvent {
  readonly pending: readonly string[];
}

export type InteractionConsumerCoverage =
  | { readonly kind: 'session' }
  | {
      readonly kind: 'agent_subtrees';
      readonly roots: () => ReadonlySet<string>;
      readonly parent: (agentId: string) => string | undefined;
    };

export function interactionCoverageIncludes(
  coverage: InteractionConsumerCoverage,
  origin: InteractionOrigin,
): boolean {
  if (coverage.kind === 'session') return true;
  let agentId = origin.agentId;
  const seen = new Set<string>();
  while (agentId !== undefined && !seen.has(agentId)) {
    if (coverage.roots().has(agentId)) return true;
    seen.add(agentId);
    agentId = coverage.parent(agentId);
  }
  return false;
}

export interface ISessionInteractionService {
  readonly _serviceBrand: undefined;

  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse>;
  enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction;
  acquireConsumer(id: string, coverage?: InteractionConsumerCoverage): void;
  releaseConsumer(id: string): void;
  hasConsumer(origin?: InteractionOrigin): boolean;
  respond(id: string, response: unknown): void;
  listPending(kind?: InteractionKind, origin?: InteractionOrigin): readonly Interaction[];
  isRecentlyResolved(id: string): boolean;
  cancelPendingForTurn(turnId: number): void;
  readonly onDidChangePending: Event<InteractionPendingChangedEvent>;
  readonly onDidResolve: Event<InteractionResolution>;
}

export const ISessionInteractionService: ServiceIdentifier<ISessionInteractionService> =
  createDecorator<ISessionInteractionService>('sessionInteractionService');
