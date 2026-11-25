import { open } from 'node:fs/promises';

import type { ContextRecord } from '@kiki/transcript-live';

import { openLogicalWire } from '../history/logicalWireRead';
import { WIRE_YIELD_BUDGET_MS } from './prefixWitness';

export interface BoundedWireScanOptions {
  readonly maxBytes: number;
  readonly chunkBytes?: number;
  readonly decodeRecord?: (line: Buffer) => ContextRecord | undefined;
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
  const opened = await openLogicalWire(wirePath);
  const handle = opened === undefined ? await open(wirePath, 'r') : undefined;
  let position = 0;
  let pendingChunks: Buffer[] = [];
  let pendingBytes = 0;
  let lineNumber = 0;
  let yieldedAt = performance.now();
  try {
    while (position < fileSize) {
      const length = Math.min(chunkBytes, fileSize - position);
      const chunk = Buffer.allocUnsafe(length);
      let read: number;
      if (opened !== undefined) {
        const bytes = await opened.readAt(position, length);
        read = Math.min(bytes.byteLength, length);
        chunk.set(bytes.subarray(0, read));
      } else {
        read = (await handle!.read(chunk, 0, length, position)).bytesRead;
      }
      const readChunk = chunk.subarray(0, read);
      if (read === 0) {
        throw new Error(`wire.jsonl: file changed during bounded read for ${wirePath}`);
      }
      position += read;
      options.onRead?.(read);
      let scanStart = 0;
      for (;;) {
        const newline = readChunk.indexOf(0x0a, scanStart);
        if (newline < 0) break;
        const segment = readChunk.subarray(scanStart, newline);
        scanStart = newline + 1;
        let line: Buffer;
        if (pendingChunks.length === 0) {
          line = segment;
        } else {
          if (segment.length > 0) {
            pendingChunks.push(segment);
            pendingBytes += segment.length;
          }
          line = pendingChunks.length === 1 ? pendingChunks[0]! : Buffer.concat(pendingChunks, pendingBytes);
          pendingChunks = [];
          pendingBytes = 0;
        }
        lineNumber += 1;
        parseLine(wirePath, line, lineNumber, options.onRecord, options.decodeRecord);
        if (performance.now() - yieldedAt >= WIRE_YIELD_BUDGET_MS) {
          await new Promise<void>((resolve) => { setImmediate(resolve); });
          yieldedAt = performance.now();
        }
      }
      if (scanStart < readChunk.length) {
        const tail = readChunk.subarray(scanStart);
        pendingChunks.push(tail);
        pendingBytes += tail.length;
      }
      if (performance.now() - yieldedAt >= WIRE_YIELD_BUDGET_MS) {
        await new Promise<void>((resolve) => { setImmediate(resolve); });
        yieldedAt = performance.now();
      }
    }
    if (pendingBytes > 0) {
      const finalLine = pendingChunks.length === 1 ? pendingChunks[0]! : Buffer.concat(pendingChunks, pendingBytes);
      pendingChunks = [];
      pendingBytes = 0;
      lineNumber += 1;
      parseLine(wirePath, finalLine, lineNumber, options.onRecord, options.decodeRecord);
    }
    if (position !== fileSize) {
      throw new Error(`wire.jsonl: file changed during bounded read for ${wirePath}`);
    }
    return position;
  } finally {
    opened?.close();
    await handle?.close().catch(() => undefined);
  }
}

function parseLine(
  wirePath: string,
  line: Buffer,
  lineNumber: number,
  onRecord: (record: ContextRecord, lineNumber: number) => void,
  decodeRecord?: (line: Buffer) => ContextRecord | undefined,
): void {
  const normalized = line.length > 0 && line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
  if (normalized.length === 0) return;
  const predecoded = decodeRecord?.(normalized);
  if (predecoded !== undefined) {
    onRecord(predecoded, lineNumber);
    return;
  }
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
