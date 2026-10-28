import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { type Entry, type ZipFile, fromBuffer as yauzlFromBuffer } from 'yauzl';

import { Error2, ErrorCodes } from '#/errors';

/** Hard ceilings for untrusted plugin downloads and extraction before consent. */
export const MAX_ZIP_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 20_000;

export async function downloadZip(url: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(5 * 60 * 1000);
  const downloadSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const resp = await fetch(url, { signal: downloadSignal });
  try {
    downloadSignal.throwIfAborted();
    if (!resp.ok) {
      throw new Error2(
        ErrorCodes.PLUGIN_LOAD_FAILED,
        `Failed to download zip: HTTP ${resp.status} ${resp.statusText}`,
        { details: { url, status: resp.status } },
      );
    }
    const declared = resp.headers.get('content-length');
    if (declared !== null && Number(declared) > MAX_ZIP_DOWNLOAD_BYTES) {
      throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Plugin zip exceeds the ${MAX_ZIP_DOWNLOAD_BYTES}-byte download limit`);
    }
    const reader = resp.body?.getReader();
    if (reader === undefined) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cancel = (): void => { void reader.cancel(downloadSignal.reason).catch(() => {}); };
    downloadSignal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        downloadSignal.throwIfAborted();
        const next = await reader.read();
        downloadSignal.throwIfAborted();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_ZIP_DOWNLOAD_BYTES) {
          throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Plugin zip exceeds the ${MAX_ZIP_DOWNLOAD_BYTES}-byte download limit`);
        }
        chunks.push(Buffer.from(next.value));
      }
      return Buffer.concat(chunks, bytes);
    } finally {
      downloadSignal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } finally {
    await resp.body?.cancel().catch(() => {});
  }
}

export async function extractZip(buffer: Buffer, destDir: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (buffer.byteLength > MAX_ZIP_DOWNLOAD_BYTES) {
    throw new Error2(
      ErrorCodes.PLUGIN_LOAD_FAILED,
      `Plugin zip exceeds the ${MAX_ZIP_DOWNLOAD_BYTES}-byte download limit`,
      { details: { bytes: buffer.byteLength } },
    );
  }
  await mkdir(destDir, { recursive: true });
  signal?.throwIfAborted();
  const zipfile = await new Promise<ZipFile>((resolve, reject) => {
    yauzlFromBuffer(buffer, { lazyEntries: true }, (error, file) => {
      if (error !== null || file === undefined) {
        reject(new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Failed to open zip: ${error?.message ?? 'unknown error'}`, { cause: error ?? undefined }));
      } else resolve(file);
    });
  });
  const failure = new AbortController();
  const extractionSignal = signal === undefined ? failure.signal : AbortSignal.any([signal, failure.signal]);
  const onError = (error: Error): void => { failure.abort(error); };
  const onAbort = (): void => { zipfile.close(); };
  zipfile.on('error', onError);
  extractionSignal.addEventListener('abort', onAbort, { once: true });
  const destDirResolved = path.resolve(destDir);
  let entryCount = 0;
  let totalUncompressed = 0;
  try {
    while (true) {
      extractionSignal.throwIfAborted();
      const entry = await nextZipEntry(zipfile, extractionSignal);
      if (entry === undefined) break;
      extractionSignal.throwIfAborted();
      entryCount += 1;
      totalUncompressed += entry.uncompressedSize;
      if (entryCount > MAX_ZIP_ENTRIES) {
        throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Plugin zip exceeds the ${MAX_ZIP_ENTRIES}-entry limit`, { details: { entries: entryCount } });
      }
      if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
        throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Plugin zip exceeds the ${MAX_ZIP_UNCOMPRESSED_BYTES}-byte uncompressed limit`, { details: { uncompressedBytes: totalUncompressed } });
      }
      const destPath = path.resolve(destDir, entry.fileName);
      if (destPath !== destDirResolved && !destPath.startsWith(destDirResolved + path.sep)) {
        throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Path traversal detected in zip entry: ${entry.fileName}`, { details: { entry: entry.fileName } });
      }
      if (entry.fileName.endsWith('/')) {
        await mkdir(destPath, { recursive: true });
        extractionSignal.throwIfAborted();
        continue;
      }
      await mkdir(path.dirname(destPath), { recursive: true });
      extractionSignal.throwIfAborted();
      const stream = await new Promise<import('node:stream').Readable>((resolve, reject) => {
        zipfile.openReadStream(entry, (error, opened) => {
          if (error !== null || opened === undefined) {
            reject(new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Failed to read ${entry.fileName} from archive: ${error?.message ?? 'unknown error'}`, { cause: error ?? undefined }));
          } else resolve(opened);
        });
      });
      try {
        extractionSignal.throwIfAborted();
        await pipeline(stream, createWriteStream(destPath), { signal: extractionSignal });
      } finally {
        stream.destroy();
      }
      extractionSignal.throwIfAborted();
      await restoreFilePermissions(destPath, entry);
      extractionSignal.throwIfAborted();
    }
    return await detectPluginRoot(destDir, extractionSignal);
  } finally {
    extractionSignal.removeEventListener('abort', onAbort);
    zipfile.close();
    zipfile.off('error', onError);
  }
}

function nextZipEntry(zipfile: ZipFile, signal: AbortSignal): Promise<Entry | undefined> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      zipfile.off('entry', onEntry);
      zipfile.off('end', onEnd);
      signal.removeEventListener('abort', onAbort);
    };
    const onEntry = (entry: Entry): void => { cleanup(); resolve(entry); };
    const onEnd = (): void => { cleanup(); resolve(undefined); };
    const onAbort = (): void => { cleanup(); reject(signal.reason); };
    zipfile.once('entry', onEntry);
    zipfile.once('end', onEnd);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else zipfile.readEntry();
  });
}

async function restoreFilePermissions(destPath: string, entry: Entry): Promise<void> {
  const mode = entry.externalFileAttributes >>> 16;
  if (mode === 0) return;
  const permissions = mode & 0o777;
  if (permissions === 0) return;
  await chmod(destPath, permissions);
}

async function detectPluginRoot(dir: string, signal: AbortSignal): Promise<string> {
  if (await hasManifest(dir, signal)) return dir;
  signal.throwIfAborted();
  const entries = await readdir(dir, { withFileTypes: true });
  signal.throwIfAborted();
  const childDirs = entries.filter((entry) => entry.isDirectory());
  const childDir = childDirs.length === 1 ? childDirs[0] : undefined;
  if (childDir !== undefined) {
    const child = path.join(dir, childDir.name);
    if (await hasManifest(child, signal)) return child;
  }
  return dir;
}

async function hasManifest(dir: string, signal: AbortSignal): Promise<boolean> {
  return (await isFile(path.join(dir, 'kimi.plugin.json'), signal)) ||
    (await isFile(path.join(dir, '.kimi-plugin', 'plugin.json'), signal));
}

async function isFile(file: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  try {
    const result = await stat(file);
    signal.throwIfAborted();
    return result.isFile();
  } catch {
    signal.throwIfAborted();
    return false;
  }
}
