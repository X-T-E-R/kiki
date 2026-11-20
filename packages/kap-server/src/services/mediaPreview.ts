import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { compressImageForModel, MAX_IMAGE_DECODE_BYTES } from '@kiki/agent-core-v2/agent/media/image-compress';
import { sniffMediaFromMagic } from '@kiki/agent-core-v2/agent/media/file-type';
import type { SessionMediaFile } from '@kiki/agent-core-v2/agent/media/sessionMediaStore';

import { MEDIA_PREVIEW_MAX_BYTES } from '@kiki/protocol';

export const MEDIA_PREVIEW_BYTES = MEDIA_PREVIEW_MAX_BYTES;
export const MEDIA_PREVIEW_EDGE = 768;

const DEFAULT_PREVIEW_RESULT_CACHE_MAX_ENTRIES = 256;
const DEFAULT_PREVIEW_RESULT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const DISK_CACHE_SUBDIR = ['cache', 'media-previews-v1'] as const;
const DISK_CACHE_FORMAT_VERSION = 1;
const DEFAULT_DISK_CACHE_MAX_ENTRIES = 512;
const DEFAULT_DISK_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const DEFAULT_FFMPEG_TIMEOUT_MS = 10_000;
let diskTempCounter = 0;
let diskWritesSinceSweep = 0;
const sweepingDirs = new Set<string>();

function readPositiveIntEnv(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.min(max, parsed);
}

function defaultPreviewConcurrency(): number {
  const workers = typeof availableParallelism === 'function' ? availableParallelism() : 4;
  return Math.max(2, Math.min(8, Math.floor(workers / 2) || 2));
}

function configuredPreviewCacheMaxEntries(): number {
  return readPositiveIntEnv('KIKI_MEDIA_PREVIEW_CACHE_MAX_ENTRIES', DEFAULT_PREVIEW_RESULT_CACHE_MAX_ENTRIES, 1, 65_536);
}

function configuredPreviewCacheMaxBytes(): number {
  return readPositiveIntEnv('KIKI_MEDIA_PREVIEW_CACHE_MAX_BYTES', DEFAULT_PREVIEW_RESULT_CACHE_MAX_BYTES, 64 * 1024, 1024 * 1024 * 1024);
}

function configuredDiskCacheMaxEntries(): number {
  return readPositiveIntEnv('KIKI_MEDIA_PREVIEW_DISK_CACHE_MAX_ENTRIES', DEFAULT_DISK_CACHE_MAX_ENTRIES, 1, 100_000);
}

function configuredDiskCacheMaxBytes(): number {
  return readPositiveIntEnv('KIKI_MEDIA_PREVIEW_DISK_CACHE_MAX_BYTES', DEFAULT_DISK_CACHE_MAX_BYTES, 1024 * 1024, 4 * 1024 * 1024 * 1024);
}

function configuredPreviewConcurrency(): number {
  return readPositiveIntEnv('KIKI_MEDIA_PREVIEW_CONCURRENCY', defaultPreviewConcurrency(), 1, 64);
}

function configuredFfmpegTimeoutMs(): number {
  return readPositiveIntEnv('KIKI_MEDIA_PREVIEW_FFMPEG_TIMEOUT_MS', DEFAULT_FFMPEG_TIMEOUT_MS, 500, 120_000);
}

/** Optional capacity and decode-concurrency overrides for a media preview cache instance. */
export interface MediaPreviewCacheOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxConcurrency?: number;
}

/** Per-server bounded memory cache, decode concurrency gate, and single-flight deduplicator for rendered media previews. */
export class MediaPreviewCache {
  private readonly cache = new Map<string, { readonly bytes: Uint8Array; readonly mime: string }>();
  private cacheBytes = 0;
  private readonly flights = new Map<string, {
    readonly controller: AbortController;
    users: number;
    readonly promise: Promise<{ bytes: Uint8Array; mime: string }>;
  }>();
  private activeComputes = 0;
  private readonly computeWaiters: Array<{ readonly enter: () => void; readonly cancel: () => void }> = [];
  private readonly options: MediaPreviewCacheOptions;

  constructor(options: MediaPreviewCacheOptions = {}) {
    this.options = options;
  }

  private maxEntries(): number {
    return this.options.maxEntries ?? configuredPreviewCacheMaxEntries();
  }

  private maxBytes(): number {
    return this.options.maxBytes ?? configuredPreviewCacheMaxBytes();
  }

  private maxConcurrency(): number {
    return this.options.maxConcurrency ?? configuredPreviewConcurrency();
  }

  runBounded<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new Error('Media preview cancelled'));
    }
    const execute = async (): Promise<T> => {
      this.activeComputes += 1;
      try {
        signal.throwIfAborted();
        return await work();
      } finally {
        this.activeComputes -= 1;
        this.pumpWaiters();
      }
    };
    if (this.activeComputes < this.maxConcurrency()) {
      return execute();
    }
    return new Promise<T>((resolve, reject) => {
      const waiter = {
        enter: () => {
          signal.removeEventListener('abort', waiter.cancel);
          resolve(execute());
        },
        cancel: () => {
          const index = this.computeWaiters.indexOf(waiter);
          if (index >= 0) this.computeWaiters.splice(index, 1);
          signal.removeEventListener('abort', waiter.cancel);
          reject(signal.reason ?? new Error('Media preview cancelled'));
        },
      };
      this.computeWaiters.push(waiter);
      signal.addEventListener('abort', waiter.cancel, { once: true });
    });
  }

  private pumpWaiters(): void {
    while (this.activeComputes < this.maxConcurrency() && this.computeWaiters.length > 0) {
      const next = this.computeWaiters.shift();
      next?.enter();
    }
  }

  get(key: string): { readonly bytes: Uint8Array; readonly mime: string } | undefined {
    const cached = this.cache.get(key);
    if (cached === undefined) return undefined;
    this.cache.delete(key);
    this.cache.set(key, cached);
    return cached;
  }

  store(key: string, result: { readonly bytes: Uint8Array; readonly mime: string }): void {
    const maxBytes = this.maxBytes();
    const maxEntries = this.maxEntries();
    if (result.bytes.byteLength > maxBytes) return;
    const previous = this.cache.get(key);
    if (previous !== undefined) {
      this.cache.delete(key);
      this.cacheBytes -= previous.bytes.byteLength;
    }
    this.cache.set(key, result);
    this.cacheBytes += result.bytes.byteLength;
    while (this.cache.size > maxEntries || this.cacheBytes > maxBytes) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.cache.get(oldest)!;
      this.cacheBytes -= entry.bytes.byteLength;
      this.cache.delete(oldest);
    }
  }

  sharedFlight(
    key: string,
    signal: AbortSignal,
    compute: (signal: AbortSignal) => Promise<{ bytes: Uint8Array; mime: string }>,
    persistToDisk: boolean,
  ): Promise<{ bytes: Uint8Array; mime: string }> {
    const flightKey = `${persistToDisk ? 'disk' : 'mem'}\0${key}`;
    let flight = this.flights.get(flightKey);
    if (flight === undefined) {
      const controller = new AbortController();
      const promise = (async () => {
        if (persistToDisk) {
          const diskHit = await readDiskCachedPreview(key, controller.signal);
          if (diskHit !== undefined) {
            this.store(key, diskHit);
            return diskHit;
          }
        }
        const computed = await this.runBounded(controller.signal, () => compute(controller.signal));
        this.store(key, computed);
        if (persistToDisk) {
          void writeDiskCachedPreview(key, computed);
        }
        return computed;
      })();
      flight = { controller, users: 0, promise };
      this.flights.set(flightKey, flight);
      const current = flight;
      const clear = () => {
        if (this.flights.get(flightKey) === current) this.flights.delete(flightKey);
      };
      void current.promise.then(clear, clear);
    }
    const current = flight;
    current.users += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (done: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        current.users -= 1;
        if (current.users === 0 && this.flights.get(flightKey) === current) {
          this.flights.delete(flightKey);
          current.controller.abort();
        }
        done();
      };
      const cancel = () => {
        finish(() => { reject(signal.reason ?? new Error('Media preview cancelled')); });
      };
      signal.addEventListener('abort', cancel, { once: true });
      void current.promise.then(
        (value) => { finish(() => { resolve(value); }); },
        (error: unknown) => { finish(() => { reject(error); }); },
      );
    });
  }

  clear(): void {
    this.cache.clear();
    this.cacheBytes = 0;
  }
}

const defaultPreviewCache = new MediaPreviewCache();

export class MediaPreviewUnavailableError extends Error {}

export function clearMediaPreviewMemoryCacheForTest(): void {
  defaultPreviewCache.clear();
}

export interface CreateMediaPreviewOptions {
  readonly persistToDisk?: boolean;
  readonly cache?: MediaPreviewCache;
}

export async function createMediaPreview(
  file: SessionMediaFile,
  mediaType: string | undefined,
  signal: AbortSignal,
  cacheKey?: string,
  options?: CreateMediaPreviewOptions,
): Promise<{ bytes: Uint8Array; mime: string }> {
  signal.throwIfAborted();
  const persistToDisk = options?.persistToDisk ?? true;
  const cache = options?.cache ?? defaultPreviewCache;
  if (cacheKey !== undefined && cacheKey.length > 0) {
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    return cache.sharedFlight(
      cacheKey,
      signal,
      (flightSignal) => computeMediaPreview(file, mediaType, flightSignal),
      persistToDisk,
    );
  }
  return cache.runBounded(signal, () => computeMediaPreview(file, mediaType, signal));
}

function resolveDiskCacheEntryPath(key: string): { readonly dir: string; readonly filePath: string } | undefined {
  const sep = key.indexOf('\0');
  if (sep <= 0) return undefined;
  const homeDir = key.slice(0, sep);
  const digest = createHash('sha256').update(key).digest('hex');
  const dir = join(homeDir, ...DISK_CACHE_SUBDIR);
  return { dir, filePath: join(dir, `${digest}.bin`) };
}

async function readDiskCachedPreview(
  key: string,
  signal: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly mime: string } | undefined> {
  const location = resolveDiskCacheEntryPath(key);
  if (location === undefined) return undefined;
  try {
    const raw = await readFile(location.filePath);
    signal.throwIfAborted();
    if (raw.byteLength < 3 || raw[0] !== DISK_CACHE_FORMAT_VERSION) return undefined;
    const mimeLength = raw[1]!;
    if (mimeLength === 0 || raw.byteLength <= 2 + mimeLength) return undefined;
    const mime = raw.subarray(2, 2 + mimeLength).toString('utf8');
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset + 2 + mimeLength, raw.byteLength - 2 - mimeLength);
    if (bytes.byteLength > MEDIA_PREVIEW_BYTES) return undefined;
    return { bytes, mime };
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
}

async function writeDiskCachedPreview(
  key: string,
  result: { readonly bytes: Uint8Array; readonly mime: string },
): Promise<void> {
  const location = resolveDiskCacheEntryPath(key);
  if (location === undefined || result.bytes.byteLength === 0 || result.bytes.byteLength > MEDIA_PREVIEW_BYTES) return;
  const mimeBytes = Buffer.from(result.mime, 'utf8');
  if (mimeBytes.byteLength === 0 || mimeBytes.byteLength > 255) return;
  const payload = Buffer.allocUnsafe(2 + mimeBytes.byteLength + result.bytes.byteLength);
  payload[0] = DISK_CACHE_FORMAT_VERSION;
  payload[1] = mimeBytes.byteLength;
  mimeBytes.copy(payload, 2);
  payload.set(result.bytes, 2 + mimeBytes.byteLength);
  const tempPath = `${location.filePath}.tmp.${process.pid}.${++diskTempCounter}`;
  try {
    await mkdir(location.dir, { recursive: true });
    await writeFile(tempPath, payload);
    await rename(tempPath, location.filePath);
    if ((++diskWritesSinceSweep & 31) === 0) void sweepDiskPreviewCache(location.dir);
  } catch {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function sweepDiskPreviewCache(dir: string): Promise<void> {
  if (sweepingDirs.has(dir)) return;
  sweepingDirs.add(dir);
  const maxEntries = configuredDiskCacheMaxEntries();
  const maxBytes = configuredDiskCacheMaxBytes();
  try {
    const names = (await readdir(dir)).filter((name) => name.endsWith('.bin'));
    if (names.length <= maxEntries / 2) return;
    const infos: { readonly path: string; readonly size: number; readonly mtimeMs: number }[] = [];
    let totalBytes = 0;
    for (const name of names) {
      const path = join(dir, name);
      const info = await stat(path).catch(() => undefined);
      if (info === undefined || !info.isFile()) continue;
      infos.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      totalBytes += info.size;
    }
    if (infos.length <= maxEntries && totalBytes <= maxBytes) return;
    infos.sort((left, right) => left.mtimeMs - right.mtimeMs);
    let remainingCount = infos.length;
    for (const entry of infos) {
      if (remainingCount <= maxEntries && totalBytes <= maxBytes) break;
      await rm(entry.path, { force: true }).catch(() => undefined);
      remainingCount -= 1;
      totalBytes -= entry.size;
    }
  } catch {
  } finally {
    sweepingDirs.delete(dir);
  }
}

async function computeMediaPreview(file: SessionMediaFile, mediaType: string | undefined, signal: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }> {
  signal.throwIfAborted();
  if (file.size === 0) throw new MediaPreviewUnavailableError('This media is empty. Open or download the original.');
  let mime = file.mediaType === 'application/octet-stream' ? mediaType : file.mediaType;
  if (mime === undefined || mime === 'application/octet-stream') {
    for await (const chunk of file.stream({ start: 0, end: Math.min(511, file.size - 1) })) {
      signal.throwIfAborted();
      mime = sniffMediaFromMagic(chunk)?.mimeType;
      break;
    }
  }
  if (mime?.startsWith('video/')) return { bytes: await videoPoster(file, signal), mime: 'image/jpeg' };
  if (!mime?.startsWith('image/')) throw new MediaPreviewUnavailableError('This media has no image preview. Open or download the original.');
  if (file.size > MAX_IMAGE_DECODE_BYTES) throw new MediaPreviewUnavailableError('This image is too large to decode as a preview. Open or download the original.');
  const bytes = await readPreviewSource(file, signal);
  const sourceMime = sniffMediaFromMagic(bytes)?.mimeType ?? mime;
  const image = await compressImageForModel(bytes, sourceMime, { maxEdge: MEDIA_PREVIEW_EDGE, byteBudget: MEDIA_PREVIEW_BYTES, maxDecodeBytes: MAX_IMAGE_DECODE_BYTES, outputMimes: new Set(['image/jpeg']), acceptedMimes: new Set(['image/png', 'image/jpeg']), signal });
  signal.throwIfAborted();
  if (image.data.byteLength > MEDIA_PREVIEW_BYTES || image.width <= 0 || image.height <= 0 || image.width > MEDIA_PREVIEW_EDGE || image.height > MEDIA_PREVIEW_EDGE) throw new MediaPreviewUnavailableError('This image could not be reduced to a small preview. Open or download the original.');
  return { bytes: image.data, mime: image.mimeType };
}

async function readPreviewSource(file: SessionMediaFile, signal: AbortSignal): Promise<Uint8Array> {
  const input = Readable.from(file.stream());
  const onAbort = () => input.destroy(new Error('Media preview cancelled'));
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const value of input) {
      signal.throwIfAborted();
      const chunk = value as Uint8Array;
      size += chunk.byteLength;
      if (size > MAX_IMAGE_DECODE_BYTES) throw new MediaPreviewUnavailableError('Image preview decode limit exceeded. Open or download the original.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', onAbort);
    input.destroy();
  }
}

function videoPoster(file: SessionMediaFile, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vf', 'scale=384:384:force_original_aspect_ratio=decrease', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '8', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const source = Readable.from(file.stream());
    const chunks: Uint8Array[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      source.destroy();
      child.stdin.destroy();
      if (error !== undefined) { child.kill(); reject(error); }
      else resolve(Buffer.concat(chunks, size));
    };
    const onAbort = () => finish(new Error('Media preview cancelled'));
    const timer = setTimeout(() => finish(new MediaPreviewUnavailableError('Video preview timed out. Open or download the original.')), configuredFfmpegTimeoutMs());
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', () => finish(new MediaPreviewUnavailableError('Video previews require ffmpeg. Open or download the original.')));
    child.stdout.on('data', (chunk: Uint8Array) => {
      size += chunk.byteLength;
      if (size > MEDIA_PREVIEW_BYTES) finish(new MediaPreviewUnavailableError('Video preview exceeded its size budget. Open or download the original.'));
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => source.destroy());
    source.on('error', () => finish(new MediaPreviewUnavailableError('Video source could not be read. Open or download the original.')));
    child.on('close', (code) => finish(code === 0 && size > 0 ? undefined : new MediaPreviewUnavailableError('Video preview could not be decoded. Open or download the original.')));
    if (signal.aborted) onAbort();
    else source.pipe(child.stdin);
  });
}
