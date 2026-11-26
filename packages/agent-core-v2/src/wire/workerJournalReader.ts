import { deserialize } from 'node:v8';
import { runCpuStream, type CpuExecutor } from '#/app/cpuWorker/stream';
import type {
  ParsedJournalRecordEntry,
  WireParseJournalFailure,
  WireParseJournalResult,
} from '#/app/cpuWorker/wireJournalTask';
import { readLogicalBytes } from '#/persistence/coldSegmentLog';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';

export const WORKER_JOURNAL_REPLAY_MIN_BYTES = 256 * 1024;
const TARGET_SLICE_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_LINE_BYTES = 16 * 1024 * 1024;
const MAX_PIPELINED_SLICES = 2;

export interface WorkerJournalBatchChunk {
  readonly entries: readonly ParsedJournalRecordEntry[];
}

export interface WorkerJournalStreamHandlers {
  readonly requireTrailingNewline: boolean;
  readonly canCompactPayloads: () => boolean;
  readonly onFailure?: (failure: WireParseJournalFailure) => void;
}

function countNewlines(bytes: Uint8Array): number {
  let count = 0;
  let index = bytes.indexOf(0x0a, 0);
  while (index !== -1) {
    count += 1;
    index = bytes.indexOf(0x0a, index + 1);
  }
  return count;
}

function detachSliceBuffers(parts: readonly Uint8Array[]): {
  readonly buffers: ArrayBuffer[];
  readonly totalBytes: number;
  readonly newlineCount: number;
} {
  const buffers: ArrayBuffer[] = [];
  let totalBytes = 0;
  let newlineCount = 0;
  for (const part of parts) {
    if (part.byteLength === 0) continue;
    totalBytes += part.byteLength;
    newlineCount += countNewlines(part);
    const copy = new Uint8Array(part.byteLength);
    copy.set(part);
    buffers.push(copy.buffer);
  }
  return { buffers, totalBytes, newlineCount };
}

function decodeSingleBatch(buffer: ArrayBuffer): WorkerJournalBatchChunk {
  return {
    entries: deserialize(Buffer.from(buffer)) as readonly ParsedJournalRecordEntry[],
  };
}

/** Streams logical wire bytes through the CPU worker pool in newline-aligned windows and yields decoded sub-batches. */
export async function* readWorkerJournalBatches(
  execute: CpuExecutor,
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  startOffset: number,
  endOffset: number,
  handlers: WorkerJournalStreamHandlers,
  signal?: AbortSignal,
): AsyncIterable<WorkerJournalBatchChunk> {
  signal?.throwIfAborted();
  if (startOffset >= endOffset) return;

  const inFlight: Promise<WireParseJournalResult>[] = [];
  let buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let nextByteOffset = startOffset;
  let nextLineNumber = 0;
  let firstSliceDispatched = false;
  let stoppedOnFailure = false;

  const dispatchSlice = (parts: readonly Uint8Array[], isEof: boolean): void => {
    const { buffers, totalBytes, newlineCount } = detachSliceBuffers(parts);
    if (totalBytes === 0) return;
    const sliceStartByte = nextByteOffset;
    const sliceStartLine = nextLineNumber;
    nextByteOffset += totalBytes;
    nextLineNumber += newlineCount;
    const compactReplayPayloads =
      (startOffset > 0 || firstSliceDispatched) && handlers.canCompactPayloads();
    firstSliceDispatched = true;
    const promise = execute<WireParseJournalResult>(
      {
        type: 'wire.parseJournalSlice',
        chunks: buffers,
        startByteOffset: sliceStartByte,
        startLineNumber: sliceStartLine,
        isEof,
        requireTrailingNewline: handlers.requireTrailingNewline,
        compactReplayPayloads,
      },
      {
        signal,
        transferList: buffers,
        bytes: totalBytes,
        priority: 'high',
      },
    );
    void promise.catch(() => {});
    inFlight.push(promise);
  };

  const drainOne = async function* (): AsyncIterable<WorkerJournalBatchChunk> {
    const next = inFlight.shift();
    if (next === undefined) return;
    const result = await next;
    signal?.throwIfAborted();
    for (const buffer of result.batches) {
      signal?.throwIfAborted();
      yield decodeSingleBatch(buffer);
    }
    if (result.failure !== undefined) {
      stoppedOnFailure = true;
      handlers.onFailure?.(result.failure);
    }
  };

  const iterator = readLogicalBytes(
    storage,
    scope,
    key,
    { start: startOffset, end: endOffset - 1 },
    { signal, chunkBytes: 1024 * 1024 },
  )[Symbol.asyncIterator]();

  try {
    while (!stoppedOnFailure) {
      signal?.throwIfAborted();
      const step = await iterator.next();
      signal?.throwIfAborted();
      if (step.done) break;
      const chunk = step.value;
      if (chunk.byteLength === 0) continue;

      const candidateTotal = bufferedBytes + chunk.byteLength;
      if (candidateTotal >= TARGET_SLICE_BYTES || !firstSliceDispatched) {
        const lastNewline = chunk.lastIndexOf(0x0a);
        if (lastNewline !== -1) {
          const headLen = lastNewline + 1;
          const tail = headLen < chunk.byteLength ? Uint8Array.from(chunk.subarray(headLen)) : undefined;
          const head = headLen === chunk.byteLength ? chunk : chunk.subarray(0, headLen);
          const sliceParts = buffered.length === 0 ? [head] : [...buffered, head];
          buffered = tail === undefined ? [] : [tail];
          bufferedBytes = tail?.byteLength ?? 0;
          const allowPipeline = firstSliceDispatched && handlers.canCompactPayloads();
          dispatchSlice(sliceParts, false);
          while (inFlight.length >= (allowPipeline ? MAX_PIPELINED_SLICES : 1)) {
            yield* drainOne();
            if (stoppedOnFailure) break;
          }
          continue;
        }
      }

      buffered.push(Uint8Array.from(chunk));
      bufferedBytes += chunk.byteLength;

      if (bufferedBytes >= MAX_BUFFERED_LINE_BYTES) {
        while (inFlight.length > 0 && !stoppedOnFailure) {
          yield* drainOne();
        }
        if (stoppedOnFailure) break;

        const streamParts: Uint8Array[] = buffered.splice(0);
        let streamByteLength = bufferedBytes;
        bufferedBytes = 0;
        let sawTerminator = false;
        let leftover: Uint8Array | undefined;

        const streamResult = await runCpuStream<WireParseJournalResult>(
          execute,
          {
            type: 'wire.parseJournalStream',
            startByteOffset: nextByteOffset,
            byteLength: 0,
            lineNumber: nextLineNumber + 1,
            unterminatedEof: false,
            requireTrailingNewline: handlers.requireTrailingNewline,
            compactReplayPayloads:
              (startOffset > 0 || firstSliceDispatched) && handlers.canCompactPayloads(),
          },
          async function* (streamSignal) {
            for (const prefix of streamParts) {
              streamSignal.throwIfAborted();
              yield prefix;
            }
            while (!sawTerminator) {
              streamSignal.throwIfAborted();
              const more = await iterator.next();
              streamSignal.throwIfAborted();
              if (more.done) break;
              if (more.value.byteLength === 0) continue;
              const nl = more.value.indexOf(0x0a);
              if (nl !== -1) {
                sawTerminator = true;
                const head = more.value.subarray(0, nl + 1);
                if (nl + 1 < more.value.byteLength) {
                  leftover = Uint8Array.from(more.value.subarray(nl + 1));
                }
                streamByteLength += head.byteLength;
                yield head;
                break;
              }
              streamByteLength += more.value.byteLength;
              yield more.value;
            }
          },
          signal,
        );
        firstSliceDispatched = true;
        if (leftover !== undefined) {
          buffered = [leftover];
          bufferedBytes = leftover.byteLength;
        }
        if (!sawTerminator && handlers.requireTrailingNewline) {
          stoppedOnFailure = true;
          handlers.onFailure?.({
            lineNumber: nextLineNumber + 1,
            message: 'Unterminated journal tail line',
            unterminatedEof: true,
          });
          break;
        }
        const resolvedEnd = nextByteOffset + streamByteLength;
        nextByteOffset = resolvedEnd;
        nextLineNumber += 1;
        if (streamResult.failure !== undefined) {
          stoppedOnFailure = true;
          handlers.onFailure?.({
            ...streamResult.failure,
            unterminatedEof: !sawTerminator,
          });
          break;
        }
        for (const buffer of streamResult.batches) {
          const batch = decodeSingleBatch(buffer);
          yield {
            entries: batch.entries.map((entry) => ({
              ...entry,
              endByteOffset: resolvedEnd,
              newlineTerminated: sawTerminator,
            })),
          };
        }
      }
    }

    if (!stoppedOnFailure && bufferedBytes > 0) {
      const finalParts = buffered.splice(0);
      bufferedBytes = 0;
      dispatchSlice(finalParts, true);
    }

    while (inFlight.length > 0 && !stoppedOnFailure) {
      yield* drainOne();
    }
  } finally {
    await iterator.return?.();
  }
}
