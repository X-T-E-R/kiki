import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readFile, stat, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'pathe';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { replaceFileNonDestructive, syncDir } from '#/_base/utils/fs';
import { LifecycleScope } from '#/app/scopes';
import type { BlobReadRange } from '#/persistence/interface/blobStore';
import {
  IContentAddressedStore,
  type CasOperationOptions,
  type CasStoredObject,
} from '#/persistence/interface/contentAddressedStore';
import {
  IFileSystemStorageService,
  StorageError,
  StorageErrors,
  toStorageIoError,
} from '#/persistence/interface/storage';

/** Relative storage scope for global raw-byte content-addressed objects. */
export const CAS_V2_SCOPE = 'blobs/v2';

/** Bounded streaming chunk size (64 KiB) for CAS verification and Range reads. */
export const CAS_STREAM_CHUNK_BYTES = 64 * 1024;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;
const MAX_SOURCE_STABILITY_ATTEMPTS = 2;

function assertValidSha256(sha256: string): void {
  if (!SHA256_HEX_RE.test(sha256)) {
    throw new StorageError(StorageErrors.codes.STORAGE_DECODE_FAILED, `invalid CAS digest: ${sha256}`);
  }
}

function objectKeyFor(sha256: string): string {
  return `${sha256.slice(0, 2)}/${sha256}`;
}

function errorCodeOf(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function unlinkQuietly(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return;
    if (process.platform === 'win32' && (errorCodeOf(error) === 'EPERM' || errorCodeOf(error) === 'EACCES')) {
      await chmod(filePath, 0o600).catch(() => undefined);
      await unlink(filePath).catch(() => undefined);
    }
  }
}

async function writeAll(handle: FileHandle, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset);
    if (bytesWritten <= 0) {
      throw new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'short write to CAS staging file');
    }
    offset += bytesWritten;
  }
}

async function digestFileStreaming(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CAS_STREAM_CHUNK_BYTES);
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function verifyExistingTarget(targetPath: string, expectedSha256: string, signal?: AbortSignal): Promise<void> {
  const actual = await digestFileStreaming(targetPath, signal);
  if (actual !== expectedSha256) {
    throw new StorageError(
      StorageErrors.codes.STORAGE_CORRUPTED,
      `CAS object failed integrity check for ${expectedSha256}`,
      { details: { path: targetPath, expectedSha256, actualSha256: actual } },
    );
  }
}

/** File-backed raw-byte content-addressed store with NTFS-safe hard-link publication and in-memory fallback. */
export class ContentAddressedStoreService implements IContentAddressedStore {
  declare readonly _serviceBrand: undefined;
  private readonly inFlightFiles = new Map<string, Promise<CasStoredObject>>();

  constructor(@IFileSystemStorageService private readonly storage: IFileSystemStorageService) {}

  objectPath(sha256: string): string | undefined {
    if (!SHA256_HEX_RE.test(sha256)) return undefined;
    return this.storage.pathFor(CAS_V2_SCOPE, objectKeyFor(sha256));
  }

  async putBytes(data: Uint8Array, options: CasOperationOptions = {}): Promise<CasStoredObject> {
    options.signal?.throwIfAborted();
    const sha256 = createHash('sha256').update(data).digest('hex');
    const target = this.objectPath(sha256);
    if (target !== undefined) {
      const existing = await stat(target).catch(() => undefined);
      if (existing !== undefined && existing.isFile() && existing.size === data.byteLength) {
        await verifyExistingTarget(target, sha256, options.signal);
        await chmod(target, 0o400).catch(() => undefined);
        return { sha256, bytes: data.byteLength, deduplicated: true };
      }
    } else {
      const existingSize = await this.storage.size(CAS_V2_SCOPE, objectKeyFor(sha256));
      if (existingSize === data.byteLength) {
        const existingBytes = await this.storage.read(CAS_V2_SCOPE, objectKeyFor(sha256));
        if (existingBytes !== undefined && createHash('sha256').update(existingBytes).digest('hex') === sha256) {
          return { sha256, bytes: data.byteLength, deduplicated: true };
        }
      }
    }
    return this.putStream((async function* () { yield data; })(), options);
  }

  async putStream(source: AsyncIterable<Uint8Array>, options: CasOperationOptions = {}): Promise<CasStoredObject> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const casRoot = this.storage.pathFor(CAS_V2_SCOPE, '');
    if (casRoot === undefined) {
      const chunks: Uint8Array[] = [];
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of source) {
        signal?.throwIfAborted();
        chunks.push(chunk);
        hash.update(chunk);
        bytes += chunk.byteLength;
      }
      signal?.throwIfAborted();
      const sha256 = hash.digest('hex');
      const key = objectKeyFor(sha256);
      const existing = await this.storage.size(CAS_V2_SCOPE, key);
      if (existing === bytes) {
        return { sha256, bytes, deduplicated: true };
      }
      const payload = chunks.length === 0
        ? new Uint8Array(0)
        : chunks.length === 1
          ? chunks[0]!
          : Buffer.concat(chunks, bytes);
      await this.storage.write(CAS_V2_SCOPE, key, payload, { atomic: true, signal });
      return { sha256, bytes, deduplicated: false };
    }

    const stagingDir = join(casRoot, 'tmp');
    const stagedPath = join(stagingDir, randomUUID());
    let handle: FileHandle | undefined;
    let sha256: string;
    let bytes = 0;
    try {
      await mkdir(stagingDir, { recursive: true, mode: 0o700 });
      handle = await open(stagedPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      const hash = createHash('sha256');
      for await (const chunk of source) {
        signal?.throwIfAborted();
        if (chunk.byteLength === 0) continue;
        await writeAll(handle, chunk);
        hash.update(chunk);
        bytes += chunk.byteLength;
      }
      signal?.throwIfAborted();
      await handle.sync();
      signal?.throwIfAborted();
      await handle.close();
      handle = undefined;
      sha256 = hash.digest('hex');
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlinkQuietly(stagedPath);
      if (signal?.aborted === true || error instanceof StorageError) throw error;
      throw toStorageIoError(error, { path: stagedPath, op: 'write' });
    }

    const target = join(casRoot, sha256.slice(0, 2), sha256);
    const targetDir = dirname(target);
    let deduplicated = false;
    try {
      await mkdir(targetDir, { recursive: true, mode: 0o700 });
      try {
        await link(stagedPath, target);
      } catch (error) {
        if (errorCodeOf(error) !== 'EEXIST') throw error;
        await verifyExistingTarget(target, sha256, signal);
        deduplicated = true;
      }
      await unlink(stagedPath);
      await chmod(target, 0o400);
      await syncDir(targetDir);
      return { sha256, bytes, deduplicated };
    } catch (error) {
      await unlinkQuietly(stagedPath);
      if (signal?.aborted === true || error instanceof StorageError) throw error;
      throw toStorageIoError(error, { path: target, op: 'write' });
    }
  }

  private async putFromFileDirect(
    sourcePath: string,
    casRoot: string,
    chunkBytes: number,
    signal?: AbortSignal,
  ): Promise<CasStoredObject> {
    const stagingDir = join(casRoot, 'tmp');
    const stagedPath = join(stagingDir, randomUUID());
    let srcHandle: FileHandle | undefined;
    let dstHandle: FileHandle | undefined;
    let sha256: string;
    let bytes = 0;
    try {
      await mkdir(stagingDir, { recursive: true, mode: 0o700 });
      srcHandle = await open(sourcePath, 'r');
      dstHandle = await open(stagedPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(chunkBytes);
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await srcHandle.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        const slice = buffer.subarray(0, bytesRead);
        await writeAll(dstHandle, slice);
        hash.update(slice);
        bytes += bytesRead;
      }
      signal?.throwIfAborted();
      await dstHandle.sync();
      signal?.throwIfAborted();
      await dstHandle.close();
      dstHandle = undefined;
      await srcHandle.close();
      srcHandle = undefined;
      sha256 = hash.digest('hex');
    } catch (error) {
      if (srcHandle !== undefined) await srcHandle.close().catch(() => undefined);
      if (dstHandle !== undefined) await dstHandle.close().catch(() => undefined);
      await unlinkQuietly(stagedPath);
      if (signal?.aborted === true || error instanceof StorageError) throw error;
      throw toStorageIoError(error, { path: stagedPath, op: 'write' });
    }

    const target = join(casRoot, sha256.slice(0, 2), sha256);
    const targetDir = dirname(target);
    let deduplicated = false;
    try {
      await mkdir(targetDir, { recursive: true, mode: 0o700 });
      try {
        await link(stagedPath, target);
      } catch (error) {
        if (errorCodeOf(error) !== 'EEXIST') throw error;
        await verifyExistingTarget(target, sha256, signal);
        deduplicated = true;
      }
      await unlink(stagedPath);
      await chmod(target, 0o400);
      await syncDir(targetDir);
      return { sha256, bytes, deduplicated };
    } catch (error) {
      await unlinkQuietly(stagedPath);
      if (signal?.aborted === true || error instanceof StorageError) throw error;
      throw toStorageIoError(error, { path: target, op: 'write' });
    }
  }

  async putFromFile(sourcePath: string, options: CasOperationOptions = {}): Promise<CasStoredObject> {
    const signal = options.signal;
    const chunkBytes = Math.min(Math.max(4096, options.chunkBytes ?? CAS_STREAM_CHUNK_BYTES), CAS_STREAM_CHUNK_BYTES);
    const casRoot = this.storage.pathFor(CAS_V2_SCOPE, '');
    for (let attempt = 0; attempt < MAX_SOURCE_STABILITY_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted();
      let before;
      try {
        before = await stat(sourcePath, { bigint: true });
      } catch (error) {
        throw toStorageIoError(error, { path: sourcePath, op: 'stat' });
      }
      if (!before.isFile()) {
        throw new StorageError(StorageErrors.codes.STORAGE_NOT_FOUND, `source path is not a regular file: ${sourcePath}`);
      }
      const flightKey =
        before.ino > 0n
          ? `${before.dev.toString(16)}:${before.ino.toString(16)}:${before.size.toString()}:${before.mtimeNs.toString()}:${before.ctimeNs.toString()}`
          : undefined;
      let stored: CasStoredObject;
      if (flightKey !== undefined && signal === undefined && casRoot !== undefined) {
        let pending = this.inFlightFiles.get(flightKey);
        const isLeader = pending === undefined;
        if (pending === undefined) {
          pending = this.putFromFileDirect(sourcePath, casRoot, chunkBytes);
          this.inFlightFiles.set(flightKey, pending);
        }
        try {
          const result = await pending;
          stored = isLeader ? result : { sha256: result.sha256, bytes: result.bytes, deduplicated: true };
        } finally {
          if (isLeader) this.inFlightFiles.delete(flightKey);
        }
      } else if (casRoot !== undefined) {
        stored = await this.putFromFileDirect(sourcePath, casRoot, chunkBytes, signal);
      } else {
        const stream = createReadStream(sourcePath, { highWaterMark: chunkBytes, signal });
        try {
          stored = await this.putStream(stream as AsyncIterable<Uint8Array>, { signal });
        } finally {
          stream.destroy();
        }
      }
      let after;
      try {
        after = await stat(sourcePath, { bigint: true });
      } catch (error) {
        if (attempt + 1 < MAX_SOURCE_STABILITY_ATTEMPTS) continue;
        throw toStorageIoError(error, { path: sourcePath, op: 'stat' });
      }
      const stable =
        after.isFile() &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs &&
        before.dev === after.dev &&
        before.ino === after.ino &&
        BigInt(stored.bytes) === after.size;
      if (stable) return stored;
    }
    throw new StorageError(
      StorageErrors.codes.STORAGE_IO_FAILED,
      `source file changed concurrently while archiving: ${sourcePath}`,
      { details: { path: sourcePath } },
    );
  }

  async has(sha256: string): Promise<boolean> {
    if (!SHA256_HEX_RE.test(sha256)) return false;
    return (await this.size(sha256)) !== undefined;
  }

  async size(sha256: string): Promise<number | undefined> {
    if (!SHA256_HEX_RE.test(sha256)) return undefined;
    const target = this.objectPath(sha256);
    if (target === undefined) return this.storage.size(CAS_V2_SCOPE, objectKeyFor(sha256));
    try {
      const info = await stat(target);
      return info.isFile() ? info.size : undefined;
    } catch (error) {
      if (errorCodeOf(error) === 'ENOENT') return undefined;
      throw toStorageIoError(error, { path: target, op: 'stat' });
    }
  }

  async get(sha256: string): Promise<Uint8Array | undefined> {
    if (!SHA256_HEX_RE.test(sha256)) return undefined;
    const target = this.objectPath(sha256);
    if (target === undefined) return this.storage.read(CAS_V2_SCOPE, objectKeyFor(sha256));
    try {
      return await readFile(target);
    } catch (error) {
      if (errorCodeOf(error) === 'ENOENT') return undefined;
      throw toStorageIoError(error, { path: target, op: 'read' });
    }
  }

  async *getStream(
    sha256: string,
    range?: BlobReadRange,
    options: CasOperationOptions = {},
  ): AsyncIterable<Uint8Array> {
    if (!SHA256_HEX_RE.test(sha256)) return;
    const chunkBytes = options.chunkBytes ?? CAS_STREAM_CHUNK_BYTES;
    const target = this.objectPath(sha256);
    if (target === undefined) {
      yield* this.storage.readStream(CAS_V2_SCOPE, objectKeyFor(sha256), range, {
        signal: options.signal,
        chunkBytes,
      });
      return;
    }
    const stream = createReadStream(target, {
      start: range?.start,
      end: range?.end,
      signal: options.signal,
      highWaterMark: chunkBytes,
    });
    try {
      for await (const chunk of stream) {
        yield chunk as Uint8Array;
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (errorCodeOf(error) === 'ENOENT') return;
      throw toStorageIoError(error, { path: target, op: 'read' });
    } finally {
      stream.destroy();
    }
  }

  async linkAlias(
    sha256: string,
    targetScope: string,
    targetKey: string,
    options: CasOperationOptions = {},
  ): Promise<string | undefined> {
    assertValidSha256(sha256);
    options.signal?.throwIfAborted();
    const targetPath = this.storage.pathFor(targetScope, targetKey);
    const sourcePath = this.objectPath(sha256);
    if (sourcePath === undefined || targetPath === undefined) {
      const data = await this.get(sha256);
      if (data === undefined) {
        throw new StorageError(StorageErrors.codes.STORAGE_NOT_FOUND, `CAS object not found: ${sha256}`);
      }
      await this.storage.write(targetScope, targetKey, data, { atomic: true, signal: options.signal });
      return targetPath;
    }
    await this.linkAliasToPath(sha256, targetPath, options);
    return targetPath;
  }

  async linkAliasToPath(
    sha256: string,
    targetPath: string,
    options: CasOperationOptions = {},
  ): Promise<void> {
    assertValidSha256(sha256);
    options.signal?.throwIfAborted();
    const sourcePath = this.objectPath(sha256);
    if (sourcePath === undefined) {
      throw new StorageError(StorageErrors.codes.STORAGE_IO_FAILED, 'CAS hard-link aliases require file-backed storage');
    }
    const targetDir = dirname(targetPath);
    try {
      await mkdir(targetDir, { recursive: true, mode: 0o700 });
      try {
        await link(sourcePath, targetPath);
      } catch (error) {
        const code = errorCodeOf(error);
        if (code === 'EXDEV') {
          await this.copyToPathAtomic(sha256, targetPath, options.signal);
          return;
        }
        if (code !== 'EEXIST') throw error;
        const actual = await digestFileStreaming(targetPath, options.signal).catch(() => undefined);
        if (actual === sha256) {
          await chmod(targetPath, 0o400).catch(() => undefined);
          return;
        }
        const tempAlias = `${targetPath}.cas.${process.pid}.${randomUUID()}`;
        try {
          await link(sourcePath, tempAlias);
          await replaceFileNonDestructive(tempAlias, targetPath, options.signal);
        } catch (replaceError) {
          await unlinkQuietly(tempAlias);
          throw replaceError;
        }
      }
      await chmod(targetPath, 0o400);
      await syncDir(targetDir);
    } catch (error) {
      if (options.signal?.aborted === true || error instanceof StorageError) throw error;
      throw toStorageIoError(error, { path: targetPath, op: 'write' });
    }
  }

  async removeUnreferenced(sha256: string): Promise<boolean> {
    if (!SHA256_HEX_RE.test(sha256)) return false;
    const target = this.objectPath(sha256);
    if (target === undefined) {
      await this.storage.delete(CAS_V2_SCOPE, objectKeyFor(sha256));
      return true;
    }
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if (errorCodeOf(error) === 'ENOENT') return false;
      throw toStorageIoError(error, { path: target, op: 'stat' });
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) return false;
    if (process.platform === 'win32') {
      await chmod(target, 0o600);
    }
    try {
      await unlink(target);
      return true;
    } catch (error) {
      if (errorCodeOf(error) === 'ENOENT') return false;
      throw toStorageIoError(error, { path: target, op: 'delete' });
    }
  }

  private async copyToPathAtomic(sha256: string, targetPath: string, signal?: AbortSignal): Promise<void> {
    const tempPath = `${targetPath}.cas.${process.pid}.${randomUUID()}`;
    let handle: FileHandle | undefined;
    try {
      handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      for await (const chunk of this.getStream(sha256, undefined, { signal })) {
        signal?.throwIfAborted();
        await handle.writeFile(chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await replaceFileNonDestructive(tempPath, targetPath, signal);
      await chmod(targetPath, 0o400).catch(() => undefined);
      await syncDir(dirname(targetPath));
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlinkQuietly(tempPath);
      throw error;
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IContentAddressedStore,
  ContentAddressedStoreService,
  ScopeActivation.OnScopeCreated,
  'contentAddressedStore',
);
