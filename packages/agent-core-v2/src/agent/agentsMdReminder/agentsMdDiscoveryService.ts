import { dirname, join, normalize } from 'pathe';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import {
  AGENTS_MD_PLAIN_NAMES,
  dirsRootToLeaf,
  dotKimiAgentsMdPath,
  findProjectRoot,
} from '#/agent/profile/context';
import type { HostDirEntry, IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { Runtime, RuntimeLease } from '#/runtime/runtime';

const DISCOVERY_CACHE_TTL_MS = 5_000;
const DIRECTORY_PROBE_CONCURRENCY = 4;
const MAX_DIRECTORY_WATCHERS = 64;

interface DirectoryEntry {
  readonly paths: readonly string[];
  readonly expiresAt: number;
}

interface ProjectRootEntry {
  readonly root: string;
  readonly expiresAt: number;
}

interface WatchEntry {
  readonly owners: Set<string>;
  readonly ready: Promise<boolean>;
  readonly resources: DisposableStore;
}

interface RuntimeCache {
  readonly directories: Map<string, DirectoryEntry>;
  readonly directoryFlights: Map<string, Promise<readonly string[]>>;
  readonly existingDirectories: Map<string, number>;
  readonly projectRoots: Map<string, ProjectRootEntry>;
  readonly projectRootFlights: Map<string, Promise<string>>;
  readonly revisions: Map<string, number>;
  readonly watchers: Map<string, WatchEntry>;
}

export interface IAgentsMdDiscoveryService {
  readonly _serviceBrand: undefined;

  discover(lease: RuntimeLease, targetDir: string): Promise<readonly string[]>;
  invalidate(runtime: Runtime, directory: string): void;
}

export const IAgentsMdDiscoveryService: ServiceIdentifier<IAgentsMdDiscoveryService> =
  createDecorator<IAgentsMdDiscoveryService>('agentsMdDiscoveryService');

export class AgentsMdDiscoveryService implements IAgentsMdDiscoveryService {
  declare readonly _serviceBrand: undefined;

  private readonly runtimeCaches = new WeakMap<Runtime, RuntimeCache>();

  constructor(
    private readonly ttlMs = DISCOVERY_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly maxWatchers = MAX_DIRECTORY_WATCHERS,
  ) {}

  async discover(lease: RuntimeLease, targetDir: string): Promise<readonly string[]> {
    const runtime = lease.runtime;
    const fs = runtime.fs;
    if (fs === undefined) return [];
    const cache = this.cacheFor(runtime);
    const anchor = await this.nearestExistingDir(cache, fs, targetDir, runtime.environment.pathClass);
    if (anchor === undefined) return [];
    const projectRoot = await this.projectRoot(cache, fs, anchor, runtime.environment.pathClass);
    const chain = dirsRootToLeaf(anchor, projectRoot);
    const discovered = await mapBoundedOrdered(chain, DIRECTORY_PROBE_CONCURRENCY, (directory) =>
      this.discoverDirectory(lease, cache, directory),
    );
    return discovered.flat();
  }

  invalidate(runtime: Runtime, directory: string): void {
    const cache = this.runtimeCaches.get(runtime);
    if (cache === undefined) return;
    this.invalidateKey(cache, pathKey(directory, runtime.environment.pathClass));
  }

  private cacheFor(runtime: Runtime): RuntimeCache {
    let cache = this.runtimeCaches.get(runtime);
    if (cache !== undefined) return cache;
    cache = {
      directories: new Map(),
      directoryFlights: new Map(),
      existingDirectories: new Map(),
      projectRoots: new Map(),
      projectRootFlights: new Map(),
      revisions: new Map(),
      watchers: new Map(),
    };
    this.runtimeCaches.set(runtime, cache);
    return cache;
  }

  private async discoverDirectory(
    lease: RuntimeLease,
    cache: RuntimeCache,
    directory: string,
  ): Promise<readonly string[]> {
    const pathClass = lease.runtime.environment.pathClass;
    const key = pathKey(directory, pathClass);
    const cached = cache.directories.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.paths;
    const currentFlight = cache.directoryFlights.get(key);
    if (currentFlight !== undefined) return currentFlight;
    const flight = this.scanStableDirectory(lease, cache, normalize(directory), key).finally(() => {
      if (cache.directoryFlights.get(key) === flight) cache.directoryFlights.delete(key);
    });
    cache.directoryFlights.set(key, flight);
    return flight;
  }

  private async scanStableDirectory(
    lease: RuntimeLease,
    cache: RuntimeCache,
    directory: string,
    key: string,
  ): Promise<readonly string[]> {
    for (;;) {
      const revision = cache.revisions.get(key) ?? 0;
      const scanned = await this.scanDirectory(lease, cache, directory, key);
      if ((cache.revisions.get(key) ?? 0) !== revision) continue;
      cache.directories.set(key, {
        paths: scanned,
        expiresAt: this.now() + this.ttlMs,
      });
      return scanned;
    }
  }

  private async scanDirectory(
    lease: RuntimeLease,
    cache: RuntimeCache,
    directory: string,
    ownerKey: string,
  ): Promise<readonly string[]> {
    const runtime = lease.runtime;
    const fs = runtime.fs!;
    const pathClass = runtime.environment.pathClass;
    await this.ensureWatcher(lease, cache, directory, ownerKey);
    const entries = await readDir(fs, directory);
    if (entries === undefined) {
      cache.existingDirectories.delete(ownerKey);
      return [];
    }
    cache.existingDirectories.set(ownerKey, this.now() + this.ttlMs);
    const paths: string[] = [];
    const dotKimiEntry = namedEntry(entries, '.kimi-code', pathClass);
    if (dotKimiEntry !== undefined && (dotKimiEntry.isDirectory || dotKimiEntry.isSymbolicLink)) {
      const dotKimiDir = dirname(dotKimiAgentsMdPath(directory));
      const isDirectory = dotKimiEntry.isDirectory || (await statDirectory(fs, dotKimiDir));
      if (isDirectory) {
        await this.ensureWatcher(lease, cache, dotKimiDir, ownerKey);
        const nestedEntries = await readDir(fs, dotKimiDir);
        if (nestedEntries !== undefined) {
          const candidate = join(dotKimiDir, 'AGENTS.md');
          const entry = namedEntry(nestedEntries, 'AGENTS.md', pathClass);
          if (entry !== undefined && (await isNonEmptyFile(fs, candidate, entry))) {
            paths.push(normalize(candidate));
          }
        }
      }
    }
    for (const name of AGENTS_MD_PLAIN_NAMES) {
      const entry = namedEntry(entries, name, pathClass);
      if (entry === undefined) continue;
      const candidate = join(directory, name);
      if (await isNonEmptyFile(fs, candidate, entry)) {
        paths.push(normalize(candidate));
        break;
      }
    }
    return paths;
  }

  private async ensureWatcher(
    lease: RuntimeLease,
    cache: RuntimeCache,
    watchPath: string,
    ownerKey: string,
  ): Promise<void> {
    const runtime = lease.runtime;
    const watch = runtime.watch;
    if (watch === undefined || this.maxWatchers <= 0) return;
    const pathClass = runtime.environment.pathClass;
    const watchKey = pathKey(watchPath, pathClass);
    const current = cache.watchers.get(watchKey);
    if (current !== undefined) {
      current.owners.add(ownerKey);
      cache.watchers.delete(watchKey);
      cache.watchers.set(watchKey, current);
      await current.ready;
      return;
    }
    const owners = new Set([ownerKey]);
    const resources = new DisposableStore();
    let entry: WatchEntry;
    try {
      const handle = resources.add(watch.watch(watchPath, { recursive: false }));
      resources.add(
        handle.onDidChange((event) => {
          const changedKey = pathKey(event.path, pathClass);
          for (const owner of owners) {
            if (!affectsDirectory(owner, event.path, pathClass)) continue;
            if (changedKey === owner) cache.existingDirectories.delete(owner);
            this.invalidateKey(cache, owner);
          }
        }),
      );
      lease.track(resources);
      const ready = handle.ready.then(
        () => true,
        () => {
          if (cache.watchers.get(watchKey) === entry) cache.watchers.delete(watchKey);
          resources.dispose();
          return false;
        },
      );
      entry = { owners, ready, resources };
      cache.watchers.set(watchKey, entry);
      this.trimWatchers(cache);
      await ready;
    } catch {
      resources.dispose();
    }
  }

  private trimWatchers(cache: RuntimeCache): void {
    while (cache.watchers.size > this.maxWatchers) {
      const oldest = cache.watchers.entries().next();
      if (oldest.done === true) return;
      cache.watchers.delete(oldest.value[0]);
      oldest.value[1].resources.dispose();
    }
  }

  private async projectRoot(
    cache: RuntimeCache,
    fs: IHostFileSystem,
    anchor: string,
    pathClass: 'posix' | 'win32',
  ): Promise<string> {
    const key = pathKey(anchor, pathClass);
    const cached = cache.projectRoots.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.root;
    const currentFlight = cache.projectRootFlights.get(key);
    if (currentFlight !== undefined) return currentFlight;
    const flight = findProjectRoot({ fs }, anchor)
      .then((root) => {
        cache.projectRoots.set(key, { root, expiresAt: this.now() + this.ttlMs });
        return root;
      })
      .finally(() => {
        if (cache.projectRootFlights.get(key) === flight) cache.projectRootFlights.delete(key);
      });
    cache.projectRootFlights.set(key, flight);
    return flight;
  }

  private async nearestExistingDir(
    cache: RuntimeCache,
    fs: IHostFileSystem,
    path: string,
    pathClass: 'posix' | 'win32',
  ): Promise<string | undefined> {
    let current = normalize(path);
    for (;;) {
      const key = pathKey(current, pathClass);
      const cachedUntil = cache.existingDirectories.get(key);
      if (cachedUntil !== undefined && cachedUntil > this.now()) return current;
      cache.existingDirectories.delete(key);
      const stat = await fs.stat(current).catch(() => undefined);
      if (stat?.isDirectory === true) {
        cache.existingDirectories.set(key, this.now() + this.ttlMs);
        return current;
      }
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }

  private invalidateKey(cache: RuntimeCache, key: string): void {
    cache.directories.delete(key);
    cache.revisions.set(key, (cache.revisions.get(key) ?? 0) + 1);
  }
}

function namedEntry(
  entries: readonly HostDirEntry[],
  name: string,
  pathClass: 'posix' | 'win32',
): HostDirEntry | undefined {
  const expected = pathClass === 'win32' ? name.toLowerCase() : name;
  return entries.find((entry) =>
    pathClass === 'win32' ? entry.name.toLowerCase() === expected : entry.name === expected,
  );
}

async function readDir(
  fs: IHostFileSystem,
  directory: string,
): Promise<readonly HostDirEntry[] | undefined> {
  try {
    return await fs.readdir(directory);
  } catch {
    return undefined;
  }
}

async function statDirectory(fs: IHostFileSystem, path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

async function isNonEmptyFile(
  fs: IHostFileSystem,
  path: string,
  entry: HostDirEntry,
): Promise<boolean> {
  if (!entry.isFile && !entry.isSymbolicLink) return false;
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile) return false;
    return (await fs.readText(path, { errors: 'ignore' })).trim().length > 0;
  } catch {
    return false;
  }
}

function pathKey(path: string, pathClass: 'posix' | 'win32'): string {
  const normalized = normalize(path);
  return pathClass === 'win32' ? normalized.toLowerCase() : normalized;
}

function affectsDirectory(
  ownerKey: string,
  changedPath: string,
  pathClass: 'posix' | 'win32',
): boolean {
  const changedKey = pathKey(changedPath, pathClass);
  if (changedKey === ownerKey) return true;
  if (changedKey === pathKey(join(ownerKey, '.kimi-code'), pathClass)) return true;
  return [
    dotKimiAgentsMdPath(ownerKey),
    ...AGENTS_MD_PLAIN_NAMES.map((name) => join(ownerKey, name)),
  ].some((candidate) => pathKey(candidate, pathClass) === changedKey);
}

async function mapBoundedOrdered<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      output[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return output;
}

registerScopedService(
  LifecycleScope.App,
  IAgentsMdDiscoveryService,
  AgentsMdDiscoveryService,
  ScopeActivation.OnDemand,
  'agentsMdDiscovery',
);
