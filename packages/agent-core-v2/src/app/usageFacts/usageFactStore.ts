import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { ILogService } from '#/_base/log/log';
import { normalizeUsageFact, type UsageFact, type UsageFactTotals } from '#/agent/usage/usageFact';
import { UsageJsonStream, type UsageFactJsonObserver } from '#/agent/usage/usageJson';
import { IAppendLogStore, type AppendLogCommit } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IUsageReadModel, type UsageImportProgress } from '#/persistence/interface/usageReadModel';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

export interface UsageFactCheckpoint {
  readonly generation: string;
  readonly offset: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly boundaryHash: string;
  readonly valid: boolean;
}

/** Read coverage is independent of canonical coverage. An incomplete read resumes through nextCursor or source import progress; only a fully validated batch publishes facts. */
export interface UsageFactSnapshot {
  readonly checkpoint?: UsageFactCheckpoint;
  readonly records: readonly UsageFact[];
  readonly readComplete?: boolean;
  readonly nextCursor?: string;
}
export interface UsageFactReadBudget { remainingRecords: number }
export interface UsageFactReadOptions { readonly budget?: UsageFactReadBudget; readonly cursor?: string; readonly pageSize?: number }
export interface UsageFactRange { readonly startAt?: number; readonly endAt?: number }
export interface IUsageFactStore {
  readonly _serviceBrand: undefined;
  checkpoint(scope: string, signal?: AbortSignal): Promise<UsageFactCheckpoint | undefined>;
  read(scope: string, range?: UsageFactRange, signal?: AbortSignal, options?: UsageFactReadOptions): Promise<UsageFactSnapshot>;
  summary(scope: string, signal?: AbortSignal, options?: UsageFactReadOptions): Promise<{ checkpoint?: UsageFactCheckpoint; totals?: UsageFactTotals; readComplete?: boolean }>;
  commit(scope: string, start: number, checkpoint: UsageFactCheckpoint, records: readonly UsageFact[]): Promise<void>;
}
export const IUsageFactStore = createDecorator<IUsageFactStore>('usageFactStore');
interface FactBatch { readonly version: 1; readonly start: number; readonly checkpoint: UsageFactCheckpoint; readonly records: readonly UsageFact[] }
const LOG = 'facts.jsonl';
class FactBudgetReached extends Error {}
export class UsageFactCursorChangedError extends Error { constructor() { super('Usage fact cursor changed'); } }

export class UsageFactStore extends Disposable implements IUsageFactStore {
  declare readonly _serviceBrand: undefined;
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly damaged = new Set<string>();
  constructor(
    @IAppendLogStore private readonly logs: IAppendLogStore,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IUsageReadModel private readonly model: IUsageReadModel,
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
          if (fact === undefined) valid = false; else facts.push(fact);
        }
        return { facts, valid };
      },
      commit: (position, value) => {
        void this.exclusive(position.scope, () => this.commitWritten(position, value.facts, value.valid)).catch((error: unknown) => {
          this.log.warn('Usage projection pending; canonical source remains recoverable', error);
        });
        return Promise.resolve();
      },
      onError: (error) => { this.log.warn('Usage projection pending; canonical source remains recoverable', error); },
    }));
  }
  override async dispose(): Promise<void> {
    await super.dispose();
    while (this.operations.size > 0) await Promise.allSettled(this.operations.values());
  }
  private async commitWritten(position: AppendLogCommit, records: readonly UsageFact[], valid: boolean): Promise<void> {
    const mtimeMs = await this.storage.mtime(position.scope, position.key) ?? 0;
    await this.commitBatch(position.scope, position.start, { generation: position.generation, offset: position.end, size: position.end, mtimeMs, boundaryHash: position.boundaryHash, valid }, records);
  }
  commit(scope: string, start: number, checkpoint: UsageFactCheckpoint, records: readonly UsageFact[]): Promise<void> {
    return this.exclusive(scope, () => this.commitBatch(scope, start, checkpoint, records));
  }
  private async commitBatch(scope: string, start: number, checkpoint: UsageFactCheckpoint, records: readonly UsageFact[]): Promise<void> {
    const directory = factDirectory(scope);
    const owner = this.logs.acquire(directory, LOG);
    try {
      const batch: FactBatch = { version: 1, start, checkpoint, records };
      if (this.damaged.has(scope)) {
        if (start !== 0) return;
        await this.logs.rewrite(directory, LOG, [batch]);
        await this.model.abandon(scope);
        this.damaged.delete(scope);
      } else { this.logs.append(directory, LOG, batch); await this.logs.flush(directory, LOG); }
      await this.prepare(scope);
    } finally { await owner.dispose(); }
  }
  checkpoint(scope: string, signal?: AbortSignal): Promise<UsageFactCheckpoint | undefined> {
    return abortable(this.exclusive(scope, async () => {
      signal?.throwIfAborted();
      await abortable(this.logs.flush(factDirectory(scope), LOG), signal);
      const size = await this.storage.size(factDirectory(scope), LOG) ?? 0;
      const head = await this.model.source(scope, signal);
      if (head === undefined || head.journalOffset !== size || head.checkpoint?.generation !== await this.logs.generation(scope, AGENT_WIRE_RECORD_KEY)) return undefined;
      return head.checkpoint;
    }), signal);
  }
  read(scope: string, range?: UsageFactRange, signal?: AbortSignal, options: UsageFactReadOptions = {}): Promise<UsageFactSnapshot> {
    return abortable(this.exclusive(scope, async () => {
      if (!await this.prepare(scope, signal, options.budget)) return { records: [], readComplete: false, nextCursor: options.cursor };
      const head = await this.model.source(scope, signal);
      if (head?.checkpoint === undefined) return { records: [] };
      let offset = 0;
      let until = head.ordinal;
      let checkpoint = head.checkpoint;
      if (options.cursor !== undefined) {
        let cursor: { scope: string; dataGeneration: string; offset: number; until: number; checkpoint: UsageFactCheckpoint; range?: UsageFactRange };
        try { cursor = JSON.parse(options.cursor); } catch { throw new UsageFactCursorChangedError(); }
        if (cursor === null || cursor.scope !== scope || cursor.dataGeneration !== head.dataGeneration || JSON.stringify(cursor.range) !== JSON.stringify(range) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(cursor.until) || cursor.until < cursor.offset || cursor.until > head.ordinal || cursor.checkpoint?.generation !== head.checkpoint.generation) throw new UsageFactCursorChangedError();
        offset = cursor.offset; until = cursor.until; checkpoint = cursor.checkpoint;
      }
      const records: UsageFact[] = [];
      const limit = options.pageSize ?? Infinity;
      let remaining = limit;
      do {
        signal?.throwIfAborted();
        if (offset >= until) return { checkpoint, records };
        const count = Math.min(1000, remaining, options.budget?.remainingRecords ?? Infinity, until - offset);
        if (count <= 0) return { checkpoint, records, readComplete: false, nextCursor: JSON.stringify({ scope, dataGeneration: head.dataGeneration, checkpoint, range, offset, until }) };
        if (options.budget !== undefined) options.budget.remainingRecords -= count;
        let page: Awaited<ReturnType<IUsageReadModel['read']>>;
        try { page = await this.model.read(scope, range, offset, count, signal, until); }
        catch (error) { if (options.budget !== undefined) options.budget.remainingRecords += count; throw error; }
        if (options.budget !== undefined) options.budget.remainingRecords += count - page.records.length;
        if (page.head?.dataGeneration !== head.dataGeneration) throw new UsageFactCursorChangedError();
        records.push(...page.records);
        remaining -= page.records.length;
        if (page.nextOffset === undefined) return { checkpoint, records };
        offset = page.nextOffset;
        await yieldToEventLoop(undefined, { signal });
      } while (offset < until);
      return { checkpoint, records };
    }), signal);
  }
  summary(scope: string, signal?: AbortSignal, options: UsageFactReadOptions = {}): ReturnType<IUsageFactStore['summary']> {
    return abortable(this.exclusive(scope, async () => {
      if (!await this.prepare(scope, signal, options.budget)) return { readComplete: false };
      const result = await this.model.summary(scope, signal);
      return { checkpoint: result.head?.checkpoint, totals: result.totals };
    }), signal);
  }
  private async prepare(scope: string, signal?: AbortSignal, budget?: UsageFactReadBudget): Promise<boolean> {
    signal?.throwIfAborted();
    const directory = factDirectory(scope);
    await abortable(this.logs.flush(directory, LOG), signal);
    const size = await this.storage.size(directory, LOG) ?? 0;
    if (size === 0) return true;
    let head = await this.model.source(scope, signal);
    let progress = await this.model.progress(scope, signal);
    if (size < (progress?.offset ?? head?.journalOffset ?? 0)) { await this.model.invalidate(scope); progress = undefined; head = undefined; }
    let offset = progress?.offset ?? head?.journalOffset ?? 0;
    if (offset === size && progress === undefined) return true;
    let ordinal = progress?.ordinal ?? 0;
    let batchStart = progress?.batchStart ?? offset;
    let queued: UsageFact[] = [];
    let reset = false;
    const observer: UsageFactJsonObserver = {
      reset: () => { queued = []; ordinal = 0; reset = true; },
      record: (raw) => { const fact = raw as unknown as UsageFact; if (!validFact(fact)) throw new SyntaxError('Invalid usage fact'); queued.push(fact); ordinal++; },
    };
    let parser = progress?.parser === undefined ? undefined : UsageJsonStream.resume(progress.parser, observer);
    try {
      while (offset < size) {
        signal?.throwIfAborted();
        if ((budget?.remainingRecords ?? Infinity) <= 0) throw new FactBudgetReached();
        const count = Math.min(64 << 10, Math.max(4, (budget?.remainingRecords ?? Infinity) * 16), size - offset);
        let bytes: Uint8Array = new Uint8Array(0);
        for await (const chunk of this.storage.readStream(directory, LOG, { start: offset, end: offset + count - 1 }, { signal, chunkBytes: count })) { bytes = bytes.length === 0 ? chunk : Buffer.concat([bytes, chunk]); }
        if (bytes.length === 0) throw new SyntaxError('Truncated Usage journal');
        let consumed = 0;
        while (consumed < bytes.length) {
          if (parser === undefined) { batchStart = offset; ordinal = 0; parser = new UsageJsonStream(observer); }
          const newline = bytes.indexOf(10, consumed);
          const end = newline >= 0 ? newline : utf8End(bytes, consumed);
          if (end === consumed && newline < 0) break;
          parser.write(new TextDecoder().decode(bytes.subarray(consumed, end)));
          const delta = end - consumed + Number(newline >= 0);
          offset += delta;
          consumed += delta;
          if (budget !== undefined) budget.remainingRecords -= queued.length;
          const complete = newline >= 0;
          const batch = complete ? parser.finishBatch() as unknown as FactBatch : undefined;
          if (batch !== undefined && !validBatch(batch)) throw new SyntaxError('Invalid Usage batch envelope');
          const next: UsageImportProgress = { batchStart, offset, ordinal, parser: complete ? undefined : parser.snapshot() };
          const accepted = await this.model.apply({ source: scope, expected: progress, progress: next, records: queued, reset, publish: batch === undefined ? undefined : { start: batch.start, checkpoint: batch.checkpoint, journalSize: size } });
          if (!accepted) throw new UsageFactCursorChangedError();
          queued = []; reset = false;
          progress = complete ? undefined : next;
          if (complete) parser = undefined;
          if ((budget?.remainingRecords ?? Infinity) <= 0 && offset < size) throw new FactBudgetReached();
          await yieldToEventLoop(undefined, { signal });
        }
      }
      if (parser !== undefined) throw new SyntaxError('Incomplete Usage batch');
      return true;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof FactBudgetReached) return false;
      if (!(error instanceof SyntaxError)) throw error;
      this.damaged.add(scope);
      await this.model.invalidate(scope);
      this.log.warn('Usage journal requires canonical recovery', error);
      return true;
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
function factDirectory(scope: string): string { return `cache/usage-facts-v1/${createHash('sha256').update(scope).digest('hex')}`; }
function validFact(record: UsageFact): boolean { return record !== null && typeof record === 'object' && Number.isFinite(record.time) && typeof record.model === 'string' && record.usage !== null && typeof record.usage === 'object' && Object.values(record.usage).every((token) => typeof token === 'number' && Number.isFinite(token) && token >= 0); }
function validBatch(value: FactBatch): boolean { const checkpoint = value.checkpoint; return value.version === 1 && Number.isSafeInteger(value.start) && value.start >= 0 && checkpoint !== null && typeof checkpoint === 'object' && typeof checkpoint.generation === 'string' && Number.isSafeInteger(checkpoint.offset) && checkpoint.offset >= value.start && Number.isSafeInteger(checkpoint.size) && checkpoint.size >= checkpoint.offset && Number.isFinite(checkpoint.mtimeMs) && typeof checkpoint.boundaryHash === 'string' && typeof checkpoint.valid === 'boolean' && Array.isArray(value.records); }
function utf8End(bytes: Uint8Array, start: number): number {
  let index = bytes.length - 1;
  while (index >= start && (bytes[index]! & 0xc0) === 0x80) index--;
  if (index < start) return bytes.length;
  const lead = bytes[index]!;
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return index + length <= bytes.length ? bytes.length : index;
}
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { reject(signal.reason); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort); });
  });
}
registerScopedService(LifecycleScope.App, IUsageFactStore, UsageFactStore, ScopeActivation.OnScopeCreated, 'usage');
