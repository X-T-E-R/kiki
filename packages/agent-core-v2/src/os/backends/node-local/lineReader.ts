import { open, readFile, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { decodeTextWithErrors, type TextDecodeErrors } from '#/_base/execEnv/decodeText';
import { toHostFsError } from '#/os/interface/hostFsErrors';

const READ_CHUNK_SIZE = 64 * 1024;
const LINE_INDEX_CHUNK_SIZE = 1024 * 1024;
const MAX_EXACT_LINE_LOCATIONS = 128;
const LINE_CHECKPOINT_INTERVAL = 256;
const MAX_LINE_INDEX_ENTRIES = 64;
const MAX_LINE_CHECKPOINTS = 4096;

export interface LineReadOptions {
  readonly encoding?: BufferEncoding;
  readonly errors?: TextDecodeErrors;
  readonly signal?: AbortSignal;
}

export interface LineRangeOptions extends LineReadOptions {
  readonly startLine: number;
  readonly maxLines: number;
}

interface LineCheckpoint {
  readonly line: number;
  readonly offset: number;
}

interface LineIndexEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
  checkpointInterval: number;
  checkpoints: LineCheckpoint[];
  readonly locations: Map<number, LineCheckpoint>;
  locating?: Promise<void>;
}

function isUtf8Encoding(encoding: BufferEncoding): boolean {
  return encoding === 'utf-8' || encoding === 'utf8';
}

function* splitLinesKeepingTerminator(text: string): Generator<string> {
  if (text.length === 0) return;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.codePointAt(i) === 0x0a) {
      yield text.slice(start, i + 1);
      start = i + 1;
    }
  }
  if (start < text.length) yield text.slice(start);
}

export class LocalLineReader {
  private readonly lineIndexes = new Map<string, LineIndexEntry>();

  async *readLines(path: string, options?: LineReadOptions): AsyncGenerator<string> {
    const signal = options?.signal;
    signal?.throwIfAborted();
    try {
      const encoding = options?.encoding ?? 'utf-8';
      const errors = options?.errors ?? 'strict';
      if (!isUtf8Encoding(encoding)) {
        const bytes = await readFile(path, { signal });
        signal?.throwIfAborted();
        for (const line of splitLinesKeepingTerminator(decodeTextWithErrors(bytes, encoding, errors))) {
          signal?.throwIfAborted();
          yield line;
        }
        return;
      }
      yield* this.readUtf8Lines(path, errors, undefined, signal);
    } catch (error) {
      signal?.throwIfAborted();
      throw toHostFsError(error, { path, op: 'read' });
    }
  }

  async *readLineRange(path: string, options: LineRangeOptions): AsyncGenerator<string> {
    const signal = options.signal;
    signal?.throwIfAborted();
    try {
      if (options.maxLines <= 0) return;
      const encoding = options.encoding ?? 'utf-8';
      const errors = options.errors ?? 'strict';
      if (!isUtf8Encoding(encoding)) {
        const bytes = await readFile(path, { signal });
        signal?.throwIfAborted();
        const content = decodeTextWithErrors(bytes, encoding, errors);
        let lineNo = 1;
        let yielded = 0;
        for (const line of splitLinesKeepingTerminator(content)) {
          signal?.throwIfAborted();
          if (lineNo >= options.startLine) {
            yield line;
            yielded += 1;
            if (yielded >= options.maxLines) return;
          }
          lineNo += 1;
        }
        return;
      }
      yield* this.readUtf8Lines(path, errors, options, signal);
    } catch (error) {
      signal?.throwIfAborted();
      throw toHostFsError(error, { path, op: 'read' });
    }
  }

  private async *readUtf8Lines(
    path: string,
    errors: TextDecodeErrors,
    range?: { startLine?: number; maxLines?: number },
    signal?: AbortSignal,
  ): AsyncGenerator<string> {
    const startLine = Math.max(1, range?.startLine ?? 1);
    const maxLines = Math.max(0, range?.maxLines ?? Number.POSITIVE_INFINITY);
    if (maxLines === 0) return;
    const fh = await open(path, 'r');
    try {
      signal?.throwIfAborted();
      const stat = await fh.stat();
      const index = this.lineIndex(path, stat);
      const checkpoint = await this.locateLine(fh, index, startLine, signal);
      const buf = Buffer.alloc(READ_CHUNK_SIZE);
      let pending: Buffer[] = [];
      let pendingOffset = 0;
      let fileOffset = checkpoint.offset;
      let lineNo = checkpoint.line;
      let yielded = 0;

      while (true) {
        signal?.throwIfAborted();
        const { bytesRead } = await fh.read(buf, 0, buf.length, fileOffset);
        signal?.throwIfAborted();
        if (bytesRead === 0) break;
        const chunk = buf.subarray(0, bytesRead);
        let lineStart = 0;
        for (let i = chunk.indexOf(0x0a); i >= 0; i = chunk.indexOf(0x0a, i + 1)) {
          const piece = chunk.subarray(lineStart, i + 1);
          const lineOffset = pending.length === 0 ? fileOffset + lineStart : pendingOffset;
          const line = pending.length === 0 ? piece : Buffer.concat([...pending, piece]);
          const nextLine = lineNo + 1;
          this.recordLineCheckpoint(index, nextLine, fileOffset + i + 1);
          pending = [];
          lineStart = i + 1;
          if (lineNo >= startLine) {
            signal?.throwIfAborted();
            yield decodeTextWithErrors(line, 'utf-8', errors, lineOffset !== 0);
            yielded += 1;
            if (yielded >= maxLines) return;
          }
          lineNo = nextLine;
        }
        if (lineStart < chunk.length) {
          const tail = Buffer.from(chunk.subarray(lineStart));
          if (pending.length === 0) pendingOffset = fileOffset + lineStart;
          pending.push(tail);
        }
        fileOffset += bytesRead;
      }
      if (pending.length > 0 && lineNo >= startLine) {
        signal?.throwIfAborted();
        yield decodeTextWithErrors(Buffer.concat(pending), 'utf-8', errors, pendingOffset !== 0);
      }
    } finally { await fh.close(); }
  }

  private lineIndex(path: string, stat: Stats): LineIndexEntry {
    const current = this.lineIndexes.get(path);
    if (current !== undefined && current.size === stat.size && current.mtimeMs === stat.mtimeMs &&
      current.ctimeMs === stat.ctimeMs && current.ino === stat.ino) {
      this.lineIndexes.delete(path);
      this.lineIndexes.set(path, current);
      return current;
    }
    const next: LineIndexEntry = {
      size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino,
      checkpointInterval: LINE_CHECKPOINT_INTERVAL,
      checkpoints: [{ line: 1, offset: 0 }], locations: new Map(),
    };
    this.lineIndexes.set(path, next);
    while (this.lineIndexes.size > MAX_LINE_INDEX_ENTRIES) {
      const oldest = this.lineIndexes.keys().next().value;
      if (oldest === undefined) break;
      this.lineIndexes.delete(oldest);
    }
    return next;
  }

  private async locateLine(fh: FileHandle, index: LineIndexEntry, startLine: number, signal?: AbortSignal): Promise<LineCheckpoint> {
    signal?.throwIfAborted();
    const cached = index.locations.get(startLine);
    if (cached !== undefined) return cached;
    const locate = (index.locating ?? Promise.resolve()).then(async () => {
      signal?.throwIfAborted();
      const existing = index.locations.get(startLine);
      if (existing !== undefined) return existing;
      const checkpoint = await this.scanToLine(fh, index, startLine, signal);
      index.locations.set(startLine, checkpoint);
      if (index.locations.size > MAX_EXACT_LINE_LOCATIONS) index.locations.delete(index.locations.keys().next().value!);
      return checkpoint;
    });
    index.locating = locate.then(() => {}, () => {});
    return locate;
  }

  private async scanToLine(fh: FileHandle, index: LineIndexEntry, startLine: number, signal?: AbortSignal): Promise<LineCheckpoint> {
    const checkpoint = this.lineCheckpoint(index.checkpoints, startLine);
    let line = checkpoint.line;
    let offset = checkpoint.offset;
    if (line === startLine) return checkpoint;
    const buffer = Buffer.allocUnsafe(LINE_INDEX_CHUNK_SIZE);
    while (offset < index.size) {
      signal?.throwIfAborted();
      const { bytesRead } = await fh.read(buffer, 0, Math.min(buffer.length, index.size - offset), offset);
      signal?.throwIfAborted();
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      for (let newline = chunk.indexOf(0x0a); newline >= 0; newline = chunk.indexOf(0x0a, newline + 1)) {
        line++;
        const nextOffset = offset + newline + 1;
        this.recordLineCheckpoint(index, line, nextOffset);
        if (line === startLine) return { line, offset: nextOffset };
      }
      offset += bytesRead;
    }
    return { line, offset };
  }

  private lineCheckpoint(checkpoints: readonly LineCheckpoint[], startLine: number): LineCheckpoint {
    let low = 0;
    let high = checkpoints.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const checkpoint = checkpoints[mid];
      if (checkpoint !== undefined && checkpoint.line <= startLine) low = mid;
      else high = mid - 1;
    }
    return checkpoints[low] ?? { line: 1, offset: 0 };
  }

  private recordLineCheckpoint(index: LineIndexEntry, line: number, offset: number): void {
    if ((line - 1) % index.checkpointInterval !== 0) return;
    const last = index.checkpoints[index.checkpoints.length - 1];
    if (last !== undefined && last.line >= line) return;
    index.checkpoints.push({ line, offset });
    if (index.checkpoints.length <= MAX_LINE_CHECKPOINTS) return;
    index.checkpointInterval *= 2;
    index.checkpoints = index.checkpoints.filter((checkpoint) => (checkpoint.line - 1) % index.checkpointInterval === 0);
  }
}
