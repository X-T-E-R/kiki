import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { ILogService } from '#/_base/log/log';
import { normalizeUsageFact, summarizeUsageFacts, type UsageFact, type UsageFactTotals } from '#/agent/usage/usageFact';
import { IAppendLogStore, type AppendLogCommit } from '#/persistence/interface/appendLogStore';
import { IQueryStore, type WriteOp } from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

export interface UsageFactCheckpoint {
  readonly generation: string;
  readonly offset: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly boundaryHash: string;
  readonly valid: boolean;
}

export interface UsageFactSnapshot {
  readonly checkpoint?: UsageFactCheckpoint;
  readonly records: readonly UsageFact[];
}

export interface UsageFactRange {
  readonly startAt?: number;
  readonly endAt?: number;
}

export interface IUsageFactStore {
  readonly _serviceBrand: undefined;
  read(scope: string, range?: UsageFactRange, signal?: AbortSignal): Promise<UsageFactSnapshot>;
  summary(scope: string, signal?: AbortSignal): Promise<{ checkpoint?: UsageFactCheckpoint; totals?: UsageFactTotals }>;
  commit(scope: string, start: number, checkpoint: UsageFactCheckpoint, records: readonly UsageFact[]): Promise<void>;
}

export const IUsageFactStore = createDecorator<IUsageFactStore>('usageFactStore');

interface FactBatch {
  readonly version: 1;
  readonly start: number;
  readonly checkpoint: UsageFactCheckpoint;
  readonly records: readonly UsageFact[];
}

interface IndexHead {
  readonly version: 1;
  readonly ledgerOffset: number;
  readonly recordCount: number;
  readonly totals: UsageFactTotals;
  readonly checkpoint?: UsageFactCheckpoint;
}

const ROOT = 'cache/usage-facts-v1';
const LOG = 'facts.jsonl';
const HEAD = 'head';

class InvalidFactJournal extends Error {}

export class UsageFactStore extends Disposable implements IUsageFactStore {
  declare readonly _serviceBrand: undefined;
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly damaged = new Set<string>();
  private readonly verified = new Set<string>();

  constructor(
    @IAppendLogStore private readonly logs: IAppendLogStore,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IQueryStore private readonly query: IQueryStore,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(logs.registerProjection({
      key: AGENT_WIRE_RECORD_KEY,
      prepare: (scope, records) => {
        const facts: UsageFact[] = [];
        let valid = true;
        const sourceAgentId = scope.slice(scope.lastIndexOf('/') + 1);
        for (const value of records) {
          if (value === null || typeof value !== 'object') continue;
          const raw = value as WireRecord;
          if (raw.type !== 'usage.record') continue;
          const fact = normalizeUsageFact(raw, sourceAgentId);
          if (fact === undefined) valid = false;
          else facts.push(fact);
        }
        return { facts, valid };
      },
      commit: async (position, value) => { await this.commitWritten(position, value.facts, value.valid); },
      onError: (error) => { this.log.warn('Usage fact projection failed; uncovered source remains recoverable', error); },
    }));
  }

  private async commitWritten(position: AppendLogCommit, records: readonly UsageFact[], valid: boolean): Promise<void> {
    const mtimeMs = await this.storage.mtime(position.scope, position.key) ?? 0;
    await this.commit(position.scope, position.start, {
      generation: position.generation,
      offset: position.end,
      size: position.end,
      mtimeMs,
      boundaryHash: position.boundaryHash,
      valid,
    }, records);
  }

  commit(scope: string, start: number, checkpoint: UsageFactCheckpoint, records: readonly UsageFact[]): Promise<void> {
    return this.exclusive(scope, async () => {
      const batch: FactBatch = { version: 1, start, checkpoint, records };
      const directory = factDirectory(scope);
      const owner = this.logs.acquire(directory, LOG);
      try {
        if (this.damaged.has(scope)) {
          if (start !== 0) return;
          await this.logs.rewrite(directory, LOG, [batch]);
          await this.query.dropCollection(collectionOf(scope));
          this.damaged.delete(scope);
        } else {
          this.logs.append(directory, LOG, batch);
          await this.logs.flush(directory, LOG);
        }
      } finally {
        await owner.dispose();
      }
    });
  }

  read(scope: string, range?: UsageFactRange, signal?: AbortSignal): Promise<UsageFactSnapshot> {
    return this.exclusive(scope, async () => {
      const collection = collectionOf(scope);
      const head = await this.prepareIndex(scope, signal);
      if (head?.checkpoint === undefined) return { records: [] };
      const records: UsageFact[] = [];
      if (range?.startAt === undefined && range?.endAt === undefined) {
        for (let start = 0; start < head.recordCount; start += 256) {
          signal?.throwIfAborted();
          const keys = Array.from({ length: Math.min(256, head.recordCount - start) }, (_value, index) => `fact:${start + index}`);
          const rows = await this.query.getMany<UsageFact & { kind: string }>(collection, keys);
          if (rows.size !== keys.length) throw new Error('Incomplete usage fact index');
          for (const key of keys) { const { kind: _kind, ...fact } = rows.get(key)!; records.push(fact); }
          await yieldToEventLoop(undefined, { signal });
        }
        return { checkpoint: head.checkpoint, records };
      }
      let cursor: string | undefined;
      do {
        signal?.throwIfAborted();
        let read = this.query.query<UsageFact & { kind: string }>(collection).where({ kind: 'fact' }).limit(2048).cursor(cursor);
        if (range?.startAt !== undefined || range?.endAt !== undefined) {
          read = read.whereColumn('time', { gte: range.startAt, lt: range.endAt });
        }
        const page = await read.execute();
        for (const { kind: _kind, ...fact } of page.items) records.push(fact);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      if (range?.startAt !== undefined || range?.endAt !== undefined) {
        do {
          signal?.throwIfAborted();
          const page = await this.query.query<UsageFact & { kind: string }>(collection).where({ kind: 'fact', invalid: true }).limit(2048).cursor(cursor).execute();
          for (const { kind: _kind, ...fact } of page.items) {
            if ((range.startAt !== undefined && fact.time < range.startAt) || (range.endAt !== undefined && fact.time >= range.endAt)) records.push(fact);
          }
          cursor = page.nextCursor;
        } while (cursor !== undefined);
      }
      return { checkpoint: head.checkpoint, records };
    });
  }

  summary(scope: string, signal?: AbortSignal): Promise<{ checkpoint?: UsageFactCheckpoint; totals?: UsageFactTotals }> {
    return this.exclusive(scope, async () => {
      const head = await this.prepareIndex(scope, signal);
      return { checkpoint: head?.checkpoint, totals: head?.totals };
    });
  }

  private async prepareIndex(scope: string, signal?: AbortSignal): Promise<IndexHead | undefined> {
    signal?.throwIfAborted();
    const collection = collectionOf(scope);
    const directory = factDirectory(scope);
    await this.logs.flush(directory, LOG).catch(() => undefined);
    const size = await this.storage.size(directory, LOG) ?? 0;
    if (size === 0) return undefined;
    let head = await this.query.get<IndexHead>(collection, HEAD);
    const verify = head !== undefined && !this.verified.has(collection);
    if (head !== undefined && (head.version !== 1 || head.ledgerOffset > size || (verify && (await this.query.listKeys(collection)).length !== head.recordCount + 1))) {
      await this.query.dropCollection(collection);
      head = undefined;
    }
    if (this.verified.size >= 4096) this.verified.clear();
    this.verified.add(collection);
    return head?.ledgerOffset === size ? head : this.advanceIndex(scope, head, size, signal);
  }

  private async advanceIndex(scope: string, initial: IndexHead | undefined, size: number, signal?: AbortSignal): Promise<IndexHead | undefined> {
    const collection = collectionOf(scope);
    let head = initial;
    let offset = head?.ledgerOffset ?? 0;
    let pending = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.storage.readStream(factDirectory(scope), LOG, { start: offset, end: size - 1 }, { signal, chunkBytes: 256 << 10 })) {
        pending += decoder.decode(chunk, { stream: true });
        for (;;) {
          const newline = pending.indexOf('\n');
          if (newline < 0) break;
          signal?.throwIfAborted();
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          offset += Buffer.byteLength(line) + 1;
          let batch: FactBatch;
          try { batch = JSON.parse(line) as FactBatch; }
          catch { throw new InvalidFactJournal('Malformed usage fact batch'); }
          if (!validBatch(batch)) throw new InvalidFactJournal('Invalid usage fact batch');
          let checkpoint = head?.checkpoint;
          let recordCount = head?.recordCount ?? 0;
          let totals = head?.totals ?? summarizeUsageFacts([]);
          if (batch.start === 0 || (checkpoint !== undefined && checkpoint.generation !== batch.checkpoint.generation)) {
            if (head !== undefined) await this.query.dropCollection(collection);
            checkpoint = undefined;
            recordCount = 0;
            totals = summarizeUsageFacts([]);
          }
          const ops: WriteOp[] = [];
          if (batch.start === (checkpoint?.offset ?? 0)) {
            for (let i = 0; i < batch.records.length; i++) {
              const fact = batch.records[i]!;
              ops.push({ kind: 'put', collection, key: `fact:${recordCount + i}`, value: { ...fact, kind: 'fact' }, columns: { time: fact.time } });
            }
            recordCount += batch.records.length;
            totals = summarizeUsageFacts(batch.records, totals);
            checkpoint = { ...batch.checkpoint, valid: (checkpoint?.valid ?? true) && batch.checkpoint.valid };
          }
          head = { version: 1, ledgerOffset: offset, recordCount, checkpoint, totals };
          for (let start = 0; start < ops.length; start += 256) {
            signal?.throwIfAborted();
            await this.query.batch(ops.slice(start, start + 256));
            await yieldToEventLoop(undefined, { signal });
          }
          await this.query.put(collection, HEAD, head);
        }
      }
      if (offset !== size) throw new InvalidFactJournal('Incomplete usage fact batch');
      return head;
    } catch (error) {
      this.verified.delete(collection);
      signal?.throwIfAborted();
      if (!(error instanceof InvalidFactJournal)) throw error;
      this.damaged.add(scope);
      await this.query.dropCollection(collection);
      this.log.warn('Usage facts require source recovery', error);
      return undefined;
    }
  }

  private exclusive<T>(scope: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.operations.get(scope) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    this.operations.set(scope, next);
    void next.finally(() => { if (this.operations.get(scope) === next) this.operations.delete(scope); }).catch(() => undefined);
    return next;
  }
}

function sourceId(scope: string): string {
  return createHash('sha256').update(scope).digest('hex');
}

function factDirectory(scope: string): string {
  return `${ROOT}/${sourceId(scope)}`;
}

function collectionOf(scope: string): string {
  return `usage-facts-v1:${sourceId(scope)}`;
}

function validBatch(value: FactBatch): boolean {
  return value !== null && typeof value === 'object' && value.version === 1 &&
    Number.isSafeInteger(value.start) && value.start >= 0 && Array.isArray(value.records) &&
    value.checkpoint !== null && typeof value.checkpoint === 'object' &&
    typeof value.checkpoint.generation === 'string' &&
    Number.isSafeInteger(value.checkpoint.offset) && value.checkpoint.offset >= value.start &&
    typeof value.checkpoint.valid === 'boolean' &&
    value.records.every((record) => record !== null && typeof record === 'object' &&
      Number.isFinite(record.time) && typeof record.model === 'string' && record.usage !== null &&
      typeof record.usage === 'object' && Object.values(record.usage).every((token) => typeof token === 'number' && Number.isFinite(token) && token >= 0));
}

registerScopedService(LifecycleScope.App, IUsageFactStore, UsageFactStore, ScopeActivation.OnScopeCreated, 'usage');
