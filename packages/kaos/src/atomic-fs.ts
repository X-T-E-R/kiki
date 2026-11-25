import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { chmod, link, mkdir, open, rename, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'pathe';

import { KaosError } from './errors';

export type Win32MoveFileReplace = (
  srcPath: string,
  destPath: string,
  signal?: AbortSignal,
) => Promise<void>;

export class AtomicWriteChmodError extends KaosError {
  constructor(filePath: string, mode: number) {
    super(`chmod(${filePath}, ${mode.toString(8)}) failed after atomic write`);
    this.name = 'AtomicWriteChmodError';
  }
}

let win32MoveFileReplace: Win32MoveFileReplace | undefined;

export function registerWin32MoveFileReplace(fn: Win32MoveFileReplace | undefined): void {
  win32MoveFileReplace = fn;
}

export async function replaceFileNonDestructive(
  tmpPath: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (process.platform !== 'win32') {
    await rename(tmpPath, filePath);
    return;
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    signal?.throwIfAborted();
    try {
      await rename(tmpPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
    }
    await delay(10 * (attempt + 1), undefined, { signal });
  }
  if (win32MoveFileReplace !== undefined) {
    await win32MoveFileReplace(tmpPath, filePath, signal);
    return;
  }
  throw lastError;
}

export async function syncDir(dirPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  const dirFh = await open(dirPath, 'r');
  try {
    await dirFh.sync();
  } finally {
    await dirFh.close();
  }
}

export function syncDirSync(dirPath: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dirPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export async function writeFileAtomicDurable(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const tmpPath = filePath + '.tmp';
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (process.platform === 'win32') {
      try {
        await unlink(filePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw error;
      }
    }
    await rename(tmpPath, filePath);
    renamed = true;
    await syncDir(dirname(filePath));
  } finally {
    if (!renamed) {
      try {
        await unlink(tmpPath);
      } catch {
      }
    }
  }
}

function syncFd(fd: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    nodeFs.fsync(fd, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/** Suffix appended to an atomic-write temp file once its bytes are durably synced; only such temps are complete. */
export const ATOMIC_TEMP_READY_SUFFIX = '.ready';

async function markTempReady(tmpPath: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const readyPath = `${tmpPath}${ATOMIC_TEMP_READY_SUFFIX}`;
  if (process.platform !== 'win32') {
    await rename(tmpPath, readyPath);
    return readyPath;
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    signal?.throwIfAborted();
    try {
      await rename(tmpPath, readyPath);
      return readyPath;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
    }
    await delay(10 * (attempt + 1), undefined, { signal });
  }
  throw lastError;
}

async function commitAtomicTemp(
  tmpPath: string,
  filePath: string,
  signal: AbortSignal | undefined,
  preserveDestinationOnError: boolean,
): Promise<void> {
  if (preserveDestinationOnError) {
    await replaceFileNonDestructive(tmpPath, filePath, signal);
    return;
  }
  if (process.platform === 'win32') {
    try {
      await rename(tmpPath, filePath);
      return;
    } catch (error) {
      const isWindowsRenameContention =
        (error as NodeJS.ErrnoException).code === 'EPERM';
      if (!isWindowsRenameContention) throw error;
    }
    try {
      await unlink(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
  }
  signal?.throwIfAborted();
  await rename(tmpPath, filePath);
}

async function applyAtomicMode(filePath: string, mode: number | undefined): Promise<void> {
  if (mode === undefined) return;
  try {
    await chmod(filePath, mode);
  } catch {
    if (process.platform !== 'win32') throw new AtomicWriteChmodError(filePath, mode);
  }
}

export async function atomicWrite(
  filePath: string,
  content: string | Uint8Array,
  _syncOverride?: (fd: number) => Promise<void>,
  mode?: number,
  signal?: AbortSignal,
  preserveDestinationOnError = false,
): Promise<void> {
  signal?.throwIfAborted();
  const hex = randomBytes(4).toString('hex');
  const tag = preserveDestinationOnError ? 'stage' : 'tmp';
  const stagingPath = `${filePath}.${tag}.${process.pid}.${hex}`;
  let tmpPath = stagingPath;
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w', mode);
    try {
      signal?.throwIfAborted();
      await fh.writeFile(content);
      signal?.throwIfAborted();
      await (_syncOverride ?? syncFd)(fh.fd);
    } finally {
      await fh.close();
    }
    if (!preserveDestinationOnError) tmpPath = await markTempReady(stagingPath, signal);
    await commitAtomicTemp(tmpPath, filePath, signal, preserveDestinationOnError);
    renamed = true;
    await applyAtomicMode(filePath, mode);
  } finally {
    if (!renamed) {
      try {
        await unlink(tmpPath);
      } catch {
      }
    }
  }
}

export function atomicWriteSync(
  filePath: string,
  content: string | Uint8Array,
  mode?: number,
): void {
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let renamed = false;
  try {
    const fd = openSync(tmpPath, 'w', mode);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, filePath);
    renamed = true;
    if (mode !== undefined) {
      try {
        chmodSync(filePath, mode);
      } catch {
        if (process.platform !== 'win32') throw new AtomicWriteChmodError(filePath, mode);
      }
    }
  } finally {
    if (!renamed) {
      try {
        unlinkSync(tmpPath);
      } catch {
      }
    }
  }
}

export async function atomicCreate(filePath: string, content: string, mode?: number): Promise<void> {
  if (process.platform === 'android') {
    await createFileExclusiveDirect(filePath, content, mode);
    return;
  }
  const tmpPath = join(dirname(filePath), `.create.${process.pid}.${randomBytes(8).toString('hex')}`);
  try {
    await atomicWrite(tmpPath, content, undefined, mode, undefined, true);
    try {
      await link(tmpPath, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOSYS' || code === 'ENOTSUP') {
        await createFileExclusiveDirect(filePath, content, mode);
        return;
      }
      throw error;
    }
    await syncDir(dirname(filePath));
  } finally {
    await removeCreateTemporary(tmpPath);
  }
}

async function createFileExclusiveDirect(filePath: string, content: string, mode?: number): Promise<void> {
  const fh = await open(filePath, 'wx', mode);
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } catch (error) {
    await fh.close().catch(() => undefined);
    await unlink(filePath).catch(() => undefined);
    throw error;
  }
  await fh.close();
  await syncDir(dirname(filePath));
}

async function removeCreateTemporary(tmpPath: string): Promise<void> {
  try {
    await unlink(tmpPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function atomicWriteStream(
  filePath: string,
  source: AsyncIterable<Uint8Array>,
  mode?: number,
  signal?: AbortSignal,
  preserveDestinationOnError = false,
): Promise<void> {
  signal?.throwIfAborted();
  const hex = randomBytes(4).toString('hex');
  const tag = preserveDestinationOnError ? 'stage' : 'tmp';
  const stagingPath = `${filePath}.${tag}.${process.pid}.${hex}`;
  let tmpPath = stagingPath;
  let renamed = false;
  const destroyable = source as AsyncIterable<Uint8Array> & {
    destroy?(error?: Error): void;
  };
  const onAbort = (): void => {
    const reason = signal?.reason instanceof Error ? signal.reason : undefined;
    destroyable.destroy?.(reason);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const fh = await open(tmpPath, 'w', mode);
    try {
      for await (const chunk of source) {
        signal?.throwIfAborted();
        if (chunk.byteLength > 0) {
          await fh.writeFile(chunk);
        }
      }
      signal?.throwIfAborted();
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (!preserveDestinationOnError) tmpPath = await markTempReady(stagingPath, signal);
    await commitAtomicTemp(tmpPath, filePath, signal, preserveDestinationOnError);
    renamed = true;
    await applyAtomicMode(filePath, mode);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!renamed) {
      try {
        await unlink(tmpPath);
      } catch {
      }
    }
  }
}

export interface AtomicWriteOptions {
  readonly mode?: number;
  readonly dirMode?: number;
  readonly signal?: AbortSignal;
  readonly preserveDestinationOnError?: boolean;
}

export async function atomicWriteBytes(
  filePath: string,
  bytes: Uint8Array,
  options?: AtomicWriteOptions,
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: options?.dirMode });
  if (options?.dirMode !== undefined) {
    await applyAtomicMode(dir, options.dirMode);
  }
  await atomicWrite(
    filePath,
    bytes,
    undefined,
    options?.mode,
    options?.signal,
    options?.preserveDestinationOnError ?? false,
  );
}

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
  options?: AtomicWriteOptions & { readonly indent?: number },
): Promise<void> {
  const serialized =
    options?.indent !== undefined
      ? `${JSON.stringify(value, null, options.indent)}\n`
      : JSON.stringify(value);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: options?.dirMode });
  if (options?.dirMode !== undefined) {
    await applyAtomicMode(dir, options.dirMode);
  }
  await atomicWrite(
    filePath,
    serialized,
    undefined,
    options?.mode,
    options?.signal,
    options?.preserveDestinationOnError ?? false,
  );
}
