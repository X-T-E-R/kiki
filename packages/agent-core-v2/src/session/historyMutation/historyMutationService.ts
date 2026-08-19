/**
 * `historyMutation` domain — `ISessionHistoryMutationService` implementation.
 *
 * Owns one Session's in-process FIFO mutation/admission gate. The gate provides
 * process-local linearization only; crash-atomic history/event transactions are
 * intentionally outside this version. Bound at Session scope.
 */

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

import {
  ISessionHistoryMutationService,
  type SessionHistoryMutationLease,
} from './historyMutation';

interface Lease extends SessionHistoryMutationLease {
  dispose(): void;
}

export class SessionHistoryMutationService implements ISessionHistoryMutationService {
  declare readonly _serviceBrand: undefined;

  private tail: Promise<void> = Promise.resolve();
  private active: SessionHistoryMutationLease | undefined;

  async acquire(): Promise<Lease> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    const lease = { _historyMutationLeaseBrand: undefined } as Lease;
    let disposed = false;
    lease.dispose = () => {
      if (disposed) return;
      disposed = true;
      if (this.active === lease) this.active = undefined;
      release();
    };
    this.active = lease;
    return lease;
  }

  async runAdmission<T>(
    lease: SessionHistoryMutationLease | undefined,
    callback: () => Promise<T>,
  ): Promise<T> {
    if (lease !== undefined && lease === this.active) return callback();
    const acquired = await this.acquire();
    try {
      return await callback();
    } finally {
      acquired.dispose();
    }
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionHistoryMutationService,
  SessionHistoryMutationService,
  ScopeActivation.OnScopeCreated,
  'historyMutation',
);
