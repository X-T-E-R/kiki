import { open } from 'node:fs/promises';

export interface ContextRecord {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface WireRecordsReadResult {
  readonly records: ContextRecord[];
  readonly complete: boolean;
}

export type WireRecordsIncompleteReason = 'byte_budget' | 'record_budget' | 'line_budget' | 'partial_tail';

export interface WireRecordsStreamOptions {
  readonly chunkBytes?: number;
  readonly maxBytes?: number;
  readonly maxRecords?: number;
  readonly maxLineBytes?: number;
  readonly startByteOffset?: number;
  readonly signal?: AbortSignal;
  readonly onRecord: (record: ContextRecord) => void;
}

export interface WireRecordsStreamResult {
  readonly recordCount: number;
  readonly bytesRead: number;
  readonly nextByteOffset: number;
  readonly complete: boolean;
  readonly incompleteReason?: WireRecordsIncompleteReason;
}

export const WIRE_READ_CHUNK_BYTES = 1 << 20;
export const WIRE_COLD_READ_MAX_BYTES = 1 << 30;
export const WIRE_COLD_READ_MAX_RECORDS = 2_000_000;
export const WIRE_COLD_READ_MAX_LINE_BYTES = 64 << 20;

/**
 * Read one `wire.jsonl` in file order without ever holding the whole file (or
 * its line array) in memory: fixed chunks, incremental newline splitting, one
 * `JSON.parse` per record. The reader is unbounded unless a budget is passed,
 * so omitting `maxBytes` / `maxRecords` / `maxLineBytes` reads any complete
 * file like a full-file read; a tripped budget only ever cuts at a record
 * boundary and is reported through `complete` + `incompleteReason` — it never
 * throws and never delivers a partial record.
 *
 * `byte_budget`, `record_budget` and `line_budget` mean the file continues
 * beyond what was returned; `partial_tail` means the file itself ends in an
 * unterminated, unparseable record (the historical cold-read tail). The
 * `WIRE_COLD_READ_MAX_*` fences belong to the cold transcript reader: healthy
 * wires stay far below them, and that reader treats a tripped fence as a
 * failed read instead of serving a shorter history.
 */
export async function streamWireRecords(
  wirePath: string,
  options: WireRecordsStreamOptions,
): Promise<WireRecordsStreamResult> {
  const chunkBytes = positiveLimit(options.chunkBytes, WIRE_READ_CHUNK_BYTES);
  const maxBytes = optionalLimit(options.maxBytes);
  const maxRecords = optionalLimit(options.maxRecords);
  const maxLineBytes = optionalLimit(options.maxLineBytes);
  const startByteOffset = optionalLimit(options.startByteOffset) ?? 0;
  const signal = options.signal;
  let remainingBytes = maxBytes ?? Number.POSITIVE_INFINITY;
  let lineChunks: Buffer[] = [];
  let lineBytes = 0;
  let lineNumber = 0;
  let recordCount = 0;
  let bytesRead = 0;
  let nextByteOffset = startByteOffset;
  let stopped = false;
  let incompleteReason: WireRecordsIncompleteReason | undefined;

  const stop = (reason: WireRecordsIncompleteReason): void => {
    stopped = true;
    incompleteReason = reason;
    lineChunks = [];
    lineBytes = 0;
  };

  const consume = (line: Buffer, terminated: boolean): void => {
    const normalized = line.length > 0 && line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
    if (normalized.length === 0) return;
    if (maxRecords !== undefined && recordCount >= maxRecords) {
      stop('record_budget');
      return;
    }
    let record: unknown;
    try {
      record = JSON.parse(normalized.toString('utf8'));
    } catch (parseError) {
      if (terminated) {
        throw new Error(
          `wire.jsonl: corrupted line ${lineNumber} in ${wirePath}: ${String(parseError)}`,
          { cause: parseError },
        );
      }
      stop('partial_tail');
      return;
    }
    recordCount += 1;
    options.onRecord(record as ContextRecord);
    nextByteOffset += line.length + (terminated ? 1 : 0);
  };

  const mergeLine = (): Buffer => {
    const line = lineChunks.length === 1 ? lineChunks[0]! : Buffer.concat(lineChunks, lineBytes);
    lineChunks = [];
    lineBytes = 0;
    return line;
  };

  const absorb = (chunk: Buffer): void => {
    let rest = chunk;
    for (;;) {
      const newline = rest.indexOf(0x0a);
      if (newline < 0) {
        if (rest.length === 0) return;
        if (maxLineBytes !== undefined && lineBytes + rest.length > maxLineBytes) {
          stop('line_budget');
          return;
        }
        lineChunks.push(rest);
        lineBytes += rest.length;
        return;
      }
      if (newline > 0) {
        lineChunks.push(rest.subarray(0, newline));
        lineBytes += newline;
      }
      if (maxLineBytes !== undefined && lineBytes > maxLineBytes) {
        stop('line_budget');
        return;
      }
      lineNumber += 1;
      consume(mergeLine(), true);
      if (stopped) return;
      rest = rest.subarray(newline + 1);
    }
  };

  signal?.throwIfAborted();
  const handle = await open(wirePath, 'r');
  try {
    const info = await handle.stat();
    if (!Number.isSafeInteger(info.size) || info.size < 0) {
      throw new Error(`wire.jsonl: invalid size for ${wirePath}`);
    }
    const fileSize = info.size;
    if (startByteOffset > fileSize) {
      throw new Error(`wire.jsonl: start offset exceeds file size for ${wirePath}`);
    }
    let position = startByteOffset;
    while (position < fileSize) {
      if (stopped) break;
      signal?.throwIfAborted();
      if (remainingBytes <= 0) {
        stop('byte_budget');
        break;
      }
      const length = Math.min(chunkBytes, fileSize - position, remainingBytes);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead: read } = await handle.read(chunk, 0, length, position);
      if (read === 0) {
        throw new Error(`wire.jsonl: file changed during streaming read for ${wirePath}`);
      }
      position += read;
      bytesRead += read;
      remainingBytes -= read;
      absorb(chunk.subarray(0, read));
    }
    if (!stopped && lineBytes > 0) {
      lineNumber += 1;
      consume(mergeLine(), false);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return {
    recordCount,
    bytesRead,
    nextByteOffset,
    complete: incompleteReason === undefined,
    incompleteReason,
  };
}

/** Historical unbounded array read, including its partial-tail behavior. */
export async function readWireRecords(wirePath: string): Promise<ContextRecord[]> {
  return (await readWireRecordsWithCompleteness(wirePath)).records;
}

/** Unbounded array read that preserves the historical completeness contract. */
export async function readWireRecordsWithCompleteness(
  wirePath: string,
): Promise<WireRecordsReadResult> {
  const records: ContextRecord[] = [];
  const result = await streamWireRecords(wirePath, {
    onRecord: (record) => records.push(record),
  });
  return { records, complete: result.complete };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function optionalLimit(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : undefined;
}
