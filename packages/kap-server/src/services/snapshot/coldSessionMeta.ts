import { IAtomicDocumentStore, IFileSystemStorageService, type Scope, type SessionMeta } from '@kiki/agent-core-v2';

const META_KEY = 'state.json';
const MAX_ENTRIES = 32;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

interface Entry {
  readonly revision: string;
  readonly bytes: number;
  readonly meta: SessionMeta;
}

interface Cache {
  readonly entries: Map<string, Entry>;
  bytes: number;
}

const caches = new WeakMap<object, Cache>();

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
  const info = storage.stat === undefined ? undefined : await storage.stat(scope, META_KEY);
  if (info === undefined) return docs.get<SessionMeta>(scope, META_KEY);
  const revision = fingerprint(info);
  let cache = caches.get(core);
  if (cache === undefined) { cache = { entries: new Map(), bytes: 0 }; caches.set(core, cache); }
  const cached = cache.entries.get(scope);
  if (cached?.revision === revision) {
    cache.entries.delete(scope);
    cache.entries.set(scope, cached);
    return cached.meta;
  }
  remove(cache, scope);
  const meta = await docs.get<SessionMeta>(scope, META_KEY);
  if (meta === undefined || info.size > MAX_ENTRY_BYTES) return meta;
  const after = await storage.stat!(scope, META_KEY);
  if (after === undefined || fingerprint(after) !== revision) return meta;
  remove(cache, scope);
  cache.entries.set(scope, { revision, bytes: info.size, meta });
  cache.bytes += info.size;
  while (cache.entries.size > MAX_ENTRIES || cache.bytes > MAX_SOURCE_BYTES) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) break;
    remove(cache, oldest);
  }
  return meta;
}
