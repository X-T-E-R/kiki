import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import type { WorkspacePathSnapshot } from './workspacePathIndex';
import type { WorkspacePathEntry } from './workspacePathInventory';

export function requiredGrepLiteral(pattern: string, literal: boolean): string | undefined {
  if (/[\n\r\0]/u.test(pattern)) return undefined;
  if (literal) return Array.from(pattern).length >= 3 ? pattern : undefined;
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === '\\') index++;
    else if (pattern[index] === '|') return undefined;
  }
  const prefix: string[] = [];
  const chars = Array.from(pattern);
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!;
    if (char === '\\') {
      const next = chars[index + 1];
      if (next === undefined || !/[\\[\]().*+?{}|^$]/u.test(next)) break;
      prefix.push(next);
      index++;
    } else if (/[[\]().*+?{}^$]/u.test(char)) {
      if (/[*+?{]/u.test(char)) prefix.pop();
      break;
    } else prefix.push(char);
  }
  return prefix.length >= 3 ? prefix.join('') : undefined;
}

export class WorkspaceTrigramIndex {
  readonly dirtyPaths = new Set<string>();
  private readonly path: string;
  private readonly owner = `${process.pid}:${randomUUID()}`;
  private readonly controller = new AbortController();
  private epoch?: string;
  private revision = -1;
  private count = 0;
  private pending?: Promise<void>;
  private latest?: WorkspacePathSnapshot;
  private rebuildRequested = false;
  private readonly updates = new Map<string, WorkspacePathEntry | undefined>();
  error?: unknown;

  constructor(private readonly root: string, cacheDir: string, private readonly cpu: ICpuWorkerService) {
    const key = createHash('sha256').update(root).digest('hex');
    this.path = join(cacheDir, 'workspace-trigram-v1', `${key}.sqlite`);
  }

  dirty(path: string): void {
    this.dirtyPaths.add(path.replaceAll('\\', '/'));
  }

  invalidate(): void { this.revision = -1; }

  patch(snapshot: WorkspacePathSnapshot, path: string, entry: WorkspacePathEntry | undefined): void {
    this.patchBatch(snapshot, [[path, entry]]);
  }

  patchBatch(
    snapshot: WorkspacePathSnapshot,
    patches: readonly (readonly [string, WorkspacePathEntry | undefined])[],
  ): void {
    if (patches.length === 0) return;
    this.latest = snapshot;
    for (const [path, entry] of patches) {
      this.dirtyPaths.add(path);
      this.updates.set(path, entry?.kind === 'file' && !entry.sensitive ? entry : undefined);
    }
    if (this.epoch !== undefined && this.revision !== -1) this.revision = snapshot.revision;
    this.flushUpdates();
  }

  private flushUpdates(): void {
    if (this.pending !== undefined || this.epoch === undefined || this.revision === -1 || this.updates.size === 0 || this.controller.signal.aborted) return;
    const updates = [...this.updates];
    const epoch = this.epoch;
    this.pending = this.cpu.request<boolean>({ type: 'workspace.trigram.update', path: this.path, epoch, root: this.root,
      entries: updates.flatMap(([, entry]) => entry === undefined ? [] : [entry]),
      removed: updates.flatMap(([path, entry]) => entry === undefined ? [path] : []) },
      { signal: this.controller.signal, timeoutMs: 30_000 }).then(accepted => {
      if (!accepted) { this.revision = -1; return; }
      for (const [path, entry] of updates) if (this.updates.has(path) && this.updates.get(path) === entry) {
        this.updates.delete(path);
        this.dirtyPaths.delete(path);
      }
    }).catch(error => { this.error = error; this.revision = -1; }).finally(() => {
      this.pending = undefined;
      if (this.rebuildRequested && this.latest !== undefined) this.rebuild(this.latest);
      else this.flushUpdates();
    });
  }

  rebuild(snapshot: WorkspacePathSnapshot): void {
    this.latest = snapshot;
    const files = snapshot.entries.filter(entry => entry.kind === 'file' && !entry.sensitive);
    this.count = files.length;
    this.revision = -1;
    this.epoch = undefined;
    if (this.pending !== undefined) { this.rebuildRequested = true; return; }
    this.rebuildRequested = false;
    if (files.length < 1500 || this.controller.signal.aborted) return;
    const epoch = randomUUID();
    this.epoch = undefined;
    this.pending = (async () => {
      const options = { signal: this.controller.signal, timeoutMs: 120_000 };
      const started = await this.cpu.request<boolean>({ type: 'workspace.trigram.begin', path: this.path, epoch, owner: this.owner }, options);
      if (!started) return;
      for (let offset = 0; offset < files.length; offset += 64) {
        const accepted = await this.cpu.request<boolean>({ type: 'workspace.trigram.update', path: this.path, epoch,
          root: this.root, entries: files.slice(offset, offset + 64), owner: this.owner }, options);
        if (!accepted) return;
      }
      const accepted = await this.cpu.request<boolean>({ type: 'workspace.trigram.finish', path: this.path, epoch, owner: this.owner }, options);
      if (accepted && !this.rebuildRequested) {
        this.epoch = epoch;
        this.revision = this.latest?.revision ?? snapshot.revision;
        this.count = files.length;
        for (const path of this.dirtyPaths) if (!this.updates.has(path)) this.dirtyPaths.delete(path);
        this.error = undefined;
      }
    })().catch(error => { this.error = error; }).finally(() => {
      this.pending = undefined;
      if (this.rebuildRequested && this.latest !== undefined) this.rebuild(this.latest);
      else this.flushUpdates();
    });
  }

  async whenReady(): Promise<void> { while (this.pending !== undefined) await this.pending; }

  async candidates(snapshot: WorkspacePathSnapshot, pattern: string, literal: boolean, insensitive: boolean): Promise<readonly string[] | undefined> {
    const required = requiredGrepLiteral(pattern, literal);
    if (required === undefined || insensitive && /[^\x00-\x7f]/u.test(required) ||
      this.epoch === undefined || this.revision !== snapshot.revision) return undefined;
    const limit = Math.min(2000, Math.max(0, Math.ceil(this.count / 4) - 1));
    let paths: readonly string[] | undefined;
    try {
      paths = await this.cpu.request<readonly string[] | undefined>({ type: 'workspace.trigram.query',
        path: this.path, epoch: this.epoch, literal: required, insensitive, limit }, { signal: this.controller.signal, timeoutMs: 5000 });
    } catch (error) {
      this.error = error;
      return undefined;
    }
    if (paths === undefined || this.revision !== snapshot.revision) return undefined;
    const eligible = new Set(snapshot.entries.filter(entry => entry.kind === 'file' && !entry.sensitive).map(entry => entry.path));
    const candidates = [...new Set([...paths, ...this.dirtyPaths])].filter(path => eligible.has(path));
    return candidates.length > limit ? undefined : candidates;
  }

  async dispose(): Promise<void> { this.controller.abort(); await this.whenReady(); }
}
