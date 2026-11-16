import { watch, type FSWatcher } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import picomatch from 'picomatch';
import fuzzysort from 'fuzzysort';
import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import type { WorkspacePathEntry, WorkspacePathInventory } from './workspacePathInventory';
import { WorkspaceTrigramIndex } from './workspaceTrigramIndex';

export interface WorkspacePathSnapshot {
  readonly revision: number;
  readonly entries: readonly WorkspacePathEntry[];
}

type PreparedEntry = WorkspacePathEntry & { readonly target: Fuzzysort.Prepared; readonly basenameTarget: Fuzzysort.Prepared };

export class WorkspacePathIndex {
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private repair?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private revision = 0;
  private snapshotRevision = 0;
  private current?: WorkspacePathSnapshot;
  private prepared: readonly PreparedEntry[] = [];
  private byPath = new Map<string, WorkspacePathEntry>();
  private readonly globCache = new Map<string, readonly string[]>();
  private readonly fuzzyCache = new Map<string, readonly WorkspacePathEntry[]>();
  private readonly controller = new AbortController();
  private disposed = false;
  private watching = false;
  readonly trigram?: WorkspaceTrigramIndex;
  error?: unknown;

  constructor(readonly root: string, private readonly cpu: ICpuWorkerService, cacheDir?: string) {
    this.root = resolve(root);
    if (cacheDir !== undefined) this.trigram = new WorkspaceTrigramIndex(this.root, cacheDir, cpu);
    try {
      this.watcher = watch(this.root, { recursive: true }, (_kind, filename) => {
        if (filename !== null && filename.split(/[\\/]/u).some(part => ['.git', '.hg', '.svn', '.jj', '.bzr', '.sl'].includes(part))) return;
        if (filename !== null) this.trigram?.dirty(filename);
        this.invalidate();
      });
      this.watcher.on('error', error => {
        this.error = error;
        this.watching = false;
        this.current = undefined;
        this.watcher?.close();
      });
      this.watcher.unref();
      this.watching = true;
    } catch (error) {
      this.error = error;
    }
    if (this.watching) {
      void this.refresh();
      this.repair = setInterval(() => this.invalidate(), 10 * 60_000);
      this.repair.unref();
    }
  }

  private invalidate(): void {
    this.revision++;
    this.current = undefined;
    this.globCache.clear();
    this.fuzzyCache.clear();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 50);
    this.timer.unref();
  }

  async refresh(): Promise<void> {
    if (this.pending !== undefined) {
      await this.pending;
      while (this.pending !== undefined) await this.pending;
      return;
    }
    if (this.disposed || !this.watching) return;
    const revision = this.revision;
    this.pending = this.cpu.request<WorkspacePathInventory>({ type: 'workspace.paths', root: this.root, limit: 250_000 }, { signal: this.controller.signal, timeoutMs: 120_000 })
      .then(async inventory => {
        if (inventory.overflow) return;
        const prepared: PreparedEntry[] = [];
        const byPath = new Map<string, WorkspacePathEntry>();
        for (let offset = 0; offset < inventory.entries.length; offset += 512) {
          if (this.disposed || revision !== this.revision) return;
          for (const entry of inventory.entries.slice(offset, offset + 512)) {
            prepared.push({ ...entry, target: fuzzysort.prepare(entry.path), basenameTarget: fuzzysort.prepare(entry.name) });
            byPath.set(entry.path, entry);
          }
          await yieldToEventLoop();
        }
        if (this.disposed || revision !== this.revision) return;
        this.prepared = prepared;
        this.byPath = byPath;
        this.globCache.clear();
        this.fuzzyCache.clear();
        this.current = { revision: ++this.snapshotRevision, entries: inventory.entries };
        this.trigram?.rebuild(this.current);
        this.error = undefined;
      }, error => { this.error = error; })
      .finally(() => {
        this.pending = undefined;
        if (!this.disposed && revision !== this.revision && this.timer === undefined) void this.refresh();
      });
    await this.pending;
    while (this.pending !== undefined) await this.pending;
  }

  snapshot(): WorkspacePathSnapshot | undefined { return this.current; }

  mtime(path: string): number | undefined {
    if (this.current === undefined) return undefined;
    return this.byPath.get(relative(this.root, path).replaceAll('\\', '/'))?.mtimeMs;
  }

  glob(directory: string, pattern: string): readonly string[] | undefined {
    if (this.current === undefined) return undefined;
    const prefix = relative(this.root, resolve(directory)).replaceAll('\\', '/');
    if (prefix === '..' || prefix.startsWith('../') || isAbsolute(prefix)) return undefined;
    const key = `${prefix}\0${pattern}`;
    const cached = this.globCache.get(key);
    if (cached !== undefined) {
      this.globCache.delete(key);
      this.globCache.set(key, cached);
      return cached;
    }
    const normalized = pattern.replace(/^\//u, '');
    const matcher = picomatch(normalized, { dot: true, basename: !normalized.includes('/') && normalized !== '*' });
    const depth = !normalized.includes('**') && (normalized === '*' || normalized.includes('/')) ? normalized.split('/').length : Infinity;
    const start = prefix === '' ? '' : `${prefix}/`;
    const matches = this.current.entries.filter(entry => {
      if (entry.kind !== 'file' || !entry.path.startsWith(start)) return false;
      const local = entry.path.slice(start.length);
      return local.split('/').length <= depth && matcher(local);
    }).toSorted((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
      .map(entry => resolve(this.root, entry.path));
    if (this.globCache.size >= 32) this.globCache.delete(this.globCache.keys().next().value!);
    this.globCache.set(key, matches);
    return matches;
  }

  fuzzy(query: string, pathMode: boolean): readonly WorkspacePathEntry[] | undefined {
    if (this.current === undefined) return undefined;
    if (query === '') return this.current.entries;
    const key = `${Number(pathMode)}\0${query}`;
    const cached = this.fuzzyCache.get(key);
    if (cached !== undefined) {
      this.fuzzyCache.delete(key);
      this.fuzzyCache.set(key, cached);
      return cached;
    }
    const matches = fuzzysort.go(query, this.prepared, { key: pathMode ? 'target' : 'basenameTarget' }).map(result => result.obj);
    if (this.fuzzyCache.size >= 32) this.fuzzyCache.delete(this.fuzzyCache.keys().next().value!);
    this.fuzzyCache.set(key, matches);
    return matches;
  }

  dispose(): void {
    this.disposed = true;
    this.controller.abort();
    this.watcher?.close();
    this.trigram?.dispose();
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.repair !== undefined) clearInterval(this.repair);
    this.current = undefined;
    this.prepared = [];
    this.byPath.clear();
    this.globCache.clear();
    this.fuzzyCache.clear();
  }
}
