import { IAtomicDocumentStore, IFileSystemStorageService, type Scope, type SessionMeta } from '@kiki/agent-core-v2';
import { RESOURCE_DEFAULTS } from '@kiki/agent-core-v2/_base/node/resourceDefaults';

const META_KEY = 'state.json';
const MAX_ENTRIES = 32;
const MIN_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MIN_ENTRY_BYTES = 48 * 1024 * 1024;
const COLD_SESSION_META_CACHE_MB_ENV = 'KIKI_COLD_SESSION_META_CACHE_MB';

function resolveColdSessionMetaBudgets(): { readonly maxSourceBytes: number; readonly maxEntryBytes: number } {
  const rawMb = process.env[COLD_SESSION_META_CACHE_MB_ENV]?.trim();
  let maxSourceBytes: number;
  if (rawMb !== undefined && /^\d+$/.test(rawMb)) {
    const parsedMb = Number.parseInt(rawMb, 10);
    maxSourceBytes = parsedMb > 0 ? parsedMb * 1024 * 1024 : MIN_SOURCE_BYTES;
  } else {
    maxSourceBytes = Math.min(MAX_SOURCE_BYTES, Math.max(MIN_SOURCE_BYTES, Math.floor(RESOURCE_DEFAULTS.residentHeapBytes / 8)));
  }
  const maxEntryBytes = Math.max(MIN_ENTRY_BYTES, Math.floor(maxSourceBytes * 0.75));
  return { maxSourceBytes, maxEntryBytes };
}

interface Entry {
  readonly revision: string;
  readonly bytes: number;
  readonly meta: SessionMeta;
}

interface Cache {
  readonly entries: Map<string, Entry>;
  readonly inflight: Map<string, Promise<SessionMeta | undefined>>;
  readonly workspaceBySession: Map<string, string>;
  bytes: number;
}

const caches = new WeakMap<object, Cache>();

function cacheFor(core: Scope): Cache {
  let cache = caches.get(core);
  if (cache === undefined) {
    cache = { entries: new Map(), inflight: new Map(), workspaceBySession: new Map(), bytes: 0 };
    caches.set(core, cache);
  }
  return cache;
}

function fingerprint(info: { readonly size: number; readonly identity?: string; readonly revision: string }): string {
  return `${String(info.size)}:${info.identity ?? ''}:${info.revision}`;
}

function remove(cache: Cache, scope: string): void {
  const entry = cache.entries.get(scope);
  if (entry === undefined) return;
  cache.entries.delete(scope);
  cache.bytes -= entry.bytes;
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
  const cache = cacheFor(core);
  const info = storage.stat === undefined ? undefined : await storage.stat(scope, META_KEY);
  if (info === undefined) return docs.get<SessionMeta>(scope, META_KEY);
  const revision = fingerprint(info);
  const cached = cache.entries.get(scope);
  if (cached?.revision === revision) {
    cache.entries.delete(scope);
    cache.entries.set(scope, cached);
    cache.workspaceBySession.set(sessionId, workspaceId);
    return cached.meta;
  }
  const inflightKey = `${scope}\0${revision}`;
  const pending = cache.inflight.get(inflightKey);
  if (pending !== undefined) return pending;
  const budgets = resolveColdSessionMetaBudgets();
  const load = (async (): Promise<SessionMeta | undefined> => {
    remove(cache, scope);
    const meta = await docs.get<SessionMeta>(scope, META_KEY);
    if (meta === undefined) return undefined;
    cache.workspaceBySession.set(sessionId, workspaceId);
    if (cache.workspaceBySession.size > MAX_ENTRIES * 8) {
      const oldestSession = cache.workspaceBySession.keys().next().value;
      if (oldestSession !== undefined) cache.workspaceBySession.delete(oldestSession);
    }
    if (info.size > budgets.maxEntryBytes) return meta;
    const after = await storage.stat!(scope, META_KEY);
    if (after === undefined || fingerprint(after) !== revision) return meta;
    remove(cache, scope);
    cache.entries.set(scope, { revision, bytes: info.size, meta });
    cache.bytes += info.size;
    while (cache.entries.size > MAX_ENTRIES || (cache.entries.size > 1 && cache.bytes > budgets.maxSourceBytes)) {
      const oldest = cache.entries.keys().next().value;
      if (oldest === undefined) break;
      remove(cache, oldest);
    }
    return meta;
  })().finally(() => {
    if (cache.inflight.get(inflightKey) === load) cache.inflight.delete(inflightKey);
  });
  cache.inflight.set(inflightKey, load);
  return load;
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
  const cache = cacheFor(core);
  const cachedWorkspaceId = cache.workspaceBySession.get(sessionId);
  if (cachedWorkspaceId !== undefined && storage.stat !== undefined) {
    const scope = `sessions/${cachedWorkspaceId}/${sessionId}`;
    const info = await storage.stat(scope, META_KEY);
    if (info !== undefined) {
      return readColdSessionMeta(core, cachedWorkspaceId, sessionId);
    }
    cache.workspaceBySession.delete(sessionId);
  }
  const workspaceId = await resolveWorkspaceId();
  if (workspaceId === undefined) return undefined;
  return readColdSessionMeta(core, workspaceId, sessionId);
}
