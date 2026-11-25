import { statSync, watch, type FSWatcher } from 'node:fs';
import { createDeletedRootSpinDetector } from '#/_base/utils/fsWatchGuard';
import { isAbsolute, relative, resolve, basename } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import picomatch from 'picomatch';
import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import { isAlwaysIgnoredPathSegment, type WorkspacePathEntry, type WorkspacePathInventory } from './workspacePathInventory';
import { WorkspaceTrigramIndex } from './workspaceTrigramIndex';

export interface WorkspacePathSnapshot {
  readonly revision: number;
  readonly entries: readonly WorkspacePathEntry[];
}

export interface WorkspacePathIndexOptions {
  readonly watch?: typeof watch;
  readonly statSync?: typeof statSync;
  readonly reconcileDebounceMs?: number;
  readonly maxScanRetainedMutations?: number;
  readonly settleTimeoutMs?: number;
}

interface PreparedEntry {
  readonly entry: WorkspacePathEntry;
  readonly key: string;
  readonly pathLower: string;
  readonly nameLower: string;
  readonly charMask: number;
  readonly nameCharMask: number;
  baseIndex: number;
  active: boolean;
}

interface PathTable {
  readonly prepared: Map<string, PreparedEntry>;
  readonly byPath: Map<string, WorkspacePathEntry>;
  readonly directoryCounts: Map<string, number>;
  readonly sortedBase: PreparedEntry[];
  readonly liveInserted: Map<string, PreparedEntry>;
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
const DEFAULT_SETTLE_TIMEOUT_MS = 250;
const DEFAULT_MAX_SCAN_RETAINED_MUTATIONS = 4_096;
const WATCHER_BURST_RECONCILE_THRESHOLD = 64;
const MAX_CONCURRENT_WATCHER_UPDATES = 4;

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
    const code = char.charCodeAt(0);
    if (code >= 97 && code <= 122) mask |= 1 << (code - 97);
    else if (code >= 48 && code <= 57) mask |= 1 << (26 + (code - 48) % 5);
    else if (!asciiOnly) mask |= 1 << 31;
  }
  return mask;
}

function comparePathCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function matchesSubsequence(targetLower: string, chars: readonly string[]): boolean {
  let idx = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const found = targetLower.indexOf(chars[i]!, idx);
    if (found < 0) return false;
    idx = found + 1;
  }
  return true;
}

function createPreparedEntry(key: string, entry: WorkspacePathEntry, baseIndex: number): PreparedEntry {
  const pathLower = entry.path.toLowerCase();
  const nameLower = entry.name.toLowerCase();
  return {
    entry,
    key,
    pathLower,
    nameLower,
    charMask: characterMask(pathLower),
    nameCharMask: characterMask(nameLower),
    baseIndex,
    active: true,
  };
}

function insertEntry(table: PathTable, key: string, entry: WorkspacePathEntry, appendToBase = false): void {
  const prevPrepared = table.prepared.get(key);
  if (!table.byPath.has(key)) {
    let slash = key.indexOf('/');
    while (slash !== -1) {
      const ancestor = key.slice(0, slash);
      table.directoryCounts.set(ancestor, (table.directoryCounts.get(ancestor) ?? 0) + 1);
      slash = key.indexOf('/', slash + 1);
    }
  }
  table.byPath.set(key, entry);
  if (appendToBase) {
    const prepared = createPreparedEntry(key, entry, table.sortedBase.length);
    if (prevPrepared !== undefined) {
      prevPrepared.active = false;
      table.liveInserted.delete(key);
    }
    table.sortedBase.push(prepared);
    table.prepared.set(key, prepared);
    return;
  }
  if (prevPrepared !== undefined && prevPrepared.baseIndex >= 0 && prevPrepared.entry.path === entry.path) {
    const prepared = createPreparedEntry(key, entry, prevPrepared.baseIndex);
    prevPrepared.active = false;
    table.sortedBase[prevPrepared.baseIndex] = prepared;
    table.prepared.set(key, prepared);
    return;
  }
  if (prevPrepared !== undefined) {
    prevPrepared.active = false;
    table.liveInserted.delete(key);
  }
  const prepared = createPreparedEntry(key, entry, -1);
  table.prepared.set(key, prepared);
  table.liveInserted.set(key, prepared);
}

function deleteEntry(table: PathTable, key: string): WorkspacePathEntry | undefined {
  const removed = table.byPath.get(key);
  if (removed === undefined) return undefined;
  const prevPrepared = table.prepared.get(key);
  if (prevPrepared !== undefined) {
    prevPrepared.active = false;
    if (prevPrepared.baseIndex < 0) table.liveInserted.delete(key);
  }
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
  private watcherTimer?: ReturnType<typeof setTimeout>;
  private repair?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private watcherDrain?: Promise<void>;
  private readonly watcherPending = new Set<string>();
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
  private sortedBase: PreparedEntry[] = [];
  private liveInserted = new Map<string, PreparedEntry>();
  private readonly pendingTrigramPatches = new Map<string, WorkspacePathEntry | undefined>();
  private readonly pathUpdates = new Map<string, Promise<void>>();
  private readonly globCache = new Map<string, readonly string[]>();
  private readonly globInflight = new Map<string, Promise<readonly string[] | undefined>>();
  private readonly fuzzyCache = new Map<string, readonly WorkspacePathEntry[]>();
  private readonly controller = new AbortController();
  private readonly mutationListeners = new Set<(path: string | undefined) => void>();
  private readonly networkRoot: boolean;
  private readonly watchFn: typeof watch;
  private readonly statSyncFn: typeof statSync | undefined;
  private readonly reconcileDebounceMs: number;
  private readonly maxScanRetainedMutations: number;
  private readonly settleTimeoutMs: number;
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
    this.statSyncFn = options.statSync ?? (options.watch === undefined ? statSync : undefined);
    this.reconcileDebounceMs = options.reconcileDebounceMs ?? DEFAULT_RECONCILE_DEBOUNCE_MS;
    this.maxScanRetainedMutations = Math.max(0, options.maxScanRetainedMutations ?? DEFAULT_MAX_SCAN_RETAINED_MUTATIONS);
    this.settleTimeoutMs = Math.max(0, options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);
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

  private watchRootIsDirectory(): boolean {
    if (this.statSyncFn === undefined) return true;
    try {
      return this.statSyncFn(this.root).isDirectory();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw error;
    }
  }

  private ensureStarted(triggerRefresh = true): void {
    if (this.started || this.disposed || this.networkRoot) return;
    this.started = true;
    try {
      if (!this.watchRootIsDirectory()) {
        this.rootDeleted = true;
        return;
      }
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
          this.clearWatcherPending();
          this.clearPublishedState();
          this.trigram?.reset();
          this.emitMutation(undefined);
          this.watcher?.close();
          this.watcher = undefined;
          return;
        }
        if (filename !== null && filename.split(/[\\/]/u).some(isAlwaysIgnoredPathSegment)) return;
        if (filename === null) {
          this.clearWatcherPending();
          this.invalidate();
        } else {
          const fullPath = resolve(this.root, filename);
          this.emitMutation(fullPath);
          this.enqueueWatcherMutation(fullPath);
        }
      });
      this.watcher.on('error', error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.rootDeleted = true;
        }
        this.error = error;
        this.watching = false;
        this.clearWatcherPending();
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

  private clearWatcherPending(): void {
    if (this.watcherTimer !== undefined) {
      clearTimeout(this.watcherTimer);
      this.watcherTimer = undefined;
    }
    this.watcherPending.clear();
  }

  private enqueueWatcherMutation(fullPath: string): void {
    if (!this.started || this.disposed || this.networkRoot || this.rootDeleted) return;
    const local = relative(this.root, fullPath).replaceAll('\\', '/');
    if (local === '..' || local.startsWith('../') || isAbsolute(local)) return;
    if (local.split('/').some(isAlwaysIgnoredPathSegment)) return;
    if (local === '' || ['.gitignore', '.ignore', '.rgignore'].includes(basename(local).toLowerCase())) {
      this.clearWatcherPending();
      this.invalidate();
      return;
    }
    if (this.overflowed) {
      if (this.activeScan !== undefined) this.activeScan.fidelityLost = true;
      return;
    }
    if (this.reconcileQueued) return;
    if (this.timer !== undefined) {
      this.armReconcileTimer();
      return;
    }
    this.watcherPending.add(fullPath);
    if (this.watcherPending.size > WATCHER_BURST_RECONCILE_THRESHOLD) {
      this.clearWatcherPending();
      if (this.activeScan !== undefined) {
        this.loseScanFidelity(this.activeScan);
      }
      this.scheduleReconcile();
      return;
    }
    if (this.watcherTimer === undefined) {
      this.watcherTimer = setTimeout(() => {
        this.watcherTimer = undefined;
        this.flushWatcherPending();
      }, MUTATION_COALESCE_MS);
      this.watcherTimer.unref();
    }
  }

  private flushWatcherPending(): void {
    if (this.watcherTimer !== undefined) {
      clearTimeout(this.watcherTimer);
      this.watcherTimer = undefined;
    }
    if (this.watcherPending.size === 0 || this.disposed || this.networkRoot || this.rootDeleted) {
      this.watcherPending.clear();
      return;
    }
    const batch = [...this.watcherPending];
    this.watcherPending.clear();
    const previous = this.watcherDrain ?? Promise.resolve();
    const drain = previous.then(async () => {
      if (this.disposed || this.networkRoot || this.rootDeleted) return;
      let cursor = 0;
      const workerCount = Math.min(MAX_CONCURRENT_WATCHER_UPDATES, batch.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (
          cursor < batch.length
          && !this.disposed
          && !this.networkRoot
          && !this.rootDeleted
          && !this.reconcileQueued
          && this.timer === undefined
        ) {
          const nextPath = batch[cursor++];
          if (nextPath !== undefined) await this.applyMutation(nextPath, false);
        }
      });
      await Promise.all(workers);
    }).finally(() => {
      if (this.watcherDrain === drain) this.watcherDrain = undefined;
    });
    this.watcherDrain = drain;
  }

  invalidate(): void {
    if (!this.started || this.disposed || this.networkRoot || this.rootDeleted) return;
    this.clearWatcherPending();
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
    if (entry === undefined && !this.byPath.has(key) && (this.directoryCounts.get(key) ?? 0) === 0) {
      return;
    }
    const table: PathTable = {
      prepared: this.prepared,
      byPath: this.byPath,
      directoryCounts: this.directoryCounts,
      sortedBase: this.sortedBase,
      liveInserted: this.liveInserted,
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
    await this.applyMutation(path, true);
  }

  private async applyMutation(path: string, emitEvent: boolean): Promise<void> {
    if (!this.started || this.disposed || this.networkRoot || this.rootDeleted) return;
    const resolved = resolve(path);
    const local = relative(this.root, resolved).replaceAll('\\', '/');
    if (local === '..' || local.startsWith('../') || isAbsolute(local)) return;
    if (local.split('/').some(isAlwaysIgnoredPathSegment)) return;
    if (emitEvent) this.emitMutation(resolved);
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
      if (entry === undefined && !this.byPath.has(key) && (this.directoryCounts.get(key) ?? 0) === 0) {
        if (this.pathUpdates.get(key) === update) {
          this.trigram?.dirtyPaths.delete(display);
        }
        return;
      }
      this.applyLiveMutation(key, display, entry);
    }).catch(error => {
      if (!this.disposed) { this.error = error; this.invalidate(); }
    }).finally(() => { if (this.pathUpdates.get(key) === update) this.pathUpdates.delete(key); });
    this.pathUpdates.set(key, update);
    await update;
  }

  async whenSettled(timeoutMs = this.settleTimeoutMs): Promise<boolean> {
    if (this.watcherTimer !== undefined || this.watcherPending.size > 0) {
      this.flushWatcherPending();
    }
    const deadline = Number.isFinite(timeoutMs) ? performance.now() + Math.max(0, timeoutMs) : Infinity;
    const waitWithDeadline = async (work: Promise<unknown>): Promise<boolean> => {
      if (!Number.isFinite(deadline)) {
        await work;
        return true;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        await Promise.race([
          work,
          new Promise<void>((resolveWait) => {
            timer = setTimeout(() => {
              timedOut = true;
              resolveWait();
            }, remaining);
            timer.unref();
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      return !timedOut;
    };
    const initialDrain = this.watcherDrain;
    if (initialDrain !== undefined) {
      if (!(await waitWithDeadline(initialDrain))) return false;
    }
    const pending = [...this.pathUpdates.values()];
    if (pending.length > 0) {
      if (!(await waitWithDeadline(Promise.all(pending)))) return false;
    }
    return true;
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
          this.sortedBase = [];
          this.liveInserted.clear();
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
          sortedBase: [],
          liveInserted: new Map(),
        };
        const totalEntries = inventory.entries.length;
        let baseInOrder = true;
        let previousPath: string | undefined;
        for (let offset = 0; offset < totalEntries; offset += 256) {
          if (this.disposed || revision !== this.revision || this.activeScan !== scan) return;
          if (scan.fidelityLost) break;
          const end = Math.min(offset + 256, totalEntries);
          for (let i = offset; i < end; i += 1) {
            const entry = inventory.entries[i]!;
            if (baseInOrder && previousPath !== undefined && entry.path < previousPath) {
              baseInOrder = false;
            }
            previousPath = entry.path;
            insertEntry(nextTable, pathIdentity(entry.path), entry, true);
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
        if (!baseInOrder) {
          nextTable.sortedBase.sort((left, right) => comparePathCodeUnits(left.entry.path, right.entry.path));
          for (let i = 0; i < nextTable.sortedBase.length; i += 1) {
            nextTable.sortedBase[i]!.baseIndex = i;
          }
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
        this.sortedBase = nextTable.sortedBase;
        this.liveInserted = nextTable.liveInserted;
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
    const settled = await this.whenSettled();
    this.publishPendingMutations();
    if (!settled || this.current === undefined || pattern.includes('{') && pattern.includes('/')) return undefined;
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
    const queryChars = Array.from(lower);
    const baseMatches: WorkspacePathEntry[] = [];
    const base = this.sortedBase;
    for (let i = 0; i < base.length; i += 1) {
      const item = base[i]!;
      if (!item.active || item.entry.sensitive) continue;
      const itemMask = pathMode ? item.charMask : item.nameCharMask;
      if ((itemMask & mask) !== mask) continue;
      if (matchesSubsequence(pathMode ? item.pathLower : item.nameLower, queryChars)) {
        baseMatches.push(item.entry);
      }
    }
    let matches: WorkspacePathEntry[];
    if (this.liveInserted.size === 0) {
      matches = baseMatches;
    } else {
      const extraMatches: WorkspacePathEntry[] = [];
      for (const item of this.liveInserted.values()) {
        if (!item.active || item.entry.sensitive) continue;
        const itemMask = pathMode ? item.charMask : item.nameCharMask;
        if ((itemMask & mask) !== mask) continue;
        if (matchesSubsequence(pathMode ? item.pathLower : item.nameLower, queryChars)) {
          extraMatches.push(item.entry);
        }
      }
      if (extraMatches.length === 0) {
        matches = baseMatches;
      } else {
        extraMatches.sort((left, right) => comparePathCodeUnits(left.path, right.path));
        matches = [];
        let bi = 0;
        let ei = 0;
        while (bi < baseMatches.length && ei < extraMatches.length) {
          const left = baseMatches[bi]!;
          const right = extraMatches[ei]!;
          if (left.path <= right.path) {
            matches.push(left);
            bi += 1;
          } else {
            matches.push(right);
            ei += 1;
          }
        }
        while (bi < baseMatches.length) matches.push(baseMatches[bi++]!);
        while (ei < extraMatches.length) matches.push(extraMatches[ei++]!);
      }
    }
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
    this.clearWatcherPending();
    this.clearPublishedState();
    this.activeScan = undefined;
    this.refreshController = undefined;
    this.hadCommittedSnapshot = false;
    this.reconcileQueued = false;
    this.mutationListeners.clear();
    this.prepared.clear();
    this.byPath.clear();
    this.directoryCounts.clear();
    this.sortedBase = [];
    this.liveInserted.clear();
    this.globCache.clear();
    this.fuzzyCache.clear();
    await Promise.all([this.pending, this.whenSettled(Infinity), this.trigram?.dispose()]);
  }
}
