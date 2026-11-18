import { AsyncLocalStorage } from 'node:async_hooks';
import { discoverAgentFiles, type DiscoverAgentFilesWarn } from '@kiki/agent-profiles/agentFileDiscovery';
import type { AgentFileDiscoveryResult, AgentFileRoot } from '@kiki/agent-profiles/agentFileTypes';
import { isHostFsMissing } from '@kiki/agent-profiles/hostFs';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

const DEFAULT_DISCOVERY_FRESHNESS_MS = 1_500;
const revalidationScope = new AsyncLocalStorage<boolean>();

interface DiscoveryEntry {
  readonly result: AgentFileDiscoveryResult;
  readonly fingerprints: ReadonlyMap<string, string>;
  verifiedAt: number;
}

interface DiscoveryCache {
  readonly entries: Map<string, DiscoveryEntry>;
  readonly flights: Map<string, Promise<AgentFileDiscoveryResult>>;
  readonly revalidations: Map<string, Promise<AgentFileDiscoveryResult>>;
  readonly warnings: Map<string, string>;
}

export interface DiscoverCachedAgentFilesOptions {
  readonly includeRoutes?: boolean;
  readonly revalidate?: boolean;
  readonly freshnessMs?: number;
}

const caches = new WeakMap<IHostFileSystem, DiscoveryCache>();

function monotonicMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function unwrapHostFs(fs: IHostFileSystem): IHostFileSystem {
  let current = fs;
  for (;;) {
    if (
      Object.hasOwn(current, 'readText') ||
      Object.hasOwn(current, 'readdir') ||
      Object.hasOwn(current, 'stat') ||
      Object.hasOwn(current, 'realpath')
    ) {
      return current;
    }
    const proto: unknown = Object.getPrototypeOf(current);
    if (
      proto === null ||
      proto === Object.prototype ||
      typeof proto !== 'object' ||
      proto === (current as { readonly constructor?: { readonly prototype?: unknown } }).constructor?.prototype
    ) {
      return current;
    }
    current = proto as IHostFileSystem;
  }
}

export function runWithAgentFileDiscoveryRevalidation<T>(operation: () => Promise<T>): Promise<T> {
  return revalidationScope.run(true, operation);
}

export function invalidateCachedAgentFiles(fs: IHostFileSystem): void {
  const cache = caches.get(unwrapHostFs(fs));
  if (cache === undefined) return;
  for (const entry of cache.entries.values()) {
    entry.verifiedAt = Number.NEGATIVE_INFINITY;
  }
}

async function fingerprint(fs: IHostFileSystem, path: string): Promise<string> {
  try {
    const stat = await fs.stat(path);
    const entries = stat.isDirectory ? (await fs.readdir(path)).toSorted((left, right) => left.name.localeCompare(right.name)).map(entry => [entry.name, entry.isDirectory]) : undefined;
    return JSON.stringify([stat.size, stat.mtimeMs, stat.ino, stat.isDirectory, entries]);
  } catch (error) {
    if (isHostFsMissing(error)) return 'missing';
    throw error;
  }
}

export function discoverCachedAgentFiles(
  fs: IHostFileSystem,
  roots: readonly AgentFileRoot[],
  warn?: DiscoverAgentFilesWarn,
  options?: DiscoverCachedAgentFilesOptions,
): Promise<AgentFileDiscoveryResult> {
  const cacheOwner = unwrapHostFs(fs);
  let cache = caches.get(cacheOwner);
  if (cache === undefined) {
    cache = { entries: new Map(), flights: new Map(), revalidations: new Map(), warnings: new Map() };
    caches.set(cacheOwner, cache);
  }
  const key = JSON.stringify([roots, options?.includeRoutes === true]);
  const revalidate = options?.revalidate === true || revalidationScope.getStore() === true;
  const freshnessMs = options?.freshnessMs ?? DEFAULT_DISCOVERY_FRESHNESS_MS;
  const existing = cache.flights.get(key);
  if (existing !== undefined) {
    if (!revalidate) return existing;
    let pending = cache.revalidations.get(key);
    if (pending === undefined) {
      const owner = cache;
      pending = existing.then(
        () => {
          owner.revalidations.delete(key);
          return discoverCachedAgentFiles(fs, roots, warn, { ...options, revalidate: true });
        },
        () => {
          owner.revalidations.delete(key);
          return discoverCachedAgentFiles(fs, roots, warn, { ...options, revalidate: true });
        },
      );
      cache.revalidations.set(key, pending);
    }
    return pending;
  }
  const savedNow = cache.entries.get(key);
  if (savedNow !== undefined && !revalidate && freshnessMs > 0 && monotonicMs() - savedNow.verifiedAt < freshnessMs) {
    return Promise.resolve(savedNow.result);
  }
  const current = cache;
  const flight = (async () => {
    const saved = current.entries.get(key);
    if (saved !== undefined) {
      if (!revalidate && freshnessMs > 0 && monotonicMs() - saved.verifiedAt < freshnessMs) {
        return saved.result;
      }
      const checked = await Promise.all([...saved.fingerprints].map(async ([path, prior]) => await fingerprint(fs, path) === prior));
      if (checked.every(Boolean)) {
        saved.verifiedAt = monotonicMs();
        return saved.result;
      }
    }
    const fingerprints = new Map<string, string>();
    let failedRead = false;
    const access = async <T>(operation: () => Promise<T>): Promise<T> => {
      try { return await operation(); }
      catch (error) {
        if (!isHostFsMissing(error)) failedRead = true;
        throw error;
      }
    };
    const stats = new Map<string, Promise<string>>();
    const track = (path: string): Promise<string> => {
      let reading = stats.get(path);
      if (reading === undefined) {
        reading = fingerprint(fs, path).then(value => { fingerprints.set(path, value); return value; });
        stats.set(path, reading);
      }
      return reading;
    };
    const warnings: { message: string; error?: unknown }[] = [];
    const result = await discoverAgentFiles({
      readFile: path => access(async () => { await track(path); return fs.readText(path); }),
      readdir: path => access(async () => { await track(path); return fs.readdir(path); }),
      stat: path => access(async () => { await track(path); return fs.stat(path); }),
      realpath: path => access(async () => { await track(path); return fs.realpath(path); }),
    }, roots, (message, error) => warnings.push({ message, error }), options);
    if (!failedRead) current.entries.set(key, { result, fingerprints, verifiedAt: monotonicMs() });
    for (const { message, error } of warnings) {
      const subject = result.skipped.find(item => message.includes(item.path));
      const revision = subject === undefined ? JSON.stringify([...fingerprints]) : fingerprints.get(subject.path) ?? 'missing';
      if (current.warnings.get(message) === revision) continue;
      current.warnings.set(message, revision);
      warn?.(message, error);
    }
    return result;
  })().finally(() => { current.flights.delete(key); });
  current.flights.set(key, flight);
  return flight;
}
