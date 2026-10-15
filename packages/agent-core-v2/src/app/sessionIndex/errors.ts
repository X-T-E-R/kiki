import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';

export const SessionIndexErrors = {
  codes: {
    SESSION_INDEX_BUILDING: 'session.index_building',
  },
  retryable: ['session.index_building'],
} as const satisfies ErrorDomain;

registerErrorDomain(SessionIndexErrors);

export class SessionIndexBuildingError extends Error2 {
  constructor() {
    super(SessionIndexErrors.codes.SESSION_INDEX_BUILDING, 'session index is building');
    this.name = 'SessionIndexBuildingError';
  }
}

export class SessionIndexReconcilePendingError extends Error2 {
  constructor(reason: 'concurrent_changes' | 'disabled' | 'disposed' | 'uninitialized', attempts: number, retryAfterMs = 0) {
    super(SessionIndexErrors.codes.SESSION_INDEX_BUILDING, 'session index reconciliation is incomplete', {
      details: { operation: 'reconcile', reason, attempts, retryAfterMs },
    });
    this.name = 'SessionIndexReconcilePendingError';
  }
}
