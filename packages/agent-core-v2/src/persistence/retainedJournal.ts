import { open, readFile, readdir, stat } from 'node:fs/promises';

import { basename, dirname, join } from 'pathe';

import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import {
  allocatedFileBytes,
  DEFAULT_KEEP_HEAD_BYTES,
  SPARSE_UNIT_BYTES,
} from '#/persistence/backends/node-fs/sparseFile';
import {
  COLD_DEFLATE_LEVEL,
  COLD_ZSTD_LEVEL,
  COLD_ZSTD_SEGMENT_BYTES,
  discardColdSegments,
  openPinnedLogicalRead,
  readColdManifestSummary,
  sealColdSegments,
  unsealColdSegments,
  type ColdUnsealOptions,
  type ColdUnsealResult,
} from '#/persistence/coldSegmentLog';
import type {
  ColdSealCodec,
  ColdSealOptions,
  ColdSealResult,
} from '#/persistence/interface/appendLogStore';
import {
  StorageError,
  StorageErrors,
  type IFileSystemStorageService,
} from '#/persistence/interface/storage';
import { readPinnedRange, wireFileAddress } from '#/persistence/logicalWireFile';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import {
  COLD_CHECKPOINT_ARCHIVE_GZ_KEY,
  COLD_CHECKPOINT_ARCHIVE_ZST_KEY,
  COLD_CHECKPOINT_PROJECTION_KEY,
  REPLAY_CHECKPOINT_PRIMARY_KEY,
  REPLAY_CHECKPOINT_SUBSCOPE,
} from '#/session/replayCheckpointArchive';

const WIRE_FILENAME = 'wire.jsonl';
const DEFAULT_MAIN_LARGE_THRESHOLD_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAIN_HOT_TAIL_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAIN_MEDIUM_HOT_TAIL_BYTES = 128 * 1024;
const DEFAULT_SUBAGENT_HOT_TAIL_BYTES = 64 * 1024;

export interface RetainedCompactOptions {
  readonly codec?: ColdSealCodec;
  readonly level?: number;
  readonly segmentBytes?: number;
  readonly reclaim?: boolean;
  readonly incremental?: boolean;
  readonly keepHeadBytes?: number;
  readonly hotTailBytes?: number;
  readonly mainHotTailBytes?: number;
  readonly subagentHotTailBytes?: number;
  readonly signal?: AbortSignal;
}

export interface RetainedCompactJournalResult {
  readonly wirePath: string;
  readonly skipped: boolean;
  readonly logicalSize: number;
  readonly seal?: ColdSealResult;
  readonly allocatedWireBytesBefore: number;
  readonly allocatedWireBytesAfter: number;
  readonly segmentBytesBefore: number;
  readonly segmentBytesAfter: number;
  readonly physicalBytesBefore: number;
  readonly physicalBytesAfter: number;
}

export interface RetainedCompactSessionResult {
  readonly sessionDir: string;
  readonly totalJournals: number;
  readonly compactedJournals: number;
  readonly skippedJournals: number;
  readonly reusedSegments: number;
  readonly logicalBytes: number;
  readonly allocatedWireBytesBefore: number;
  readonly allocatedWireBytesAfter: number;
  readonly segmentBytesBefore: number;
  readonly segmentBytesAfter: number;
  readonly physicalBytesBefore: number;
  readonly physicalBytesAfter: number;
  readonly journals: readonly RetainedCompactJournalResult[];
}

export interface RetainedUnsealSessionResult {
  readonly sessionDir: string;
  readonly totalJournals: number;
  readonly unsealedJournals: number;
  readonly restoredOriginalJournals: number;
  readonly restoredBytes: number;
  readonly verifiedSegments: number;
}

export async function sealRetainedJournal(wirePath: string, options?: ColdSealOptions): Promise<ColdSealResult> {
  const address = wireFileAddress(wirePath);
  const storage = new FileStorageService(address.baseDir);
  try {
    const size = await storage.size(address.scope, address.key);
    if (size === undefined) {
      throw new StorageError(StorageErrors.codes.STORAGE_NOT_FOUND, 'Cold seal journal is missing', {
        details: { scope: address.scope, key: address.key },
      });
    }
    const sealedCut = await recordCutAtOrBefore(storage, address.scope, address.key, size, options?.signal);
    return await sealColdSegments(storage, address.scope, address.key, sealedCut, options);
  } finally {
    await storage.close();
  }
}

export async function discardRetainedJournal(wirePath: string, options?: ColdUnsealOptions): Promise<void> {
  const address = wireFileAddress(wirePath);
  const storage = new FileStorageService(address.baseDir);
  try {
    await discardColdSegments(storage, address.scope, address.key, options);
  } finally {
    await storage.close();
  }
}

export async function unsealRetainedJournal(wirePath: string, options?: ColdUnsealOptions): Promise<ColdUnsealResult> {
  const address = wireFileAddress(wirePath);
  const storage = new FileStorageService(address.baseDir);
  try {
    return await unsealColdSegments(storage, address.scope, address.key, options);
  } finally {
    await storage.close();
  }
}

export async function sealRetainedSession(sessionDir: string, options?: ColdSealOptions): Promise<readonly ColdSealResult[]> {
  const results: ColdSealResult[] = [];
  for (const wirePath of await sessionWirePaths(sessionDir)) {
    results.push(await sealRetainedJournal(wirePath, options));
  }
  return results;
}

export async function discardRetainedSession(sessionDir: string, options?: ColdUnsealOptions): Promise<number> {
  const wires = await sessionWirePaths(sessionDir);
  for (const wirePath of wires) await discardRetainedJournal(wirePath, options);
  return wires.length;
}

export async function unsealRetainedSession(
  sessionDir: string,
  options?: ColdUnsealOptions,
): Promise<RetainedUnsealSessionResult> {
  const wires = await sessionWirePaths(sessionDir);
  let unsealedJournals = 0;
  let restoredOriginalJournals = 0;
  let restoredBytes = 0;
  let verifiedSegments = 0;
  for (const wirePath of wires) {
    options?.signal?.throwIfAborted();
    const res = await unsealRetainedJournal(wirePath, options);
    if (res.hadManifest) unsealedJournals += 1;
    if (res.restoredOriginal) restoredOriginalJournals += 1;
    restoredBytes += res.restoredBytes;
    verifiedSegments += res.verifiedSegments;
  }
  return {
    sessionDir,
    totalJournals: wires.length,
    unsealedJournals,
    restoredOriginalJournals,
    restoredBytes,
    verifiedSegments,
  };
}

export async function compactRetainedJournal(
  wirePath: string,
  options: RetainedCompactOptions = {},
): Promise<RetainedCompactJournalResult> {
  options.signal?.throwIfAborted();
  const address = wireFileAddress(wirePath);
  const storage = new FileStorageService(address.baseDir);
  try {
    const size = await storage.size(address.scope, address.key);
    if (size === undefined) {
      throw new StorageError(StorageErrors.codes.STORAGE_NOT_FOUND, 'Cold seal journal is missing', {
        details: { scope: address.scope, key: address.key },
      });
    }
    const allocatedBefore = (await allocatedFileBytes(wirePath, options.signal)) ?? size;
    const segmentBytesBefore = await directoryAllocatedBytes(`${wirePath}.segments`);
    const prior = await readColdManifestSummary(storage, address.scope, address.key, options.signal);
    const keepHeadBytes = options.keepHeadBytes ?? DEFAULT_KEEP_HEAD_BYTES;
    const requestedReclaim = options.reclaim ?? true;
    const checkpoint = await inspectCheckpointWireOffset(dirname(wirePath), options.signal);
    const reclaim = checkpoint.kind === 'unreadable' ? false : requestedReclaim;
    const hotTailBytes = resolveHotTailBytes(wirePath, size, options);
    const maxDesiredCut = Math.max(0, size - hotTailBytes);
    const desiredCut = maxDesiredCut > 0
      ? await recordCutAtOrBefore(storage, address.scope, address.key, maxDesiredCut, options.signal)
      : 0;
    const sealedCut = prior !== undefined && size >= prior.sealedCut
      ? Math.max(prior.sealedCut, desiredCut)
      : desiredCut;
    const minWorthwhileCut = reclaim ? keepHeadBytes + SPARSE_UNIT_BYTES : 1;
    const needsDenseRestore = !reclaim && prior?.originalRetained === false;
    if (!needsDenseRestore && sealedCut < minWorthwhileCut) {
      return {
        wirePath,
        skipped: true,
        logicalSize: size,
        allocatedWireBytesBefore: allocatedBefore,
        allocatedWireBytesAfter: allocatedBefore,
        segmentBytesBefore,
        segmentBytesAfter: segmentBytesBefore,
        physicalBytesBefore: allocatedBefore + segmentBytesBefore,
        physicalBytesAfter: allocatedBefore + segmentBytesBefore,
      };
    }
    const codec: ColdSealCodec = options.codec ?? 'zstd';
    const level = options.level ?? (codec === 'zstd' ? COLD_ZSTD_LEVEL : COLD_DEFLATE_LEVEL);
    const segmentBytes = options.segmentBytes ?? COLD_ZSTD_SEGMENT_BYTES;
    const preserveOffsets = checkpoint.kind === 'found' && checkpoint.offset > 0 ? [checkpoint.offset] : undefined;
    const seal = await sealColdSegments(storage, address.scope, address.key, sealedCut, {
      codec,
      level,
      segmentBytes,
      reclaim,
      incremental: options.incremental ?? true,
      keepHeadBytes,
      preserveOffsets,
      signal: options.signal,
    });
    const allocatedAfter = seal.allocatedBytesAfter ?? (await allocatedFileBytes(wirePath, options.signal)) ?? size;
    const segmentBytesAfter = await directoryAllocatedBytes(`${wirePath}.segments`);
    return {
      wirePath,
      skipped: false,
      logicalSize: size,
      seal,
      allocatedWireBytesBefore: allocatedBefore,
      allocatedWireBytesAfter: allocatedAfter,
      segmentBytesBefore,
      segmentBytesAfter,
      physicalBytesBefore: allocatedBefore + segmentBytesBefore,
      physicalBytesAfter: allocatedAfter + segmentBytesAfter,
    };
  } finally {
    await storage.close();
  }
}

export async function compactRetainedSession(
  sessionDir: string,
  options: RetainedCompactOptions = {},
): Promise<RetainedCompactSessionResult> {
  const wires = await sessionWirePaths(sessionDir);
  const journals: RetainedCompactJournalResult[] = [];
  let compactedJournals = 0;
  let skippedJournals = 0;
  let reusedSegments = 0;
  let logicalBytes = 0;
  let allocatedWireBytesBefore = 0;
  let allocatedWireBytesAfter = 0;
  let segmentBytesBefore = 0;
  let segmentBytesAfter = 0;
  for (const wirePath of wires) {
    options.signal?.throwIfAborted();
    const item = await compactRetainedJournal(wirePath, options);
    journals.push(item);
    logicalBytes += item.logicalSize;
    allocatedWireBytesBefore += item.allocatedWireBytesBefore;
    allocatedWireBytesAfter += item.allocatedWireBytesAfter;
    segmentBytesBefore += item.segmentBytesBefore;
    segmentBytesAfter += item.segmentBytesAfter;
    if (item.skipped) skippedJournals += 1;
    else {
      compactedJournals += 1;
      reusedSegments += item.seal?.reusedSegmentCount ?? 0;
    }
  }
  return {
    sessionDir,
    totalJournals: wires.length,
    compactedJournals,
    skippedJournals,
    reusedSegments,
    logicalBytes,
    allocatedWireBytesBefore,
    allocatedWireBytesAfter,
    segmentBytesBefore,
    segmentBytesAfter,
    physicalBytesBefore: allocatedWireBytesBefore + segmentBytesBefore,
    physicalBytesAfter: allocatedWireBytesAfter + segmentBytesAfter,
    journals,
  };
}

function resolveHotTailBytes(wirePath: string, size: number, options: RetainedCompactOptions): number {
  if (options.hotTailBytes !== undefined) return Math.max(0, options.hotTailBytes);
  const agentDirName = basename(dirname(wirePath));
  if (agentDirName === 'main') {
    if (options.mainHotTailBytes !== undefined) return Math.max(0, options.mainHotTailBytes);
    return size >= DEFAULT_MAIN_LARGE_THRESHOLD_BYTES
      ? DEFAULT_MAIN_HOT_TAIL_BYTES
      : DEFAULT_MAIN_MEDIUM_HOT_TAIL_BYTES;
  }
  return Math.max(0, options.subagentHotTailBytes ?? DEFAULT_SUBAGENT_HOT_TAIL_BYTES);
}

type CheckpointWireOffset =
  | { readonly kind: 'absent' }
  | { readonly kind: 'found'; readonly offset: number }
  | { readonly kind: 'unreadable' };

async function inspectCheckpointWireOffset(agentDir: string, signal?: AbortSignal): Promise<CheckpointWireOffset> {
  const candidates = [
    join(agentDir, REPLAY_CHECKPOINT_SUBSCOPE, REPLAY_CHECKPOINT_PRIMARY_KEY),
    join(agentDir, REPLAY_CHECKPOINT_SUBSCOPE, COLD_CHECKPOINT_PROJECTION_KEY),
  ];
  let sawMissing = 0;
  for (const checkpointPath of candidates) {
    let handle;
    try {
      handle = await open(checkpointPath, 'r');
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
      await handle.close();
      handle = undefined;
      if (bytesRead > 0) {
        const head = buffer.subarray(0, bytesRead).toString('utf8');
        const match = /"wire"\s*:\s*\{[^{}]*?"size"\s*:\s*(\d+)/.exec(head);
        if (match !== null) {
          const parsed = Number(match[1]);
          if (Number.isSafeInteger(parsed) && parsed >= 0) {
            return { kind: 'found', offset: parsed };
          }
        }
      }
      const fullText = await readFile(checkpointPath, { encoding: 'utf8', signal });
      const parsedJson = JSON.parse(fullText) as { wire?: { size?: unknown } } | null;
      const wireSize = parsedJson?.wire?.size;
      if (typeof wireSize === 'number' && Number.isSafeInteger(wireSize) && wireSize >= 0) {
        return { kind: 'found', offset: wireSize };
      }
      return { kind: 'unreadable' };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isEnoent(error)) {
        sawMissing += 1;
        continue;
      }
      return { kind: 'unreadable' };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  const archives: ReadonlyArray<{ readonly key: string; readonly kind: 'zst' | 'gz' }> = [
    { key: COLD_CHECKPOINT_ARCHIVE_ZST_KEY, kind: 'zst' },
    { key: COLD_CHECKPOINT_ARCHIVE_GZ_KEY, kind: 'gz' },
  ];
  for (const archive of archives) {
    const archivePath = join(agentDir, REPLAY_CHECKPOINT_SUBSCOPE, archive.key);
    try {
      const compressed = await readFile(archivePath, { signal });
      const decompressed = archive.kind === 'zst' ? zstdDecompressSync(compressed) : gunzipSync(compressed);
      const parsedJson = JSON.parse(decompressed.toString('utf8')) as { wire?: { size?: unknown } } | null;
      const wireSize = parsedJson?.wire?.size;
      if (typeof wireSize === 'number' && Number.isSafeInteger(wireSize) && wireSize >= 0) {
        return { kind: 'found', offset: wireSize };
      }
      return { kind: 'unreadable' };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isEnoent(error)) continue;
      return { kind: 'unreadable' };
    }
  }
  return sawMissing === candidates.length ? { kind: 'absent' } : { kind: 'unreadable' };
}

async function directoryAllocatedBytes(dirPath: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dirPath, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    const filePath = join(entry.parentPath, entry.name);
    const info = await stat(filePath).catch(() => undefined);
    if (info !== undefined) total += info.size;
  }
  const manifestInfo = await stat(`${dirPath}.json`).catch(() => undefined);
  if (manifestInfo !== undefined) total += manifestInfo.size;
  return total;
}

export async function sessionWirePaths(sessionDir: string): Promise<readonly string[]> {
  const agentsDir = join(sessionDir, 'agents');
  let entries;
  try {
    entries = await readdir(agentsDir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile() || entry.name !== WIRE_FILENAME) continue;
    paths.push(join(entry.parentPath, entry.name));
  }
  return paths;
}

async function recordCutAtOrBefore(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  limitOffset: number,
  signal?: AbortSignal,
): Promise<number> {
  if (limitOffset <= 0) return 0;
  const pinned = await openPinnedLogicalRead(storage, scope, key, signal);
  try {
    const size = pinned.size ?? 0;
    const ceiling = Math.min(limitOffset, size);
    if (ceiling <= 0) return 0;
    const tail = await readPinnedRange(pinned, ceiling - 1, 1, signal);
    if (tail.byteLength === 1 && tail[0] === 0x0a) return ceiling;
    let end = ceiling;
    while (end > 0) {
      signal?.throwIfAborted();
      const start = Math.max(0, end - (64 * 1024));
      const chunk = await readPinnedRange(pinned, start, end - start, signal);
      for (let index = chunk.byteLength - 1; index >= 0; index -= 1) {
        if (chunk[index] === 0x0a) return start + index + 1;
      }
      if (start === 0) break;
      end = start;
    }
    return 0;
  } finally {
    pinned.close();
  }
}

function isEnoent(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';
}
