import { basename, dirname, join, normalize } from 'pathe';

import { DisposableStore } from '#/_base/di/lifecycle';
import { isPromiseLike } from '#/_base/lifecycle/disposer';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { AGENTS_MD_PLAIN_NAMES, dotKikiAgentsMdPath, findProjectRoot, instructionDirectories } from '#/agent/profile/context';
import type { HostDirEntry, IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { Runtime, RuntimeLease } from '#/runtime/runtime';

const DISCOVERY_CACHE_TTL_MS = 5_000;
const MAX_DIRECTORY_WATCHERS = 64;
const WATCHED_ENTRY_NAMES = new Set(['.kiki', ...AGENTS_MD_PLAIN_NAMES.map((name) => name.toLowerCase())]);

interface DirectoryEntry {
  readonly paths: readonly string[];
  readonly expiresAt: number;
}

interface ProjectRootEntry {
  readonly root: string;
  readonly expiresAt: number;
}

interface RealPathEntry {
  readonly path: string;
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
  readonly realpaths: Map<string, RealPathEntry>;
  readonly realpathFlights: Map<string, Promise<string>>;
  readonly revisions: Map<string, number>;
  readonly watchers: Map<string, WatchEntry>;
  pathIndexUnsubscribe?: () => void;
}

export interface DirectoryCacheState {
  readonly fresh: boolean;
  readonly revision: number;
}

export interface IAgentsMdDiscoveryService {
  readonly _serviceBrand: undefined;

  discover(lease: RuntimeLease, targetDir: string, boundary?: string): Promise<readonly string[]>;
  invalidate(runtime: Runtime, directory: string): void;
  resolveRealPath?(lease: RuntimeLease, directory: string): Promise<string>;
  directoryCacheState?(runtime: Runtime, directory: string): DirectoryCacheState;
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

  async discover(lease: RuntimeLease, workspaceDir: string, boundary?: string): Promise<readonly string[]> {
    const runtime = lease.runtime;
    const fs = runtime.fs;
    if (fs === undefined) return [];
    const cache = this.cacheFor(runtime);
    const projectRoot = boundary ?? await this.projectRoot(
      cache,
      fs,
      normalize(workspaceDir),
      runtime.environment.pathClass,
    );
    const directories = instructionDirectories(projectRoot, workspaceDir, runtime.environment.pathClass);
    const paths = await Promise.all(directories.map((directory) => this.discoverDirectory(lease, cache, directory)));
    return [...new Set(paths.flat())];
  }

  invalidate(runtime: Runtime, directory: string): void {
    const cache = this.runtimeCaches.get(runtime);
    if (cache === undefined) return;
    this.invalidateKey(cache, pathKey(directory, runtime.environment.pathClass));
  }

  async resolveRealPath(lease: RuntimeLease, directory: string): Promise<string> {
    const normalized = normalize(directory);
    const runtime = lease.runtime;
    const fs = runtime.fs;
    if (fs === undefined) return normalized;
    const cache = this.cacheFor(runtime);
    const now = this.now();
    const key = pathKey(normalized, runtime.environment.pathClass);
    const cached = cache.realpaths.get(key);
    if (cached !== undefined) {
      if (cached.expiresAt > now) return cached.path;
      cache.realpaths.delete(key);
    }
    const inflight = cache.realpathFlights.get(key);
    if (inflight !== undefined) return inflight;
    const flight = fs.realpath(normalized)
      .then((resolved) => {
        const canonical = normalize(resolved);
        if (this.ttlMs > 0) {
          const currentNow = this.now();
          for (const [entryKey, entry] of cache.realpaths) {
            if (entry.expiresAt <= currentNow) cache.realpaths.delete(entryKey);
          }
          cache.realpaths.set(key, { path: canonical, expiresAt: currentNow + this.ttlMs });
        }
        return canonical;
      })
      .finally(() => {
        if (cache.realpathFlights.get(key) === flight) cache.realpathFlights.delete(key);
      });
    cache.realpathFlights.set(key, flight);
    return flight;
  }

  directoryCacheState(runtime: Runtime, directory: string): DirectoryCacheState {
    const cache = this.runtimeCaches.get(runtime);
    if (cache === undefined) return { fresh: false, revision: 0 };
    const key = pathKey(directory, runtime.environment.pathClass);
    const cached = cache.directories.get(key);
    return {
      fresh: cached !== undefined && cached.expiresAt > this.now(),
      revision: cache.revisions.get(key) ?? 0,
    };
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
      realpaths: new Map(),
      realpathFlights: new Map(),
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
    const entries = await readDir(fs, directory);
    if (entries === undefined) {
      cache.existingDirectories.delete(ownerKey);
      return [];
    }
    await this.ensureWatcher(lease, cache, directory, ownerKey);
    cache.existingDirectories.set(ownerKey, this.now() + this.ttlMs);
    const paths: string[] = [];
    const dotKikiEntry = namedEntry(entries, '.kiki', pathClass);
    if (dotKikiEntry !== undefined && (dotKikiEntry.isDirectory || dotKikiEntry.isSymbolicLink)) {
      const dotKikiDir = dirname(dotKikiAgentsMdPath(directory));
      const isDirectory = dotKikiEntry.isDirectory || (await statDirectory(fs, dotKikiDir));
      if (isDirectory) {
        await this.ensureWatcher(lease, cache, dotKikiDir, ownerKey);
        const nestedEntries = await readDir(fs, dotKikiDir);
        if (nestedEntries !== undefined) {
          const entry = namedEntry(nestedEntries, 'AGENTS.md', pathClass);
          if (entry !== undefined) {
            const candidate = join(dotKikiDir, entry.name);
            if (await isNonEmptyFile(fs, candidate, entry)) paths.push(normalize(candidate));
          }
        }
      }
    }
    for (const name of AGENTS_MD_PLAIN_NAMES) {
      const entry = namedEntry(entries, name, pathClass);
      if (entry === undefined) continue;
      const candidate = join(directory, entry.name);
      if (!paths.includes(normalize(candidate)) && await isNonEmptyFile(fs, candidate, entry)) {
        paths.push(normalize(candidate));
      }
    }
    return paths;
  }

  private ensurePathIndexSubscription(runtime: Runtime, cache: RuntimeCache): boolean {
    const pathIndex = runtime.pathIndex;
    if (pathIndex === undefined || !pathIndex.isWatching) return false;
    if (cache.pathIndexUnsubscribe === undefined) {
      const pathClass = runtime.environment.pathClass;
      cache.pathIndexUnsubscribe = pathIndex.onDidMutate((changedPath) => {
        if (changedPath === undefined) {
          cache.existingDirectories.clear();
          cache.realpaths.clear();
          const keys = new Set([...cache.directories.keys(), ...cache.revisions.keys()]);
          for (const owner of keys) this.invalidateKey(cache, owner);
          return;
        }
        const name = basename(changedPath).toLowerCase();
        const parentDir = dirname(changedPath);
        const parentName = basename(parentDir).toLowerCase();
        const changedKey = pathKey(changedPath, pathClass);
        if (cache.directories.has(changedKey) || cache.revisions.has(changedKey)) {
          cache.existingDirectories.delete(changedKey);
          this.invalidateKey(cache, changedKey);
        }
        if (!WATCHED_ENTRY_NAMES.has(name) && parentName !== '.kiki') return;
        const affectedDir = parentName === '.kiki' ? dirname(parentDir) : parentDir;
        const affectedKey = pathKey(affectedDir, pathClass);
        if (cache.directories.has(affectedKey) || cache.revisions.has(affectedKey)) {
          cache.existingDirectories.delete(affectedKey);
          this.invalidateKey(cache, affectedKey);
        }
      });
    }
    return true;
  }

  private async ensureWatcher(
    lease: RuntimeLease,
    cache: RuntimeCache,
    watchPath: string,
    ownerKey: string,
  ): Promise<void> {
    const runtime = lease.runtime;
    const pathClass = runtime.environment.pathClass;
    if (
      runtime.pathIndex?.isWatching === true &&
      isPathUnderRoot(watchPath, runtime.pathIndex.root, pathClass) &&
      this.ensurePathIndexSubscription(runtime, cache)
    ) {
      return;
    }
    const watch = runtime.watch;
    if (watch === undefined || this.maxWatchers <= 0) return;
    const watchKey = pathKey(watchPath, pathClass);
    const current = cache.watchers.get(watchKey);
    if (current !== undefined) {
      current.owners.add(ownerKey);
      cache.watchers.delete(watchKey);
      cache.watchers.set(watchKey, current);
      return;
    }
    const owners = new Set([ownerKey]);
    const resources = new DisposableStore();
    let entry: WatchEntry;
    try {
      const handle = resources.add(watch.watch(watchPath, {
        recursive: false,
        signal: true,
        ignored: (changed: string) => {
          const changedKey = pathKey(changed, pathClass);
          if (changedKey === watchKey) return false;
          if (pathKey(dirname(changed), pathClass) !== watchKey) return true;
          return !WATCHED_ENTRY_NAMES.has(basename(changed).toLowerCase());
        },
      }));
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
        () => {
          for (const owner of owners) {
            if (cache.directories.has(owner)) this.invalidateKey(cache, owner);
          }
          return true;
        },
        () => {
          if (cache.watchers.get(watchKey) === entry) cache.watchers.delete(watchKey);
          const cleanup = resources.dispose();
          if (isPromiseLike(cleanup)) cleanup.catch(onUnexpectedError);
          return false;
        },
      );
      entry = { owners, ready, resources };
      cache.watchers.set(watchKey, entry);
      this.trimWatchers(cache);
    } catch {
      await resources.dispose();
    }
  }

  private trimWatchers(cache: RuntimeCache): void {
    while (cache.watchers.size > this.maxWatchers) {
      const oldest = cache.watchers.entries().next();
      if (oldest.done === true) return;
      cache.watchers.delete(oldest.value[0]);
      const cleanup = oldest.value[1].resources.dispose();
      if (isPromiseLike(cleanup)) cleanup.catch(onUnexpectedError);
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

  private invalidateKey(cache: RuntimeCache, key: string): void {
    cache.directories.delete(key);
    cache.realpaths.delete(key);
    cache.revisions.set(key, (cache.revisions.get(key) ?? 0) + 1);
  }
}

function namedEntry(
  entries: readonly HostDirEntry[],
  name: string,
  _pathClass: 'posix' | 'win32',
): HostDirEntry | undefined {
  const expected = name.toLowerCase();
  return entries
    .filter((entry) => entry.name.toLowerCase() === expected)
    .toSorted(
      (a, b) => Number(b.name === name) - Number(a.name === name) || a.name.localeCompare(b.name),
    )[0];
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
    return stat.isFile && stat.size > 0;
  } catch {
    return false;
  }
}

function pathKey(path: string, pathClass: 'posix' | 'win32'): string {
  const normalized = normalize(path);
  return pathClass === 'win32' ? normalized.toLowerCase() : normalized;
}

function isPathUnderRoot(candidate: string, root: string, pathClass: 'posix' | 'win32'): boolean {
  const normalizedCandidate = pathKey(candidate, pathClass);
  const normalizedRoot = pathKey(root, pathClass);
  if (normalizedCandidate === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedCandidate.startsWith(prefix);
}

function affectsDirectory(
  ownerKey: string,
  changedPath: string,
  pathClass: 'posix' | 'win32',
): boolean {
  const changedKey = pathKey(changedPath, pathClass);
  if (changedKey === ownerKey) return true;
  if (changedKey === pathKey(join(ownerKey, '.kiki'), pathClass)) return true;
  return [
    dotKikiAgentsMdPath(ownerKey),
    ...AGENTS_MD_PLAIN_NAMES.map((name) => join(ownerKey, name)),
  ].some((candidate) => pathKey(candidate, pathClass) === changedKey);
}


registerScopedService(
  LifecycleScope.App,
  IAgentsMdDiscoveryService,
  AgentsMdDiscoveryService,
  ScopeActivation.OnDemand,
  'agentsMdDiscovery',
);
