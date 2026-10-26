export class StorageStartupCleanupError extends Error {
  constructor(readonly startupError: unknown, readonly cleanupError: unknown, readonly retryCleanup: () => Promise<void>) {
    super('Normal startup failed and its owned resources still require cleanup', { cause: startupError });
  }
}
