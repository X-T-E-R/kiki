import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { chmod, open, rename, unlink } from 'node:fs/promises';

/**
 * fsync a file descriptor through the module namespace (`nodeFs.fsync`)
 * rather than `FileHandle.sync()`, so a test can intercept the call for
 * fault injection.
 */
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

/**
 * Atomically write `content` to `filePath`: write a uniquely-named temp file
 * in the same directory, fsync it, then rename over the target. Readers never
 * observe a half-written file. Does NOT fsync the parent directory.
 */
export async function atomicWrite(
  filePath: string,
  content: string | Uint8Array,
  _syncOverride?: (fd: number) => Promise<void>,
  mode?: number,
): Promise<void> {
  const hex = randomBytes(4).toString('hex');
  const tmpPath = `${filePath}.tmp.${process.pid}.${hex}`;
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w', mode);
    try {
      await fh.writeFile(content);
      await (_syncOverride ?? syncFd)(fh.fd);
    } finally {
      await fh.close();
    }
    // Windows `fs.rename` maps to MoveFileEx and fails with EPERM if the
    // target is held by another handle; unlinking the target first turns this
    // into the POSIX-style "replace" case. Rename is tried first so the
    // no-target window (crash between unlink and rename) only opens in the
    // rare contended case, not on every write.
    if (process.platform === 'win32') {
      try {
        await rename(tmpPath, filePath);
        renamed = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EPERM') throw error;
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
      await rename(tmpPath, filePath);
      renamed = true;
    }
    // Re-apply the requested mode after replacement: `rename` over an existing
    // target keeps the old file's mode on POSIX, so a rewrite of a file that
    // was created with a different (looser) mode would silently widen it.
    if (mode !== undefined) {
      try {
        await chmod(filePath, mode);
      } catch {
        // Best-effort: platforms without POSIX modes (Windows) keep the file.
      }
    }
  } finally {
    if (!renamed) {
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore — file may not exist if open itself failed */
      }
    }
  }
}
