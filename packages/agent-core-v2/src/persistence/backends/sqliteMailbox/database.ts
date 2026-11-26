import { MAILBOX_WORKER_REQUEST_TIMEOUT_MS, MailboxWorker } from './host';
import type {
  LegacyDeliveryCursor,
  LegacyDeliveryPage,
  MailboxOperation,
  MailboxOwner,
  MailboxRow,
  MailboxWrite,
} from './protocol';

export interface MailboxImportCheckpoint {
  readonly after: string;
  readonly items: number;
  readonly bytes: number;
}

export interface MailboxVerification {
  readonly counts: Readonly<Record<string, number>>;
  readonly items: number;
  readonly bytes: number;
}

export class CanonicalMailboxDatabase<V> {
  readonly shardCount = 1;
  readonly database: string;
  private readonly create: boolean;
  private readonly readOnly: boolean;
  private readonly requestTimeoutMs: number;
  private worker: MailboxWorker;
  private owner?: MailboxOwner;
  private closed = false;
  private reopening?: Promise<MailboxWorker>;

  constructor(
    database: string,
    create = false,
    readOnly = false,
    requestTimeoutMs = MAILBOX_WORKER_REQUEST_TIMEOUT_MS,
  ) {
    this.database = database;
    this.create = create;
    this.readOnly = readOnly;
    this.requestTimeoutMs = requestTimeoutMs;
    this.worker = new MailboxWorker(database, create, readOnly, requestTimeoutMs);
  }

  private async activeWorker(): Promise<MailboxWorker> {
    if (this.closed) {
      throw new Error('Canonical mailbox worker closed; reopen and reconcile the request receipt');
    }
    if (!this.worker.isStopped) return this.worker;
    if (this.reopening !== undefined) return this.reopening;
    let reopen: Promise<MailboxWorker> | undefined;
    reopen = (async () => {
      const next = new MailboxWorker(this.database, this.create, this.readOnly, this.requestTimeoutMs);
      try {
        if (this.owner !== undefined) {
          await next.request({ type: 'owner', owner: this.owner });
        }
        this.worker = next;
        return next;
      } catch (error) {
        await next.close().catch(() => undefined);
        throw error;
      } finally {
        if (this.reopening === reopen) this.reopening = undefined;
      }
    })();
    void reopen.catch(() => {});
    this.reopening = reopen;
    return reopen;
  }

  private async request<T>(operation: MailboxOperation, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const worker = await this.activeWorker();
    return worker.request<T>(operation, signal);
  }

  async claimOwner(owner: MailboxOwner): Promise<void> {
    if (this.closed) {
      throw new Error('Canonical mailbox worker closed; reopen and reconcile the request receipt');
    }
    if (this.worker.isStopped) {
      this.worker = new MailboxWorker(this.database, this.create, this.readOnly, this.requestTimeoutMs);
    }
    await this.worker.request({ type: 'owner', owner });
    this.owner = owner;
  }

  async partitionGet(_partition: string, key: string): Promise<V | undefined> {
    return (await this.request<readonly (V | undefined)[]>({ type: 'get', keys: [key] }))[0];
  }

  partitionMget(_partition: string, keys: readonly string[]): Promise<readonly (V | undefined)[]> {
    return this.request({ type: 'get', keys });
  }

  partitionBatch(_partition: string, ops: readonly MailboxWrite<V>[]): Promise<void> {
    return this.request({ type: 'batch', ops, owner: this.owner });
  }

  page(prefix: string, after?: string, limit = 256, kind?: string, signal?: AbortSignal): Promise<readonly MailboxRow<V>[]> {
    return this.request({ type: 'scan', prefix, after, limit, kind }, signal);
  }

  pendingTargets(after?: string, scope?: { readonly hostId: string; readonly workspaceId: string }, signal?: AbortSignal): Promise<readonly MailboxRow<V>[]> {
    return this.request({ type: 'pending_targets', after, scope, limit: 128 }, signal);
  }

  async prefix(prefix: string, kind?: string): Promise<readonly MailboxRow<V>[]> {
    const result: MailboxRow<V>[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.page(prefix, after, 256, kind);
      result.push(...page);
      if (page.length < 256) return result;
      after = page.at(-1)!.key;
    }
  }

  partitionPrefix(_partition: string, prefix: string): Promise<readonly MailboxRow<V>[]> { return this.prefix(prefix); }

  compoundRange(_name: string, group: string, bounds: { readonly lt?: string; readonly reverse?: boolean; readonly limit?: number }): Promise<readonly (MailboxRow<V> & { readonly orderValue: string })[]> {
    return this.request({ type: 'peer', group, before: bounds.lt, limit: bounds.limit ?? 100 });
  }

  async shardScanKeys(_shard: number, bounds: { readonly gt?: string; readonly lt?: string; readonly count?: number }): Promise<readonly string[]> {
    return (await this.page('t/', bounds.gt, bounds.count ?? 256)).map((row) => row.key).filter((key) => bounds.lt === undefined || key < bounds.lt);
  }

  listCompoundIndexes(): Promise<readonly { readonly name: string }[]> { return Promise.resolve([{ name: 'peer_history_v1' }]); }
  createCompoundIndex(_name: string, _definition: unknown): Promise<void> { return Promise.resolve(); }
  stats(): { readonly lockWaits: number } { return { lockWaits: 0 }; }

  findIdentity(partition: string, field: 'messageId' | 'legacyIdentity', value: string): Promise<MailboxRow<V> | undefined> {
    return this.request({ type: 'find_identity', partition, field, value });
  }

  importBatch(ops: readonly MailboxWrite<V>[], checkpoint: MailboxImportCheckpoint & { readonly source: string }, signal?: AbortSignal, archive?: readonly MailboxRow[]): Promise<void> {
    return this.request({ type: 'batch', ops, importCheckpoint: checkpoint, archive: archive === undefined ? undefined : { source: checkpoint.source, rows: archive } }, signal);
  }

  checkpoint(source: string): Promise<MailboxImportCheckpoint | undefined> { return this.request({ type: 'checkpoint', source }); }
  legacyDeliveries(source: string, after?: LegacyDeliveryCursor, signal?: AbortSignal): Promise<LegacyDeliveryPage> {
    return this.request({ type: 'legacy_deliveries', source, after, limit: 128 }, signal);
  }
  discardArchive(completedMigrationId?: string): Promise<void> { return this.request({ type: 'discard_archive', completedMigrationId }); }
  purgeExpired(limit = 1024, signal?: AbortSignal): Promise<number> { return this.request({ type: 'purge_expired', owner: this.owner, limit }, signal); }
  metadata<T>(key: string, value?: T): Promise<T | undefined> { return this.request({ type: 'metadata', key, value }); }
  verify(signal?: AbortSignal): Promise<MailboxVerification> { return this.request({ type: 'verify' }, signal); }
  backup(destination: string, signal?: AbortSignal): Promise<MailboxVerification & { readonly pages: number }> { return this.request({ type: 'backup', destination }, signal); }
  close(): Promise<void> {
    this.closed = true;
    return this.worker.close();
  }
}
