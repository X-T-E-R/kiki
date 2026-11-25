import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { inflateRawSync, zstdDecompressSync } from 'node:zlib';

import { StorageError, StorageErrors } from '#/persistence/interface/storage';

/** Descriptor for one sealed cold-wire segment scanned inside a CPU worker. */
export interface WireGoalScanSegment {
  readonly path: string;
  readonly logicalStart: number;
  readonly logicalEnd: number;
  readonly uncompressedSha256: string;
}

/** CPU worker operation scanning a contiguous slice of cold or dense wire bytes for goal records. */
export interface WireGoalScanOperation {
  readonly type: 'wire.goalScan';
  readonly scope: string;
  readonly key: string;
  readonly codec?: 'deflate-raw' | 'zstd';
  readonly segments?: readonly WireGoalScanSegment[];
  readonly densePath?: string;
  readonly denseStart?: number;
  readonly denseEnd?: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

/** Result returned by scanning one contiguous wire slice for goal and fork records. */
export interface WireGoalScanResult {
  readonly overflow: boolean;
  readonly hasNewline: boolean;
  readonly leading?: Uint8Array;
  readonly trailing?: Uint8Array;
  readonly matchedLines: readonly string[];
}

const GOAL_NEEDLE = Buffer.from('"goal.', 'utf8');
const FORKED_NEEDLE = Buffer.from('"forked"', 'utf8');
const DENSE_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_BOUNDARY_LINE_BYTES = 16 * 1024 * 1024;

function containsGoalNeedle(buf: Buffer): boolean {
  return buf.indexOf(GOAL_NEEDLE) !== -1 || buf.indexOf(FORKED_NEEDLE) !== -1;
}

function compressedInputLimit(outputBytes: number): number {
  return outputBytes + Math.ceil(outputBytes / 16) + 1024;
}

function corrupted(scope: string, key: string, reason: string, cause?: unknown): StorageError {
  return new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, `Cold journal cannot be read (${reason})`, {
    details: { scope, key, reason },
    cause,
  });
}

function decompressSegmentSync(
  compressed: Buffer,
  codec: 'deflate-raw' | 'zstd',
  expectedBytes: number,
  scope: string,
  key: string,
): Buffer {
  if (compressed.byteLength > compressedInputLimit(expectedBytes)) {
    throw corrupted(scope, key, 'segment');
  }
  try {
    return codec === 'zstd'
      ? zstdDecompressSync(compressed, { maxOutputLength: expectedBytes })
      : inflateRawSync(compressed, { maxOutputLength: expectedBytes });
  } catch (error) {
    throw corrupted(scope, key, 'segment', error);
  }
}

function stripTrailingCr(buf: Buffer): Buffer {
  return buf.byteLength > 0 && buf[buf.byteLength - 1] === 0x0d
    ? buf.subarray(0, buf.byteLength - 1)
    : buf;
}

/** Scans a contiguous slice of cold segments and/or dense wire bytes for lines containing goal or fork markers. */
export async function executeWireGoalScan(
  operation: WireGoalScanOperation,
  signal?: AbortSignal,
): Promise<WireGoalScanResult> {
  signal?.throwIfAborted();
  const leadingChunks: Buffer[] = [];
  let leadingBytes = 0;
  let seenNewline = false;
  let pendingChunks: Buffer[] = [];
  let pendingBytes = 0;
  const matchedLines: string[] = [];

  const feed = (buf: Buffer): boolean => {
    if (buf.byteLength === 0) return true;
    let cursor = 0;
    if (!seenNewline) {
      const firstNl = buf.indexOf(0x0a);
      if (firstNl === -1) {
        leadingBytes += buf.byteLength;
        if (leadingBytes > MAX_BOUNDARY_LINE_BYTES) return false;
        leadingChunks.push(Buffer.from(buf));
        return true;
      }
      if (firstNl > 0) {
        leadingBytes += firstNl;
        if (leadingBytes > MAX_BOUNDARY_LINE_BYTES) return false;
        leadingChunks.push(Buffer.from(buf.subarray(0, firstNl)));
      }
      seenNewline = true;
      cursor = firstNl + 1;
    }
    if (pendingBytes > 0 && cursor < buf.byteLength) {
      const nl = buf.indexOf(0x0a, cursor);
      if (nl === -1) {
        const tailLen = buf.byteLength - cursor;
        pendingBytes += tailLen;
        if (pendingBytes > MAX_BOUNDARY_LINE_BYTES) return false;
        pendingChunks.push(Buffer.from(buf.subarray(cursor)));
        return true;
      }
      const head = buf.subarray(cursor, nl);
      pendingChunks.push(head);
      const merged = Buffer.concat(pendingChunks, pendingBytes + head.byteLength);
      pendingChunks = [];
      pendingBytes = 0;
      cursor = nl + 1;
      const lineBuf = stripTrailingCr(merged);
      if (lineBuf.byteLength > 0 && containsGoalNeedle(lineBuf)) {
        matchedLines.push(lineBuf.toString('utf8'));
      }
    }
    if (cursor < buf.byteLength) {
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl >= cursor) {
        const span = buf.subarray(cursor, lastNl + 1);
        if (containsGoalNeedle(span)) {
          let lineStart = cursor;
          let nl = buf.indexOf(0x0a, lineStart);
          while (nl !== -1 && nl <= lastNl) {
            const lineBuf = stripTrailingCr(buf.subarray(lineStart, nl));
            if (lineBuf.byteLength > 0 && containsGoalNeedle(lineBuf)) {
              matchedLines.push(lineBuf.toString('utf8'));
            }
            lineStart = nl + 1;
            nl = buf.indexOf(0x0a, lineStart);
          }
        }
        cursor = lastNl + 1;
      }
      if (cursor < buf.byteLength) {
        const tailLen = buf.byteLength - cursor;
        pendingBytes += tailLen;
        if (pendingBytes > MAX_BOUNDARY_LINE_BYTES) return false;
        pendingChunks.push(Buffer.from(buf.subarray(cursor)));
      }
    }
    return true;
  };

  if (operation.segments !== undefined && operation.segments.length > 0) {
    const codec = operation.codec;
    if (codec === undefined) throw corrupted(operation.scope, operation.key, 'manifest');
    for (const seg of operation.segments) {
      signal?.throwIfAborted();
      const expected = seg.logicalEnd - seg.logicalStart;
      let compressed: Buffer;
      try {
        compressed = await readFile(seg.path);
      } catch (error) {
        throw corrupted(operation.scope, operation.key, 'segment-missing', error);
      }
      signal?.throwIfAborted();
      const plain = decompressSegmentSync(compressed, codec, expected, operation.scope, operation.key);
      if (plain.byteLength !== expected || createHash('sha256').update(plain).digest('hex') !== seg.uncompressedSha256) {
        throw corrupted(operation.scope, operation.key, 'segment');
      }
      const localStart = Math.max(0, operation.startOffset - seg.logicalStart);
      const localEnd = Math.min(plain.byteLength, operation.endOffset - seg.logicalStart);
      if (localEnd > localStart && !feed(plain.subarray(localStart, localEnd))) {
        return { overflow: true, hasNewline: false, matchedLines: [] };
      }
    }
  }

  if (
    operation.densePath !== undefined &&
    operation.denseStart !== undefined &&
    operation.denseEnd !== undefined &&
    operation.denseEnd > operation.denseStart
  ) {
    const handle = await open(operation.densePath, 'r');
    try {
      let pos = operation.denseStart;
      const scratch = Buffer.allocUnsafe(Math.min(DENSE_CHUNK_BYTES, operation.denseEnd - operation.denseStart));
      while (pos < operation.denseEnd) {
        signal?.throwIfAborted();
        const toRead = Math.min(scratch.byteLength, operation.denseEnd - pos);
        const { bytesRead } = await handle.read(scratch, 0, toRead, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        if (!feed(scratch.subarray(0, bytesRead))) {
          return { overflow: true, hasNewline: false, matchedLines: [] };
        }
      }
    } finally {
      await handle.close();
    }
  }

  const leadingBuf = leadingBytes > 0 ? Buffer.concat(leadingChunks, leadingBytes) : undefined;
  const trailingBuf = seenNewline && pendingBytes > 0 ? Buffer.concat(pendingChunks, pendingBytes) : undefined;
  return {
    overflow: false,
    hasNewline: seenNewline,
    leading: leadingBuf === undefined ? undefined : new Uint8Array(leadingBuf.buffer, leadingBuf.byteOffset, leadingBuf.byteLength),
    trailing: trailingBuf === undefined ? undefined : new Uint8Array(trailingBuf.buffer, trailingBuf.byteOffset, trailingBuf.byteLength),
    matchedLines,
  };
}
