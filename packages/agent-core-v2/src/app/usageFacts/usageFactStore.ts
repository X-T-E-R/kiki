import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { ILogService } from '#/_base/log/log';
import { normalizeUsageFact, summarizeUsageFacts, type UsageFact, type UsageFactTotals } from '#/agent/usage/usageFact';
import { UsageJsonStream } from '#/agent/usage/usageJson';
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

/** Canonical-source coverage and range-read coverage are independent. readComplete:false must not be treated as the complete range even if checkpoint covers the entire source. nextCursor resumes range pages; its absence on an incomplete read means index preparation must resume first. */
export interface UsageFactSnapshot {
  readonly checkpoint?: UsageFactCheckpoint;
  readonly records: readonly UsageFact[];
  readonly readComplete?: boolean;
  readonly nextCursor?: string;
}

/** A shared request allowance for fact visits during verification, staging, indexing and reads, including unknown and invalid facts. Each visit consumes one unit, even when a fact is revisited in another phase. */
export interface UsageFactReadBudget {
  remainingRecords: number;
}

export interface UsageFactReadOptions {
  readonly budget?: UsageFactReadBudget;
  readonly cursor?: string;
}

export interface UsageFactRange {
  readonly startAt?: number;
  readonly endAt?: number;
}

export interface IUsageFactStore {
  readonly _serviceBrand: undefined;
  read(scope: string, range?: UsageFactRange, signal?: AbortSignal, options?: UsageFactReadOptions): Promise<UsageFactSnapshot>;
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

interface IndexProgress {
  size: number;
  offset: number;
  head?: IndexHead;
  parser?: UsageJsonStream;
  decoder: InstanceType<typeof TextDecoder>;
  queued: UsageFact[];
  staged: number;
  reset: boolean;
  batch?: FactBatch;
  copying?: IndexHead;
  copied: number;
}

interface ReadCursor {
  source: string;
  startAt?: number;
  endAt?: number;
  ledgerOffset: number;
  phase: 'all' | 'range' | 'invalid';
  offset: number;
  page?: string;
}

const ROOT = 'cache/usage-facts-v1';
const LOG = 'facts.jsonl';
const HEAD = 'head';
const PAGE_SIZE = 256;

class InvalidFactJournal extends Error {}
class FactBudgetReached extends Error {}

export class UsageFactStore extends Disposable implements IUsageFactStore {
  declare readonly _serviceBrand: undefined;
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly damaged = new Set<string>();
  private readonly verified = new Set<string>();
  private readonly indexing = new Map<string, IndexProgress>();
  private readonly verifying = new Map<string, { ledgerOffset: number; count: number; cursor?: string }>();

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

  read(scope: string, range?: UsageFactRange, signal?: AbortSignal, options: UsageFactReadOptions = {}): Promise<UsageFactSnapshot> {
    return abortable(this.exclusive(scope, async () => {
      const collection = collectionOf(scope);
      const records: UsageFact[] = [];
      let head: IndexHead | undefined;
      let cursor: ReadCursor | undefined;
      try {
        head = await this.prepareIndex(scope, signal, options.budget);
        if (head?.checkpoint === undefined) return { records };
        const ranged = range?.startAt !== undefined || range?.endAt !== undefined;
        cursor = options.cursor === undefined ? { source: collection, startAt: range?.startAt, endAt: range?.endAt, ledgerOffset: head.ledgerOffset, phase: ranged ? 'range' : 'all', offset: 0 } : JSON.parse(options.cursor) as ReadCursor;
        if (cursor === null || cursor.source !== collection || cursor.startAt !== range?.startAt || cursor.endAt !== range?.endAt || cursor.ledgerOffset !== head.ledgerOffset ||
          !['all', 'range', 'invalid'].includes(cursor.phase) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > head.recordCount ||
          (cursor.page !== undefined && typeof cursor.page !== 'string')) throw new Error('Usage fact cursor changed');
        if (cursor.phase === 'all') {
          while (cursor.offset < head.recordCount) {
            signal?.throwIfAborted();
            const start = cursor.offset;
            const count = allowance(options.budget, Math.min(PAGE_SIZE, head.recordCount - start));
            const keys = Array.from({ length: count }, (_value, index) => `fact:${start + index}`);
            const rows = await abortable(this.query.getMany<UsageFact & { kind: string }>(collection, keys), signal);
            if (rows.size !== keys.length) throw new Error('Incomplete usage fact index');
            for (const key of keys) { const { kind: _kind, ...fact } = rows.get(key)!; records.push(fact); }
            cursor.offset += count;
            await yieldToEventLoop(undefined, { signal });
          }
        } else {
          for (;;) {
            signal?.throwIfAborted();
            const limit = allowance(options.budget, PAGE_SIZE);
            let read = this.query.query<UsageFact & { kind: string }>(collection).where(cursor.phase === 'invalid' ? { kind: 'fact', invalid: true } : { kind: 'fact' }).limit(limit).cursor(cursor.page);
            if (cursor.phase === 'range') read = read.whereColumn('time', { gte: range?.startAt, lt: range?.endAt });
            const page = await abortable(read.execute(), signal);
            if (options.budget !== undefined) options.budget.remainingRecords += limit - page.items.length;
            for (const { kind: _kind, ...fact } of page.items) {
              if (cursor.phase === 'range' || (range?.startAt !== undefined && fact.time < range.startAt) || (range?.endAt !== undefined && fact.time >= range.endAt)) records.push(fact);
            }
            cursor.page = page.nextCursor;
            if (cursor.page === undefined) {
              if (cursor.phase === 'invalid') break;
              cursor.phase = 'invalid';
            }
            await yieldToEventLoop(undefined, { signal });
          }
        }
        return { checkpoint: head.checkpoint, records };
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof FactBudgetReached)) throw error;
        return { checkpoint: head?.checkpoint, records, readComplete: false, nextCursor: cursor === undefined ? undefined : JSON.stringify(cursor) };
      }
    }), signal);
  }

  summary(scope: string, signal?: AbortSignal): Promise<{ checkpoint?: UsageFactCheckpoint; totals?: UsageFactTotals }> {
    return this.exclusive(scope, async () => {
      const head = await this.prepareIndex(scope, signal);
      return { checkpoint: head?.checkpoint, totals: head?.totals };
    });
  }

  private async prepareIndex(scope: string, signal?: AbortSignal, budget?: UsageFactReadBudget): Promise<IndexHead | undefined> {
    signal?.throwIfAborted();
    if (budget !== undefined && budget.remainingRecords <= 0) throw new FactBudgetReached();
    const collection = collectionOf(scope);
    const directory = factDirectory(scope);
    await abortable(this.logs.flush(directory, LOG).catch(() => undefined), signal);
    const size = await abortable(this.storage.size(directory, LOG), signal) ?? 0;
    if (size === 0) return undefined;
    const pending = this.indexing.get(scope);
    if (pending !== undefined && pending.size <= size) {
      pending.size = size;
      return this.advanceIndex(scope, pending, signal, budget);
    }
    this.indexing.delete(scope);
    let head = await abortable(this.query.get<IndexHead>(collection, HEAD), signal);
    if (head !== undefined && (head.version !== 1 || head.ledgerOffset > size || !await this.verifyIndex(collection, head, signal, budget))) {
      await this.query.dropCollection(collection);
      head = undefined;
    }
    if (this.verified.size >= 4096) this.verified.clear();
    this.verified.add(collection);
    if (head?.ledgerOffset === size) return head;
    while (this.indexing.size >= 16) {
      const idle = [...this.indexing.keys()].find((key) => !this.operations.has(key));
      if (idle === undefined) {
        await abortable(this.operations.get(this.indexing.keys().next().value!)!.catch(() => undefined), signal);
        continue;
      }
      this.indexing.delete(idle);
      this.verified.delete(collectionOf(idle));
      await this.query.dropCollection(`${collectionOf(idle)}:stage`);
    }
    const progress: IndexProgress = { size, offset: head?.ledgerOffset ?? 0, head, decoder: new TextDecoder(), queued: [], staged: 0, reset: true, copied: 0 };
    this.indexing.set(scope, progress);
    return this.advanceIndex(scope, progress, signal, budget);
  }

  private async verifyIndex(collection: string, head: IndexHead, signal?: AbortSignal, budget?: UsageFactReadBudget): Promise<boolean> {
    if (this.verified.has(collection)) return true;
    let progress = this.verifying.get(collection);
    if (progress?.ledgerOffset !== head.ledgerOffset) {
      progress = { ledgerOffset: head.ledgerOffset, count: 0 };
      if (this.verifying.size >= 4096) this.verifying.clear();
      this.verifying.set(collection, progress);
    }
    for (;;) {
      signal?.throwIfAborted();
      const limit = allowance(budget, PAGE_SIZE);
      const page = await abortable(this.query.query(collection).where({ kind: 'fact' }).limit(limit).cursor(progress.cursor).execute(), signal);
      if (budget !== undefined) budget.remainingRecords += limit - page.items.length;
      progress.count += page.items.length;
      progress.cursor = page.nextCursor;
      if (progress.count > head.recordCount || progress.cursor === undefined) break;
      await yieldToEventLoop(undefined, { signal });
    }
    this.verifying.delete(collection);
    return progress.count === head.recordCount;
  }

  private async advanceIndex(scope: string, progress: IndexProgress, signal?: AbortSignal, budget?: UsageFactReadBudget): Promise<IndexHead | undefined> {
    const collection = collectionOf(scope);
    const stage = `${collection}:stage`;
    const flush = async (): Promise<void> => {
      signal?.throwIfAborted();
      if (progress.reset) { await this.query.dropCollection(stage); progress.reset = false; }
      while (progress.queued.length > 0) {
        signal?.throwIfAborted();
        const count = allowance(budget, Math.min(PAGE_SIZE, progress.queued.length));
        const ops: WriteOp[] = progress.queued.slice(0, count).map((fact, index) => ({ kind: 'put', collection: stage, key: `fact:${progress.staged + index}`, value: fact }));
        await this.query.batch(ops);
        progress.queued.splice(0, count);
        progress.staged += count;
        await yieldToEventLoop(undefined, { signal });
      }
      if (progress.batch === undefined) return;
      const batch = progress.batch;
      if (progress.copying === undefined) {
        let checkpoint = progress.head?.checkpoint;
        let recordCount = progress.head?.recordCount ?? 0;
        let totals = progress.head?.totals ?? summarizeUsageFacts([]);
        if (batch.start === 0 || (checkpoint !== undefined && checkpoint.generation !== batch.checkpoint.generation)) {
          await this.query.dropCollection(collection);
          checkpoint = undefined;
          recordCount = 0;
          totals = summarizeUsageFacts([]);
        }
        progress.copying = { version: 1, ledgerOffset: progress.offset, recordCount, checkpoint, totals };
      }
      if (batch.start === (progress.copying.checkpoint?.offset ?? 0)) {
        while (progress.copied < progress.staged) {
          signal?.throwIfAborted();
          const count = allowance(budget, Math.min(PAGE_SIZE, progress.staged - progress.copied));
          const keys = Array.from({ length: count }, (_value, index) => `fact:${progress.copied + index}`);
          const rows = await abortable(this.query.getMany<UsageFact>(stage, keys), signal);
          if (rows.size !== count) throw new InvalidFactJournal('Incomplete staged usage facts');
          const facts = keys.map((key) => rows.get(key)!);
          await this.query.batch(facts.map((fact, index) => ({ kind: 'put', collection, key: `fact:${progress.copying!.recordCount + index}`, value: { ...fact, kind: 'fact' }, columns: { time: fact.time } })));
          progress.copying = { ...progress.copying, recordCount: progress.copying.recordCount + count, totals: summarizeUsageFacts(facts, progress.copying.totals) };
          progress.copied += count;
          await yieldToEventLoop(undefined, { signal });
        }
        progress.copying = { ...progress.copying, checkpoint: { ...batch.checkpoint, valid: (progress.copying.checkpoint?.valid ?? true) && batch.checkpoint.valid } };
      }
      signal?.throwIfAborted();
      await this.query.put(collection, HEAD, progress.copying);
      progress.head = progress.copying;
      progress.batch = undefined;
      progress.copying = undefined;
      progress.parser = undefined;
      progress.staged = 0;
      progress.copied = 0;
      progress.reset = true;
      await this.query.dropCollection(stage);
    };
    try {
      await flush();
      const stream = progress.offset < progress.size ? this.storage.readStream(factDirectory(scope), LOG, { start: progress.offset, end: progress.size - 1 }, { signal, chunkBytes: 64 << 10 }) : [];
      for await (const chunk of stream) {
        for (let start = 0; start < chunk.length;) {
          signal?.throwIfAborted();
          if (progress.parser === undefined) {
            progress.parser = new UsageJsonStream({
              reset: () => { progress.queued = []; progress.staged = 0; progress.reset = true; },
              record: (value) => {
                if (!validFact(value as unknown as UsageFact)) throw new InvalidFactJournal('Invalid usage fact');
                progress.queued.push(value as unknown as UsageFact);
              },
            });
          }
          const newline = chunk.indexOf(10, start);
          const end = Math.min(newline < 0 ? chunk.length : newline, start + (64 << 10));
          const completeLine = end === newline;
          progress.parser.write(progress.decoder.decode(chunk.subarray(start, end), { stream: true }));
          progress.offset += end - start + Number(completeLine);
          if (completeLine) {
            progress.parser.write(progress.decoder.decode());
            const batch = progress.parser.finishBatch() as unknown as FactBatch;
            if (!validBatch(batch)) throw new InvalidFactJournal('Invalid usage fact batch');
            progress.batch = batch;
          }
          await flush();
          start = end + Number(completeLine);
          await yieldToEventLoop(undefined, { signal });
        }
      }
      if (progress.parser !== undefined) throw new InvalidFactJournal('Incomplete usage fact batch');
      this.indexing.delete(scope);
      return progress.head;
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof InvalidFactJournal) && !(error instanceof SyntaxError)) throw error;
      this.indexing.delete(scope);
      this.verified.delete(collection);
      this.damaged.add(scope);
      await this.query.dropCollection(collection);
      await this.query.dropCollection(stage);
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
    typeof value.checkpoint.valid === 'boolean' && value.records.every(validFact);
}

function validFact(record: UsageFact): boolean {
  return record !== null && typeof record === 'object' && Number.isFinite(record.time) && typeof record.model === 'string' &&
    record.usage !== null && typeof record.usage === 'object' && Object.values(record.usage).every((token) => typeof token === 'number' && Number.isFinite(token) && token >= 0);
}

function allowance(budget: UsageFactReadBudget | undefined, requested: number): number {
  if (budget === undefined) return requested;
  const count = Math.min(requested, budget.remainingRecords);
  if (count <= 0) throw new FactBudgetReached();
  budget.remainingRecords -= count;
  return count;
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(signal.reason); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort); });
  });
}

registerScopedService(LifecycleScope.App, IUsageFactStore, UsageFactStore, ScopeActivation.OnScopeCreated, 'usage');
