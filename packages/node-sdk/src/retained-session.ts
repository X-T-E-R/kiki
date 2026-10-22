import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';
import { SESSION_LOCK_SCOPE, sessionLockKey } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileLock';
import type { ColdSealResult } from '@kiki/agent-core-v2/persistence/interface/appendLogStore';
import { StorageErrors } from '@kiki/agent-core-v2/persistence/interface/storage';
import { discardRetainedSession, sealRetainedSession } from '@kiki/agent-core-v2/persistence/retainedJournal';
import { sessionScopeOf, workspacePersistenceScope } from '@kiki/agent-core-v2/workspace/sessionLifecycle/internal/addressing';

export interface PersistedSessionMaintenance {
  readonly homeDir: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly sessionDir: string;
}

export function persistedSessionLockScope(workspaceId: string, sessionId: string): string {
  return sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId);
}

export function isPersistedSessionBusy(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === StorageErrors.codes.STORAGE_LOCKED;
}

export async function sealPersistedSession(input: PersistedSessionMaintenance): Promise<readonly ColdSealResult[]> {
  return withPersistedSessionLock(input, () => sealRetainedSession(input.sessionDir));
}

export async function discardPersistedSession(input: PersistedSessionMaintenance): Promise<number> {
  return withPersistedSessionLock(input, () => discardRetainedSession(input.sessionDir));
}

async function withPersistedSessionLock<T>(
  input: PersistedSessionMaintenance,
  body: () => Promise<T>,
): Promise<T> {
  const storage = new FileStorageService(input.homeDir, 0o700, 0o600);
  const scope = persistedSessionLockScope(input.workspaceId, input.sessionId);
  let lock: { release(): Promise<void> } | undefined;
  try {
    lock = await storage.acquireLock(SESSION_LOCK_SCOPE, sessionLockKey(scope), {
      waitForMs: 0,
      owner: {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        scope,
      },
    });
    return await body();
  } finally {
    await lock?.release();
    await storage.close();
  }
}
