import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rmdir } from 'node:fs/promises';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  constants as zlibConstants,
  deflateRaw,
  inflateRaw,
  zstdCompress,
  zstdDecompress,
} from 'node:zlib';

import { dirname, resolve } from 'pathe';

import { BugIndicatingError } from '#/_base/errors/errors';
import { abortable } from '#/_base/utils/abort';
import { acquireSharedReadLease, waitSharedReadIdle, withColdReaderGate } from '#/persistence/backends/node-fs/fileLock';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import {
  allocatedFileBytes,
  captureFileBasicTimes,
  clipSparseRanges,
  DEFAULT_KEEP_HEAD_BYTES,
  isSparseFile,
  mergeSparseRanges,
  planSparseRanges,
  punchSparseRanges,
  restoreFileBasicTimes,
  subtractSparseRanges,
  writeFileAtomicNoUnlink,
} from '#/persistence/backends/node-fs/sparseFile';
import type {
  ColdSealCodec,
  ColdSealOptions,
  ColdSealResult,
  ColdSparseRange,
} from '#/persistence/interface/appendLogStore';
import {
  StorageError,
  StorageErrors,
  type IFileSystemStorageService,
  type StorageReadOptions,
  type StorageReadRange,
} from '#/persistence/interface/storage';

export const COLD_SEGMENT_BYTES = 8 * 1024 * 1024;
export const COLD_ZSTD_SEGMENT_BYTES = 4 * 1024 * 1024;
export const COLD_DEFLATE_LEVEL = 6;
export const COLD_ZSTD_LEVEL = 3;
const MAX_SEGMENTS = 16384;
const YIELD_BYTES = 64 * 1024;
const SEAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNSEALED_PIN_ID = '__unsealed__';

const deflateRawAsync = promisify(deflateRaw);
const inflateRawAsync = promisify(inflateRaw);
const zstdCompressAsync = promisify(zstdCompress);
const zstdDecompressAsync = promisify(zstdDecompress);

export interface ColdUnsealOptions {
  readonly skipRestoreOriginal?: boolean;
  readonly forceRestoreOriginal?: boolean;
  readonly requireValidManifest?: boolean;
  readonly signal?: AbortSignal;
}

export interface ColdUnsealResult {
  readonly hadManifest: boolean;
  readonly restoredOriginal: boolean;
  readonly restoredBytes: number;
  readonly verifiedSegments: number;
}

export interface ColdManifestSummary {
  readonly format: 1 | 2;
  readonly codec: ColdSealCodec;
  readonly sealedCut: number;
  readonly logicalSize: number;
  readonly originalRetained: boolean;
}

interface ColdSegment {
  readonly logicalStart: number;
  readonly logicalEnd: number;
  readonly uncompressedSha256: string;
  readonly key: string;
}

interface ColdManifest {
  readonly format: 1 | 2;
  readonly codec: ColdSealCodec;
  readonly level: number;
  readonly segmentBytes: number;
  readonly sealedCut: number;
  readonly logicalSize: number;
  readonly generation: string;
  readonly sealId: string;
  readonly originalRetained: boolean;
  readonly sparseRanges: readonly ColdSparseRange[];
  readonly segments: readonly ColdSegment[];
}

interface ColdTurn {
  readonly ready: Promise<void>;
  readonly finish: () => void;
}

const coldChains = new Map<string, Promise<void>>();

interface SealPin {
  count: number;
  readonly waiters: Array<() => void>;
}

const sealPins = new Map<string, SealPin>();
const memoryIds = new WeakMap<object, string>();
let memorySerial = 0;

function resourceId(storage: IFileSystemStorageService, scope: string, key: string): string {
  const located = storage.pathFor(scope, key);
  if (located !== undefined && located.length > 0) {
    const absolute = resolve(located);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  }
  let token = memoryIds.get(storage);
  if (token === undefined) {
    memorySerial += 1;
    token = `memory:${memorySerial.toString(10)}`;
    memoryIds.set(storage, token);
  }
  return `${token}\0${scope}\0${key}`;
}

function pinId(storage: IFileSystemStorageService, scope: string, key: string, sealId: string): string {
  return `${resourceId(storage, scope, key)}\0${sealId}`;
}

function locatedJournal(storage: IFileSystemStorageService, scope: string, key: string): string | undefined {
  const located = storage.pathFor(scope, key);
  if (located === undefined || located.length === 0) return undefined;
  return located;
}

async function pinSeal(storage: IFileSystemStorageService, scope: string, key: string, sealId: string): Promise<() => void> {
  const located = locatedJournal(storage, scope, key);
  const lease = located === undefined ? undefined : await acquireSharedReadLease(located);
  try {
    const id = pinId(storage, scope, key, sealId);
    const entry = sealPins.get(id) ?? { count: 0, waiters: [] };
    entry.count += 1;
    sealPins.set(id, entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      void lease?.release();
      entry.count -= 1;
      if (entry.count > 0) return;
      sealPins.delete(id);
      const waiters = entry.waiters.splice(0);
      for (const wake of waiters) wake();
    };
  } catch (error) {
    void lease?.release();
    throw error;
  }
}

async function waitInProcessPin(storage: IFileSystemStorageService, scope: string, key: string, sealId: string): Promise<void> {
  const entry = sealPins.get(pinId(storage, scope, key, sealId));
  if (entry !== undefined && entry.count > 0) {
    await new Promise<void>((resolvePromise) => {
      entry.waiters.push(resolvePromise);
    });
  }
}

async function waitUnpinned(storage: IFileSystemStorageService, scope: string, key: string, sealId: string): Promise<void> {
  await waitInProcessPin(storage, scope, key, sealId);
  const located = locatedJournal(storage, scope, key);
  if (located !== undefined) await waitSharedReadIdle(located);
}

export async function waitActiveReadersIdle(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
): Promise<void> {
  const prefix = `${resourceId(storage, scope, key)}\0`;
  for (;;) {
    const pending: Promise<void>[] = [];
    for (const [id, entry] of sealPins) {
      if (!id.startsWith(prefix) || entry.count <= 0) continue;
      pending.push(
        new Promise<void>((resolvePromise) => {
          entry.waiters.push(resolvePromise);
        }),
      );
    }
    if (pending.length === 0) break;
    await Promise.all(pending);
  }
  const located = locatedJournal(storage, scope, key);
  if (located !== undefined) await waitSharedReadIdle(located);
}

function takeTurn(storage: IFileSystemStorageService, scope: string, key: string): ColdTurn {
  const id = resourceId(storage, scope, key);
  let finish!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    finish = resolvePromise;
  });
  const ready = (coldChains.get(id) ?? Promise.resolve()).then(() => undefined, () => undefined);
  coldChains.set(id, current);
  void current.finally(() => {
    if (coldChains.get(id) === current) coldChains.delete(id);
  });
  return { ready, finish };
}

/** Cancelling a waiter preserves the preceding operation's place before releasing its turn. */
export async function withColdExclusive<T>(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  body: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const turn = takeTurn(storage, scope, key);
  let entered = false;
  try {
    await (signal === undefined ? turn.ready : abortable(turn.ready, signal));
    entered = true;
    signal?.throwIfAborted();
    return await body();
  } finally {
    if (entered) turn.finish();
    else void turn.ready.then(turn.finish);
  }
}

export function coldManifestKey(key: string): string {
  return `${key}.segments.json`;
}

function coldSegmentExtension(codec: ColdSealCodec): string {
  return codec === 'zstd' ? 'zst' : 'deflate';
}

function coldSegmentKey(key: string, sealId: string, index: number, codec: ColdSealCodec): string {
  return `${key}.segments/${sealId}/${index.toString(10).padStart(6, '0')}.${coldSegmentExtension(codec)}`;
}

function compressedInputLimit(outputBytes: number): number {
  return outputBytes + Math.ceil(outputBytes / 16) + 1024;
}

function corrupted(scope: string, key: string, reason: string, cause?: unknown): StorageError {
  return new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, `Cold journal cannot be read (${reason})`, {
    details: { scope, key, reason },
    cause,
  });
}

function requireCut(sealedCut: number, size: number): void {
  if (!Number.isSafeInteger(sealedCut) || sealedCut < 0 || sealedCut > size) {
    throw new BugIndicatingError('cold seal cut is outside the journal');
  }
}

function requireSegmentBytes(segmentBytes: number): number {
  if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 1 || segmentBytes > COLD_SEGMENT_BYTES) {
    throw new BugIndicatingError('cold segment size is outside 1..8MiB');
  }
  return segmentBytes;
}

function requireCodecLevel(codec: ColdSealCodec, level: number): number {
  if (!Number.isSafeInteger(level)) {
    throw new BugIndicatingError('cold compression level must be an integer');
  }
  if (codec === 'deflate-raw' && (level < 1 || level > 9)) {
    throw new BugIndicatingError('deflate-raw level must be within 1..9');
  }
  if (codec === 'zstd' && (level < -7 || level > 22)) {
    throw new BugIndicatingError('zstd level must be within -7..22');
  }
  return level;
}

async function compressSegment(
  plain: Uint8Array,
  codec: ColdSealCodec,
  level: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const promise = codec === 'zstd'
    ? zstdCompressAsync(plain, { params: { [zlibConstants.ZSTD_c_compressionLevel]: level } })
    : deflateRawAsync(plain, { level });
  const buf = signal === undefined ? await promise : await abortable(promise, signal);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function decompressBounded(
  compressed: Uint8Array,
  codec: ColdSealCodec,
  outputBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (compressed.byteLength > compressedInputLimit(outputBytes)) {
    throw Object.assign(new Error(`${codec} input exceeds the segment bound`), { code: 'ERR_BUFFER_TOO_LARGE' });
  }
  const promise = codec === 'zstd'
    ? zstdDecompressAsync(compressed, { maxOutputLength: outputBytes })
    : inflateRawAsync(compressed, { maxOutputLength: outputBytes });
  const buf = signal === undefined ? await promise : await abortable(promise, signal);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function writeManifestAtomic(
  storage: IFileSystemStorageService,
  scope: string,
  manifestKey: string,
  encoded: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  const located = storage.pathFor(scope, manifestKey);
  if (
    located !== undefined &&
    located.length > 0 &&
    storage.write === FileStorageService.prototype.write
  ) {
    await mkdir(dirname(located), { recursive: true });
    await writeFileAtomicNoUnlink(located, encoded, signal);
    return;
  }
  await storage.write(scope, manifestKey, encoded, { atomic: true, signal });
}

async function readRawExact(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  start: number,
  end: number,
  options?: StorageReadOptions,
): Promise<Uint8Array> {
  if (end < start) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of storage.readStream(scope, key, { start, end }, options)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readManifestRange(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  manifest: ColdManifest,
  start: number,
  end: number,
  options?: StorageReadOptions,
): Promise<Uint8Array> {
  if (end < start) return new Uint8Array();
  const out = new Uint8Array(end - start + 1);
  let written = 0;
  for await (const chunk of readPinned(storage, scope, key, manifest, { start, end }, options)) {
    out.set(chunk, written);
    written += chunk.byteLength;
  }
  if (written !== out.byteLength) throw corrupted(scope, key, 'short-read');
  return out;
}

async function readSourceExact(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  previousManifest: ColdManifest | undefined,
  start: number,
  end: number,
  options?: StorageReadOptions,
): Promise<Uint8Array> {
  if (end < start) return new Uint8Array();
  if (previousManifest === undefined || start >= previousManifest.sealedCut) {
    return readRawExact(storage, scope, key, start, end, options);
  }
  if (end < previousManifest.sealedCut) {
    return readManifestRange(storage, scope, key, previousManifest, start, end, options);
  }
  const coldPart = await readManifestRange(
    storage,
    scope,
    key,
    previousManifest,
    start,
    previousManifest.sealedCut - 1,
    options,
  );
  const hotPart = await readRawExact(
    storage,
    scope,
    key,
    previousManifest.sealedCut,
    end,
    options,
  );
  const combined = new Uint8Array(coldPart.byteLength + hotPart.byteLength);
  combined.set(coldPart, 0);
  combined.set(hotPart, coldPart.byteLength);
  return combined;
}

async function generationOf(storage: IFileSystemStorageService, scope: string, key: string): Promise<string> {
  const bytes = await storage.read(scope, `${key}.generation`);
  return bytes === undefined ? 'legacy' : new TextDecoder().decode(bytes);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function planSegments(
  key: string,
  sealId: string,
  sealedCut: number,
  segmentBytes: number,
  codec: ColdSealCodec,
): ColdSegment[] | undefined {
  if (!SEAL_ID.test(sealId) || segmentBytes < 1 || Math.ceil(sealedCut / segmentBytes) > MAX_SEGMENTS) return undefined;
  const segments: ColdSegment[] = [];
  let start = 0;
  while (start < sealedCut) {
    const end = Math.min(sealedCut, start + segmentBytes);
    segments.push({
      logicalStart: start,
      logicalEnd: end,
      uncompressedSha256: '',
      key: coldSegmentKey(key, sealId, segments.length, codec),
    });
    start = end;
  }
  return segments;
}

function parseSparseRanges(value: unknown, sealedCut: number): readonly ColdSparseRange[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const ranges: ColdSparseRange[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const raw = item as Record<string, unknown>;
    const start = raw['start'];
    const end = raw['end'];
    if (
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > sealedCut
    ) {
      return undefined;
    }
    ranges.push({ start, end });
  }
  return ranges;
}

function isManifest(value: unknown, key: string): ColdManifest | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const format = raw['format'];
  const codec = raw['codec'];
  const level = raw['level'];
  if (format !== 1 && format !== 2) return undefined;
  if (format === 1 && (codec !== 'deflate-raw' || level !== COLD_DEFLATE_LEVEL)) return undefined;
  if (codec !== 'deflate-raw' && codec !== 'zstd') return undefined;
  if (typeof level !== 'number' || !Number.isSafeInteger(level)) return undefined;
  if (codec === 'deflate-raw' && (level < 1 || level > 9)) return undefined;
  if (codec === 'zstd' && (level < -7 || level > 22)) return undefined;
  const segmentBytes = raw['segmentBytes'];
  const sealedCut = raw['sealedCut'];
  const logicalSize = raw['logicalSize'];
  const generation = raw['generation'];
  const sealId = raw['sealId'];
  const listed = raw['segments'];
  if (!Number.isSafeInteger(segmentBytes) || (segmentBytes as number) < 1 || (segmentBytes as number) > COLD_SEGMENT_BYTES) return undefined;
  if (!Number.isSafeInteger(sealedCut) || (sealedCut as number) < 0) return undefined;
  if (!Number.isSafeInteger(logicalSize) || (logicalSize as number) < (sealedCut as number)) return undefined;
  if (typeof generation !== 'string' || typeof sealId !== 'string' || !Array.isArray(listed)) return undefined;
  const originalRetained = format === 1 ? true : raw['originalRetained'];
  if (typeof originalRetained !== 'boolean') return undefined;
  const sparseRanges = format === 1 ? [] : parseSparseRanges(raw['sparseRanges'], sealedCut as number);
  if (sparseRanges === undefined) return undefined;
  const expected = planSegments(key, sealId, sealedCut as number, segmentBytes as number, codec);
  if (expected === undefined || listed.length !== expected.length) return undefined;
  const segments: ColdSegment[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const item = listed[index];
    const plan = expected[index]!;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const segment = item as Record<string, unknown>;
    if (segment['logicalStart'] !== plan.logicalStart || segment['logicalEnd'] !== plan.logicalEnd) return undefined;
    if (segment['key'] !== plan.key || typeof segment['uncompressedSha256'] !== 'string' || segment['uncompressedSha256'].length !== 64) return undefined;
    segments.push({
      logicalStart: plan.logicalStart,
      logicalEnd: plan.logicalEnd,
      key: plan.key,
      uncompressedSha256: segment['uncompressedSha256'],
    });
  }
  return {
    format,
    codec,
    level,
    segmentBytes: segmentBytes as number,
    sealedCut: sealedCut as number,
    logicalSize: logicalSize as number,
    generation,
    sealId,
    originalRetained,
    sparseRanges,
    segments,
  };
}

function serializeValidatedManifest(manifest: ColdManifest, key: string): Uint8Array {
  const payload = manifest.format === 1
    ? {
        format: 1,
        codec: manifest.codec,
        level: manifest.level,
        segmentBytes: manifest.segmentBytes,
        sealedCut: manifest.sealedCut,
        logicalSize: manifest.logicalSize,
        generation: manifest.generation,
        sealId: manifest.sealId,
        segments: manifest.segments,
      }
    : {
        format: 2,
        codec: manifest.codec,
        level: manifest.level,
        segmentBytes: manifest.segmentBytes,
        sealedCut: manifest.sealedCut,
        logicalSize: manifest.logicalSize,
        generation: manifest.generation,
        sealId: manifest.sealId,
        originalRetained: manifest.originalRetained,
        sparseRanges: manifest.sparseRanges,
        segments: manifest.segments,
      };
  const jsonText = JSON.stringify(payload);
  if (isManifest(JSON.parse(jsonText), key) === undefined) {
    throw new BugIndicatingError('generated cold manifest failed schema validation');
  }
  return new TextEncoder().encode(jsonText);
}

async function loadManifest(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
): Promise<ColdManifest | undefined> {
  const bytes = await storage.read(scope, coldManifestKey(key));
  if (bytes === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw corrupted(scope, key, 'manifest', error);
  }
  const manifest = isManifest(parsed, key);
  if (manifest === undefined) throw corrupted(scope, key, 'manifest');
  return manifest;
}

async function loadMatchedManifest(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  expectedGeneration?: string,
): Promise<ColdManifest | undefined> {
  const manifest = await loadManifest(storage, scope, key);
  if (manifest === undefined) {
    const located = locatedJournal(storage, scope, key);
    if (located !== undefined && await isSparseFile(located)) {
      throw corrupted(scope, key, 'manifest-missing-on-sparse-journal');
    }
    return undefined;
  }
  const actualGeneration = expectedGeneration ?? await generationOf(storage, scope, key);
  if (actualGeneration !== manifest.generation) throw corrupted(scope, key, 'generation');
  return manifest;
}

export async function readColdManifestSummary(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  signal?: AbortSignal,
): Promise<ColdManifestSummary | undefined> {
  return withColdExclusive(storage, scope, key, async () => {
    const manifest = await loadMatchedManifest(storage, scope, key);
    if (manifest === undefined) return undefined;
    return {
      format: manifest.format,
      codec: manifest.codec,
      sealedCut: manifest.sealedCut,
      logicalSize: manifest.logicalSize,
      originalRetained: manifest.originalRetained,
    };
  }, signal);
}

export async function requiresProtectedColdReplace(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
): Promise<boolean> {
  const located = locatedJournal(storage, scope, key);
  if (located !== undefined) {
    try {
      if (await isSparseFile(located)) return true;
    } catch {
      return true;
    }
  }
  let bytes: Uint8Array | undefined;
  try {
    bytes = await storage.read(scope, coldManifestKey(key));
  } catch {
    return true;
  }
  if (bytes === undefined) return false;
  try {
    const parsed = isManifest(JSON.parse(new TextDecoder().decode(bytes)), key);
    return parsed === undefined || parsed.originalRetained !== true;
  } catch {
    return true;
  }
}

async function removeSegments(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  keys: readonly string[],
  sealId?: string,
): Promise<void> {
  for (const segmentKey of keys) await storage.delete(scope, segmentKey);
  const located = locatedJournal(storage, scope, key);
  if (located === undefined) return;
  if (sealId !== undefined && SEAL_ID.test(sealId)) {
    await rmdir(`${located}.segments/${sealId}`).catch(() => undefined);
  } else {
    const dirs = new Set<string>();
    for (const segmentKey of keys) {
      const segPath = storage.pathFor(scope, segmentKey);
      if (segPath !== undefined && segPath.length > 0) dirs.add(dirname(segPath));
    }
    for (const dir of dirs) await rmdir(dir).catch(() => undefined);
  }
  await rmdir(`${located}.segments`).catch(() => undefined);
}

function sealIdOf(bytes: Uint8Array): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const sealId = (parsed as { sealId?: unknown }).sealId;
  return typeof sealId === 'string' ? sealId : undefined;
}

function untrustedManifestMayRequireSegments(bytes: Uint8Array): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const raw = parsed as Record<string, unknown>;
  if (raw['format'] === 2) return raw['originalRetained'] !== true;
  if ('originalRetained' in raw && raw['originalRetained'] !== true) return true;
  if (raw['codec'] === 'zstd') return true;
  return false;
}

async function hasZstdSegmentFiles(located: string): Promise<boolean> {
  try {
    const entries = await readdir(`${located}.segments`, { recursive: true, withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith('.zst'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
}

function listedSegmentKeys(bytes: Uint8Array, key: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const listed = (parsed as { segments?: unknown }).segments;
  if (!Array.isArray(listed)) return [];
  const keys: string[] = [];
  for (const item of listed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const segmentKey = (item as { key?: unknown }).key;
    if (typeof segmentKey === 'string' && segmentKey.startsWith(`${key}.segments/`)) keys.push(segmentKey);
  }
  return keys;
}

async function readAndVerifySegment(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  manifest: ColdManifest,
  segment: ColdSegment,
  options?: StorageReadOptions,
): Promise<{ readonly compressed: Uint8Array; readonly plain: Uint8Array }> {
  const expected = segment.logicalEnd - segment.logicalStart;
  if (expected < 1 || expected > manifest.segmentBytes) throw corrupted(scope, key, 'segment');
  const sized = await storage.size(scope, segment.key);
  if (sized === undefined) throw corrupted(scope, key, 'segment-missing');
  if (sized > compressedInputLimit(expected)) throw corrupted(scope, key, 'segment');
  const compressed = await storage.read(scope, segment.key, options);
  if (compressed === undefined) throw corrupted(scope, key, 'segment-missing');
  let plain: Uint8Array;
  try {
    plain = await decompressBounded(compressed, manifest.codec, expected, options?.signal);
  } catch (error) {
    if (options?.signal?.aborted) throw options.signal.reason;
    throw corrupted(scope, key, 'segment', error);
  }
  if (plain.byteLength !== expected || sha256(plain) !== segment.uncompressedSha256) {
    throw corrupted(scope, key, 'segment');
  }
  return { compressed, plain };
}

async function restoreRangeFromManifest(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  manifest: ColdManifest,
  fromOffset: number,
  toOffset: number,
  signal?: AbortSignal,
): Promise<{ readonly restoredBytes: number; readonly verifiedSegments: number }> {
  signal?.throwIfAborted();
  if (await generationOf(storage, scope, key) !== manifest.generation) {
    throw corrupted(scope, key, 'generation');
  }
  const size = await storage.size(scope, key);
  if (size === undefined || size < manifest.sealedCut) {
    throw corrupted(scope, key, 'original-shrunk');
  }
  const start = Math.max(0, fromOffset);
  const end = Math.min(manifest.sealedCut, toOffset);
  if (end <= start) {
    return { restoredBytes: 0, verifiedSegments: 0 };
  }
  const targets = manifest.segments.filter((segment) => segment.logicalEnd > start && segment.logicalStart < end);
  for (const segment of targets) {
    signal?.throwIfAborted();
    await readAndVerifySegment(storage, scope, key, manifest, segment, { signal });
    await yieldToEventLoop();
  }
  const located = locatedJournal(storage, scope, key);
  if (located !== undefined) {
    const savedTimes = await captureFileBasicTimes(located);
    const handle = await open(located, 'r+');
    let writeErr: unknown;
    try {
      for (const segment of targets) {
        signal?.throwIfAborted();
        const { plain } = await readAndVerifySegment(storage, scope, key, manifest, segment, { signal });
        const writeStart = Math.max(start, segment.logicalStart);
        const writeEnd = Math.min(end, segment.logicalEnd);
        const slice = plain.subarray(writeStart - segment.logicalStart, writeEnd - segment.logicalStart);
        let written = 0;
        while (written < slice.byteLength) {
          const { bytesWritten } = await handle.write(slice, written, slice.byteLength - written, writeStart + written);
          if (bytesWritten <= 0) throw corrupted(scope, key, 'short-write');
          written += bytesWritten;
        }
        await yieldToEventLoop();
      }
      await handle.sync();
    } catch (error) {
      writeErr = error;
    } finally {
      await handle.close().catch((closeErr) => {
        if (writeErr === undefined) writeErr = closeErr;
      });
    }
    try {
      await restoreFileBasicTimes(located, savedTimes);
    } catch (timesErr) {
      if (writeErr === undefined) writeErr = timesErr;
    }
    if (writeErr !== undefined) throw writeErr;
  } else {
    const head = start > 0 ? await readManifestRange(storage, scope, key, manifest, 0, start - 1, { signal }) : new Uint8Array();
    const middle = await readManifestRange(storage, scope, key, manifest, start, end - 1, { signal });
    const tail = end < size ? await readRawExact(storage, scope, key, end, size - 1, { signal }) : new Uint8Array();
    const full = new Uint8Array(head.byteLength + middle.byteLength + tail.byteLength);
    full.set(head, 0);
    full.set(middle, head.byteLength);
    full.set(tail, head.byteLength + middle.byteLength);
    await storage.write(scope, key, full, { atomic: true, signal });
  }
  for (const segment of targets) {
    signal?.throwIfAborted();
    if (segment.logicalStart >= start && segment.logicalEnd <= end) {
      const rawPlain = await readRawExact(storage, scope, key, segment.logicalStart, segment.logicalEnd - 1, { signal });
      const expected = segment.logicalEnd - segment.logicalStart;
      if (rawPlain.byteLength !== expected || sha256(rawPlain) !== segment.uncompressedSha256) {
        throw corrupted(scope, key, 'restore-verification-failed');
      }
    } else {
      const verifyStart = Math.max(start, segment.logicalStart);
      const verifyEnd = Math.min(end, segment.logicalEnd);
      const { plain } = await readAndVerifySegment(storage, scope, key, manifest, segment, { signal });
      const expectedSlice = plain.subarray(verifyStart - segment.logicalStart, verifyEnd - segment.logicalStart);
      const rawSlice = await readRawExact(storage, scope, key, verifyStart, verifyEnd - 1, { signal });
      if (rawSlice.byteLength !== expectedSlice.byteLength || sha256(rawSlice) !== sha256(expectedSlice)) {
        throw corrupted(scope, key, 'restore-verification-failed');
      }
    }
    await yieldToEventLoop();
  }
  return { restoredBytes: end - start, verifiedSegments: targets.length };
}

export async function discardColdUnlocked(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  options: ColdUnsealOptions = {},
): Promise<ColdUnsealResult> {
  let outcome: ColdUnsealResult = {
    hadManifest: false,
    restoredOriginal: false,
    restoredBytes: 0,
    verifiedSegments: 0,
  };
  const located = locatedJournal(storage, scope, key);
  const drop = async (): Promise<void> => {
    options.signal?.throwIfAborted();
    const bytes = await storage.read(scope, coldManifestKey(key));
    if (bytes === undefined) {
      if (options.skipRestoreOriginal !== true && located !== undefined && await isSparseFile(located)) {
        throw corrupted(scope, key, 'manifest-missing-on-sparse-journal');
      }
      return;
    }
    let parsedManifest: ColdManifest | undefined;
    try {
      parsedManifest = isManifest(JSON.parse(new TextDecoder().decode(bytes)), key);
    } catch {
      parsedManifest = undefined;
    }

    if (options.skipRestoreOriginal !== true) {
      if (parsedManifest === undefined) {
        const unsafeDiscard =
          options.requireValidManifest === true ||
          options.forceRestoreOriginal === true ||
          untrustedManifestMayRequireSegments(bytes) ||
          (located !== undefined && (await isSparseFile(located) || await hasZstdSegmentFiles(located)));
        if (unsafeDiscard) {
          throw corrupted(scope, key, 'manifest');
        }
      } else {
        const currentGen = await generationOf(storage, scope, key);
        if (
          currentGen !== parsedManifest.generation &&
          (options.requireValidManifest === true ||
            options.forceRestoreOriginal === true ||
            parsedManifest.originalRetained === false ||
            (located !== undefined && await isSparseFile(located)))
        ) {
          throw corrupted(scope, key, 'generation');
        }
        const mustRestore =
          options.forceRestoreOriginal === true ||
          parsedManifest.originalRetained === false ||
          (located !== undefined && await isSparseFile(located));
        if (mustRestore) {
          await waitUnpinned(storage, scope, key, UNSEALED_PIN_ID);
          await waitUnpinned(storage, scope, key, parsedManifest.sealId);
          const restored = await restoreRangeFromManifest(
            storage,
            scope,
            key,
            parsedManifest,
            0,
            parsedManifest.sealedCut,
            options.signal,
          );
          outcome = {
            hadManifest: true,
            restoredOriginal: true,
            restoredBytes: restored.restoredBytes,
            verifiedSegments: restored.verifiedSegments,
          };
        } else {
          outcome = {
            hadManifest: true,
            restoredOriginal: false,
            restoredBytes: 0,
            verifiedSegments: 0,
          };
        }
      }
    } else {
      outcome = {
        hadManifest: true,
        restoredOriginal: false,
        restoredBytes: 0,
        verifiedSegments: 0,
      };
    }

    await storage.delete(scope, coldManifestKey(key));
    const sealId = sealIdOf(bytes);
    if (sealId !== undefined) await waitUnpinned(storage, scope, key, sealId);
    await removeSegments(storage, scope, key, listedSegmentKeys(bytes, key), sealId);
  };
  if (located === undefined) await drop();
  else await withColdReaderGate(located, drop, options.signal);
  return outcome;
}

export async function discardColdSegments(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  options?: ColdUnsealOptions,
): Promise<void> {
  await withColdExclusive(storage, scope, key, async () => {
    await discardColdUnlocked(storage, scope, key, options);
  }, options?.signal);
}

export function unsealColdSegments(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  options?: ColdUnsealOptions,
): Promise<ColdUnsealResult> {
  return withColdExclusive(
    storage,
    scope,
    key,
    () => discardColdUnlocked(storage, scope, key, { ...options, requireValidManifest: true }),
    options?.signal,
  );
}

async function sumSegmentBytes(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  segments: readonly ColdSegment[],
): Promise<number> {
  let total = 0;
  for (const segment of segments) {
    const sized = await storage.size(scope, segment.key);
    if (sized === undefined) throw corrupted(scope, key, 'segment-missing');
    total += sized;
  }
  return total;
}

async function sealUnlocked(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  sealedCut: number,
  options: ColdSealOptions,
): Promise<ColdSealResult> {
  options.signal?.throwIfAborted();
  const size = await storage.size(scope, key);
  if (size === undefined) {
    throw new StorageError(StorageErrors.codes.STORAGE_NOT_FOUND, 'Cold seal journal is missing', {
      details: { scope, key },
    });
  }
  requireCut(sealedCut, size);
  const codec: ColdSealCodec = options.codec ?? 'deflate-raw';
  const reclaim = options.reclaim === true;
  const format: 1 | 2 = codec === 'deflate-raw' && !reclaim && options.level === undefined ? 1 : 2;
  const level = requireCodecLevel(codec, options.level ?? (codec === 'zstd' ? COLD_ZSTD_LEVEL : COLD_DEFLATE_LEVEL));
  const defaultSegmentBytes = codec === 'zstd' ? COLD_ZSTD_SEGMENT_BYTES : COLD_SEGMENT_BYTES;
  const segmentBytes = requireSegmentBytes(options.segmentBytes ?? defaultSegmentBytes);
  const generation = await generationOf(storage, scope, key);
  const previousManifest = await loadMatchedManifest(storage, scope, key, generation);
  const located = locatedJournal(storage, scope, key);

  if (sealedCut > 0) {
    const marker = await readSourceExact(storage, scope, key, previousManifest, sealedCut - 1, sealedCut - 1, {
      signal: options.signal,
    });
    if (marker.byteLength !== 1 || marker[0] !== 0x0a) {
      throw new BugIndicatingError('cold seal cut is not a record boundary');
    }
  }

  const candidateSparse = reclaim && located !== undefined
    ? planSparseRanges(sealedCut, options.keepHeadBytes ?? DEFAULT_KEEP_HEAD_BYTES, options.preserveOffsets)
    : [];

  const retentionSatisfied = previousManifest !== undefined && (
    reclaim
      ? (previousManifest.originalRetained === false || candidateSparse.length === 0 || process.platform !== 'win32')
      : previousManifest.originalRetained === true
  );

  if (
    options.incremental === true &&
    previousManifest !== undefined &&
    previousManifest.format === format &&
    previousManifest.codec === codec &&
    previousManifest.level === level &&
    previousManifest.segmentBytes === segmentBytes &&
    previousManifest.sealedCut === sealedCut &&
    retentionSatisfied
  ) {
    const compressedBytes = await sumSegmentBytes(storage, scope, key, previousManifest.segments);
    const allocated = located === undefined ? undefined : await allocatedFileBytes(located);
    return {
      format: previousManifest.format,
      codec: previousManifest.codec,
      level: previousManifest.level,
      segmentBytes: previousManifest.segmentBytes,
      sealedCut: previousManifest.sealedCut,
      logicalSize: size,
      segmentCount: previousManifest.segments.length,
      reusedSegmentCount: previousManifest.segments.length,
      compressedBytes,
      generation,
      originalRetained: previousManifest.originalRetained,
      sparseRanges: previousManifest.sparseRanges,
      allocatedBytesBefore: allocated,
      allocatedBytesAfter: allocated,
    };
  }

  let priorRemainingSparse: readonly ColdSparseRange[] =
    reclaim && previousManifest !== undefined ? previousManifest.sparseRanges : [];

  if (previousManifest?.originalRetained === false && (!reclaim || sealedCut < previousManifest.sealedCut)) {
    const restoreFrom = reclaim ? sealedCut : 0;
    const applyGate = async (): Promise<void> => {
      await waitUnpinned(storage, scope, key, UNSEALED_PIN_ID);
      await waitUnpinned(storage, scope, key, previousManifest.sealId);
      await restoreRangeFromManifest(
        storage,
        scope,
        key,
        previousManifest,
        restoreFrom,
        previousManifest.sealedCut,
        options.signal,
      );
    };
    if (located === undefined) await applyGate();
    else await withColdReaderGate(located, applyGate, options.signal);
    priorRemainingSparse = reclaim
      ? subtractSparseRanges(priorRemainingSparse, [{ start: restoreFrom, end: previousManifest.sealedCut }])
      : [];
  }

  const sealId = randomUUID();
  const planned = planSegments(key, sealId, sealedCut, segmentBytes, codec);
  if (planned === undefined) throw new BugIndicatingError(`cold seal exceeds ${MAX_SEGMENTS} segments`);
  const written: ColdSegment[] = [];
  let reusedSegmentCount = 0;
  let compressedBytes = 0;
  const manifestKey = coldManifestKey(key);
  let manifestPublished = false;
  try {
    for (let index = 0; index < planned.length; index += 1) {
      options.signal?.throwIfAborted();
      const plan = planned[index]!;
      const expected = plan.logicalEnd - plan.logicalStart;
      const reusable =
        previousManifest !== undefined &&
        previousManifest.codec === codec &&
        previousManifest.level === level
          ? previousManifest.segments[index]
          : undefined;
      if (
        previousManifest !== undefined &&
        reusable !== undefined &&
        reusable.logicalStart === plan.logicalStart &&
        reusable.logicalEnd === plan.logicalEnd
      ) {
        const verified = await readAndVerifySegment(storage, scope, key, previousManifest, reusable, {
          signal: options.signal,
        });
        const segment: ColdSegment = { ...plan, uncompressedSha256: reusable.uncompressedSha256 };
        await storage.write(scope, segment.key, verified.compressed, { atomic: true, signal: options.signal });
        written.push(segment);
        reusedSegmentCount += 1;
        compressedBytes += verified.compressed.byteLength;
        await yieldToEventLoop();
        continue;
      }
      const plain = await readSourceExact(storage, scope, key, previousManifest, plan.logicalStart, plan.logicalEnd - 1, {
        signal: options.signal,
      });
      if (plain.byteLength !== expected) throw corrupted(scope, key, 'short-read');
      const segment: ColdSegment = { ...plan, uncompressedSha256: sha256(plain) };
      const compressed = await compressSegment(plain, codec, level, options.signal);
      await storage.write(scope, segment.key, compressed, { atomic: true, signal: options.signal });
      written.push(segment);
      compressedBytes += compressed.byteLength;
      await yieldToEventLoop();
    }

    const rawVerifyFloor = previousManifest?.originalRetained === false ? Math.min(sealedCut, previousManifest.sealedCut) : 0;
    for (const segment of written) {
      if (segment.logicalEnd <= rawVerifyFloor) continue;
      options.signal?.throwIfAborted();
      const plain = await readSourceExact(storage, scope, key, previousManifest, segment.logicalStart, segment.logicalEnd - 1, {
        signal: options.signal,
      });
      if (plain.byteLength !== segment.logicalEnd - segment.logicalStart || sha256(plain) !== segment.uncompressedSha256) {
        throw corrupted(scope, key, 'changed-during-seal');
      }
      await yieldToEventLoop();
    }

    const sizeAfter = await storage.size(scope, key);
    if (sizeAfter === undefined || sizeAfter < size) throw corrupted(scope, key, 'changed-during-seal');

    const willAttemptPunch = reclaim && located !== undefined && candidateSparse.length > 0 && process.platform === 'win32';
    const priorSparseStillActive = reclaim && priorRemainingSparse.length > 0 && previousManifest?.originalRetained === false;
    const tentativeOriginalRetained = !(willAttemptPunch || priorSparseStillActive);
    const tentativeSparseRanges = tentativeOriginalRetained
      ? []
      : clipSparseRanges(mergeSparseRanges([...priorRemainingSparse, ...candidateSparse]), sealedCut);

    let manifest: ColdManifest = {
      format,
      codec,
      level,
      segmentBytes,
      sealedCut,
      logicalSize: size,
      generation,
      sealId,
      originalRetained: tentativeOriginalRetained,
      sparseRanges: tentativeSparseRanges,
      segments: written,
    };
    const encodedManifest = serializeValidatedManifest(manifest, key);
    const previous = await storage.read(scope, manifestKey);
    if (await generationOf(storage, scope, key) !== generation) {
      throw corrupted(scope, key, 'generation');
    }
    options.signal?.throwIfAborted();
    await writeManifestAtomic(storage, scope, manifestKey, encodedManifest, options.signal);
    manifestPublished = true;

    const fresh = new Set(written.map((segment) => segment.key));
    let allocatedBytesBefore: number | undefined;
    let allocatedBytesAfter: number | undefined;

    const finalizePostCommit = async (): Promise<void> => {
      if (previous !== undefined) {
        const previousId = sealIdOf(previous);
        if (previousId !== undefined && previousId !== sealId) await waitUnpinned(storage, scope, key, previousId);
        await removeSegments(
          storage,
          scope,
          key,
          listedSegmentKeys(previous, key).filter((segmentKey) => !fresh.has(segmentKey)),
          previousId !== sealId ? previousId : undefined,
        ).catch(() => undefined);
      }
      if (willAttemptPunch && located !== undefined && !options.signal?.aborted) {
        await (
          options.signal === undefined
            ? waitActiveReadersIdle(storage, scope, key)
            : abortable(waitActiveReadersIdle(storage, scope, key), options.signal)
        );
        if (!options.signal?.aborted) {
          const punched = await punchSparseRanges(located, candidateSparse);
          allocatedBytesBefore = punched.allocatedBytesBefore;
          allocatedBytesAfter = punched.allocatedBytesAfter;
          if (punched.status === 'unsupported_before_mutation' && !priorSparseStillActive) {
            manifest = { ...manifest, originalRetained: true, sparseRanges: [] };
            const fallbackEncoded = serializeValidatedManifest(manifest, key);
            await writeManifestAtomic(storage, scope, manifestKey, fallbackEncoded);
          } else if (punched.status === 'mutated_or_unknown') {
            throw new StorageError(
              StorageErrors.codes.STORAGE_IO_FAILED,
              `Sparse extent reclamation failed after sparse open: ${punched.error ?? 'unknown error'}`,
              { details: { scope, key, sealId } },
            );
          }
        }
      } else if (located !== undefined && reclaim && !options.signal?.aborted) {
        const allocated = await allocatedFileBytes(located, options.signal);
        allocatedBytesBefore = allocated;
        allocatedBytesAfter = allocated;
      }
    };

    if (located === undefined) await finalizePostCommit();
    else await withColdReaderGate(located, finalizePostCommit);

    return {
      format: manifest.format,
      codec: manifest.codec,
      level: manifest.level,
      segmentBytes: manifest.segmentBytes,
      sealedCut: manifest.sealedCut,
      logicalSize: size,
      segmentCount: written.length,
      reusedSegmentCount,
      compressedBytes,
      generation,
      originalRetained: manifest.originalRetained,
      sparseRanges: manifest.sparseRanges,
      allocatedBytesBefore,
      allocatedBytesAfter,
    };
  } catch (error) {
    if (!manifestPublished) {
      let safeToDelete = false;
      try {
        const onDisk = await storage.read(scope, manifestKey);
        safeToDelete = onDisk === undefined || sealIdOf(onDisk) !== sealId;
      } catch {
        safeToDelete = false;
      }
      if (safeToDelete) {
        await removeSegments(storage, scope, key, written.map((segment) => segment.key), sealId).catch(() => undefined);
      }
    }
    throw error;
  }
}

export function sealColdSegments(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  sealedCut: number,
  options: ColdSealOptions = {},
): Promise<ColdSealResult> {
  return withColdExclusive(storage, scope, key, () => sealUnlocked(storage, scope, key, sealedCut, options), options.signal);
}

export async function logicalByteSize(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
): Promise<number | undefined> {
  return withColdExclusive(storage, scope, key, async () => {
    const manifest = await loadMatchedManifest(storage, scope, key);
    const size = await storage.size(scope, key);
    if (manifest === undefined) return size;
    if (size === undefined || size < manifest.sealedCut) throw corrupted(scope, key, 'original-shrunk');
    return size;
  });
}

function slices(bytes: Uint8Array, start: number, end: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let offset = start; offset < end; offset += YIELD_BYTES) {
    parts.push(bytes.subarray(offset, Math.min(end, offset + YIELD_BYTES)));
  }
  return parts;
}

async function* readPinned(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  manifest: ColdManifest,
  range: StorageReadRange | undefined,
  options: StorageReadOptions | undefined,
): AsyncIterable<Uint8Array> {
  const size = await storage.size(scope, key);
  if (size === undefined || size < manifest.sealedCut) throw corrupted(scope, key, 'original-shrunk');
  const start = range?.start ?? 0;
  const requestedEnd = range?.end ?? (size === 0 ? -1 : size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0) {
    throw new BugIndicatingError('logical journal range is not a byte offset');
  }
  if (size === 0 || requestedEnd < start) return;
  const end = Math.min(requestedEnd, size - 1);
  const needed = manifest.segments.filter((segment) => segment.logicalStart <= end && segment.logicalEnd > start);
  for (const segment of needed) {
    const expected = segment.logicalEnd - segment.logicalStart;
    if (expected < 1 || expected > manifest.segmentBytes) throw corrupted(scope, key, 'segment');
    const sized = await storage.size(scope, segment.key);
    if (sized === undefined) throw corrupted(scope, key, 'segment-missing');
    if (sized > compressedInputLimit(expected)) throw corrupted(scope, key, 'segment');
  }
  for (const segment of needed) {
    options?.signal?.throwIfAborted();
    const { plain } = await readAndVerifySegment(storage, scope, key, manifest, segment, options);
    const localStart = Math.max(0, start - segment.logicalStart);
    const localEnd = Math.min(plain.byteLength, end - segment.logicalStart + 1);
    for (const part of slices(plain, localStart, localEnd)) yield part;
  }
  if (end >= manifest.sealedCut) {
    const hotStart = Math.max(start, manifest.sealedCut);
    yield* storage.readStream(scope, key, { start: hotStart, end }, options);
  }
}

export interface PinnedLogicalRead {
  readonly size: number | undefined;
  readonly sealed: boolean;
  read(range?: StorageReadRange, options?: StorageReadOptions): AsyncIterable<Uint8Array>;
  close(): void;
}

/** Pins the selected seal or dense file under the reader gate; cancellation releases an unpublished pin. */
export async function openPinnedLogicalRead(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  signal?: AbortSignal,
): Promise<PinnedLogicalRead> {
  let manifest: ColdManifest | undefined;
  let size: number | undefined;
  let release = (): void => {};
  try {
    await withColdExclusive(storage, scope, key, async () => {
      const openPinned = async (): Promise<void> => {
        signal?.throwIfAborted();
        manifest = await loadMatchedManifest(storage, scope, key);
        size = await storage.size(scope, key);
        signal?.throwIfAborted();
        if (manifest !== undefined) {
          if (size === undefined || size < manifest.sealedCut) throw corrupted(scope, key, 'original-shrunk');
          release = await pinSeal(storage, scope, key, manifest.sealId);
        } else if (size !== undefined) {
          release = await pinSeal(storage, scope, key, UNSEALED_PIN_ID);
        }
        signal?.throwIfAborted();
      };
      const located = locatedJournal(storage, scope, key);
      if (located === undefined) await openPinned();
      else await withColdReaderGate(located, openPinned, signal);
    }, signal);
  } catch (error) {
    release();
    throw error;
  }
  let closed = false;
  return {
    size,
    sealed: manifest !== undefined,
    read(range, options) {
      if (manifest === undefined) return storage.readStream(scope, key, range, options);
      return readPinned(storage, scope, key, manifest, range, options);
    },
    close() {
      if (closed) return;
      closed = true;
      release();
    },
  };
}

export async function* readLogicalBytes(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  range?: StorageReadRange,
  options?: StorageReadOptions,
): AsyncIterable<Uint8Array> {
  const pinned = await openPinnedLogicalRead(storage, scope, key, options?.signal);
  try {
    yield* pinned.read(range, options);
  } finally {
    pinned.close();
  }
}
