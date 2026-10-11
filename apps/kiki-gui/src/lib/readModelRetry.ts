/**
 * The cold-home read-model retry contract, shared by App's sidebar queries and
 * the /new draft: a brand-new home answers `SESSION_INDEX_BUILDING` while it
 * builds its first index, so those reads retry a bounded number of times.
 */

import { isSessionIndexBuildingError } from './client';

export const SESSION_INDEX_RETRY_LIMIT = 4;

/** Bounded retries, only for the cold-index answer. */
export function retryRootReadModelQuery(failureCount: number, error: Error): boolean {
  return failureCount < SESSION_INDEX_RETRY_LIMIT && isSessionIndexBuildingError(error);
}

/** Keep cold-index retries responsive without hammering a new home. */
export function retryRootReadModelDelay(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 2_000);
}
