import { open, stat, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { basename, resolve } from 'pathe';

import { Error2, ErrorCodes } from '#/errors';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { openPinnedLogicalRead, type PinnedLogicalRead } from '#/persistence/coldSegmentLog';
import { wireFileAddress } from '#/persistence/logicalWireFile';

export interface ZipSource {
  readonly stream: Readable;
  readonly size: number;
  readonly mtime: Date;
  readonly mode: number;
  readonly identity: ZipSourceIdentity;
  readonly sourcePath?: string;
  close(): Promise<void>;
}

export interface ZipSourceIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export async function openZipSource(source: string, signal?: AbortSignal): Promise<ZipSource> {
  const handle = await open(source, 'r');
  let stream: Readable | undefined;
  try {
    signal?.throwIfAborted();
    const file = await handle.stat({ bigint: true });
    if (!file.isFile()) {
      throw new Error2(ErrorCodes.FS_IS_DIRECTORY, `not a file: ${source}`, {
        details: { path: source },
      });
    }
    const size = Number(file.size);
    if (!Number.isSafeInteger(size)) {
      throw new Error2(ErrorCodes.SESSION_EXPORT_TOO_LARGE, `file is too large to export: ${source}`, {
        details: { path: source },
      });
    }
    signal?.throwIfAborted();
    stream =
      size === 0
        ? Readable.from([])
        : handle.createReadStream({
            autoClose: false,
            start: 0,
            end: size - 1,
            signal,
          });
    let closing: Promise<void> | undefined;
    return {
      stream,
      size,
      mtime: file.mtime,
      mode: Number(file.mode),
      identity: { device: file.dev, inode: file.ino },
      sourcePath: resolve(source),
      close: () => {
        closing ??= closeZipSource(stream!, handle);
        return closing;
      },
    };
  } catch (error) {
    stream?.destroy();
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function openExportZipSource(source: string, signal?: AbortSignal): Promise<ZipSource> {
  if (basename(source) !== 'wire.jsonl') return openZipSource(source, signal);
  signal?.throwIfAborted();
  const file = await stat(source, { bigint: true });
  if (!file.isFile()) {
    throw new Error2(ErrorCodes.FS_IS_DIRECTORY, `not a file: ${source}`, {
      details: { path: source },
    });
  }
  const address = wireFileAddress(source);
  const storage = new FileStorageService(address.baseDir);
  const pinned = await openPinnedLogicalRead(storage, address.scope, address.key);
  if (pinned.size === undefined) {
    pinned.close();
    return openZipSource(source, signal);
  }
  const size = pinned.size;
  if (!Number.isSafeInteger(size)) {
    pinned.close();
    throw new Error2(ErrorCodes.SESSION_EXPORT_TOO_LARGE, `file is too large to export: ${source}`, {
      details: { path: source },
    });
  }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    pinned.close();
  };
  const stream = size === 0
    ? Readable.from([])
    : Readable.from(logicalZipChunks(pinned, size, signal), { objectMode: false });
  stream.once('close', release);
  let closing: Promise<void> | undefined;
  return {
    stream,
    size,
    mtime: file.mtime,
    mode: Number(file.mode),
    identity: { device: file.dev, inode: file.ino },
    sourcePath: resolve(source),
    close: () => {
      closing ??= (async () => {
        stream.destroy();
        release();
        await finished(stream, { cleanup: true }).catch(() => {});
      })();
      return closing;
    },
  };
}

async function* logicalZipChunks(
  pinned: PinnedLogicalRead,
  size: number,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  for await (const chunk of pinned.read({ start: 0, end: size - 1 }, { signal })) {
    signal?.throwIfAborted();
    yield Buffer.from(chunk);
  }
}

async function closeZipSource(stream: Readable, handle: FileHandle): Promise<void> {
  stream.destroy();
  await finished(stream, { cleanup: true }).catch(() => {});
  await handle.close();
}
