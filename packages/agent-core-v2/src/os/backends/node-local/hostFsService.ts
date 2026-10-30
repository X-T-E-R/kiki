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
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { decodeTextWithErrors, type TextDecodeErrors } from '#/_base/execEnv/decodeText';

import { type HostDirEntry, type HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import { toHostFsError } from '#/os/interface/hostFsErrors';
import { CpuWorkerError } from '#/app/cpuWorker/host';
import { runCpuTask } from '#/app/cpuWorker/runtime';
import type { FileLineRangeOperation } from '#/app/cpuWorker/tasks';
import { LocalLineReader, type LineRangeOptions, type LineReadOptions } from './lineReader';

const LINE_RANGE_WORKER_MIN_BYTES = 256 * 1024;

function isWorkerUnavailable(error: unknown): boolean {
  if (error instanceof CpuWorkerError) return error.code !== 'CPU_TIMEOUT';
  return error instanceof Error && error.message === 'CPU worker asset is unavailable';
}

export class HostFileSystem implements IHostFileSystem {
  declare readonly _serviceBrand: undefined;
  private readonly lineReader = new LocalLineReader();

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

  readLines(path: string, options?: LineReadOptions): AsyncGenerator<string> {
    return this.lineReader.readLines(path, options);
  }

  async *readLineRange(path: string, options: LineRangeOptions): AsyncGenerator<string> {
    const { signal, ...range } = options;
    signal?.throwIfAborted();
    const lines = range.maxLines > 0 && await this.isLargeFile(path)
      ? await this.readLineRangeInWorker(path, range, signal)
      : undefined;
    if (lines === undefined) {
      yield* this.lineReader.readLineRange(path, options);
      return;
    }
    for (const line of lines) {
      signal?.throwIfAborted();
      yield line;
    }
  }

  private async readLineRangeInWorker(
    path: string,
    range: FileLineRangeOperation['options'],
    signal: AbortSignal | undefined,
  ): Promise<string[] | undefined> {
    try {
      return await runCpuTask<string[]>({ type: 'file.lineRange', path, options: range } satisfies FileLineRangeOperation, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      if (isWorkerUnavailable(error)) return undefined;
      throw error;
    }
  }

  private async isLargeFile(path: string): Promise<boolean> {
    try {
      return (await nodeStat(path)).size >= LINE_RANGE_WORKER_MIN_BYTES;
    } catch {
      return false;
    }
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
