import { z } from 'zod';
import { abortable } from '#/_base/utils/abort';
import { IFileSystemStorageService, StorageError, StorageErrors } from './interface/storage';

const queues = new WeakMap<IFileSystemStorageService, Promise<void>>();

export const MEMORY_AUTHORITY_SCOPE = 'store/memory-authority-v1';
const issueSchema = z.object({ scope: z.string(), key: z.string(), issue: z.string() }).strict();
const migrationSchema = z.object({
  id: z.string().uuid(), namespaces: z.array(z.string()).max(1000), index: z.number().int().nonnegative(), after: z.string().optional(), issues: z.array(issueSchema).max(1000),
  phase: z.enum(['importing', 'validating', 'failed']).optional(), failure: z.object({ code: z.string(), message: z.string() }).strict().optional(),
}).strict();
const authoritySchema = z.object({
  version: z.literal(1), epoch: z.number().int().nonnegative(), backend: z.enum(['legacy', 'sqlite']),
  mode: z.enum(['active', 'migrating', 'readonly']), migration: migrationSchema.optional(),
  migrationId: z.string().uuid().optional(), recoveryId: z.string().uuid().optional(), migrationIssues: z.array(issueSchema).max(1000).optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === 'migrating' ? value.backend !== 'legacy' || value.migration === undefined : value.migration !== undefined) context.addIssue({ code: 'custom', message: 'Invalid Memory migration marker' });
  if (value.backend === 'legacy' && value.mode === 'readonly' || value.backend === 'sqlite' && value.migrationId === undefined || value.mode === 'readonly' && value.recoveryId === undefined) context.addIssue({ code: 'custom', message: 'Invalid Memory authority marker' });
});
export type MemoryAuthorityState = z.infer<typeof authoritySchema>;
export interface MemoryAuthorityLease {
  read(): Promise<MemoryAuthorityState>;
  publish(state: MemoryAuthorityState): Promise<void>;
}
export function assertMemoryAuthorityWritable(state: MemoryAuthorityState, backend: 'legacy' | 'sqlite'): void {
  if (state.backend !== backend || state.mode !== 'active') throw new StorageError(StorageErrors.codes.STORAGE_LOCKED,
    state.mode === 'readonly' ? 'Memory recovery mode is read-only; resume SQLite editing to write' : state.mode === 'migrating' ? 'Memory migration is paused behind its write barrier; resume or cancel the migration' : 'Memory authority changed; this legacy writer must be upgraded or stopped',
    { details: { backend: state.backend, mode: state.mode, epoch: state.epoch } });
}
export class MemoryAuthorityAccess {
  constructor(private readonly storage: IFileSystemStorageService) {}
  async read(): Promise<MemoryAuthorityState> {
    const bytes = await this.storage.read(MEMORY_AUTHORITY_SCOPE, 'backend.json', { recoverMissing: false });
    if (bytes === undefined) return { version: 1, epoch: 0, backend: 'legacy', mode: 'active' };
    let state: MemoryAuthorityState;
    try { state = authoritySchema.parse(JSON.parse(new TextDecoder().decode(bytes))); }
    catch (error) { throw new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, 'Invalid Memory authority marker; repair it before opening Memory', { cause: error }); }
    if (state.backend === 'sqlite' && (await this.storage.size('store/memory-sqlite-v1', 'memory.sqlite') ?? 0) < 100) throw new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, 'Memory authority database is missing or truncated; restore its governed recovery package before opening Memory');
    return state;
  }
  async exclusive<T>(operation: (lease: MemoryAuthorityLease) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = queues.get(this.storage) ?? Promise.resolve();
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => released);
    queues.set(this.storage, current);
    try {
      await (signal === undefined ? previous : abortable(previous, signal));
      return await this.locked(operation, signal);
    } finally {
      release();
      void current.then(() => { if (queues.get(this.storage) === current) queues.delete(this.storage); });
    }
  }
  private async locked<T>(operation: (lease: MemoryAuthorityLease) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lock = await this.storage.acquireLock(MEMORY_AUTHORITY_SCOPE, 'writer', {
      leaseMs: 30_000, renewIntervalMs: 5_000, waitForMs: 5_000, signal, owner: { kind: 'memory-authority', pid: process.pid },
    });
    try {
      signal?.throwIfAborted();
      return await operation({ read: () => this.read(), publish: async (state) => {
        const checked = authoritySchema.parse(state);
        await this.storage.write(MEMORY_AUTHORITY_SCOPE, 'backend.json', new TextEncoder().encode(JSON.stringify(checked)), { atomic: true });
      } });
    } finally { await lock.release(); }
  }
  write<T>(backend: 'legacy' | 'sqlite', operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.exclusive(async (lease) => { assertMemoryAuthorityWritable(await lease.read(), backend); return operation(); }, signal);
  }
}
