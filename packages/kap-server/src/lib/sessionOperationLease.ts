import {
  ISessionManager,
  ITelemetryService,
  isError2,
  type ISessionScopeHandle,
  type Scope,
  type SessionLease,
} from '@kiki/agent-core-v2';

/**
 * A route's hold on one session operation: the resolved session handle plus the
 * pin that keeps an idle session from being unloaded underneath the request.
 * `dispose` is idempotent and must run after the last use of the handle on
 * every exit path — success, error, and early return.
 */
export interface SessionOperationLease {
  readonly handle: ISessionScopeHandle | undefined;
  dispose(): void | Promise<void>;
}

export interface DeferredCleanup {
  release(): void;
  wait(): Promise<void>;
}

export function createDeferredCleanup(
  cleanup: () => void | Promise<void>,
  onError: (error: unknown) => void,
): DeferredCleanup {
  let released = false;
  let pending: Promise<void> | undefined;
  return {
    release: () => {
      if (released) return;
      released = true;
      pending = Promise.resolve().then(cleanup);
      pending.catch(onError);
    },
    wait: async () => {
      if (pending !== undefined) await pending;
    },
  };
}

/**
 * Resolves a session for one request and pins it for the request's duration.
 * Requires `ISessionManager.acquire` so an unavailable pin cannot silently
 * degrade into an unprotected resume. Non-existent sessions answer `undefined`;
 * acquisition failures still report `session_load_failed`.
 */
export async function acquireSessionOperation(
  core: Scope,
  sessionId: string,
  reason: string,
): Promise<SessionOperationLease> {
  const manager = core.accessor.get(ISessionManager);
  if (manager.acquire === undefined) throw new Error('session operation leases are unavailable');
  const lease: SessionLease | undefined = await manager.acquire(sessionId, reason).catch((error: unknown) => {
    core.accessor
      .get(ITelemetryService)
      .withContext({ sessionId })
      .track2('session_load_failed', {
        reason: isError2(error) ? error.code : error instanceof Error ? error.name : 'unknown',
      });
    throw error;
  });
  if (lease === undefined) return { handle: undefined, dispose: async () => {} };
  const session = lease;
  let released = false;
  return {
    handle: session.handle,
    dispose: async () => {
      if (released) return;
      released = true;
      await session.dispose();
    },
  };
}

export async function withSessionOperation<T>(
  core: Scope,
  sessionId: string,
  work: (handle: ISessionScopeHandle | undefined) => Promise<T>,
): Promise<T> {
  const lease = await acquireSessionOperation(core, sessionId, 'operation');
  try {
    return await work(lease.handle);
  } finally {
    await lease.dispose();
  }
}
