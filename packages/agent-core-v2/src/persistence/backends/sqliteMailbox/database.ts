import { MailboxWorker } from './host';
import type { MailboxOwner, MailboxRow, MailboxWrite } from './protocol';

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
  private readonly worker: MailboxWorker;
  private owner?: MailboxOwner;

  constructor(readonly database: string, create = false, readOnly = false) { this.worker = new MailboxWorker(database, create, readOnly); }

  async claimOwner(owner: MailboxOwner): Promise<void> {
    await this.worker.request({ type: 'owner', owner });
    this.owner = owner;
  }

  async partitionGet(_partition: string, key: string): Promise<V | undefined> {
    return (await this.worker.request<readonly (V | undefined)[]>({ type: 'get', keys: [key] }))[0];
  }

  partitionMget(_partition: string, keys: readonly string[]): Promise<readonly (V | undefined)[]> {
    return this.worker.request({ type: 'get', keys });
  }

  partitionBatch(_partition: string, ops: readonly MailboxWrite<V>[]): Promise<void> {
    return this.worker.request({ type: 'batch', ops, owner: this.owner });
  }

  page(prefix: string, after?: string, limit = 256, kind?: string, signal?: AbortSignal): Promise<readonly MailboxRow<V>[]> {
    return this.worker.request({ type: 'scan', prefix, after, limit, kind }, signal);
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
    return this.worker.request({ type: 'peer', group, before: bounds.lt, limit: bounds.limit ?? 100 });
  }

  async shardScanKeys(_shard: number, bounds: { readonly gt?: string; readonly lt?: string; readonly count?: number }): Promise<readonly string[]> {
    return (await this.page('t/', bounds.gt, bounds.count ?? 256)).map((row) => row.key).filter((key) => bounds.lt === undefined || key < bounds.lt);
  }

  listCompoundIndexes(): Promise<readonly { readonly name: string }[]> { return Promise.resolve([{ name: 'peer_history_v1' }]); }
  createCompoundIndex(_name: string, _definition: unknown): Promise<void> { return Promise.resolve(); }
  stats(): { readonly lockWaits: number } { return { lockWaits: 0 }; }

  findIdentity(partition: string, field: 'messageId' | 'legacyIdentity', value: string): Promise<MailboxRow<V> | undefined> {
    return this.worker.request({ type: 'find_identity', partition, field, value });
  }

  importBatch(ops: readonly MailboxWrite<V>[], checkpoint: MailboxImportCheckpoint & { readonly source: string }, signal?: AbortSignal, archive?: readonly MailboxRow[]): Promise<void> {
    return this.worker.request({ type: 'batch', ops, importCheckpoint: checkpoint, archive: archive === undefined ? undefined : { source: checkpoint.source, rows: archive } }, signal);
  }

  checkpoint(source: string): Promise<MailboxImportCheckpoint | undefined> { return this.worker.request({ type: 'checkpoint', source }); }
  metadata<T>(key: string, value?: T): Promise<T | undefined> { return this.worker.request({ type: 'metadata', key, value }); }
  verify(signal?: AbortSignal): Promise<MailboxVerification> { return this.worker.request({ type: 'verify' }, signal); }
  backup(destination: string, signal?: AbortSignal): Promise<MailboxVerification & { readonly pages: number }> { return this.worker.request({ type: 'backup', destination }, signal); }
  close(): Promise<void> { return this.worker.close(); }
}
