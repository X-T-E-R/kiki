import {
  appendFile,
  lstat,
  open,
  readFile,
  readdir,
  mkdir,
  realpath as nodeRealpath,
  rm,
  stat as nodeStat,
  writeFile,
} from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { decodeTextWithErrors, type TextDecodeErrors } from '#/_base/execEnv/decodeText';

import { type HostDirEntry, type HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { toHostFsError } from '#/os/interface/hostFsErrors';

const READ_CHUNK_SIZE = 64 * 1024;
const LINE_CHECKPOINT_INTERVAL = 256;
const MAX_LINE_INDEX_ENTRIES = 64;
const MAX_LINE_CHECKPOINTS = 4096;

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
  if (start < text.length) {
    yield text.slice(start);
  }
}

export class HostFileSystem implements IHostFileSystem {
  declare readonly _serviceBrand: undefined;
  private readonly lineIndexes = new Map<string, LineIndexEntry>();

  async readText(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): Promise<string> {
    try {
      if (options === undefined) {
        return await readFile(path, 'utf8');
      }
      const encoding = options.encoding ?? 'utf-8';
      const errors = options.errors ?? 'strict';
      return decodeTextWithErrors(await readFile(path), encoding, errors);
    } catch (error) {
      throw toHostFsError(error, { path, op: 'read' });
    }
  }

  async writeText(path: string, data: string): Promise<void> {
    try {
      await writeFile(path, data, 'utf8');
    } catch (error) {
      throw toHostFsError(error, { path, op: 'write' });
    }
  }

  async appendText(path: string, data: string): Promise<void> {
    try {
      await appendFile(path, data, 'utf8');
    } catch (error) {
      throw toHostFsError(error, { path, op: 'append' });
    }
  }

  async readBytes(path: string, n?: number, offset = 0): Promise<Uint8Array> {
    try {
      if (n === undefined && offset === 0) {
        const buf = await readFile(path);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      }
      const fh = await open(path, 'r');
      try {
        const length = n ?? Math.max(0, (await fh.stat()).size - offset);
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch (error) {
      throw toHostFsError(error, { path, op: 'read' });
    }
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    try {
      await writeFile(path, data);
    } catch (error) {
      throw toHostFsError(error, { path, op: 'write' });
    }
  }

  async *readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): AsyncGenerator<string> {
    try {
      const encoding = options?.encoding ?? 'utf-8';
      const errors = options?.errors ?? 'strict';

      if (!isUtf8Encoding(encoding)) {
        const content = decodeTextWithErrors(await readFile(path), encoding, errors);
        yield* splitLinesKeepingTerminator(content);
        return;
      }

      yield* this._readUtf8Lines(path, errors);
    } catch (error) {
      throw toHostFsError(error, { path, op: 'read' });
    }
  }

  async *readLineRange(
    path: string,
    options: {
      startLine: number;
      maxLines: number;
      encoding?: BufferEncoding;
      errors?: TextDecodeErrors;
    },
  ): AsyncGenerator<string> {
    try {
      if (options.maxLines <= 0) return;
      const encoding = options.encoding ?? 'utf-8';
      const errors = options.errors ?? 'strict';
      if (!isUtf8Encoding(encoding)) {
        const content = decodeTextWithErrors(await readFile(path), encoding, errors);
        let lineNo = 1;
        let yielded = 0;
        for (const line of splitLinesKeepingTerminator(content)) {
          if (lineNo >= options.startLine) {
            yield line;
            yielded += 1;
            if (yielded >= options.maxLines) return;
          }
          lineNo += 1;
        }
        return;
      }
      yield* this._readUtf8Lines(path, errors, {
        startLine: options.startLine,
        maxLines: options.maxLines,
      });
    } catch (error) {
      throw toHostFsError(error, { path, op: 'read' });
    }
  }

  private async *_readUtf8Lines(
    path: string,
    errors: TextDecodeErrors,
    range?: { startLine?: number; maxLines?: number },
  ): AsyncGenerator<string> {
    const startLine = Math.max(1, range?.startLine ?? 1);
    const maxLines = Math.max(0, range?.maxLines ?? Number.POSITIVE_INFINITY);
    if (maxLines === 0) return;
    const fh = await open(path, 'r');
    try {
      const stat = await fh.stat();
      const index = this.lineIndex(path, stat);
      const checkpoint = this.lineCheckpoint(index.checkpoints, startLine);
      const buf = Buffer.alloc(READ_CHUNK_SIZE);
      let pending: Buffer[] = [];
      let pendingOffset = 0;
      let fileOffset = checkpoint.offset;
      let lineNo = checkpoint.line;
      let yielded = 0;

      while (true) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, fileOffset);
        if (bytesRead === 0) break;
        const chunk = buf.subarray(0, bytesRead);
        let lineStart = 0;

        for (let i = 0; i < chunk.length; i += 1) {
          const byte = chunk[i];
          if (byte !== 0x0a) continue;
          const piece = chunk.subarray(lineStart, i + 1);
          const lineOffset = pending.length === 0 ? fileOffset + lineStart : pendingOffset;
          const line = pending.length === 0 ? piece : Buffer.concat([...pending, piece]);
          const nextLine = lineNo + 1;
          this.recordLineCheckpoint(index, nextLine, fileOffset + i + 1);
          pending = [];
          lineStart = i + 1;
          if (lineNo >= startLine) {
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

      if (pending.length > 0) {
        const line = Buffer.concat(pending);
        if (lineNo >= startLine) {
          yield decodeTextWithErrors(line, 'utf-8', errors, pendingOffset !== 0);
        }
      }
    } finally {
      await fh.close();
    }
  }

  private lineIndex(path: string, stat: Stats): LineIndexEntry {
    const current = this.lineIndexes.get(path);
    if (
      current !== undefined &&
      current.size === stat.size &&
      current.mtimeMs === stat.mtimeMs &&
      current.ctimeMs === stat.ctimeMs &&
      current.ino === stat.ino
    ) {
      this.lineIndexes.delete(path);
      this.lineIndexes.set(path, current);
      return current;
    }
    const next: LineIndexEntry = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      ino: stat.ino,
      checkpointInterval: LINE_CHECKPOINT_INTERVAL,
      checkpoints: [{ line: 1, offset: 0 }],
    };
    this.lineIndexes.set(path, next);
    while (this.lineIndexes.size > MAX_LINE_INDEX_ENTRIES) {
      const oldest = this.lineIndexes.keys().next().value;
      if (oldest === undefined) break;
      this.lineIndexes.delete(oldest);
    }
    return next;
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
    index.checkpoints = index.checkpoints.filter(
      (checkpoint) => (checkpoint.line - 1) % index.checkpointInterval === 0,
    );
  }

  async createExclusive(path: string, data: Uint8Array): Promise<boolean> {
    try {
      const fh = await open(path, 'wx');
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw toHostFsError(error, { path, op: 'create' });
    }
  }

  async stat(path: string): Promise<HostFileStat> {
    try {
      const s = await nodeStat(path);
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        size: s.size,
        mtimeMs: s.mtimeMs,
        ino: s.ino,
        mode: s.mode,
        uid: s.uid,
      };
    } catch (error) {
      throw toHostFsError(error, { path, op: 'stat' });
    }
  }

  async lstat(path: string): Promise<HostFileStat> {
    try {
      const s = await lstat(path);
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        size: s.size,
        mtimeMs: s.mtimeMs,
        ino: s.ino,
        mode: s.mode,
        uid: s.uid,
      };
    } catch (error) {
      throw toHostFsError(error, { path, op: 'lstat' });
    }
  }

  async readdir(path: string): Promise<readonly HostDirEntry[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((d) => ({
        name: d.name,
        isFile: d.isFile(),
        isDirectory: d.isDirectory(),
        isSymbolicLink: d.isSymbolicLink(),
      }));
    } catch (error) {
      throw toHostFsError(error, { path, op: 'readdir' });
    }
  }

  async mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    try {
      await mkdir(path, { recursive: options?.recursive ?? false });
    } catch (error) {
      throw toHostFsError(error, { path, op: 'mkdir' });
    }
  }

  async remove(path: string): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      throw toHostFsError(error, { path, op: 'remove' });
    }
  }

  async realpath(path: string): Promise<string> {
    try {
      return await nodeRealpath(path);
    } catch (error) {
      throw toHostFsError(error, { path, op: 'realpath' });
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostFileSystem,
  HostFileSystem,
  ScopeActivation.OnScopeCreated,
  'hostFs',
);
