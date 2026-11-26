import { serialize } from 'node:v8';
import type { MessagePort } from 'node:worker_threads';
import { BugIndicatingError } from '#/_base/errors/errors';
import { WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';
import { decodeWireInput } from './wireTask';

const MAX_BATCH_BYTES = 256 * 1024;
const MAX_BATCH_RECORDS = 256;

export interface WireParseJournalSliceOperation {
  readonly type: 'wire.parseJournalSlice';
  readonly chunks: readonly ArrayBuffer[];
  readonly startByteOffset: number;
  readonly startLineNumber: number;
  readonly isEof: boolean;
  readonly requireTrailingNewline: boolean;
  readonly compactReplayPayloads?: boolean;
}

export interface WireParseJournalStreamOperation {
  readonly type: 'wire.parseJournalStream';
  readonly input: MessagePort;
  readonly startByteOffset: number;
  readonly byteLength: number;
  readonly lineNumber: number;
  readonly unterminatedEof: boolean;
  readonly requireTrailingNewline: boolean;
  readonly compactReplayPayloads?: boolean;
}

export interface ParsedJournalRecordEntry {
  readonly record: unknown;
  readonly endByteOffset: number;
  readonly newlineTerminated: boolean;
}

export interface WireParseJournalFailure {
  readonly lineNumber: number;
  readonly message: string;
  readonly unterminatedEof: boolean;
}

export interface WireParseJournalResult {
  readonly batches: readonly ArrayBuffer[];
  readonly endByteOffset: number;
  readonly nextLineNumber: number;
  readonly failure?: WireParseJournalFailure;
}

function isValidLlmToolEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const candidate = entry as Record<string, unknown>;
  const params = candidate['parameters'];
  return (
    typeof candidate['name'] === 'string' &&
    typeof candidate['description'] === 'string' &&
    params !== null &&
    typeof params === 'object' &&
    !Array.isArray(params)
  );
}

function compactRecordForReplay(parsed: unknown, enabled: boolean): { readonly value: unknown; readonly compacted: boolean } {
  if (!enabled || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: parsed, compacted: false };
  }
  const record = parsed as Record<string, unknown>;
  if (
    record['type'] === 'llm.tools_snapshot' &&
    typeof record['hash'] === 'string' &&
    Array.isArray(record['tools']) &&
    record['tools'].length > 0 &&
    record['tools'].every(isValidLlmToolEntry)
  ) {
    return { value: { ...record, tools: [] }, compacted: true };
  }
  if (
    record['type'] === 'llm.request' &&
    typeof record['systemPrompt'] === 'string' &&
    record['systemPrompt'].length > 1
  ) {
    return { value: { ...record, systemPrompt: '1' }, compacted: true };
  }
  return { value: parsed, compacted: false };
}

function serializeBatch(entries: readonly ParsedJournalRecordEntry[]): ArrayBuffer {
  const encoded = serialize(entries);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

export function executeWireParseJournalSlice(
  operation: WireParseJournalSliceOperation,
  signal?: AbortSignal,
): WireParseJournalResult {
  signal?.throwIfAborted();
  const decoder = new TextDecoder();
  const batches: ArrayBuffer[] = [];
  let currentBatch: ParsedJournalRecordEntry[] = [];
  let currentBatchBytes = 0;
  let pendingParts: Uint8Array[] = [];
  let pendingBytes = 0;
  let byteOffset = operation.startByteOffset;
  let lineNumber = operation.startLineNumber;
  let compact = operation.compactReplayPayloads === true;
  let checkedInitialHeader = operation.startByteOffset > 0 || operation.startLineNumber > 0;

  const flushBatch = (): void => {
    if (currentBatch.length === 0) return;
    batches.push(serializeBatch(currentBatch));
    currentBatch = [];
    currentBatchBytes = 0;
  };

  const pushParsedLine = (
    rawBytes: Uint8Array,
    consumedBytes: number,
    newlineTerminated: boolean,
  ): WireParseJournalFailure | undefined => {
    lineNumber += 1;
    if ((lineNumber & 63) === 0) signal?.throwIfAborted();
    const trimmedLen =
      rawBytes.byteLength > 0 && rawBytes[rawBytes.byteLength - 1] === 0x0d
        ? rawBytes.byteLength - 1
        : rawBytes.byteLength;
    if (trimmedLen === 0) {
      byteOffset += consumedBytes;
      return undefined;
    }
    const line = decoder.decode(rawBytes.subarray(0, trimmedLen));
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      return {
        lineNumber,
        message: error instanceof Error ? error.message : String(error),
        unterminatedEof: !newlineTerminated,
      };
    }
    byteOffset += consumedBytes;
    if (!checkedInitialHeader) {
      checkedInitialHeader = true;
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>)['type'] === 'metadata' &&
        (parsed as Record<string, unknown>)['protocol_version'] === WIRE_PROTOCOL_VERSION
      ) {
        compact = true;
      }
    }
    const { value, compacted } = compactRecordForReplay(parsed, compact);
    currentBatch.push({
      record: value,
      endByteOffset: byteOffset,
      newlineTerminated,
    });
    currentBatchBytes += (compacted ? 128 : Math.min(trimmedLen, MAX_BATCH_BYTES)) + 64;
    if (currentBatchBytes >= MAX_BATCH_BYTES || currentBatch.length >= MAX_BATCH_RECORDS) {
      flushBatch();
    }
    return undefined;
  };

  for (const buffer of operation.chunks) {
    signal?.throwIfAborted();
    const chunk = new Uint8Array(buffer);
    let cursor = 0;
    if (pendingBytes > 0) {
      const firstNewline = chunk.indexOf(0x0a, 0);
      if (firstNewline === -1) {
        pendingParts.push(chunk);
        pendingBytes += chunk.byteLength;
        continue;
      }
      const head = chunk.subarray(0, firstNewline);
      const totalLineBytes = pendingBytes + head.byteLength + 1;
      pendingParts.push(head);
      const merged = Buffer.concat(pendingParts, pendingBytes + head.byteLength);
      pendingParts = [];
      pendingBytes = 0;
      cursor = firstNewline + 1;
      const failure = pushParsedLine(merged, totalLineBytes, true);
      if (failure !== undefined) {
        flushBatch();
        return { batches, endByteOffset: byteOffset, nextLineNumber: lineNumber, failure };
      }
    }
    let newline = chunk.indexOf(0x0a, cursor);
    while (newline !== -1) {
      const lineBytes = newline - cursor + 1;
      const rawLine = chunk.subarray(cursor, newline);
      cursor = newline + 1;
      const failure = pushParsedLine(rawLine, lineBytes, true);
      if (failure !== undefined) {
        flushBatch();
        return { batches, endByteOffset: byteOffset, nextLineNumber: lineNumber, failure };
      }
      newline = chunk.indexOf(0x0a, cursor);
    }
    if (cursor < chunk.byteLength) {
      const tail = chunk.subarray(cursor);
      pendingParts.push(tail);
      pendingBytes += tail.byteLength;
    }
  }

  if (pendingBytes > 0) {
    if (!operation.isEof) {
      throw new BugIndicatingError('Non-EOF journal slice ended with an unterminated line');
    }
    if (operation.requireTrailingNewline) {
      flushBatch();
      return {
        batches,
        endByteOffset: byteOffset,
        nextLineNumber: lineNumber + 1,
        failure: {
          lineNumber: lineNumber + 1,
          message: 'Unterminated journal tail line',
          unterminatedEof: true,
        },
      };
    }
    const merged = pendingParts.length === 1
      ? pendingParts[0]!
      : Buffer.concat(pendingParts, pendingBytes);
    const failure = pushParsedLine(merged, pendingBytes, false);
    if (failure !== undefined) {
      flushBatch();
      return { batches, endByteOffset: byteOffset, nextLineNumber: lineNumber, failure };
    }
  }

  signal?.throwIfAborted();
  flushBatch();
  return { batches, endByteOffset: byteOffset, nextLineNumber: lineNumber };
}

export async function executeWireParseJournalStream(
  operation: WireParseJournalStreamOperation,
  signal?: AbortSignal,
): Promise<WireParseJournalResult> {
  signal?.throwIfAborted();
  if (operation.unterminatedEof && operation.requireTrailingNewline) {
    operation.input.close();
    return {
      batches: [],
      endByteOffset: operation.startByteOffset,
      nextLineNumber: operation.lineNumber,
      failure: {
        lineNumber: operation.lineNumber,
        message: 'Unterminated journal tail line',
        unterminatedEof: true,
      },
    };
  }
  const textParts: string[] = [];
  for await (const chunk of decodeWireInput(operation.input, signal)) {
    signal?.throwIfAborted();
    textParts.push(chunk);
  }
  signal?.throwIfAborted();
  let raw = textParts.join('');
  if (raw.endsWith('\n')) raw = raw.slice(0, -1);
  if (raw.endsWith('\r')) raw = raw.slice(0, -1);
  if (raw.length === 0) {
    return {
      batches: [],
      endByteOffset: operation.startByteOffset + operation.byteLength,
      nextLineNumber: operation.lineNumber,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      batches: [],
      endByteOffset: operation.startByteOffset,
      nextLineNumber: operation.lineNumber,
      failure: {
        lineNumber: operation.lineNumber,
        message: error instanceof Error ? error.message : String(error),
        unterminatedEof: operation.unterminatedEof,
      },
    };
  }
  const endByteOffset = operation.startByteOffset + operation.byteLength;
  const { value } = compactRecordForReplay(parsed, operation.compactReplayPayloads === true);
  return {
    batches: [serializeBatch([{
      record: value,
      endByteOffset,
      newlineTerminated: !operation.unterminatedEof,
    }])],
    endByteOffset,
    nextLineNumber: operation.lineNumber,
  };
}
