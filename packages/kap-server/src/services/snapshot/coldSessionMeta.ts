import { IAtomicDocumentStore, IFileSystemStorageService, type Scope, type SessionMeta } from '@kiki/agent-core-v2';
import { readCachedColdSessionMeta } from '@kiki/agent-core-v2/session/sessionMetadata/coldSessionMetaRead';

const META_KEY = 'state.json';
const MAX_WORKSPACE_BY_SESSION = 256;

const workspaceBySessionCaches = new WeakMap<object, Map<string, string>>();

function workspaceBySessionFor(core: Scope): Map<string, string> {
  let map = workspaceBySessionCaches.get(core);
  if (map === undefined) {
    map = new Map();
    workspaceBySessionCaches.set(core, map);
  }
  return map;
}

/**
 * Reads a cold session's `state.json` and reuses the decoded value while the file's
 * size, identity and modification revision stay unchanged. Callers must not mutate
 * the result. Without a storage stat, every call decodes the file again.
 */
export async function readColdSessionMeta(core: Scope, workspaceId: string, sessionId: string): Promise<SessionMeta | undefined> {
  const scope = `sessions/${workspaceId}/${sessionId}`;
  const storage = core.accessor.get(IFileSystemStorageService);
  const docs = core.accessor.get(IAtomicDocumentStore);
  const meta = await readCachedColdSessionMeta(storage, docs, scope);
  if (meta !== undefined) {
    const map = workspaceBySessionFor(core);
    map.delete(sessionId);
    map.set(sessionId, workspaceId);
    if (map.size > MAX_WORKSPACE_BY_SESSION) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
  }
  return meta;
}

/**
 * Reads a cold session's `state.json` by session ID, reusing a cached workspace mapping
 * when the underlying `state.json` still exists on disk so repeated cold reads avoid
 * redundant session-index lookups.
 */
export async function readColdSessionMetaBySessionId(
  core: Scope,
  sessionId: string,
  resolveWorkspaceId: () => Promise<string | undefined>,
): Promise<SessionMeta | undefined> {
  const storage = core.accessor.get(IFileSystemStorageService);
  const map = workspaceBySessionFor(core);
  const cachedWorkspaceId = map.get(sessionId);
  if (cachedWorkspaceId !== undefined && storage.stat !== undefined) {
    const scope = `sessions/${cachedWorkspaceId}/${sessionId}`;
    const info = await storage.stat(scope, META_KEY);
    if (info !== undefined) {
      return readColdSessionMeta(core, cachedWorkspaceId, sessionId);
    }
    map.delete(sessionId);
  }
  const workspaceId = await resolveWorkspaceId();
  if (workspaceId === undefined) return undefined;
  return readColdSessionMeta(core, workspaceId, sessionId);
}
