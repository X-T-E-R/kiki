import { isSessionIndexBuildingError } from './client';

export function retryRootReadModelQuery(_failureCount: number, error: Error): boolean {
  return isSessionIndexBuildingError(error);
}

export function retryRootReadModelDelay(attempt: number): number {
  return Math.min(250 * 2 ** attempt, 5_000);
}
