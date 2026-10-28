import { createHash, randomUUID } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { resolve } from 'pathe';

import { BugIndicatingError } from '#/_base/errors/errors';
import { abortable } from '#/_base/utils/abort';
import { acquireSharedReadLease, waitSharedReadIdle, withColdReaderGate } from '#/persistence/backends/node-fs/fileLock';
import type { ColdSealOptions, ColdSealResult } from '#/persistence/interface/appendLogStore';
import {
  StorageError,
  StorageErrors,
  type IFileSystemStorageService,
  type StorageReadOptions,
  type StorageReadRange,
} from '#/persistence/interface/storage';

export const COLD_SEGMENT_BYTES = 8 * 1024 * 1024;
const COLD_CODEC = 'deflate-raw';
const COLD_LEVEL = 6;
const COLD_FORMAT = 1;
const MAX_SEGMENTS = 4096;
const YIELD_BYTES = 64 * 1024;
const SEAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ColdSegment {
  readonly logicalStart: number;
  readonly logicalEnd: number;
  readonly uncompressedSha256: string;
  readonly key: string;
}

interface ColdManifest {
  readonly format: typeof COLD_FORMAT;
  readonly codec: typeof COLD_CODEC;
  readonly level: typeof COLD_LEVEL;
  readonly segmentBytes: number;
  readonly sealedCut: number;
  readonly logicalSize: number;
  readonly generation: string;
  readonly sealId: string;
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

async function waitUnpinned(storage: IFileSystemStorageService, scope: string, key: string, sealId: string): Promise<void> {
  const entry = sealPins.get(pinId(storage, scope, key, sealId));
  if (entry !== undefined && entry.count > 0) {
    await new Promise<void>((resolvePromise) => {
      entry.waiters.push(resolvePromise);
    });
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

function coldSegmentKey(key: string, sealId: string, index: number): string {
  return `${key}.segments/${sealId}/${index.toString(10).padStart(6, '0')}.deflate`;
}

function deflateInputLimit(outputBytes: number): number {
  return outputBytes + Math.ceil(outputBytes / 16) + 1024;
}

function corrupted(scope: string, key: string, reason: string, cause?: unknown): StorageError {
  return new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, 'Cold journal cannot be read', {
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

async function readExact(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  start: number,
  end: number,
  options?: StorageReadOptions,
): Promise<Uint8Array> {
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

async function generationOf(storage: IFileSystemStorageService, scope: string, key: string): Promise<string> {
  const bytes = await storage.read(scope, `${key}.generation`);
  return bytes === undefined ? 'legacy' : new TextDecoder().decode(bytes);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function planSegments(key: string, sealId: string, sealedCut: number, segmentBytes: number): ColdSegment[] | undefined {
  if (!SEAL_ID.test(sealId) || segmentBytes < 1 || Math.ceil(sealedCut / segmentBytes) > MAX_SEGMENTS) return undefined;
  const segments: ColdSegment[] = [];
  let start = 0;
  while (start < sealedCut) {
    const end = Math.min(sealedCut, start + segmentBytes);
    segments.push({
      logicalStart: start,
      logicalEnd: end,
      uncompressedSha256: '',
      key: coldSegmentKey(key, sealId, segments.length),
    });
    start = end;
  }
  return segments;
}

function isManifest(value: unknown, key: string): ColdManifest | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw['format'] !== COLD_FORMAT || raw['codec'] !== COLD_CODEC || raw['level'] !== COLD_LEVEL) return undefined;
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
  const expected = planSegments(key, sealId, sealedCut as number, segmentBytes as number);
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
    format: COLD_FORMAT,
    codec: COLD_CODEC,
    level: COLD_LEVEL,
    segmentBytes: segmentBytes as number,
    sealedCut: sealedCut as number,
    logicalSize: logicalSize as number,
    generation,
    sealId,
    segments,
  };
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
): Promise<ColdManifest | undefined> {
  const manifest = await loadManifest(storage, scope, key);
  if (manifest === undefined) return undefined;
  if (await generationOf(storage, scope, key) !== manifest.generation) throw corrupted(scope, key, 'generation');
  return manifest;
}

async function removeSegments(
  storage: IFileSystemStorageService,
  scope: string,
  keys: readonly string[],
): Promise<void> {
  for (const segmentKey of keys) await storage.delete(scope, segmentKey);
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

export async function discardColdUnlocked(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
): Promise<void> {
  const drop = async (): Promise<void> => {
    const bytes = await storage.read(scope, coldManifestKey(key));
    await storage.delete(scope, coldManifestKey(key));
    if (bytes === undefined) return;
    const sealId = sealIdOf(bytes);
    if (sealId !== undefined) await waitUnpinned(storage, scope, key, sealId);
    await removeSegments(storage, scope, listedSegmentKeys(bytes, key));
  };
  const located = locatedJournal(storage, scope, key);
  if (located === undefined) await drop();
  else await withColdReaderGate(located, drop);
}

export async function discardColdSegments(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
): Promise<void> {
  await withColdExclusive(storage, scope, key, () => discardColdUnlocked(storage, scope, key));
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
  const segmentBytes = requireSegmentBytes(options.segmentBytes ?? COLD_SEGMENT_BYTES);
  if (sealedCut > 0) {
    const marker = await readExact(storage, scope, key, sealedCut - 1, sealedCut - 1, { signal: options.signal });
    if (marker.byteLength !== 1 || marker[0] !== 0x0a) {
      throw new BugIndicatingError('cold seal cut is not a record boundary');
    }
  }
  const generation = await generationOf(storage, scope, key);
  const sealId = randomUUID();
  const planned = planSegments(key, sealId, sealedCut, segmentBytes);
  if (planned === undefined) throw new BugIndicatingError('cold seal exceeds 4096 segments');
  const written: ColdSegment[] = [];
  let committed = false;
  try {
    for (const plan of planned) {
      options.signal?.throwIfAborted();
      const plain = await readExact(storage, scope, key, plan.logicalStart, plan.logicalEnd - 1, { signal: options.signal });
      if (plain.byteLength !== plan.logicalEnd - plan.logicalStart) throw corrupted(scope, key, 'short-read');
      const segment: ColdSegment = { ...plan, uncompressedSha256: sha256(plain) };
      await storage.write(scope, segment.key, deflateRawSync(plain, { level: COLD_LEVEL }), { atomic: true, signal: options.signal });
      written.push(segment);
    }
    for (const segment of written) {
      options.signal?.throwIfAborted();
      const plain = await readExact(storage, scope, key, segment.logicalStart, segment.logicalEnd - 1, { signal: options.signal });
      if (plain.byteLength !== segment.logicalEnd - segment.logicalStart || sha256(plain) !== segment.uncompressedSha256) {
        throw corrupted(scope, key, 'changed-during-seal');
      }
    }
    const sizeAfter = await storage.size(scope, key);
    if (sizeAfter === undefined || sizeAfter < size) throw corrupted(scope, key, 'changed-during-seal');
    if (await generationOf(storage, scope, key) !== generation) throw corrupted(scope, key, 'generation');
    const manifest: ColdManifest = {
      format: COLD_FORMAT,
      codec: COLD_CODEC,
      level: COLD_LEVEL,
      segmentBytes,
      sealedCut,
      logicalSize: size,
      generation,
      sealId,
      segments: written,
    };
    const manifestKey = coldManifestKey(key);
    const previous = await storage.read(scope, manifestKey);
    options.signal?.throwIfAborted();
    await storage.write(scope, manifestKey, new TextEncoder().encode(JSON.stringify(manifest)), {
      atomic: true,
      signal: options.signal,
    });
    if (await generationOf(storage, scope, key) !== generation) {
      if (previous === undefined) await storage.delete(scope, manifestKey);
      else await storage.write(scope, manifestKey, previous, { atomic: true });
      throw corrupted(scope, key, 'generation');
    }
    committed = true;
    const fresh = new Set(written.map((segment) => segment.key));
    if (previous !== undefined) {
      const dropPrevious = async (): Promise<void> => {
        const previousId = sealIdOf(previous);
        if (previousId !== undefined && previousId !== sealId) await waitUnpinned(storage, scope, key, previousId);
        await removeSegments(storage, scope, listedSegmentKeys(previous, key).filter((segmentKey) => !fresh.has(segmentKey))).catch(() => undefined);
      };
      const located = locatedJournal(storage, scope, key);
      if (located === undefined) await dropPrevious();
      else await withColdReaderGate(located, dropPrevious);
    }
    return {
      format: COLD_FORMAT,
      codec: COLD_CODEC,
      level: COLD_LEVEL,
      segmentBytes,
      sealedCut,
      logicalSize: size,
      segmentCount: written.length,
      generation,
      originalRetained: true,
    };
  } catch (error) {
    if (!committed) await removeSegments(storage, scope, written.map((segment) => segment.key)).catch(() => undefined);
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
  return withColdExclusive(storage, scope, key, () => sealUnlocked(storage, scope, key, sealedCut, options));
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

async function inflateBounded(compressed: Uint8Array, outputBytes: number): Promise<Uint8Array> {
  if (compressed.byteLength > deflateInputLimit(outputBytes)) {
    throw Object.assign(new Error('deflate input exceeds the segment bound'), { code: 'ERR_BUFFER_TOO_LARGE' });
  }
  return inflateRawSync(compressed, { maxOutputLength: outputBytes });
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
    if (sized > deflateInputLimit(expected)) throw corrupted(scope, key, 'segment');
  }
  for (const segment of needed) {
    options?.signal?.throwIfAborted();
    const expected = segment.logicalEnd - segment.logicalStart;
    const compressed = await storage.read(scope, segment.key, options);
    if (compressed === undefined) throw corrupted(scope, key, 'segment-missing');
    let plain: Uint8Array;
    try {
      plain = await inflateBounded(compressed, expected);
    } catch (error) {
      throw corrupted(scope, key, 'segment', error);
    }
    if (plain.byteLength !== expected || sha256(plain) !== segment.uncompressedSha256) {
      throw corrupted(scope, key, 'segment');
    }
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

/** Pins the selected seal under the reader gate; cancellation releases an unpublished pin. */
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
      const open = async (): Promise<void> => {
        signal?.throwIfAborted();
        manifest = await loadMatchedManifest(storage, scope, key);
        size = await storage.size(scope, key);
        signal?.throwIfAborted();
        if (manifest !== undefined) {
          if (size === undefined || size < manifest.sealedCut) throw corrupted(scope, key, 'original-shrunk');
          release = await pinSeal(storage, scope, key, manifest.sealId);
        }
        signal?.throwIfAborted();
      };
      const located = locatedJournal(storage, scope, key);
      if (located === undefined) await open();
      else await withColdReaderGate(located, open, signal);
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
