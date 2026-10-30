import '#/_base/utils/fsWatchGuard';
import { createReadStream, mkdirSync, statSync, type BigIntStats } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';
import { FSWatcher } from 'chokidar';
import * as portablePath from 'pathe';

import { DisposableStore, combinedDisposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { onUnexpectedError } from '#/_base/errors/unexpectedError';
import { atomicWrite, atomicWriteStream, syncDir } from '#/_base/utils/fs';

import type {
  IFileSystemStorageService,
  IStorageLock,
  StorageAppendOptions,
  StorageFileStat,
  StorageLockOptions,
  StorageReadOptions,
  StorageReadRange,
  StorageWriteOptions,
} from '#/persistence/interface/storage';
import { toStorageIoError } from '#/persistence/interface/storage';

import { acquireFileLock } from './fileLock';

const storagePath = process.platform === 'win32' ? portablePath : posix;
const basename = (value: string): string => storagePath.basename(value);
const dirname = (value: string): string => storagePath.dirname(value);
const join = (...parts: string[]): string => storagePath.join(...parts);
const normalize = (value: string): string => storagePath.normalize(value);
const WATCH_DEBOUNCE_MS = 150;
const TORN_READ_RETRIES = 3;
const TORN_READ_RETRY_DELAY_MS = 15;
const TRANSIENT_OPEN_ATTEMPTS = 4;
const TRANSIENT_OPEN_DELAY_MS = 10;
const TRANSIENT_OPEN_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Retries only the open itself. A later write, sync, or close is not repeated. */
export async function openAppendAfterTransientDenial(
  openFile: () => Promise<FileHandle>,
  attempts = TRANSIENT_OPEN_ATTEMPTS,
  delayMs = TRANSIENT_OPEN_DELAY_MS,
): Promise<FileHandle> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await openFile();
    } catch (error) {
      last = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !TRANSIENT_OPEN_CODES.has(code) || attempt === attempts - 1) throw error;
      if (delayMs > 0) await delay(delayMs);
    }
  }
  throw last;
}

function toFileStat(info: BigIntStats): StorageFileStat {
  return {
    size: Number(info.size),
    identity: info.ino > 0n ? `${info.dev}:${info.ino}:${info.birthtimeNs}` : undefined,
    revision: `${info.mtimeNs}:${info.ctimeNs}`,
  };
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function recoverOrphanedTempFile(filePath: string): Promise<boolean> {
  const dir = dirname(filePath);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return false;
  }
  const prefix = `${basename(filePath)}.tmp.`;
  let newestOrphanedTemp: string | undefined;
  let newestOrphanedTempMtimeMs = -Infinity;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const pid = parseTempPid(entry, prefix);
    if (pid !== undefined && isPidAlive(pid)) return false;
    const path = join(dir, entry);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > newestOrphanedTempMtimeMs) {
      newestOrphanedTemp = path;
      newestOrphanedTempMtimeMs = mtimeMs;
    }
  }
  if (newestOrphanedTemp === undefined) return false;
  try {
    await rename(newestOrphanedTemp, filePath);
    return true;
  } catch {
    return false;
  }
}

function parseTempPid(entry: string, prefix: string): number | undefined {
  const pid = Number.parseInt(entry.slice(prefix.length, entry.indexOf('.', prefix.length)), 10);
  return Number.isInteger(pid) ? pid : undefined;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const isForeignProcessPid = (error as NodeJS.ErrnoException).code === 'EPERM';
    return isForeignProcessPid;
  }
}

export class FileStorageService implements IFileSystemStorageService {
  declare readonly _serviceBrand: undefined;

  private readonly syncedDirs = new Set<string>();

  constructor(
    private readonly baseDir: string,
    private readonly dirMode?: number,
    private readonly fileMode?: number,
    private readonly recoverMissingDocuments = true,
    private readonly openAppend?: (path: string) => Promise<FileHandle>,
  ) {}

  async read(scope: string, key: string, options: StorageReadOptions = {}): Promise<Uint8Array | undefined> {
    const filePath = this.pathFor(scope, key);
    for (let attempt = 0; ; attempt += 1) {
      let bytes: Uint8Array;
      try {
        bytes = await readFile(filePath);
      } catch (error) {
        if (!isEnoent(error)) {
          throw toStorageIoError(error, { path: filePath, op: 'read' });
        }
        if (!this.recoverMissingDocuments || options.recoverMissing === false) return undefined;
        const recovered = await recoverOrphanedTempFile(filePath);
        if (!recovered) return undefined;
        continue;
      }
      if (attempt >= TORN_READ_RETRIES) return bytes;
      let size: number | undefined;
      try {
        size = (await stat(filePath)).size;
      } catch {
        size = undefined;
      }
      if (size === undefined || size === bytes.length) return bytes;
      await new Promise((resolve) => setTimeout(resolve, TORN_READ_RETRY_DELAY_MS));
    }
  }

  async *readStream(
    scope: string,
    key: string,
    range?: StorageReadRange,
    options: StorageReadOptions = {},
  ): AsyncIterable<Uint8Array> {
    const filePath = this.pathFor(scope, key);
    const stream = createReadStream(filePath, {
      start: range?.start,
      end: range?.end,
      signal: options.signal,
      highWaterMark: options.chunkBytes ?? 1024 * 1024,
    });
    try {
      for await (const chunk of stream) {
        yield chunk as Uint8Array;
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (isEnoent(error)) return;
      throw toStorageIoError(error, { path: filePath, op: 'read' });
    }
  }

  async write(
    scope: string,
    key: string,
    data: Uint8Array,
    options: StorageWriteOptions = {},
  ): Promise<void> {
    const filePath = this.pathFor(scope, key);
    try {
      await mkdir(dirname(filePath), { recursive: true, mode: this.dirMode });
      await atomicWrite(filePath, data, undefined, this.fileMode, options.signal);
      await this.syncDirOnce(dirname(filePath));
    } catch (error) {
      options.signal?.throwIfAborted();
      throw toStorageIoError(error, { path: filePath, op: 'write' });
    }
  }

  async writeStream(
    scope: string,
    key: string,
    source: AsyncIterable<Uint8Array>,
    options: StorageWriteOptions = {},
  ): Promise<void> {
    const filePath = this.pathFor(scope, key);
    try {
      await mkdir(dirname(filePath), { recursive: true, mode: this.dirMode });
      await atomicWriteStream(filePath, source, this.fileMode, options.signal);
      await this.syncDirOnce(dirname(filePath));
    } catch (error) {
      options.signal?.throwIfAborted();
      throw toStorageIoError(error, { path: filePath, op: 'write' });
    }
  }

  async append(
    scope: string,
    key: string,
    data: Uint8Array,
    options: StorageAppendOptions = {},
  ): Promise<void> {
    const filePath = this.pathFor(scope, key);
    const dir = dirname(filePath);
    let committed = false;
    try {
      await mkdir(dir, { recursive: true, mode: this.dirMode });

      const fh = await openAppendAfterTransientDenial(() => this.openAppend === undefined
        ? open(filePath, 'a', this.fileMode)
        : this.openAppend(filePath));
      let opened: StorageFileStat | undefined;
      try {
        if (options.observe !== undefined) opened = toFileStat(await fh.stat({ bigint: true }));
        if (data.byteLength > 0) {
          committed = true;
          await fh.writeFile(data);
        }
        if (options.durable !== false) {
          await fh.sync();
        }
      } finally {
        if (opened !== undefined) {
          const after = await fh.stat({ bigint: true }).then(toFileStat, () => undefined);
          options.observe?.({ before: opened, after });
        }
        await fh.close();
      }
      await this.syncDirOnce(dir);
    } catch (error) {
      throw toStorageIoError(error, { path: filePath, op: 'append', committed });
    }
  }

  acquireLock(
    scope: string,
    key: string,
    options: StorageLockOptions = {},
  ): Promise<IStorageLock> {
    return acquireFileLock(this.pathFor(scope, key), options, {
      dirMode: this.dirMode,
      fileMode: this.fileMode,
    });
  }

  async list(scope: string, prefix?: string): Promise<readonly string[]> {
    let entries: readonly string[];
    try {
      entries = await readdir(this.scopePath(scope));
    } catch (error) {
      if (isEnoent(error)) return [];
      throw toStorageIoError(error, { path: this.scopePath(scope), op: 'list' });
    }
    return prefix === undefined ? entries : entries.filter((entry) => entry.startsWith(prefix));
  }

  async delete(scope: string, key: string): Promise<void> {
    const filePath = this.pathFor(scope, key);
    try {
      await unlink(filePath);
    } catch (error) {
      if (isEnoent(error)) return;
      throw toStorageIoError(error, { path: filePath, op: 'delete' });
    }
  }

  async moveDirectory(sourceScope: string, targetScope: string): Promise<void> {
    const source = this.scopePath(sourceScope);
    const target = this.scopePath(targetScope);
    try {
      await mkdir(dirname(target), { recursive: true, mode: this.dirMode });
      try {
        await stat(target);
        throw new Error('target session directory already exists');
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
      await rename(source, target);
    } catch (error) {
      throw toStorageIoError(error, { path: source, op: 'moveDirectory' });
    }
  }

  async size(scope: string, key: string): Promise<number | undefined> {
    const filePath = this.pathFor(scope, key);
    try {
      return (await stat(filePath)).size;
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw toStorageIoError(error, { path: filePath, op: 'stat' });
    }
  }

  async mtime(scope: string, key: string): Promise<number | undefined> {
    const filePath = this.pathFor(scope, key);
    try {
      return (await stat(filePath)).mtimeMs;
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw toStorageIoError(error, { path: filePath, op: 'stat' });
    }
  }

  async stat(scope: string, key: string): Promise<StorageFileStat | undefined> {
    const filePath = this.pathFor(scope, key);
    try {
      return toFileStat(await stat(filePath, { bigint: true }));
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw toStorageIoError(error, { path: filePath, op: 'stat' });
    }
  }

  watch(scope: string, key: string): Event<void> {
    const target = this.pathFor(scope, key);
    const dir = dirname(target);
    const normalizedTarget = normalize(target);
    const emitter = new Emitter<void>();

    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refCount = 0;

    const schedule = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => emitter.fire(), WATCH_DEBOUNCE_MS);
    };

    const fingerprint = (): string | undefined | null => {
      try {
        const info = statSync(target, { bigint: true });
        return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      } catch (error) {
        if (isEnoent(error)) return undefined;
        onUnexpectedError(error);
        return null;
      }
    };

    const arm = (): void => {
      try {
        mkdirSync(dir, { recursive: true, mode: this.dirMode });
        const initial = fingerprint();
        const current = new FSWatcher({
          ignoreInitial: true,
          awaitWriteFinish: false,
          depth: 0,
        });
        watcher = current;
        current.on('all', (_event, changedPath) => {
          if (watcher === current && normalize(changedPath) === normalizedTarget) schedule();
        });
        current.once('ready', () => {
          if (watcher !== current) return;
          const latest = fingerprint();
          if (initial === null || latest === null || latest !== initial) schedule();
        });
        current.on('error', (error: unknown) => onUnexpectedError(error));
        current.add(dir);
      } catch (error) {
        onUnexpectedError(error);
      }
    };

    const disarm = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      const current = watcher;
      watcher = undefined;
      const closeResult = current?.close();
      if (closeResult !== undefined) void closeResult.catch(() => undefined);
    };

    return (listener, thisArg, disposables) => {
      if (refCount === 0) arm();
      refCount++;
      const subscription = emitter.event(listener, thisArg);
      let tornDown = false;
      const teardown = toDisposable(() => {
        if (tornDown) return;
        tornDown = true;
        refCount--;
        if (refCount === 0) disarm();
      });
      const combined = combinedDisposable(subscription, teardown);
      if (disposables instanceof DisposableStore) {
        disposables.add(combined);
      } else if (disposables !== undefined) {
        (disposables as IDisposable[]).push(combined);
      }
      return combined;
    };
  }

  async flush(): Promise<void> {
  }

  async close(): Promise<void> {}

  pathFor(scope: string, key: string): string {
    return join(this.baseDir, scope, key);
  }

  private scopePath(scope: string): string {
    return join(this.baseDir, scope);
  }

  private async syncDirOnce(dir: string): Promise<void> {
    if (this.syncedDirs.has(dir)) return;
    try {
      await syncDir(dir);
      this.syncedDirs.add(dir);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
}
