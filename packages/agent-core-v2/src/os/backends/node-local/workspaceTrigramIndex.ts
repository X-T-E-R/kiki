import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import type { WorkspacePathSnapshot } from './workspacePathIndex';

export function requiredGrepLiteral(pattern: string, literal: boolean): string | undefined {
  if (/[\n\r\0]/u.test(pattern)) return undefined;
  if (literal) return [...pattern].length >= 3 ? pattern : undefined;
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === '\\') index++;
    else if (pattern[index] === '|') return undefined;
  }
  const prefix: string[] = [];
  const chars = [...pattern];
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!;
    if (char === '\\') {
      const next = chars[index + 1];
      if (next === undefined || !/[\\[\]().*+?{}|^$]/u.test(next)) break;
      prefix.push(next);
      index++;
    } else if (/[\[\]().*+?{}^$]/u.test(char)) {
      if (/[*+?{]/u.test(char)) prefix.pop();
      break;
    } else prefix.push(char);
  }
  return prefix.length >= 3 ? prefix.join('') : undefined;
}

export class WorkspaceTrigramIndex {
  readonly dirtyPaths = new Set<string>();
  private readonly path: string;
  private readonly controller = new AbortController();
  private epoch?: string;
  private revision = -1;
  private count = 0;
  private pending?: Promise<void>;
  private latest?: WorkspacePathSnapshot;
  error?: unknown;

  constructor(private readonly root: string, cacheDir: string, private readonly cpu: ICpuWorkerService) {
    const key = createHash('sha256').update(root).digest('hex');
    this.path = join(cacheDir, 'workspace-trigram-v1', `${key}.sqlite`);
  }

  dirty(path: string): void {
    this.dirtyPaths.add(path.replaceAll('\\', '/'));
    this.revision = -1;
  }

  rebuild(snapshot: WorkspacePathSnapshot): void {
    this.latest = snapshot;
    const files = snapshot.entries.filter(entry => entry.kind === 'file');
    if (files.length < 1500 || this.pending !== undefined || this.controller.signal.aborted) return;
    const epoch = randomUUID();
    this.epoch = undefined;
    this.pending = (async () => {
      const options = { signal: this.controller.signal, timeoutMs: 120_000 };
      await this.cpu.request({ type: 'workspace.trigram.begin', path: this.path, epoch }, options);
      for (let offset = 0; offset < files.length; offset += 64) {
        const accepted = await this.cpu.request<boolean>({ type: 'workspace.trigram.update', path: this.path, epoch,
          root: this.root, entries: files.slice(offset, offset + 64) }, options);
        if (!accepted) return;
      }
      const accepted = await this.cpu.request<boolean>({ type: 'workspace.trigram.finish', path: this.path, epoch }, options);
      if (accepted) {
        this.epoch = epoch;
        this.revision = snapshot.revision;
        this.count = files.length;
        this.dirtyPaths.clear();
        this.error = undefined;
      }
    })().catch(error => { this.error = error; }).finally(() => {
      this.pending = undefined;
      if (this.latest !== undefined && this.latest.revision !== snapshot.revision) this.rebuild(this.latest);
    });
  }

  async whenReady(): Promise<void> { while (this.pending !== undefined) await this.pending; }

  async candidates(snapshot: WorkspacePathSnapshot, pattern: string, literal: boolean, insensitive: boolean): Promise<readonly string[] | undefined> {
    const required = requiredGrepLiteral(pattern, literal);
    if (required === undefined || insensitive && /[^\x00-\x7f]/u.test(required) ||
      this.epoch === undefined || this.revision !== snapshot.revision) return undefined;
    const limit = Math.min(2000, Math.max(0, Math.ceil(this.count / 4) - 1));
    const paths = await this.cpu.request<readonly string[] | undefined>({ type: 'workspace.trigram.query',
      path: this.path, epoch: this.epoch, literal: required, insensitive, limit }, { signal: this.controller.signal, timeoutMs: 5000 });
    if (paths === undefined || this.revision !== snapshot.revision) return undefined;
    const candidates = [...new Set([...paths, ...this.dirtyPaths])];
    return candidates.length > limit ? undefined : candidates;
  }

  dispose(): void { this.controller.abort(); }
}
