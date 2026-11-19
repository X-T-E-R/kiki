import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { chmod, link, open, rename, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'pathe';

import { BugIndicatingError } from '#/_base/errors/errors';

export type Win32MoveFileReplace = (
  srcPath: string,
  destPath: string,
  signal?: AbortSignal,
) => Promise<void>;

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
  const tmpPath = `${filePath}.${tag}.${process.pid}.${hex}`;
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
    if (preserveDestinationOnError) {
      await replaceFileNonDestructive(tmpPath, filePath, signal);
      renamed = true;
    } else {
      if (process.platform === 'win32') {
        try {
          await rename(tmpPath, filePath);
          renamed = true;
        } catch (error) {
          const isWindowsRenameContention =
            (error as NodeJS.ErrnoException).code === 'EPERM';
          if (!isWindowsRenameContention) throw error;
        }
      }
      if (!renamed) {
        if (process.platform === 'win32') {
          try {
            await unlink(filePath);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') throw error;
          }
        }
        signal?.throwIfAborted();
        await rename(tmpPath, filePath);
        renamed = true;
      }
    }
    if (mode !== undefined) {
      try {
        await chmod(filePath, mode);
      } catch {
        if (process.platform !== 'win32') throw new BugIndicatingError(
          `chmod(${filePath}, ${mode.toString(8)}) failed after atomic write`,
        );
      }
    }
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
        if (process.platform !== 'win32') throw new BugIndicatingError(
          `chmod(${filePath}, ${mode.toString(8)}) failed after atomic write`,
        );
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
    await atomicWrite(tmpPath, content, undefined, mode);
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
  const tmpPath = `${filePath}.${tag}.${process.pid}.${hex}`;
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
    if (preserveDestinationOnError) {
      await replaceFileNonDestructive(tmpPath, filePath, signal);
      renamed = true;
    } else {
      if (process.platform === 'win32') {
        try {
          await rename(tmpPath, filePath);
          renamed = true;
        } catch (error) {
          const isWindowsRenameContention =
            (error as NodeJS.ErrnoException).code === 'EPERM';
          if (!isWindowsRenameContention) throw error;
        }
      }
      if (!renamed) {
        if (process.platform === 'win32') {
          try {
            await unlink(filePath);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') throw error;
          }
        }
        signal?.throwIfAborted();
        await rename(tmpPath, filePath);
        renamed = true;
      }
    }
    if (mode !== undefined) {
      try {
        await chmod(filePath, mode);
      } catch {
        if (process.platform !== 'win32') throw new BugIndicatingError(
          `chmod(${filePath}, ${mode.toString(8)}) failed after atomic write`,
        );
      }
    }
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
