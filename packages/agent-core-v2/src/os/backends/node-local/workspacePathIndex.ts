import { watch, type FSWatcher } from 'node:fs';
import { createDeletedRootSpinDetector } from '#/_base/utils/fsWatchGuard';
import { isAbsolute, relative, resolve, basename } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import picomatch from 'picomatch';
import { computeFuzzyScore } from '#/_base/text/fuzzy';
import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import type { WorkspacePathEntry, WorkspacePathInventory } from './workspacePathInventory';
import { WorkspaceTrigramIndex } from './workspaceTrigramIndex';

export interface WorkspacePathSnapshot {
  readonly revision: number;
  readonly entries: readonly WorkspacePathEntry[];
}

export interface WorkspacePathIndexOptions {
  readonly watch?: typeof watch;
  readonly reconcileDebounceMs?: number;
  readonly maxScanRetainedMutations?: number;
}

type PreparedEntry = WorkspacePathEntry & { readonly charMask: number };

interface PathTable {
  readonly prepared: Map<string, PreparedEntry>;
  readonly byPath: Map<string, WorkspacePathEntry>;
  readonly directoryCounts: Map<string, number>;
}

interface ScanMutationRecord {
  readonly seq: number;
  readonly key: string;
  readonly entry: WorkspacePathEntry | undefined;
}

interface ActiveScan {
  readonly revision: number;
  readonly startSeq: number;
  readonly trackedKeys: Set<string>;
  readonly retained: Map<string, ScanMutationRecord>;
  fidelityLost: boolean;
}

const MUTATION_COALESCE_MS = 16;
const DEFAULT_RECONCILE_DEBOUNCE_MS = 250;
const DEFAULT_MAX_SCAN_RETAINED_MUTATIONS = 4_096;

/** Returns true when a workspace root targets a UNC or SMB network share (`\\server\share`, `//server/share`, `\\?\UNC\server\share`). */
export function isUncRoot(path: string): boolean {
  return /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(path)
    || /^\\\\\?\\UNC[\\/][^\\/]+[\\/][^\\/]+/i.test(path);
}

function isTrigramFile(entry: WorkspacePathEntry | undefined): entry is WorkspacePathEntry {
  return entry !== undefined && entry.kind === 'file' && !entry.sensitive;
}

function sameFileIdentity(left: WorkspacePathEntry, right: WorkspacePathEntry): boolean {
  return left.path === right.path
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.size === right.size
    && left.ino === right.ino;
}

function diffTrigramPatches(
  previousByPath: ReadonlyMap<string, WorkspacePathEntry>,
  nextByPath: ReadonlyMap<string, WorkspacePathEntry>,
  dirtyPaths?: ReadonlySet<string>,
): Array<readonly [string, WorkspacePathEntry | undefined]> {
  const patches = new Map<string, WorkspacePathEntry | undefined>();
  for (const [key, next] of nextByPath) {
    if (!isTrigramFile(next)) continue;
    const prev = previousByPath.get(key);
    if (!isTrigramFile(prev) || !sameFileIdentity(prev, next)) {
      if (isTrigramFile(prev) && prev.path !== next.path) {
        patches.set(prev.path, undefined);
      }
      patches.set(next.path, next);
    }
  }
  for (const [key, prev] of previousByPath) {
    if (!isTrigramFile(prev)) continue;
    const next = nextByPath.get(key);
    if (!isTrigramFile(next)) {
      patches.set(prev.path, undefined);
    }
  }
  if (dirtyPaths !== undefined) {
    for (const dirtyPath of dirtyPaths) {
      if (patches.has(dirtyPath)) continue;
      const next = nextByPath.get(pathIdentity(dirtyPath));
      patches.set(dirtyPath, isTrigramFile(next) && next.path === dirtyPath ? next : undefined);
    }
  }
  return [...patches];
}

function pathIdentity(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path; }

function characterMask(text: string, asciiOnly = false): number {
  let mask = 0;
  for (const char of text.toLowerCase()) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 97 && code <= 122) mask |= 1 << (code - 97);
    else if (code >= 48 && code <= 57) mask |= 1 << (26 + (code - 48) % 5);
    else if (!asciiOnly) mask |= 1 << 31;
  }
  return mask;
}

function insertEntry(table: PathTable, key: string, entry: WorkspacePathEntry): void {
  if (!table.byPath.has(key)) {
    let slash = key.indexOf('/');
    while (slash !== -1) {
      const ancestor = key.slice(0, slash);
      table.directoryCounts.set(ancestor, (table.directoryCounts.get(ancestor) ?? 0) + 1);
      slash = key.indexOf('/', slash + 1);
    }
  }
  table.byPath.set(key, entry);
  table.prepared.set(key, { ...entry, charMask: characterMask(entry.path) });
}

function deleteEntry(table: PathTable, key: string): WorkspacePathEntry | undefined {
  const removed = table.byPath.get(key);
  if (removed === undefined) return undefined;
  table.byPath.delete(key);
  table.prepared.delete(key);
  let slash = key.indexOf('/');
  while (slash !== -1) {
    const ancestor = key.slice(0, slash);
    const next = (table.directoryCounts.get(ancestor) ?? 0) - 1;
    if (next <= 0) table.directoryCounts.delete(ancestor);
    else table.directoryCounts.set(ancestor, next);
    slash = key.indexOf('/', slash + 1);
  }
  return removed;
}

function applyEntryMutation(
  table: PathTable,
  key: string,
  entry: WorkspacePathEntry | undefined,
  onRemovedChild?: (childPath: string) => void,
): void {
  if (entry === undefined) {
    deleteEntry(table, key);
    if ((table.directoryCounts.get(key) ?? 0) > 0) {
      const prefix = `${key}/`;
      for (const existing of Array.from(table.byPath.keys())) {
        if (existing.startsWith(prefix)) {
          const removed = deleteEntry(table, existing);
          if (removed !== undefined) onRemovedChild?.(removed.path);
        }
      }
    }
    return;
  }
  insertEntry(table, key, entry);
}

export class WorkspacePathIndex {
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private publishTimer?: ReturnType<typeof setTimeout>;
  private repair?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private revision = 0;
  private snapshotRevision = 0;
  private mutationSeq = 0;
  private committedScanStartSeq = 0;
  private current?: WorkspacePathSnapshot;
  private hasBaseSnapshot = false;
  private snapshotDirty = false;
  private prepared = new Map<string, PreparedEntry>();
  private byPath = new Map<string, WorkspacePathEntry>();
  private directoryCounts = new Map<string, number>();
  private readonly pendingTrigramPatches = new Map<string, WorkspacePathEntry | undefined>();
  private readonly pathUpdates = new Map<string, Promise<void>>();
  private readonly globCache = new Map<string, readonly string[]>();
  private readonly globInflight = new Map<string, Promise<readonly string[] | undefined>>();
  private readonly fuzzyCache = new Map<string, readonly WorkspacePathEntry[]>();
  private readonly controller = new AbortController();
  private readonly mutationListeners = new Set<(path: string | undefined) => void>();
  private readonly networkRoot: boolean;
  private readonly watchFn: typeof watch;
  private readonly reconcileDebounceMs: number;
  private readonly maxScanRetainedMutations: number;
  private refreshController: AbortController | undefined;
  private activeScan: ActiveScan | undefined;
  private started = false;
  private disposed = false;
  private watching = false;
  private overflowed = false;
  private rootDeleted = false;
  private hadCommittedSnapshot = false;
  private reconcileQueued = false;
  readonly trigram?: WorkspaceTrigramIndex;
  error?: unknown;

  get isOverflowed(): boolean { return this.overflowed; }
  get isStarted(): boolean { return this.started; }
  get isWatching(): boolean { return this.watching; }
  get isNetworkRoot(): boolean { return this.networkRoot; }

  constructor(
    readonly root: string,
    private readonly cpu: ICpuWorkerService,
    cacheDir?: string,
    options: WorkspacePathIndexOptions = {},
  ) {
    this.networkRoot = isUncRoot(root) || isUncRoot(resolve(root));
    this.root = this.networkRoot ? root : resolve(root);
    this.watchFn = options.watch ?? watch;
    this.reconcileDebounceMs = options.reconcileDebounceMs ?? DEFAULT_RECONCILE_DEBOUNCE_MS;
    this.maxScanRetainedMutations = Math.max(0, options.maxScanRetainedMutations ?? DEFAULT_MAX_SCAN_RETAINED_MUTATIONS);
    if (cacheDir !== undefined && !this.networkRoot) {
      this.trigram = new WorkspaceTrigramIndex(this.root, cacheDir, cpu);
    }
  }

  onDidMutate(listener: (path: string | undefined) => void): () => void {
    this.mutationListeners.add(listener);
    return () => { this.mutationListeners.delete(listener); };
  }

  private emitMutation(path: string | undefined): void {
    for (const listener of this.mutationListeners) {
      try { listener(path); } catch {}
    }
  }

  private ensureStarted(triggerRefresh = true): void {
    if (this.started || this.disposed || this.networkRoot) return;
    this.started = true;
    try {
      const isDeletedSpin = createDeletedRootSpinDetector(this.root);
      this.watcher = this.watchFn(this.root, { recursive: true }, (_kind, filename) => {
        if (isDeletedSpin()) {
          this.rootDeleted = true;
          this.watching = false;
          this.hadCommittedSnapshot = false;
          this.reconcileQueued = false;
          this.activeScan = undefined;
          this.refreshController?.abort();
          this.refreshController = undefined;
          this.clearPublishedState();
          this.trigram?.reset();
          this.emitMutation(undefined);
          this.watcher?.close();
          this.watcher = undefined;
          return;
        }
        if (filename !== null && filename.split(/[\\/]/u).some(part => ['.git', '.hg', '.svn', '.jj', '.bzr', '.sl'].includes(part.toLowerCase()))) return;
        if (filename === null) {
          this.invalidate();
        } else {
          const fullPath = resolve(this.root, filename);
          this.emitMutation(fullPath);
          void this.mutation(fullPath);
        }
      });
      this.watcher.on('error', error => {
        this.error = error;
        this.watching = false;
        if (this.activeScan !== undefined) {
          this.loseScanFidelity(this.activeScan);
        } else {
          this.clearPublishedState();
          this.trigram?.invalidate();
          this.globCache.clear();
          this.fuzzyCache.clear();
        }
        this.emitMutation(undefined);
        this.watcher?.close();
        this.watcher = undefined;
      });
      this.watcher.unref();
      this.watching = true;
    } catch (error) {
      this.error = error;
    }
    if (this.watching) {
      this.repair = setInterval(() => { this.scheduleReconcile(); }, 10 * 60_000);
      this.repair.unref();
      if (triggerRefresh) void this.refresh();
    }
  }

  private armReconcileTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, this.reconcileDebounceMs);
    this.timer.unref();
  }

  private scheduleReconcile(): void {
    if (!this.started || this.disposed || this.networkRoot || this.rootDeleted) return;
    if (this.pending !== undefined) {
      this.reconcileQueued = true;
      return;
    }
    this.armReconcileTimer();
  }

  private clearPublishedState(): void {
    this.current = undefined;
    this.hasBaseSnapshot = false;
    this.snapshotDirty = false;
    this.pendingTrigramPatches.clear();
    if (this.publishTimer !== undefined) {
      clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
    }
  }

  notifyExternalChange(): void {
    if (!this.started || this.disposed || this.networkRoot || this.rootDeleted) return;
    if (this.watching && !this.overflowed) return;
    this.scheduleReconcile();
  }

  private loseScanFidelity(scan: ActiveScan): void {
    scan.fidelityLost = true;
    scan.trackedKeys.clear();
    scan.retained.clear();
    this.reconcileQueued = true;
    this.clearPublishedState();
    this.trigram?.invalidate();
    this.globCache.clear();
    this.fuzzyCache.clear();
    if (this.activeScan === scan) this.refreshController?.abort();
  }

  invalidate(): void {
    if (!this.started || this.disposed || this.networkRoot || this.rootDeleted) return;
    this.revision++;
    this.reconcileQueued = false;
    this.activeScan = undefined;
    this.refreshController?.abort();
    this.refreshController = undefined;
    this.clearPublishedState();
    this.trigram?.invalidate();
    this.globCache.clear();
    this.fuzzyCache.clear();
    this.emitMutation(undefined);
    this.armReconcileTimer();
  }

  private applyLiveMutation(key: string, display: string, entry: WorkspacePathEntry | undefined): void {
    const table: PathTable = {
      prepared: this.prepared,
      byPath: this.byPath,
      directoryCounts: this.directoryCounts,
    };
    applyEntryMutation(table, key, entry, childPath => {
      this.trigram?.dirty(childPath);
      this.pendingTrigramPatches.set(childPath, undefined);
    });
    this.snapshotDirty = true;
    this.globCache.clear();
    this.fuzzyCache.clear();
    if (!this.overflowed) this.trigram?.dirty(entry?.path ?? display);
    this.pendingTrigramPatches.set(display, entry);
    this.schedulePublish();
  }

  private schedulePublish(): void {
    if (this.publishTimer !== undefined) clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      if (this.pathUpdates.size === 0) this.publishPendingMutations();
    }, MUTATION_COALESCE_MS);
    this.publishTimer.unref();
  }

  private publishPendingMutations(): void {
    if (this.publishTimer !== undefined) {
      clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
    }
    if (!this.snapshotDirty || !this.hasBaseSnapshot || this.disposed) return;
    this.snapshotDirty = false;
    const next: WorkspacePathSnapshot = {
      revision: ++this.snapshotRevision,
      entries: [...this.byPath.values()],
    };
    this.current = next;
    if (this.pendingTrigramPatches.size > 0) {
      const patches = [...this.pendingTrigramPatches];
      this.pendingTrigramPatches.clear();
      this.trigram?.patchBatch(next, patches);
    }
  }

  async mutation(path: string): Promise<void> {
    if (!this.started || this.disposed || this.networkRoot || this.rootDeleted) return;
    const resolved = resolve(path);
    const local = relative(this.root, resolved).replaceAll('\\', '/');
    if (local === '..' || local.startsWith('../') || isAbsolute(local)) return;
    this.emitMutation(resolved);
    if (local === '' || ['.gitignore', '.ignore', '.rgignore'].includes(basename(local).toLowerCase())) {
      this.invalidate();
      return;
    }
    const seq = ++this.mutationSeq;
    const key = pathIdentity(local);
    const entryScan = this.activeScan;
    if (this.overflowed) {
      if (entryScan !== undefined) entryScan.fidelityLost = true;
      return;
    }
    this.trigram?.dirty(this.byPath.get(key)?.path ?? local);
    if (entryScan !== undefined && !entryScan.fidelityLost && seq > entryScan.startSeq) {
      if (!entryScan.trackedKeys.has(key)) {
        if (entryScan.trackedKeys.size >= this.maxScanRetainedMutations) {
          this.loseScanFidelity(entryScan);
        } else {
          entryScan.trackedKeys.add(key);
        }
      }
    }
    const previous = this.pathUpdates.get(key) ?? Promise.resolve();
    const update = previous.then(async () => {
      if (this.disposed || this.overflowed) return;
      const scanAtStart = this.activeScan;
      const trackingForScan = scanAtStart !== undefined && !scanAtStart.fidelityLost && seq > scanAtStart.startSeq;
      if (!this.hasBaseSnapshot && !trackingForScan) {
        if (scanAtStart === undefined) this.invalidate();
        return;
      }
      const epoch = this.revision;
      const display = this.byPath.get(key)?.path ?? local;
      const entry = await this.cpu.request<WorkspacePathEntry | undefined>(
        { type: 'workspace.path', root: this.root, path: resolve(this.root, display) },
        { signal: this.controller.signal, timeoutMs: 30_000, priority: 'low' },
      );
      if (this.disposed || this.overflowed || epoch !== this.revision) return;
      if (seq <= this.committedScanStartSeq) return;
      if (entry?.kind === 'directory') {
        const old = this.byPath.get(key);
        if (!this.hasBaseSnapshot || old?.kind !== 'directory' || old.ino !== entry.ino) this.invalidate();
        return;
      }
      const currentScan = this.activeScan;
      if (currentScan !== undefined && currentScan.revision === epoch && seq > currentScan.startSeq) {
        if (currentScan.fidelityLost) return;
        if (!currentScan.retained.has(key) && currentScan.retained.size >= this.maxScanRetainedMutations) {
          this.loseScanFidelity(currentScan);
          return;
        }
        currentScan.retained.set(key, { seq, key, entry });
      }
      if (!this.hasBaseSnapshot) return;
      this.applyLiveMutation(key, display, entry);
    }).catch(error => {
      if (!this.disposed) { this.error = error; this.invalidate(); }
    }).finally(() => { if (this.pathUpdates.get(key) === update) this.pathUpdates.delete(key); });
    this.pathUpdates.set(key, update);
    await update;
  }

  async whenSettled(): Promise<void> {
    while (this.pathUpdates.size > 0) await Promise.all(this.pathUpdates.values());
  }

  async refresh(): Promise<void> {
    this.ensureStarted(false);
    if (this.disposed || this.networkRoot || this.rootDeleted) return;
    if (this.pending !== undefined) {
      await this.pending;
      while (this.pending !== undefined) await this.pending;
      return;
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const revision = this.revision;
    const scan: ActiveScan = {
      revision,
      startSeq: this.mutationSeq,
      trackedKeys: new Set(),
      retained: new Map(),
      fidelityLost: false,
    };
    this.activeScan = scan;
    const refreshController = new AbortController();
    this.refreshController = refreshController;
    const onDispose = (): void => { refreshController.abort(); };
    this.controller.signal.addEventListener('abort', onDispose, { once: true });
    this.pending = this.cpu.request<WorkspacePathInventory>(
      { type: 'workspace.paths', root: this.root, limit: 250_000 },
      { signal: refreshController.signal, timeoutMs: 120_000, priority: 'low' },
    )
      .then(async inventory => {
        if (inventory.overflow) {
          if (this.disposed || revision !== this.revision || this.activeScan !== scan) return;
          this.overflowed = true;
          this.hadCommittedSnapshot = false;
          this.reconcileQueued = false;
          this.clearPublishedState();
          this.prepared.clear();
          this.byPath.clear();
          this.directoryCounts.clear();
          this.globCache.clear();
          this.fuzzyCache.clear();
          this.trigram?.reset();
          return;
        }
        const previousByPath = this.hadCommittedSnapshot ? this.byPath : undefined;
        const nextTable: PathTable = {
          prepared: new Map(),
          byPath: new Map(),
          directoryCounts: new Map(),
        };
        const totalEntries = inventory.entries.length;
        for (let offset = 0; offset < totalEntries; offset += 256) {
          if (this.disposed || revision !== this.revision || this.activeScan !== scan) return;
          if (scan.fidelityLost) break;
          const end = Math.min(offset + 256, totalEntries);
          for (let i = offset; i < end; i += 1) {
            const entry = inventory.entries[i]!;
            insertEntry(nextTable, pathIdentity(entry.path), entry);
          }
          await yieldToEventLoop();
        }
        if (this.disposed || revision !== this.revision || this.activeScan !== scan) return;
        if (scan.fidelityLost) {
          this.overflowed = false;
          this.clearPublishedState();
          this.trigram?.invalidate();
          this.globCache.clear();
          this.fuzzyCache.clear();
          this.reconcileQueued = true;
          return;
        }
        const replayed = scan.retained.size > 0;
        if (replayed) {
          const records = [...scan.retained.values()].toSorted((left, right) => left.seq - right.seq);
          for (const record of records) {
            applyEntryMutation(nextTable, record.key, record.entry);
          }
        }
        let dirtyPaths: ReadonlySet<string> | undefined = this.trigram?.dirtyPaths;
        if (this.pendingTrigramPatches.size > 0) {
          const merged = new Set<string>(dirtyPaths);
          for (const path of this.pendingTrigramPatches.keys()) merged.add(path);
          dirtyPaths = merged;
        }
        const patches = previousByPath === undefined
          ? undefined
          : diffTrigramPatches(previousByPath, nextTable.byPath, dirtyPaths);
        this.overflowed = false;
        this.prepared = nextTable.prepared;
        this.byPath = nextTable.byPath;
        this.directoryCounts = nextTable.directoryCounts;
        this.snapshotDirty = false;
        this.pendingTrigramPatches.clear();
        if (this.publishTimer !== undefined) {
          clearTimeout(this.publishTimer);
          this.publishTimer = undefined;
        }
        this.globCache.clear();
        this.fuzzyCache.clear();
        this.committedScanStartSeq = Math.max(this.committedScanStartSeq, scan.startSeq);
        this.hasBaseSnapshot = true;
        this.hadCommittedSnapshot = true;
        const entries = replayed ? [...nextTable.byPath.values()] : inventory.entries;
        this.current = { revision: ++this.snapshotRevision, entries };
        if (patches !== undefined) {
          this.trigram?.reconcile(this.current, patches);
        } else {
          this.trigram?.rebuild(this.current);
        }
        this.error = undefined;
      }, error => {
        if (!refreshController.signal.aborted) this.error = error;
      })
      .finally(() => {
        this.controller.signal.removeEventListener('abort', onDispose);
        if (this.refreshController === refreshController) this.refreshController = undefined;
        if (this.activeScan === scan) this.activeScan = undefined;
        this.pending = undefined;
        if (!this.disposed && !this.networkRoot && !this.rootDeleted) {
          if (revision !== this.revision && this.timer === undefined) {
            void this.refresh();
          } else if (this.reconcileQueued && this.timer === undefined) {
            this.reconcileQueued = false;
            this.armReconcileTimer();
          }
        }
      });
    await this.pending;
    while (this.pending !== undefined) await this.pending;
  }

  snapshot(): WorkspacePathSnapshot | undefined {
    this.ensureStarted(true);
    this.publishPendingMutations();
    return this.current;
  }

  mtime(path: string): number | undefined {
    if (!this.hasBaseSnapshot) return undefined;
    return this.byPath.get(pathIdentity(relative(this.root, path).replaceAll('\\', '/')))?.mtimeMs;
  }

  async glob(directory: string, pattern: string): Promise<readonly string[] | undefined> {
    this.ensureStarted(true);
    await this.whenSettled();
    this.publishPendingMutations();
    if (this.current === undefined || pattern.includes('{') && pattern.includes('/')) return undefined;
    const prefix = relative(this.root, resolve(directory)).replaceAll('\\', '/');
    if (prefix === '..' || prefix.startsWith('../') || isAbsolute(prefix)) return undefined;
    const key = `${prefix}\0${pattern}`;
    const cached = this.globCache.get(key);
    if (cached !== undefined) return cached;
    const snapshot = this.current;
    const inflightKey = `${snapshot.revision}\0${key}`;
    const existing = this.globInflight.get(inflightKey);
    if (existing !== undefined) return existing;
    const work = (async (): Promise<readonly string[] | undefined> => {
      const normalized = pattern.replace(/^\//u, '');
      const insensitive = process.platform === 'win32';
      const matcher = picomatch(normalized, { dot: true, nocase: insensitive, basename: !normalized.includes('/') && normalized !== '*' });
      const depth = !normalized.includes('**') && (normalized === '*' || normalized.includes('/')) ? normalized.split('/').length : Infinity;
      const start = prefix === '' ? '' : `${prefix}/`;
      const lowerStart = insensitive ? start.toLowerCase() : start;
      const entries = snapshot.entries;
      const matchedEntries: WorkspacePathEntry[] = [];
      let yieldedAt = performance.now();
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!;
        if (entry.kind === 'file') {
          const matchesPrefix = insensitive ? entry.path.toLowerCase().startsWith(lowerStart) : entry.path.startsWith(start);
          if (matchesPrefix) {
            const local = entry.path.slice(start.length);
            if (local.split('/').length <= depth && matcher(local)) {
              matchedEntries.push(entry);
            }
          }
        }
        if ((index & 511) === 511 && performance.now() - yieldedAt >= 2.5) {
          await yieldToEventLoop();
          if (this.disposed) return undefined;
          yieldedAt = performance.now();
        }
      }
      matchedEntries.sort((left, right) => right.mtimeMs - left.mtimeMs || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
      const rootSep = process.platform === 'win32' ? '\\' : '/';
      const rootPrefix = this.root.endsWith(rootSep) ? this.root : `${this.root}${rootSep}`;
      const matches: string[] = [];
      yieldedAt = performance.now();
      for (let index = 0; index < matchedEntries.length; index++) {
        const rel = matchedEntries[index]!.path;
        matches.push(process.platform === 'win32' ? `${rootPrefix}${rel.replaceAll('/', '\\')}` : `${rootPrefix}${rel}`);
        if ((index & 511) === 511 && performance.now() - yieldedAt >= 2.5) {
          await yieldToEventLoop();
          if (this.disposed) return undefined;
          yieldedAt = performance.now();
        }
      }
      if (this.current === snapshot) {
        if (this.globCache.size >= 32) this.globCache.delete(this.globCache.keys().next().value!);
        this.globCache.set(key, matches);
      }
      return matches;
    })().finally(() => {
      if (this.globInflight.get(inflightKey) === work) this.globInflight.delete(inflightKey);
    });
    this.globInflight.set(inflightKey, work);
    return work;
  }

  fuzzy(query: string, pathMode: boolean): readonly WorkspacePathEntry[] | undefined {
    this.ensureStarted(true);
    this.publishPendingMutations();
    if (this.current === undefined) return undefined;
    if (query === '') {
      return this.current.entries.filter(entry => !entry.sensitive);
    }
    const key = `${Number(pathMode)}\0${query}`;
    const cached = this.fuzzyCache.get(key);
    if (cached !== undefined) return cached;
    const lower = query.toLowerCase();
    const mask = characterMask(lower, true);
    const matches = [...this.prepared.values()]
      .filter(entry => !entry.sensitive && (entry.charMask & mask) === mask)
      .map(entry => ({ entry, score: computeFuzzyScore(pathMode ? entry.path : entry.name, lower) }))
      .filter(item => item.score > 0).toSorted((left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path))
      .map(item => item.entry);
    if (this.fuzzyCache.size >= 32) this.fuzzyCache.delete(this.fuzzyCache.keys().next().value!);
    this.fuzzyCache.set(key, matches);
    return matches;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.controller.abort();
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.publishTimer !== undefined) clearTimeout(this.publishTimer);
    if (this.repair !== undefined) clearInterval(this.repair);
    this.clearPublishedState();
    this.activeScan = undefined;
    this.refreshController = undefined;
    this.hadCommittedSnapshot = false;
    this.reconcileQueued = false;
    this.mutationListeners.clear();
    this.prepared.clear();
    this.byPath.clear();
    this.directoryCounts.clear();
    this.globCache.clear();
    this.fuzzyCache.clear();
    await Promise.all([this.pending, this.whenSettled(), this.trigram?.dispose()]);
  }
}
