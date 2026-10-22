import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

import { BugIndicatingError } from '#/_base/errors/errors';
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
  readonly segments: readonly ColdSegment[];
}

export function coldManifestKey(key: string): string {
  return `${key}.segments.json`;
}

function coldSegmentKey(key: string, index: number): string {
  return `${key}.segments/${index.toString(10).padStart(6, '0')}.deflate`;
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

function planSegments(key: string, sealedCut: number, segmentBytes: number): ColdSegment[] | undefined {
  if (segmentBytes < 1 || Math.ceil(sealedCut / segmentBytes) > MAX_SEGMENTS) return undefined;
  const segments: ColdSegment[] = [];
  let start = 0;
  while (start < sealedCut) {
    const end = Math.min(sealedCut, start + segmentBytes);
    segments.push({
      logicalStart: start,
      logicalEnd: end,
      uncompressedSha256: '',
      key: coldSegmentKey(key, segments.length),
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
  const listed = raw['segments'];
  if (!Number.isSafeInteger(segmentBytes) || (segmentBytes as number) < 1 || (segmentBytes as number) > COLD_SEGMENT_BYTES) return undefined;
  if (!Number.isSafeInteger(sealedCut) || (sealedCut as number) < 0) return undefined;
  if (!Number.isSafeInteger(logicalSize) || (logicalSize as number) < (sealedCut as number)) return undefined;
  if (typeof generation !== 'string' || !Array.isArray(listed)) return undefined;
  const expected = planSegments(key, sealedCut as number, segmentBytes as number);
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

async function removeSegments(
  storage: IFileSystemStorageService,
  scope: string,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) await storage.delete(scope, key);
}

export async function discardColdSegments(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
): Promise<void> {
  const bytes = await storage.read(scope, coldManifestKey(key));
  await storage.delete(scope, coldManifestKey(key));
  if (bytes === undefined) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const listed = (parsed as { segments?: unknown }).segments;
  if (!Array.isArray(listed)) return;
  for (const item of listed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const segmentKey = (item as { key?: unknown }).key;
    if (typeof segmentKey === 'string' && segmentKey.startsWith(`${key}.segments/`)) {
      await storage.delete(scope, segmentKey);
    }
  }
}

export async function sealColdSegments(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  sealedCut: number,
  options: ColdSealOptions = {},
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
  const planned = planSegments(key, sealedCut, segmentBytes);
  if (planned === undefined) throw new BugIndicatingError('cold seal exceeds 4096 segments');
  const written: ColdSegment[] = [];
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
    const generation = await generationOf(storage, scope, key);
    const manifest: ColdManifest = {
      format: COLD_FORMAT,
      codec: COLD_CODEC,
      level: COLD_LEVEL,
      segmentBytes,
      sealedCut,
      logicalSize: size,
      generation,
      segments: written,
    };
    options.signal?.throwIfAborted();
    await storage.write(scope, coldManifestKey(key), new TextEncoder().encode(JSON.stringify(manifest)), {
      atomic: true,
      signal: options.signal,
    });
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
    await removeSegments(storage, scope, written.map((segment) => segment.key)).catch(() => undefined);
    await storage.delete(scope, coldManifestKey(key)).catch(() => undefined);
    throw error;
  }
}

export async function logicalByteSize(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
): Promise<number | undefined> {
  const manifest = await loadManifest(storage, scope, key);
  const size = await storage.size(scope, key);
  if (manifest === undefined) return size;
  if (size === undefined || size < manifest.sealedCut) throw corrupted(scope, key, 'original-shrunk');
  return size;
}

function slices(bytes: Uint8Array, start: number, end: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let offset = start; offset < end; offset += YIELD_BYTES) {
    parts.push(bytes.subarray(offset, Math.min(end, offset + YIELD_BYTES)));
  }
  return parts;
}

export async function* readLogicalBytes(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  range?: StorageReadRange,
  options?: StorageReadOptions,
): AsyncIterable<Uint8Array> {
  const manifest = await loadManifest(storage, scope, key);
  if (manifest === undefined) {
    yield* storage.readStream(scope, key, range, options);
    return;
  }
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
    if (await storage.size(scope, segment.key) === undefined) throw corrupted(scope, key, 'segment-missing');
  }
  for (const segment of needed) {
    options?.signal?.throwIfAborted();
    const compressed = await storage.read(scope, segment.key, options);
    if (compressed === undefined) throw corrupted(scope, key, 'segment-missing');
    let plain: Uint8Array;
    try {
      plain = inflateRawSync(compressed);
    } catch (error) {
      throw corrupted(scope, key, 'segment', error);
    }
    const expected = segment.logicalEnd - segment.logicalStart;
    if (plain.byteLength !== expected || sha256(plain) !== segment.uncompressedSha256) {
      throw corrupted(scope, key, 'segment');
    }
    if (plain.byteLength > manifest.segmentBytes) throw corrupted(scope, key, 'segment');
    const localStart = Math.max(0, start - segment.logicalStart);
    const localEnd = Math.min(plain.byteLength, end - segment.logicalStart + 1);
    for (const part of slices(plain, localStart, localEnd)) yield part;
  }
  if (end >= manifest.sealedCut) {
    const hotStart = Math.max(start, manifest.sealedCut);
    yield* storage.readStream(scope, key, { start: hotStart, end }, options);
  }
}
