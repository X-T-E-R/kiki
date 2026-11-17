import { watch, type FSWatcher } from 'node:fs';
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

type PreparedEntry = WorkspacePathEntry & { readonly charMask: number };

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

export class WorkspacePathIndex {
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private repair?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private revision = 0;
  private snapshotRevision = 0;
  private current?: WorkspacePathSnapshot;
  private prepared = new Map<string, PreparedEntry>();
  private byPath = new Map<string, WorkspacePathEntry>();
  private readonly pathUpdates = new Map<string, Promise<void>>();
  private readonly globCache = new Map<string, readonly string[]>();
  private readonly fuzzyCache = new Map<string, readonly WorkspacePathEntry[]>();
  private readonly controller = new AbortController();
  private disposed = false;
  private watching = false;
  private overflowed = false;
  readonly trigram?: WorkspaceTrigramIndex;
  error?: unknown;

  get isOverflowed(): boolean { return this.overflowed; }

  constructor(readonly root: string, private readonly cpu: ICpuWorkerService, cacheDir?: string) {
    this.root = resolve(root);
    if (cacheDir !== undefined) this.trigram = new WorkspaceTrigramIndex(this.root, cacheDir, cpu);
    try {
      this.watcher = watch(this.root, { recursive: true }, (_kind, filename) => {
        if (filename !== null && filename.split(/[\\/]/u).some(part => ['.git', '.hg', '.svn', '.jj', '.bzr', '.sl'].includes(part))) return;
        if (filename === null) this.invalidate();
        else void this.mutation(resolve(this.root, filename));
      });
      this.watcher.on('error', error => {
        this.error = error;
        this.watching = false;
        this.current = undefined;
        this.trigram?.invalidate();
        this.watcher?.close();
      });
      this.watcher.unref();
      this.watching = true;
    } catch (error) { this.error = error; }
    if (this.watching) {
      void this.refresh();
      this.repair = setInterval(() => this.invalidate(), 10 * 60_000);
      this.repair.unref();
    }
  }

  invalidate(): void {
    this.revision++;
    this.current = undefined;
    this.trigram?.invalidate();
    this.globCache.clear();
    this.fuzzyCache.clear();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 50);
    this.timer.unref();
  }

  async mutation(path: string): Promise<void> {
    const local = relative(this.root, resolve(path)).replaceAll('\\', '/');
    if (this.disposed || local === '..' || local.startsWith('../') || isAbsolute(local)) return;
    if (local === '' || ['.gitignore', '.ignore', '.rgignore'].includes(basename(local))) { this.invalidate(); return; }
    const key = pathIdentity(local);
    if (!this.overflowed) this.trigram?.dirty(this.byPath.get(key)?.path ?? local);
    const previous = this.pathUpdates.get(key) ?? Promise.resolve();
    const update = previous.then(async () => {
      if (this.disposed) return;
      if (this.current === undefined) {
        if (!this.overflowed) this.invalidate();
        return;
      }
      const epoch = this.revision;
      const display = this.byPath.get(key)?.path ?? local;
      const entry = await this.cpu.request<WorkspacePathEntry | undefined>({ type: 'workspace.path', root: this.root, path: resolve(this.root, display) },
        { signal: this.controller.signal, timeoutMs: 30_000 });
      if (this.disposed || this.current === undefined || epoch !== this.revision) return;
      if (entry?.kind === 'directory') {
        const old = this.byPath.get(key);
        if (old?.kind !== 'directory' || old.ino !== entry.ino) this.invalidate();
        return;
      }
      if (entry === undefined) {
        for (const existing of this.byPath.keys()) if (existing === key || existing.startsWith(`${key}/`)) {
          this.byPath.delete(existing);
          this.prepared.delete(existing);
        }
      } else {
        this.byPath.set(key, entry);
        this.prepared.set(key, { ...entry, charMask: characterMask(entry.path) });
      }
      this.current = { revision: ++this.snapshotRevision, entries: [...this.byPath.values()] };
      this.globCache.clear();
      this.fuzzyCache.clear();
      this.trigram?.patch(this.current, display, entry);
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
    if (this.pending !== undefined) {
      await this.pending;
      while (this.pending !== undefined) await this.pending;
      return;
    }
    if (this.disposed || !this.watching) return;
    const revision = this.revision;
    this.pending = this.cpu.request<WorkspacePathInventory>({ type: 'workspace.paths', root: this.root, limit: 250_000 }, { signal: this.controller.signal, timeoutMs: 120_000 })
      .then(async inventory => {
        if (inventory.overflow) {
          if (this.disposed || revision !== this.revision) return;
          this.overflowed = true;
          this.current = undefined;
          this.prepared.clear();
          this.byPath.clear();
          this.globCache.clear();
          this.fuzzyCache.clear();
          this.trigram?.invalidate();
          return;
        }
        const prepared = new Map<string, PreparedEntry>();
        const byPath = new Map<string, WorkspacePathEntry>();
        for (let offset = 0; offset < inventory.entries.length; offset += 512) {
          if (this.disposed || revision !== this.revision) return;
          for (const entry of inventory.entries.slice(offset, offset + 512)) {
            prepared.set(pathIdentity(entry.path), { ...entry, charMask: characterMask(entry.path) });
            byPath.set(pathIdentity(entry.path), entry);
          }
          await yieldToEventLoop();
        }
        if (this.disposed || revision !== this.revision) return;
        this.overflowed = false;
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
    return this.byPath.get(pathIdentity(relative(this.root, path).replaceAll('\\', '/')))?.mtimeMs;
  }

  async glob(directory: string, pattern: string): Promise<readonly string[] | undefined> {
    await this.whenSettled();
    if (this.current === undefined || pattern.includes('{') && pattern.includes('/')) return undefined;
    const prefix = relative(this.root, resolve(directory)).replaceAll('\\', '/');
    if (prefix === '..' || prefix.startsWith('../') || isAbsolute(prefix)) return undefined;
    const key = `${prefix}\0${pattern}`;
    const cached = this.globCache.get(key);
    if (cached !== undefined) return cached;
    const normalized = pattern.replace(/^\//u, '');
    const insensitive = process.platform === 'win32';
    const matcher = picomatch(normalized, { dot: true, nocase: insensitive, basename: !normalized.includes('/') && normalized !== '*' });
    const depth = !normalized.includes('**') && (normalized === '*' || normalized.includes('/')) ? normalized.split('/').length : Infinity;
    const start = prefix === '' ? '' : `${prefix}/`;
    const matches = this.current.entries.filter(entry => {
      if (entry.kind !== 'file' || !(insensitive ? entry.path.toLowerCase().startsWith(start.toLowerCase()) : entry.path.startsWith(start))) return false;
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
      .filter(item => item.score > 0).sort((left, right) => right.score - left.score || left.entry.path.localeCompare(right.entry.path))
      .map(item => item.entry);
    if (this.fuzzyCache.size >= 32) this.fuzzyCache.delete(this.fuzzyCache.keys().next().value!);
    this.fuzzyCache.set(key, matches);
    return matches;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.controller.abort();
    this.watcher?.close();
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.repair !== undefined) clearInterval(this.repair);
    this.current = undefined;
    this.prepared.clear();
    this.byPath.clear();
    this.globCache.clear();
    this.fuzzyCache.clear();
    await Promise.all([this.pending, this.whenSettled(), this.trigram?.dispose()]);
  }
}
