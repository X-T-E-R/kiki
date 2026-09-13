import { open } from 'node:fs/promises';

import type { ContextRecord } from '@kiki/transcript-live';

export interface BoundedWireScanOptions {
  readonly maxBytes: number;
  readonly chunkBytes?: number;
  readonly onRead?: (bytes: number) => void;
  readonly onRecord: (record: ContextRecord, lineNumber: number) => void;
}

export async function readWireRecordsBounded(
  wirePath: string,
  fileSize: number,
  options: BoundedWireScanOptions,
): Promise<number> {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
    throw new Error(`wire.jsonl: invalid size for ${wirePath}`);
  }
  if (fileSize > options.maxBytes) {
    throw new Error(`wire.jsonl: bounded read exceeds budget for ${wirePath}`);
  }
  const chunkBytes = Math.max(1, Math.floor(options.chunkBytes ?? 64 * 1024));
  const handle = await open(wirePath, 'r');
  let position = 0;
  let pending = Buffer.alloc(0);
  let lineNumber = 0;
  try {
    while (position < fileSize) {
      const length = Math.min(chunkBytes, fileSize - position);
      const chunk = Buffer.allocUnsafe(length);
      const result = await handle.read(chunk, 0, length, position);
      if (result.bytesRead === 0) {
        throw new Error(`wire.jsonl: file changed during bounded read for ${wirePath}`);
      }
      position += result.bytesRead;
      options.onRead?.(result.bytesRead);
      const readChunk = chunk.subarray(0, result.bytesRead);
      pending = pending.length === 0 ? readChunk : Buffer.concat([pending, readChunk]);
      for (;;) {
        const newline = pending.indexOf(0x0a);
        if (newline < 0) break;
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        lineNumber += 1;
        parseLine(wirePath, line, lineNumber, options.onRecord);
      }
    }
    if (pending.length > 0) {
      lineNumber += 1;
      parseLine(wirePath, pending, lineNumber, options.onRecord);
    }
    if (position !== fileSize) {
      throw new Error(`wire.jsonl: file changed during bounded read for ${wirePath}`);
    }
    return position;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseLine(
  wirePath: string,
  line: Buffer,
  lineNumber: number,
  onRecord: (record: ContextRecord, lineNumber: number) => void,
): void {
  const normalized = line.length > 0 && line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
  if (normalized.length === 0) return;
  let record: unknown;
  try {
    record = JSON.parse(normalized.toString('utf8'));
  } catch (error) {
    throw new Error(
      `wire.jsonl: corrupted line ${lineNumber} in ${wirePath}: ${String(error)}`,
      { cause: error },
    );
  }
  if (record === null || typeof record !== 'object' || typeof (record as { type?: unknown }).type !== 'string') {
    throw new Error(`wire.jsonl: invalid record line ${lineNumber} in ${wirePath}`);
  }
  onRecord(record as ContextRecord, lineNumber);
}
