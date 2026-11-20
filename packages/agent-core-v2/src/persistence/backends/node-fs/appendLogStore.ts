import { createHash, randomUUID } from 'node:crypto';

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';

import { IFileSystemStorageService, StorageError, StorageErrors, type StorageFileStat } from '#/persistence/interface/storage';
import {
  discardColdSegments,
  discardColdUnlocked,
  hasColdStateForRewrite,
  readLogicalBytes,
  sealColdSegments,
  waitActiveReadersIdle,
  withColdExclusive,
} from '#/persistence/coldSegmentLog';
import { withColdReaderGate } from '#/persistence/backends/node-fs/fileLock';
import { removeSparseMarker } from '#/persistence/backends/node-fs/sparseFile';
import { encodeJsonLines } from '#/persistence/jsonLines';
import {
  AppendLogCorruptedError,
  IAppendLogStore,
  type AppendLogOptions,
  type AppendLogReadOptions,
  type AppendLogSourceRevision,
  type AppendLogWrite,
  type AppendLogCommit,
  type AppendLogProjection,
  type ColdSealOptions,
  type ColdSealResult,
} from '#/persistence/interface/appendLogStore';

export { COLD_SEGMENT_BYTES, coldManifestKey, logicalByteSize, openPinnedLogicalRead, readLogicalBytes } from '#/persistence/coldSegmentLog';
export type { PinnedLogicalRead } from '#/persistence/coldSegmentLog';
export { readLogicalRange, readPinnedRange, wireFileAddress } from '#/persistence/logicalWireFile';

const textEncoder = new TextEncoder();
const TRANSIENT_APPEND_ERRNOS = new Set(['EBUSY', 'EPERM', 'EACCES']);
const MAX_APPEND_BATCH_BYTES = 4 * 1024 * 1024;

const pendingRetirements = new Set<Promise<void>>();

function sameStat(left: StorageFileStat | undefined, right: StorageFileStat | undefined): boolean {
  return left !== undefined && right !== undefined &&
    left.identity === right.identity && left.size === right.size && left.revision === right.revision;
}

function appendCommitted(error: unknown): boolean | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const committed = (error as { details?: { committed?: unknown } }).details?.committed;
  return typeof committed === 'boolean' ? committed : undefined;
}

function isUncommittedTransientAppend(error: unknown): boolean {
  if (appendCommitted(error) !== false || error === null || typeof error !== 'object') return false;
  const errno = (error as { details?: { errno?: unknown } }).details?.errno;
  if (typeof errno === 'string' && TRANSIENT_APPEND_ERRNOS.has(errno)) return true;
  return (error as { code?: unknown }).code === 'storage.locked';
}

function mayRetryAppendFailure(error: unknown, isRetry: boolean): boolean {
  if (isRetry) return false;
  const committed = appendCommitted(error);
  if (committed === true) return false;
  if (committed === false) return isUncommittedTransientAppend(error);
  return true;
}

export async function drainAppendLogRetirements(): Promise<void> {
  while (pendingRetirements.size > 0) {
    await Promise.all(pendingRetirements);
  }
}

interface PendingAppendEntry {
  readonly record: unknown;
  encodedLine?: Uint8Array;
}

interface LogState {
  pending: PendingAppendEntry[];
  flushPromise: Promise<void> | undefined;
  flushScheduled: boolean;
  storageFailure: { readonly error: unknown } | undefined;
  storageFailureRetriable: boolean;
  cutoverEpoch: number;
  refCount: number;
  retired: boolean;
  ready: Promise<void>;
  retirement: Promise<void> | undefined;
  position?: AppendPosition;
  source?: { revision: number; unexplained: number; stat: StorageFileStat | undefined };
  uncertainAppend?: {
    readonly start: AppendPosition;
    readonly encoded: Uint8Array;
    readonly count: number;
    readonly prepared: readonly ((position: AppendLogCommit) => Promise<void>)[];
  };
  onError?: (error: unknown) => void;
}

interface AppendPosition {
  readonly generation: string;
  readonly offset: number;
  readonly boundary: Uint8Array;
}

interface ProjectionObserver {
  readonly key: string;
  prepare(scope: string, records: readonly unknown[]): ((position: AppendLogCommit) => Promise<void>) | undefined;
}

export class AppendLogStore extends Disposable implements IAppendLogStore {
  declare readonly _serviceBrand: undefined;

  private readonly logs = new Map<string, LogState>();
  private readonly projections = new Set<ProjectionObserver>();
  private readonly writeEmitter = this._register(new Emitter<AppendLogWrite>());
  readonly onDidWrite: Event<AppendLogWrite> = this.writeEmitter.event;

  constructor(@IFileSystemStorageService private readonly storage: IFileSystemStorageService) {
    super();
  }

  registerProjection<T>(projection: AppendLogProjection<T>): IDisposable {
    const report = (error: unknown): void => { try { projection.onError(error); } catch {} };
    const observer: ProjectionObserver = {
      key: projection.key,
      prepare(scope, records) {
        try {
          const value = projection.prepare(scope, records);
          return async (position) => {
            try { await projection.commit(position, value); } catch (error) { report(error); }
          };
        } catch (error) { report(error); return undefined; }
      },
    };
    this.projections.add(observer);
    return toDisposable(() => { this.projections.delete(observer); });
  }

  async generation(scope: string, key: string): Promise<string> {
    await this.logs.get(logId(scope, key))?.flushPromise?.catch(() => undefined);
    return this.readGeneration(scope, key);
  }

  async sourceRevision(scope: string, key: string): Promise<AppendLogSourceRevision | undefined> {
    if (this.storage.stat === undefined) return undefined;
    await this.flush(scope, key);
    const state = this.state(scope, key);
    const source = state.source ??= { revision: 0, unexplained: 0, stat: undefined };
    const info = await this.storage.stat(scope, key);
    if (state.flushPromise !== undefined) {
      source.revision++;
      source.unexplained++;
      source.stat = undefined;
      return undefined;
    }
    this.observeSource(source, info);
    return info === undefined ? undefined : { revision: source.revision, unexplained: source.unexplained, size: info.size, identity: info.identity };
  }

  private observeSource(source: NonNullable<LogState['source']>, info: StorageFileStat | undefined): void {
    const previous = source.stat;
    if (previous?.identity !== info?.identity || previous?.size !== info?.size || previous?.revision !== info?.revision) {
      source.revision++;
      source.unexplained++;
    }
    source.stat = info;
  }

  private async appendObserved(scope: string, key: string, state: LogState, data: Uint8Array): Promise<void> {
    const source = state.source;
    if (source === undefined || this.storage.stat === undefined) {
      await this.storage.append(scope, key, data, { durable: true });
      return;
    }
    const before = await this.storage.stat(scope, key).catch(() => undefined);
    this.observeSource(source, before);
    try {
      await this.storage.append(scope, key, data, { durable: true });
    } catch (error) {
      const after = before === undefined ? undefined : await this.storage.stat(scope, key).catch(() => undefined);
      if (sameStat(before, after)) {
        source.stat = after;
      } else {
        source.revision++;
        const grewWithinBatch = appendCommitted(error) !== false && before !== undefined && after !== undefined &&
          before.identity !== undefined && before.identity === after.identity &&
          after.size > before.size && after.size <= before.size + data.byteLength;
        if (grewWithinBatch) source.stat = after;
        else {
          source.unexplained++;
          source.stat = undefined;
        }
      }
      throw error;
    }
    const after = await this.storage.stat(scope, key).catch(() => undefined);
    if (before === undefined || after === undefined || before.identity !== after.identity || after.size !== before.size + data.byteLength) {
      source.revision++;
      source.unexplained++;
    }
    source.stat = after;
  }

  private async readGeneration(scope: string, key: string): Promise<string> {
    const bytes = await this.storage.read(scope, `${key}.generation`);
    return bytes === undefined ? 'legacy' : new TextDecoder().decode(bytes);
  }

  private prepareProjections(scope: string, key: string, records: readonly unknown[]): ((position: AppendLogCommit) => Promise<void>)[] {
    const prepared: ((position: AppendLogCommit) => Promise<void>)[] = [];
    for (const observer of this.projections) {
      if (observer.key !== key) continue;
      const commit = observer.prepare(scope, records);
      if (commit !== undefined) prepared.push(commit);
    }
    return prepared;
  }

  append<R>(scope: string, key: string, record: R, options?: AppendLogOptions): void {
    const state = this.state(scope, key);
    state.pending.push({ record, encodedLine: options?.encodedLine });
    if (options?.onError !== undefined && state.onError === undefined) {
      state.onError = options.onError;
    }
    if (
      state.storageFailure !== undefined &&
      state.storageFailureRetriable &&
      state.flushPromise === undefined &&
      !state.flushScheduled
    ) {
      state.flushScheduled = true;
      queueMicrotask(() => {
        state.flushScheduled = false;
        state.storageFailure = undefined;
        state.storageFailureRetriable = false;
        void this.flushState(scope, key, state).catch((error) => state.onError?.(error));
      });
      return;
    }
    this.scheduleFlush(scope, key, state);
  }

  async *read<R>(scope: string, key: string, options?: AppendLogReadOptions): AsyncIterable<R> {
    await waitForSignal(this.flushLog(scope, key), options?.signal);
    const onTruncate = options?.onTruncate;
    const lineFilter = options?.lineFilter;
    const rawSubstrings = options?.rawSubstrings?.map((n) =>
      Buffer.isBuffer(n) ? n : Buffer.from(n.buffer, n.byteOffset, n.byteLength),
    );
    let pendingChunks: Uint8Array[] = [];
    let pendingBytes = 0;
    let lineNumber = 0;
    let position = options?.startOffset ?? 0;
    const end = options?.endOffset ?? (options?.startOffset === undefined ? undefined : await this.storage.size(scope, key));
    if (end !== undefined && position >= end) {
      options?.signal?.throwIfAborted();
      return;
    }
    const range = end === undefined ? undefined : { start: position, end: end - 1 };
    for await (const chunk of readLogicalBytes(this.storage, scope, key, range, {
      signal: options?.signal,
      chunkBytes: options?.chunkBytes,
    })) {
      let cursor = 0;
      if (pendingBytes > 0) {
        const firstNewline = chunk.indexOf(0x0a, 0);
        if (firstNewline === -1) {
          const tail = Buffer.from(chunk);
          pendingChunks.push(tail);
          pendingBytes += tail.byteLength;
          continue;
        }
        const head = chunk.subarray(0, firstNewline);
        const lineBytes = pendingBytes + head.byteLength + 1;
        pendingChunks.push(head);
        const merged = Buffer.concat(pendingChunks, pendingBytes + head.byteLength);
        pendingChunks = [];
        pendingBytes = 0;
        cursor = firstNewline + 1;
        lineNumber++;
        const trimEnd = merged.byteLength > 0 && merged[merged.byteLength - 1] === 0x0d ? merged.byteLength - 1 : merged.byteLength;
        if (trimEnd === 0) {
          position += lineBytes;
          options?.onPosition?.(position);
        } else if (rawSubstrings !== undefined && rawSubstrings.length > 0 && !containsRawSubstring(merged, 0, trimEnd, rawSubstrings)) {
          position += lineBytes;
          options?.onPosition?.(position);
          options?.signal?.throwIfAborted();
        } else {
          const line = merged.toString('utf8', 0, trimEnd);
          if (lineFilter !== undefined && !lineFilter(line)) {
            position += lineBytes;
            options?.onPosition?.(position);
            options?.signal?.throwIfAborted();
          } else {
            let record: R;
            try {
              record = JSON.parse(line) as R;
            } catch (error) {
              const corrupted = new AppendLogCorruptedError(scope, key, lineNumber, error);
              if (onTruncate === undefined) throw corrupted;
              onTruncate({ lineNumber, reason: 'corrupted', cause: corrupted });
              return;
            }
            position += lineBytes;
            options?.onPosition?.(position);
            options?.signal?.throwIfAborted();
            options?.onRecordBytes?.(lineBytes);
            yield record;
          }
        }
      }
      if (rawSubstrings !== undefined && rawSubstrings.length > 0 && cursor < chunk.byteLength) {
        const lastNewline = chunk.lastIndexOf(0x0a);
        if (lastNewline >= cursor) {
          const spanLen = lastNewline + 1 - cursor;
          const headBuf = Buffer.from(chunk.buffer, chunk.byteOffset + cursor, spanLen);
          if (!containsRawSubstring(headBuf, 0, spanLen, rawSubstrings)) {
            let skippedLines = 0;
            let nl = headBuf.indexOf(0x0a, 0);
            while (nl !== -1) {
              skippedLines++;
              nl = headBuf.indexOf(0x0a, nl + 1);
            }
            lineNumber += skippedLines;
            position += spanLen;
            options?.onPosition?.(position);
            options?.signal?.throwIfAborted();
            cursor = lastNewline + 1;
          }
        }
      }
      let newlineIndex = chunk.indexOf(0x0a, cursor);
      while (newlineIndex !== -1) {
        const lineBytes = newlineIndex - cursor + 1;
        const trimEnd = newlineIndex > cursor && chunk[newlineIndex - 1] === 0x0d ? newlineIndex - 1 : newlineIndex;
        const rawLen = trimEnd - cursor;
        cursor = newlineIndex + 1;
        lineNumber++;
        if (rawLen === 0) {
          position += lineBytes;
          options?.onPosition?.(position);
          newlineIndex = chunk.indexOf(0x0a, cursor);
          continue;
        }
        const lineBuf = Buffer.from(chunk.buffer, chunk.byteOffset + (cursor - lineBytes), rawLen);
        if (rawSubstrings !== undefined && rawSubstrings.length > 0 && !containsRawSubstring(lineBuf, 0, rawLen, rawSubstrings)) {
          position += lineBytes;
          options?.onPosition?.(position);
          options?.signal?.throwIfAborted();
          newlineIndex = chunk.indexOf(0x0a, cursor);
          continue;
        }
        const line = lineBuf.toString('utf8');
        if (lineFilter !== undefined && !lineFilter(line)) {
          position += lineBytes;
          options?.onPosition?.(position);
          options?.signal?.throwIfAborted();
          newlineIndex = chunk.indexOf(0x0a, cursor);
          continue;
        }
        let record: R;
        try {
          record = JSON.parse(line) as R;
        } catch (error) {
          const corrupted = new AppendLogCorruptedError(scope, key, lineNumber, error);
          if (onTruncate === undefined) throw corrupted;
          onTruncate({ lineNumber, reason: 'corrupted', cause: corrupted });
          return;
        }
        position += lineBytes;
        options?.onPosition?.(position);
        options?.signal?.throwIfAborted();
        options?.onRecordBytes?.(lineBytes);
        yield record;
        newlineIndex = chunk.indexOf(0x0a, cursor);
      }
      if (cursor < chunk.byteLength) {
        const tail = Buffer.from(chunk.subarray(cursor));
        pendingChunks.push(tail);
        pendingBytes += tail.byteLength;
      }
    }
    if (pendingBytes > 0) {
      lineNumber++;
      const merged = pendingChunks.length === 1
        ? Buffer.from(pendingChunks[0]!.buffer, pendingChunks[0]!.byteOffset, pendingChunks[0]!.byteLength)
        : Buffer.concat(pendingChunks, pendingBytes);
      const raw = merged.toString('utf8');
      const record = this.parseLine<R>(raw, scope, key, lineNumber, true);
      if (record !== undefined) {
        position += pendingBytes;
        options?.onPosition?.(position);
        options?.signal?.throwIfAborted();
        options?.onRecordBytes?.(pendingBytes);
        yield record;
      } else if (onTruncate !== undefined) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line.length > 0) onTruncate({ lineNumber, reason: 'truncated' });
      }
    }
  }

  private parseLine<R>(
    raw: string,
    scope: string,
    key: string,
    lineNumber: number,
    allowTruncated: boolean,
  ): R | undefined {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length === 0) return undefined;
    try {
      return JSON.parse(line) as R;
    } catch (error) {
      if (allowTruncated) return undefined;
      throw new AppendLogCorruptedError(scope, key, lineNumber, error);
    }
  }

  async rewrite<R>(scope: string, key: string, records: readonly R[]): Promise<void> {
    const encoded = [...encodeJsonLines(records)];
    const state = this.state(scope, key);
    state.cutoverEpoch++;
    const prior = state.flushPromise ?? state.ready;
    const priorSettled = prior.then(
      () => undefined,
      () => undefined,
    );
    const prepared = this.prepareProjections(scope, key, records);
    const rewrite = priorSettled.then(async () => {
      try {
        let committed: { generation: string; offset: number; boundary: Uint8Array } | undefined;
        await withColdExclusive(this.storage, scope, key, async () => {
          const located = this.storage.pathFor(scope, key);
          const replace = async (): Promise<void> => {
            if (await hasColdStateForRewrite(this.storage, scope, key)) {
              await discardColdUnlocked(this.storage, scope, key);
            }
            await waitActiveReadersIdle(this.storage, scope, key);
            const generation = randomUUID();
            state.position = undefined;
            if (state.source !== undefined) {
              state.source.revision++;
              state.source.unexplained++;
            }
            let offset = 0;
            let boundary = new Uint8Array(0);
            const source = async function* () {
              for (const chunk of encoded) {
                offset += chunk.byteLength;
                boundary = chunk.byteLength >= 4096
                  ? chunk.slice(-4096)
                  : new Uint8Array([...boundary.slice(-(4096 - chunk.byteLength)), ...chunk]);
                yield chunk;
              }
            };
            await this.storage.write(scope, `${key}.generation`, textEncoder.encode(generation), {
              atomic: true,
              preserveDestinationOnError: true,
            });
            await this.storage.writeStream(scope, key, source(), {
              atomic: true,
              preserveDestinationOnError: true,
            });
            committed = { generation, offset, boundary };
            if (located !== undefined && located.length > 0) {
              try {
                await removeSparseMarker(located);
              } catch {}
            }
          };
          if (located === undefined || located.length === 0) await replace();
          else await withColdReaderGate(located, replace);
        });
        if (committed === undefined) return false;
        state.position = committed;
        state.uncertainAppend = undefined;
        state.storageFailure = undefined;
        for (const commit of prepared) {
          await commit({
            scope,
            key,
            generation: committed.generation,
            start: 0,
            end: committed.offset,
            boundaryHash: boundaryProof(committed.boundary),
            rewrite: true,
          });
        }
        return true;
      } catch (error) {
        state.storageFailure = { error };
        state.storageFailureRetriable = false;
        throw error;
      }
    });
    await this.ownFlush(scope, key, state, rewrite, { value: false });
  }

  async sealCold(scope: string, key: string, sealedCut: number, options?: ColdSealOptions): Promise<ColdSealResult> {
    const state = this.state(scope, key);
    const prior = state.flushPromise ?? state.ready;
    const priorSettled = prior.then(() => undefined, () => undefined);
    let result!: ColdSealResult;
    const operation = priorSettled.then(async () => {
      result = await sealColdSegments(this.storage, scope, key, sealedCut, options);
      return false;
    });
    await this.ownFlush(scope, key, state, operation, { value: false });
    return result;
  }

  async discardCold(scope: string, key: string): Promise<void> {
    const state = this.state(scope, key);
    const prior = state.flushPromise ?? state.ready;
    const priorSettled = prior.then(() => undefined, () => undefined);
    const operation = priorSettled.then(async () => {
      await discardColdSegments(this.storage, scope, key);
      return false;
    });
    await this.ownFlush(scope, key, state, operation, { value: false });
  }

  async flush(...target: [] | [scope: string, key: string]): Promise<void> {
    if (target.length === 2) {
      const [scope, key] = target;
      const state = this.logs.get(logId(scope, key));
      if (state === undefined) return;
      await this.flushState(scope, key, state, false, true);
      return;
    }
    const inFlight = [...this.logs.entries()].map(([id, state]) => {
      const { scope, key } = fromLogId(id);
      return this.flushState(scope, key, state, false, true);
    });
    const settled = await Promise.allSettled(inFlight);
    for (const result of settled) {
      if (result.status === 'rejected') throw result.reason;
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  drainRetirements(): Promise<void> {
    return drainAppendLogRetirements();
  }

  acquire(scope: string, key: string): IDisposable {
    const state = this.state(scope, key);
    state.refCount++;
    return toDisposable(() => {
      this.release(scope, key, state);
    });
  }

  private state(scope: string, key: string): LogState {
    const id = logId(scope, key);
    let state = this.logs.get(id);
    if (state === undefined || state.retired) {
      const ready = state?.retirement ?? Promise.resolve();
      state = {
        pending: [],
        flushPromise: undefined,
        flushScheduled: false,
        storageFailure: undefined,
        storageFailureRetriable: false,
        cutoverEpoch: 0,
        refCount: 0,
        retired: false,
        ready,
        retirement: undefined,
      };
      this.logs.set(id, state);
    }
    return state;
  }

  private scheduleFlush(scope: string, key: string, state: LogState): void {
    if (state.flushScheduled || state.flushPromise !== undefined) return;
    state.flushScheduled = true;
    queueMicrotask(() => {
      state.flushScheduled = false;
      void this.flushState(scope, key, state).catch((error) => state.onError?.(error));
    });
  }

  private flushLog(scope: string, key: string): Promise<void> {
    const state = this.state(scope, key);
    return this.flushState(scope, key, state, false, true);
  }

  private flushState(scope: string, key: string, state: LogState, retryFailure = false, recoverFailure = false): Promise<void> {
    if (state.flushPromise !== undefined) return state.flushPromise;
    if (state.uncertainAppend !== undefined) {
      if (!recoverFailure) return Promise.reject(state.storageFailure?.error);
      const wroteBox = { value: false };
      return this.ownFlush(scope, key, state, this.recoverAppend(scope, key, state), wroteBox);
    }
    if (!retryFailure && state.storageFailure !== undefined) {
      const failure = state.storageFailure.error;
      if ((!isUncommittedTransientAppend(failure) && !(recoverFailure && appendCommitted(failure) === false)) || state.pending.length === 0) {
        return Promise.reject(failure);
      }
      state.storageFailure = undefined;
      state.storageFailureRetriable = false;
    }
    const wroteBox = { value: false };
    return this.ownFlush(
      scope,
      key,
      state,
      this.drain(scope, key, state, wroteBox, retryFailure),
      wroteBox,
    );
  }

  private async recoverAppend(scope: string, key: string, state: LogState): Promise<boolean> {
    const pending = state.uncertainAppend!;
    const { start, encoded } = pending;
    try {
      const [generation, size] = await Promise.all([this.readGeneration(scope, key), this.storage.size(scope, key)]);
      const end = size ?? 0;
      const from = start.offset - start.boundary.byteLength;
      const mismatch = (): StorageError => new StorageError(StorageErrors.codes.STORAGE_CORRUPTED,
        'Append recovery found changed journal bytes. Preserve the journal and inspect it before continuing.',
        { cause: state.storageFailure?.error, details: { scope, key, expectedOffset: start.offset, actualSize: end, recovery: 'journal_mismatch' } });
      if (generation !== start.generation || end < start.offset || end > start.offset + encoded.byteLength) throw mismatch();
      const chunks: Uint8Array[] = [];
      if (end > from) {
        for await (const chunk of readLogicalBytes(this.storage, scope, key, { start: from, end: end - 1 })) chunks.push(chunk);
      }
      const existing = Buffer.concat(chunks);
      const written = end - start.offset;
      if (existing.byteLength !== end - from ||
        !existing.subarray(0, start.boundary.byteLength).equals(start.boundary) ||
        !existing.subarray(start.boundary.byteLength).equals(encoded.subarray(0, written))) throw mismatch();
      await this.appendObserved(scope, key, state, encoded.subarray(written));
      await this.publishAppend(scope, key, state, start, encoded, pending.prepared);
      state.pending.splice(0, pending.count);
      state.uncertainAppend = undefined;
      state.storageFailure = undefined;
      state.storageFailureRetriable = false;
      return true;
    } catch (error) {
      state.storageFailure = { error };
      state.storageFailureRetriable = false;
      throw error;
    }
  }

  private async publishAppend(scope: string, key: string, state: LogState, start: AppendPosition, encoded: Uint8Array,
    prepared: readonly ((position: AppendLogCommit) => Promise<void>)[]): Promise<void> {
    const boundary = encoded.byteLength >= 4096
      ? encoded.slice(-4096)
      : Buffer.concat([start.boundary.slice(Math.max(0, start.boundary.byteLength + encoded.byteLength - 4096)), encoded]);
    state.position = { generation: start.generation, offset: start.offset + encoded.byteLength, boundary };
    if (prepared.length === 0) return;
    const boundaryHash = boundaryProof(boundary);
    for (const commit of prepared) await commit({ scope, key, generation: start.generation, start: start.offset, end: state.position.offset, boundaryHash, rewrite: false });
  }

  private release(scope: string, key: string, state: LogState): void {
    state.refCount--;
    if (state.refCount > 0) return;
    state.retired = true;
    const retirement = this.settleRetiredState(scope, key, state).catch((error) => {
      if (state.onError !== undefined) state.onError(error);
      else onUnexpectedError(error);
    });
    state.retirement = retirement;
    pendingRetirements.add(retirement);
    void retirement.finally(() => pendingRetirements.delete(retirement));
  }

  private async settleRetiredState(scope: string, key: string, state: LogState): Promise<void> {
    try {
      await this.flushState(scope, key, state);
    } finally {
      const id = logId(scope, key);
      if (this.logs.get(id) === state) this.logs.delete(id);
    }
  }

  private ownFlush(
    scope: string,
    key: string,
    state: LogState,
    operation: Promise<boolean>,
    wroteBox: { value: boolean },
  ): Promise<void> {
    let owned!: Promise<void>;
    owned = this.finishOwnedFlush(scope, key, state, operation, wroteBox, () => owned);
    state.flushPromise = owned;
    return owned;
  }

  private async finishOwnedFlush(
    scope: string,
    key: string,
    state: LogState,
    operation: Promise<boolean>,
    wroteBox: { value: boolean },
    owner: () => Promise<void>,
  ): Promise<void> {
    let failure: { readonly error: unknown } | undefined;
    try {
      if (await operation) wroteBox.value = true;
      const owned = owner();
      if (state.flushPromise === owned) {
        while (state.flushPromise === owned && state.pending.length > 0) {
          await this.drain(scope, key, state, wroteBox);
        }
      }
    } catch (error) {
      failure ??= { error };
    } finally {
      const owned = owner();
      if (state.flushPromise === owned) {
        state.flushPromise = undefined;
      }
    }
    if (failure !== undefined) {
      const mayRetryQueuedTurns =
        state.storageFailureRetriable && state.pending.length > 0;
      if (mayRetryQueuedTurns) {
        state.storageFailureRetriable = false;
        queueMicrotask(() => {
          state.storageFailure = undefined;
          void this.flushState(scope, key, state, true).catch((error) => state.onError?.(error));
        });
      }
    }
    if (wroteBox.value) this.writeEmitter.fire({ scope, key });
    if (failure !== undefined) throw failure.error;
  }

  private async drain(
    scope: string,
    key: string,
    state: LogState,
    wroteBox?: { value: boolean },
    isRetry = false,
  ): Promise<boolean> {
    const cutoverEpoch = state.cutoverEpoch;
    await state.ready;
    if (state.cutoverEpoch !== cutoverEpoch) return false;
    let wrote = false;
    while (state.pending.length > 0) {
      const { batch, encoded } = takeEncodedBatch(state.pending);
      const prepared = this.prepareProjections(scope, key, batch.map((entry) => entry.record));
      if (state.position === undefined) {
        try {
          const [generation, size] = await Promise.all([this.readGeneration(scope, key), this.storage.size(scope, key)]);
          const offset = size ?? 0;
          const chunks: Uint8Array[] = [];
          if (offset > 0) for await (const chunk of readLogicalBytes(this.storage, scope, key, { start: Math.max(0, offset - 4096), end: offset - 1 })) chunks.push(chunk);
          state.position = { generation, offset, boundary: Buffer.concat(chunks) };
        } catch {
          prepared.length = 0;
        }
      }
      const start = state.position;
      try {
        await this.appendObserved(scope, key, state, encoded);
        wrote = true;
        if (wroteBox !== undefined) wroteBox.value = true;
      } catch (error) {
        state.position = undefined;
        if (appendCommitted(error) === true && start !== undefined) {
          state.uncertainAppend = { start, encoded, count: batch.length, prepared };
        }
        state.storageFailure ??= { error };
        state.storageFailureRetriable = mayRetryAppendFailure(state.storageFailure.error, isRetry);
        throw state.storageFailure.error;
      }
      if (start !== undefined) await this.publishAppend(scope, key, state, start, encoded, prepared);
      if (state.cutoverEpoch !== cutoverEpoch) return wrote;
      state.pending.splice(0, batch.length);
    }
    return wrote;
  }
}

function boundaryProof(bytes: Uint8Array): string {
  return bytes.byteLength === 0 ? '' : createHash('sha256').update(bytes).digest('base64url');
}

function logId(scope: string, key: string): string {
  return `${scope}\n${key}`;
}

function fromLogId(id: string): { scope: string; key: string } {
  const index = id.indexOf('\n');
  return { scope: id.slice(0, index), key: id.slice(index + 1) };
}

function plainUint8Array(bytes: Uint8Array): Uint8Array {
  return Buffer.isBuffer(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : bytes;
}

function takeEncodedBatch(pending: readonly PendingAppendEntry[]): {
  readonly batch: readonly PendingAppendEntry[];
  readonly encoded: Uint8Array;
} {
  const batch: PendingAppendEntry[] = [];
  const lines: Uint8Array[] = [];
  let totalBytes = 0;
  for (const entry of pending) {
    const raw = entry.encodedLine ?? (entry.encodedLine = textEncoder.encode(`${JSON.stringify(entry.record)}\n`));
    const line = plainUint8Array(raw);
    entry.encodedLine = line;
    if (batch.length > 0 && totalBytes + line.byteLength > MAX_APPEND_BATCH_BYTES) break;
    batch.push(entry);
    lines.push(line);
    totalBytes += line.byteLength;
  }
  if (lines.length === 1) {
    return { batch, encoded: lines[0]! };
  }
  const encoded = new Uint8Array(totalBytes);
  let offset = 0;
  for (const line of lines) {
    encoded.set(line, offset);
    offset += line.byteLength;
  }
  return { batch, encoded };
}

function containsRawSubstring(buf: Buffer, start: number, end: number, needles: readonly Buffer[]): boolean {
  const view = start === 0 && end === buf.byteLength ? buf : buf.subarray(start, end);
  for (let i = 0; i < needles.length; i++) {
    if (view.includes(needles[i]!)) return true;
  }
  return false;
}

function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

registerScopedService(
  LifecycleScope.App,
  IAppendLogStore,
  AppendLogStore,
  ScopeActivation.OnScopeCreated,
  'storage',
);
