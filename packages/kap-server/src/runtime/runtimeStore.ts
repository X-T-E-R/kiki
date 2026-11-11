import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ServerExitReceipt } from '../start';

const identitySchema = z.object({
  serverId: z.string(), homeId: z.string(), pid: z.number().int(), generation: z.number().int(),
  ownerId: z.string(), startedAt: z.number(), host: z.string(), port: z.number().int(),
  serverVersion: z.string(), buildId: z.string().optional(), buildChannel: z.string().optional(),
});
export const serverExitReceiptSchema: z.ZodType<ServerExitReceipt> = z.object({
  operationId: z.string(), owner: z.literal('backend'),
  exitReason: z.enum(['normal', 'idle', 'requested', 'cleanup_failed']),
  callerOutcome: z.enum(['resolved', 'rejected']), cleanupOutcome: z.enum(['closed', 'cleanup_failed', 'unknown']),
  resourcesBefore: z.number().optional(), resourcesAfter: z.number().optional(),
  failureDomain: z.enum(['persistence', 'cleanup']).optional(), errorCode: z.string().optional(),
  errorName: z.string().optional(), errorMessage: z.string().optional(), settledAt: z.number(),
});

export const managedWriterSchema = identitySchema.extend({
  phase: z.enum(['starting', 'ready', 'draining', 'stopping', 'exited', 'failed']),
  operationId: z.string().optional(), updatedAt: z.number(),
  warnings: z.array(z.object({ code: z.literal('other_home_instances'), serverIds: z.array(z.string()) })),
  exitReceipt: serverExitReceiptSchema.optional(),
});
export type ManagedWriter = z.infer<typeof managedWriterSchema>;

export interface RuntimeLease {
  readonly id: string;
  close(): void;
}

export class RuntimeStore {
  readonly directory: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(homeDir: string) {
    this.directory = join(homeDir, 'runtime');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.directory, 'switch.sqlite'), { timeout: 1000 });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  lease(kind: 'writer' | 'controller'): RuntimeLease {
    const db = new DatabaseSync(join(this.directory, `${kind}.lease.sqlite`), { timeout: 0 });
    try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
    catch (error) {
      db.close();
      throw new Error(`The managed runtime ${kind} is already owned. Reconnect to its existing owner.`, { cause: error });
    }
    let closed = false;
    return { id: randomUUID(), close: () => {
      if (closed) return;
      db.exec('ROLLBACK');
      db.close();
      closed = true;
    } };
  }

  read<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM records WHERE key = ?').get(key) as { value: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.value) as T;
  }

  write<T>(key: string, value: T): void {
    this.db.prepare('INSERT INTO records(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  writer(): ManagedWriter | undefined {
    const raw = this.read<unknown>('writer');
    return raw === undefined ? undefined : managedWriterSchema.parse(raw);
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

const failedOwners = new Set<ManagedWriterOwner>();

export class ManagedWriterOwner {
  private finished = false;
  private constructor(readonly store: RuntimeStore, private readonly lease: RuntimeLease, private current: ManagedWriter) {}

  static acquire(homeDir: string, identity: Omit<ManagedWriter, 'ownerId' | 'generation' | 'phase' | 'updatedAt' | 'warnings'>): ManagedWriterOwner {
    const store = new RuntimeStore(homeDir);
    let lease: RuntimeLease | undefined;
    try {
      lease = store.lease('writer');
      const current: ManagedWriter = { ...identity, ownerId: lease.id, generation: (store.writer()?.generation ?? 0) + 1,
        phase: 'starting', updatedAt: Date.now(), warnings: [] };
      store.write('writer', current);
      return new ManagedWriterOwner(store, lease, current);
    } catch (error) { lease?.close(); store.close(); throw error; }
  }

  state(): ManagedWriter { return structuredClone(this.current); }

  private persist(next: ManagedWriter): void {
    this.store.transaction(() => {
      this.store.write(`writers/${next.ownerId}`, next);
      this.store.write('writer', next);
    });
    this.current = next;
  }

  update(patch: Partial<Pick<ManagedWriter, 'serverId' | 'phase' | 'port' | 'operationId' | 'warnings'>>): void {
    this.persist(managedWriterSchema.parse({ ...this.current, ...patch, updatedAt: Date.now() }));
  }

  finish(receipt: ServerExitReceipt): void {
    if (this.finished) return;
    this.finished = true;
    const clean = receipt.cleanupOutcome === 'closed' && receipt.resourcesAfter === 0;
    this.persist(managedWriterSchema.parse({ ...this.current, phase: clean ? 'exited' : 'failed',
      updatedAt: Date.now(), exitReceipt: receipt }));
    if (!clean) { failedOwners.add(this); return; }
    failedOwners.delete(this);
    this.lease.close();
    this.store.close();
  }
}
