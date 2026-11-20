import { RESOURCE_DEFAULTS } from '#/_base/node/resourceDefaults';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import type { SessionMeta } from './sessionMetadata';

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
  bytes: number;
}

const caches = new WeakMap<IFileSystemStorageService, Cache>();

function cacheFor(storage: IFileSystemStorageService): Cache {
  let cache = caches.get(storage);
  if (cache === undefined) {
    cache = { entries: new Map(), inflight: new Map(), bytes: 0 };
    caches.set(storage, cache);
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
 * Reads a cold session's `state.json` and reuses the decoded object across concurrent
 * and repeated callers while the file's size, identity and modification revision stay
 * unchanged. Callers must not mutate the returned object.
 */
export async function readCachedColdSessionMeta(
  storage: IFileSystemStorageService,
  docs: IAtomicDocumentStore,
  scope: string,
): Promise<SessionMeta | undefined> {
  const info = storage.stat === undefined ? undefined : await storage.stat(scope, META_KEY);
  if (info === undefined) return docs.get<SessionMeta>(scope, META_KEY);
  const cache = cacheFor(storage);
  const revision = fingerprint(info);
  const cached = cache.entries.get(scope);
  if (cached?.revision === revision) {
    cache.entries.delete(scope);
    cache.entries.set(scope, cached);
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
