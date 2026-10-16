import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { UsageReadAllowance, UsageWireFramer, type UsageWireState } from '@kiki/agent-core-v2/agent/usage/usageWireFramer';
import type { UsageFact } from '@kiki/agent-core-v2/agent/usage/usageFact';
import type { IFileSystemStorageService } from '@kiki/agent-core-v2/persistence/interface/storage';
import type { Ledger } from '@kiki/agent-core-v2/_base/lifecycle/ledger';
import { UsageParserWorker, type UsageWorkerObservation } from './worker/host';
import { USAGE_CHUNK_BYTES } from './worker/protocol';

export interface WireLineContinuation { readonly source: string; readonly state: UsageWireState }
export interface WireTailResult {
  readonly readBytes: number;
  readonly records: readonly UsageFact[];
  readonly offset: number;
  readonly scannedRecordCount: number;
  readonly scannedFactCount: number;
  readonly valid: boolean;
  readonly complete: boolean;
  readonly incompleteReason: 'deadline' | 'record_budget' | null;
}

const pools = new WeakMap<object, UsageRecoveryPool>();
export function usageRecoveryPool(owner: object & { readonly ledger?: Ledger }): UsageRecoveryPool {
  let pool = pools.get(owner);
  if (pool === undefined) {
    pool = new UsageRecoveryPool();
    pools.set(owner, pool);
    const owned = pool;
    owner.ledger?.register(async () => { owned.dispose(); await owned.closed(); pools.delete(owner); }, 'usage-recovery');
  }
  return pool;
}

/** One App-wide recovery operation uses the main lane and at most one pure parser isolate. Waiting operations retain only source descriptors; byte queues have one transferred chunk per lane. */
export class UsageRecoveryPool {
  private active = false;
  private disposed = false;
  private readonly stop = new AbortController();
  private readonly waiters: { resolve: () => void; reject: (error: Error) => void; signal: AbortSignal; abort: () => void }[] = [];
  private worker?: UsageParserWorker;
  private lastObservation?: UsageWorkerObservation;
  private closing: Promise<void> = Promise.resolve();
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle?: () => void;
  readonly workerEnabled: boolean;
  private readonly entry?: URL;

  constructor(workerEnabled = true, entry?: URL) { this.workerEnabled = workerEnabled; this.entry = entry; }

  async run<T>(sources: readonly T[], consume: (source: T, worker: UsageParserWorker | undefined, signal: AbortSignal) => Promise<void>, signal?: AbortSignal, parallel = true): Promise<void> {
    const readSignal = signal === undefined ? this.stop.signal : AbortSignal.any([signal, this.stop.signal]);
    await this.acquire(readSignal);
    const operation = new AbortController();
    const laneSignal = AbortSignal.any([readSignal, operation.signal]);
    let index = 0;
    const loop = async (worker?: UsageParserWorker): Promise<void> => {
      while (index < sources.length) { laneSignal.throwIfAborted(); const source = sources[index++]!; await consume(source, worker, laneSignal); }
    };
    try {
      if (parallel && this.workerEnabled && sources.length > 1) this.worker = new UsageParserWorker(laneSignal, this.entry);
      const lanes = [loop()];
      if (this.worker !== undefined) lanes.push(loop(this.worker));
      try { await Promise.all(lanes); }
      catch (error) { operation.abort(error); await Promise.allSettled(lanes); throw error; }
    } finally {
      if (this.worker !== undefined) {
        const worker = this.worker;
        this.closing = worker.close();
        await this.closing;
        this.lastObservation = worker.observation();
        this.worker = undefined;
      }
      this.release();
    }
  }

  observation(): UsageWorkerObservation | undefined { return this.worker?.observation() ?? this.lastObservation; }
  dispose(): void { this.disposed = true; this.stop.abort(new DOMException('Usage recovery disposed', 'AbortError')); if (this.worker !== undefined) this.closing = this.worker.close(); }
  async closed(): Promise<void> { await this.idle; await this.closing; }

  private async acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.disposed) throw new Error('Usage recovery disposed');
    if (!this.active) { this.active = true; this.idle = new Promise((resolve) => { this.resolveIdle = resolve; }); return; }
    if (this.waiters.length >= 8) throw new Error('Usage recovery queue is full');
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: () => { const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1); reject(signal.reason as Error); } };
      this.waiters.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
    });
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) { this.active = false; this.resolveIdle?.(); this.resolveIdle = undefined; return; }
    waiter.signal.removeEventListener('abort', waiter.abort);
    waiter.resolve();
  }
}

export async function readUsageWireTail(
  storage: IFileSystemStorageService,
  scope: string,
  startOffset: number,
  size: number,
  allowance: UsageReadAllowance,
  deadlineAt: number,
  now: () => number,
  sourceAgentId: string | undefined,
  signal: AbortSignal | undefined,
  onCheckpoint: ((offset: number, records: readonly UsageFact[], valid: boolean) => Promise<void>) | undefined,
  continuations: Map<string, WireLineContinuation>,
  source: string,
  worker?: UsageParserWorker,
  onScannedRecord?: () => void,
  externalSignal?: AbortSignal,
): Promise<WireTailResult> {
  const retained = continuations.get(scope);
  continuations.delete(scope);
  let state: UsageWireState = retained?.source === source && retained.state.offset === startOffset ? retained.state : { offset: startOffset, cursor: startOffset, valid: true };
  const framer = worker === undefined ? new UsageWireFramer(startOffset, sourceAgentId, state) : undefined;
  const deadline = new AbortController();
  const wallDeadline = Date.now() + Math.max(0, deadlineAt - now());
  const timer = Number.isFinite(deadlineAt) ? setTimeout(() => { allowance.stop('deadline'); deadline.abort(); }, Math.max(0, deadlineAt - now())) : undefined;
  const readSignal = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
  const deadlineExpired = (): boolean => !externalSignal?.aborted && (deadline.signal.aborted || (signal?.aborted === true && signal.reason instanceof Error && signal.reason.name === 'TimeoutError'));
  const cancel = (): void => { allowance.stop(deadlineExpired() ? 'deadline' : 'cancelled'); };
  signal?.addEventListener('abort', cancel, { once: true });
  const records: UsageFact[] = [];
  let readBytes = 0, scannedRecordCount = 0, scannedFactCount = 0;
  let incompleteReason: WireTailResult['incompleteReason'] = null;
  let failed = false;
  const availableBytes = allowance.reserveBytes(size - state.cursor);
  const end = state.cursor + availableBytes;
  const stopWorker = (): void => { void worker?.close(); };
  readSignal.addEventListener('abort', stopWorker, { once: true });
  try {
    readSignal.throwIfAborted();
    if (worker !== undefined) await worker.begin(startOffset, sourceAgentId, state, allowance.buffer, wallDeadline);
    if (state.cursor < end) {
      sourceRead: for await (const input of storage.readStream(scope, 'wire.jsonl', { start: state.cursor, end: end - 1 }, { signal: readSignal, chunkBytes: USAGE_CHUNK_BYTES })) {
        signal?.throwIfAborted();
        readBytes += input.byteLength;
        for (let part = 0; part < input.byteLength; part += USAGE_CHUNK_BYTES) {
          const chunk = input.subarray(part, Math.min(part + USAGE_CHUNK_BYTES, input.byteLength));
          const count = chunk.byteLength;
          let bytes = worker === undefined ? chunk : Uint8Array.from(chunk);
          let start = 0;
          while (start < count) {
            const response = worker === undefined ? undefined : await worker.chunk(bytes.buffer as ArrayBuffer, bytes.byteOffset + start, bytes.byteOffset + count);
            if (response?.bytes !== undefined) bytes = new Uint8Array(response.bytes);
            const slice = response?.slice ?? framer!.consume(bytes.subarray(start, count), allowance, deadlineAt, now);
            start += slice.consumed;
            state = slice.state;
            scannedRecordCount += slice.rawCount;
            scannedFactCount += slice.factCount;
            for (const record of slice.records) records.push(record);
            if (onScannedRecord !== undefined) for (let i = 0; i < slice.rawCount; i++) onScannedRecord();
            if (slice.stop === 'checkpoint') await onCheckpoint?.(state.offset, records, state.valid);
            if (slice.stop === 'record_budget' || slice.stop === 'deadline') { incompleteReason = slice.stop; break sourceRead; }
            if (slice.stop === 'cancelled') { signal?.throwIfAborted(); throw new DOMException('Usage recovery stopped', 'AbortError'); }
            if (slice.stop === 'yield' || slice.stop === 'checkpoint') await yieldToEventLoop(undefined, { signal: readSignal });
          }
        }
      }
    }
    if (end < size) incompleteReason ??= 'deadline';
  } catch {
    externalSignal?.throwIfAborted();
    if (!deadlineExpired()) signal?.throwIfAborted();
    failed = true;
    if (deadlineExpired() || allowance.stopped() === 'deadline') incompleteReason = 'deadline';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    readSignal.removeEventListener('abort', stopWorker);
    allowance.refundBytes(availableBytes - readBytes);
    if (state.parser !== undefined && state.cursor < size) {
      if (continuations.size >= 16) continuations.delete(continuations.keys().next().value!);
      continuations.set(scope, { source, state });
    }
  }
  externalSignal?.throwIfAborted();
  if (!deadlineExpired()) signal?.throwIfAborted();
  return { readBytes, records, offset: state.offset, scannedRecordCount, scannedFactCount, valid: state.valid, complete: !failed && incompleteReason === null && state.offset === size, incompleteReason };
}
