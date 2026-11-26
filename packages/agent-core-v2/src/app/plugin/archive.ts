import { lookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { type Entry, type ZipFile, fromBuffer as yauzlFromBuffer } from 'yauzl';

import { Error2, ErrorCodes } from '#/errors';
import { isBlockedIp, isExplicitLoopbackHost, stripHostBrackets } from './networkSafety';

/** Hard ceilings for untrusted plugin downloads and extraction before consent. */
export const MAX_ZIP_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
export const MAX_ZIP_SINGLE_ENTRY_BYTES = MAX_ZIP_UNCOMPRESSED_BYTES;
export const MAX_ZIP_ENTRIES = 20_000;
const MAX_ZIP_REDIRECTS = 5;
const ORIGINAL_GLOBAL_FETCH = globalThis.fetch;

/** Optional internal ceiling overrides for unit tests; production uses the pinned defaults. */
export interface ArchiveLimits {
  maxDownloadBytes?: number;
  maxEntries?: number;
  maxUncompressedBytes?: number;
  maxSingleEntryBytes?: number;
}

/** Optional download safety and test overrides for plugin zip downloads. */
export interface DownloadZipOptions extends Pick<ArchiveLimits, 'maxDownloadBytes'> {
  readonly strictPublic?: boolean;
  readonly maxRedirects?: number;
  readonly lookupFn?: (hostname: string) => Promise<readonly { readonly address: string; readonly family?: number }[]>;
  readonly pinnedFetchFn?: (
    target: { readonly url: URL; readonly address: string; readonly family: 4 | 6 },
    signal: AbortSignal,
    maxDownloadBytes: number,
  ) => Promise<{ readonly status: number; readonly statusText: string; readonly location?: string; readonly bytes: Buffer }>;
}

interface ResolvedZipTarget {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function validateZipUrlSyntax(rawUrl: string, allowLoopback: boolean, strictPublic: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Invalid plugin zip URL: ${rawUrl}`, { details: { url: rawUrl } });
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, 'Plugin zip URL must not embed credentials', { details: { url: rawUrl } });
  }
  const explicitLoopback = isExplicitLoopbackHost(parsed.hostname);
  if (parsed.protocol === 'http:') {
    if (strictPublic || !allowLoopback || !explicitLoopback) {
      throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, 'Plugin zip URL must use HTTPS', { details: { url: rawUrl } });
    }
  } else if (parsed.protocol !== 'https:') {
    throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, 'Plugin zip URL must use HTTPS', { details: { url: rawUrl } });
  }
  const bare = stripHostBrackets(parsed.hostname).toLowerCase();
  if (bare === 'localhost' || bare.endsWith('.localhost')) {
    if (strictPublic || !allowLoopback) {
      throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, 'Plugin zip URL target address is blocked', { details: { url: rawUrl } });
    }
    return parsed;
  }
  if (isIP(bare) !== 0 && isBlockedIp(bare)) {
    if (strictPublic || !allowLoopback || !explicitLoopback) {
      throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, 'Plugin zip URL target address is blocked', { details: { url: rawUrl } });
    }
  }
  return parsed;
}

async function resolvePinnedZipTarget(
  parsed: URL,
  allowLoopback: boolean,
  strictPublic: boolean,
  lookupFn?: DownloadZipOptions['lookupFn'],
): Promise<ResolvedZipTarget> {
  const bare = stripHostBrackets(parsed.hostname);
  const explicitLoopback = isExplicitLoopbackHost(parsed.hostname);
  if (explicitLoopback) {
    if (strictPublic || !allowLoopback) {
      throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, 'Plugin zip URL target address is blocked', { details: { url: parsed.toString() } });
    }
    const address = bare.toLowerCase() === '::1' ? '::1' : '127.0.0.1';
    return { url: parsed, address, family: address === '::1' ? 6 : 4 };
  }
  const ipKind = isIP(bare);
  if (ipKind !== 0) {
    if (isBlockedIp(bare)) {
      throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, 'Plugin zip URL target address is blocked', { details: { url: parsed.toString() } });
    }
    return { url: parsed, address: bare, family: ipKind === 6 ? 6 : 4 };
  }
  const resolver = lookupFn ?? ((host: string) => lookup(host, { all: true }));
  let records: readonly { readonly address: string; readonly family?: number }[];
  try {
    records = await resolver(bare);
  } catch (error) {
    throw new Error2(
      ErrorCodes.PLUGIN_LOAD_FAILED,
      `Failed to resolve plugin zip host: ${bare}`,
      { cause: error, details: { url: parsed.toString() } },
    );
  }
  if (records.length === 0) {
    throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Failed to resolve plugin zip host: ${bare}`, { details: { url: parsed.toString() } });
  }
  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new Error2(
        ErrorCodes.PLUGIN_LOAD_FAILED,
        'Plugin zip URL resolved to a blocked private address',
        { details: { url: parsed.toString() } },
      );
    }
  }
  const first = records[0]!;
  const cleanAddress = stripHostBrackets(first.address);
  const family: 4 | 6 = first.family === 6 || isIP(cleanAddress) === 6 ? 6 : 4;
  return { url: parsed, address: cleanAddress, family };
}

function fetchPinnedZipHop(
  target: ResolvedZipTarget,
  signal: AbortSignal,
  maxDownloadBytes: number,
): Promise<{ readonly status: number; readonly statusText: string; readonly location?: string; readonly bytes: Buffer }> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
      return;
    }
    const requester = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requester(
      target.url,
      {
        method: 'GET',
        signal,
        lookup: (_hostname, opts, cb) => {
          if (opts !== undefined && typeof opts === 'object' && opts.all === true) {
            cb(null, [{ address: target.address, family: target.family }] as never);
          } else {
            cb(null, target.address, target.family);
          }
        },
        ...(target.url.protocol === 'https:' ? { servername: stripHostBrackets(target.url.hostname) } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const statusText = res.statusMessage ?? '';
        const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;
        if (isRedirectStatus(status)) {
          res.resume();
          resolvePromise({ status, statusText, location, bytes: Buffer.alloc(0) });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          resolvePromise({ status, statusText, location, bytes: Buffer.alloc(0) });
          return;
        }
        const declared = typeof res.headers['content-length'] === 'string' ? res.headers['content-length'] : undefined;
        if (declared !== undefined && Number(declared) > maxDownloadBytes) {
          res.destroy();
          rejectPromise(new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Plugin zip exceeds the ${maxDownloadBytes}-byte download limit`));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > maxDownloadBytes) {
            res.destroy();
            rejectPromise(new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Plugin zip exceeds the ${maxDownloadBytes}-byte download limit`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', (error) => rejectPromise(error));
        res.on('end', () => {
          resolvePromise({ status, statusText, location, bytes: Buffer.concat(chunks, bytes) });
        });
      },
    );
    req.on('error', (error) => rejectPromise(error));
    req.end();
  });
}

async function readFetchResponseBytes(resp: Response, downloadSignal: AbortSignal, maxDownloadBytes: number): Promise<Buffer> {
  const declared = resp.headers.get('content-length');
  if (declared !== null && Number(declared) > maxDownloadBytes) {
    throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Plugin zip exceeds the ${maxDownloadBytes}-byte download limit`);
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
      if (bytes > maxDownloadBytes) {
        throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Plugin zip exceeds the ${maxDownloadBytes}-byte download limit`);
      }
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    downloadSignal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function downloadZip(
  url: string,
  signal?: AbortSignal,
  limits?: DownloadZipOptions,
): Promise<Buffer> {
  const maxDownloadBytes = limits?.maxDownloadBytes ?? MAX_ZIP_DOWNLOAD_BYTES;
  const maxRedirects = limits?.maxRedirects ?? MAX_ZIP_REDIRECTS;
  const strictPublic = limits?.strictPublic === true;
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(5 * 60 * 1000);
  const downloadSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  const initialParsed = validateZipUrlSyntax(url, !strictPublic, strictPublic);
  const allowLoopback = !strictPublic && isExplicitLoopbackHost(initialParsed.hostname);
  const usePinnedTransport =
    limits?.pinnedFetchFn !== undefined
    || limits?.lookupFn !== undefined
    || globalThis.fetch === ORIGINAL_GLOBAL_FETCH;

  let currentUrl = initialParsed;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    downloadSignal.throwIfAborted();
    if (usePinnedTransport) {
      const target = await resolvePinnedZipTarget(currentUrl, allowLoopback, strictPublic, limits?.lookupFn);
      downloadSignal.throwIfAborted();
      const res = await (limits?.pinnedFetchFn ?? fetchPinnedZipHop)(target, downloadSignal, maxDownloadBytes);
      downloadSignal.throwIfAborted();
      if (isRedirectStatus(res.status)) {
        if (res.location === undefined || res.location.trim().length === 0) {
          throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Plugin zip redirect missing Location: HTTP ${res.status}`, { details: { url: currentUrl.toString(), status: res.status } });
        }
        if (hop === maxRedirects) {
          throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, 'Too many redirects downloading plugin zip', { details: { url: currentUrl.toString() } });
        }
        currentUrl = validateZipUrlSyntax(new URL(res.location, currentUrl).toString(), allowLoopback, strictPublic);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error2(
          ErrorCodes.PLUGIN_LOAD_FAILED,
          `Failed to download zip: HTTP ${res.status} ${res.statusText}`.trim(),
          { details: { url: currentUrl.toString(), status: res.status } },
        );
      }
      return res.bytes;
    }

    const resp = await fetch(currentUrl.toString(), { redirect: 'manual', signal: downloadSignal });
    try {
      downloadSignal.throwIfAborted();
      if (isRedirectStatus(resp.status)) {
        const location = resp.headers.get('location');
        if (location === null || location.trim().length === 0) {
          throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Plugin zip redirect missing Location: HTTP ${resp.status}`, { details: { url: currentUrl.toString(), status: resp.status } });
        }
        if (hop === maxRedirects) {
          throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, 'Too many redirects downloading plugin zip', { details: { url: currentUrl.toString() } });
        }
        currentUrl = validateZipUrlSyntax(new URL(location, currentUrl).toString(), allowLoopback, strictPublic);
        continue;
      }
      if (!resp.ok) {
        throw new Error2(
          ErrorCodes.PLUGIN_LOAD_FAILED,
          `Failed to download zip: HTTP ${resp.status} ${resp.statusText}`,
          { details: { url: currentUrl.toString(), status: resp.status } },
        );
      }
      return await readFetchResponseBytes(resp, downloadSignal, maxDownloadBytes);
    } finally {
      await resp.body?.cancel().catch(() => {});
    }
  }
  throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, 'Too many redirects downloading plugin zip', { details: { url } });
}

export async function extractZip(
  buffer: Buffer,
  destDir: string,
  signal?: AbortSignal,
  limits?: ArchiveLimits,
): Promise<string> {
  const maxDownloadBytes = limits?.maxDownloadBytes ?? MAX_ZIP_DOWNLOAD_BYTES;
  const maxEntries = limits?.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxUncompressedBytes = limits?.maxUncompressedBytes ?? MAX_ZIP_UNCOMPRESSED_BYTES;
  const maxSingleEntryBytes = limits?.maxSingleEntryBytes ?? maxUncompressedBytes;
  signal?.throwIfAborted();
  if (buffer.byteLength > maxDownloadBytes) {
    throw new Error2(
      ErrorCodes.PLUGIN_LOAD_FAILED,
      `Plugin zip exceeds the ${maxDownloadBytes}-byte download limit`,
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
      if (entryCount > maxEntries) {
        throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Plugin zip exceeds the ${maxEntries}-entry limit`, { details: { entries: entryCount } });
      }
      if (entry.uncompressedSize > maxSingleEntryBytes) {
        throw new Error2(
          ErrorCodes.PLUGIN_LOAD_FAILED,
          `Plugin zip entry ${entry.fileName} exceeds the ${maxSingleEntryBytes}-byte single-entry limit`,
          { details: { entry: entry.fileName, uncompressedBytes: entry.uncompressedSize } },
        );
      }
      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > maxUncompressedBytes) {
        throw new Error2(ErrorCodes.PLUGIN_LOAD_FAILED, `Plugin zip exceeds the ${maxUncompressedBytes}-byte uncompressed limit`, { details: { uncompressedBytes: totalUncompressed } });
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
