/**
 * `historyMutation` domain — session-scoped conversation mutation gate.
 *
 * Serializes history rewrites with prompt and undo admission for one Session.
 * A mutation lease may be passed through a composed operation so its internal
 * undo and prompt admission do not deadlock on the same gate. Bound at Session
 * scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface SessionHistoryMutationLease {
  readonly _historyMutationLeaseBrand: undefined;
}

export interface ISessionHistoryMutationService {
  readonly _serviceBrand: undefined;

  acquire(): Promise<SessionHistoryMutationLease & { dispose(): void }>;
  runAdmission<T>(
    lease: SessionHistoryMutationLease | undefined,
    callback: () => Promise<T>,
  ): Promise<T>;
}

export const ISessionHistoryMutationService: ServiceIdentifier<ISessionHistoryMutationService> =
  createDecorator<ISessionHistoryMutationService>('sessionHistoryMutationService');
