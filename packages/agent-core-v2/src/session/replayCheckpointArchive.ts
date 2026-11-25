import { createHash } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';
import { gunzipSync, gzipSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { dirname, join } from 'pathe';

import { writeFileAtomicDurable } from '#/_base/utils/fs';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import {
  decodeReplayCheckpointGraph,
  decodeReplayCheckpointStates,
  encodeReplayCheckpointGraph,
  type ReplayCheckpointGraph,
} from '#/state/replayCheckpointCodec';
import type { ReplayCheckpointEnvelope, ReplayCheckpointWire } from '#/state/eventDispatcherService';

/** Subdirectory under an agent scope containing replay checkpoints and cold archives. */
export const REPLAY_CHECKPOINT_SUBSCOPE = 'replay-checkpoints';

/** Primary uncompressed replay checkpoint filename. */
export const REPLAY_CHECKPOINT_PRIMARY_KEY = 'engine-v1';

/** Versioned read-only cold projection filename for slimmed leaf checkpoints. */
export const COLD_CHECKPOINT_PROJECTION_KEY = 'cold-projection-v1.json';

/** Lossless zstd-compressed full replay checkpoint archive filename. */
export const COLD_CHECKPOINT_ARCHIVE_ZST_KEY = 'engine-v1.archive.zst';

/** Lossless gzip-compressed fallback replay checkpoint archive filename. */
export const COLD_CHECKPOINT_ARCHIVE_GZ_KEY = 'engine-v1.archive.gz';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Independent read-only cold projection stored alongside a lossless compressed full checkpoint archive. */
export interface ColdCheckpointProjection {
  readonly format: 1;
  readonly kind: 'cold-projection';
  readonly replayAbi: number;
  readonly wire: ReplayCheckpointWire;
  readonly stateNames: readonly string[];
  readonly projectedStateNames: readonly string[];
  readonly projectedGraph: ReplayCheckpointGraph;
  readonly archiveKey: typeof COLD_CHECKPOINT_ARCHIVE_ZST_KEY | typeof COLD_CHECKPOINT_ARCHIVE_GZ_KEY;
  readonly archiveSha256: string;
  readonly originalBytes: number;
  readonly archivedAt: number;
}

/** Result returned by slimming one cold leaf agent's replay checkpoint. */
export interface SlimReplayCheckpointResult {
  readonly agentDir: string;
  readonly status: 'slimmed' | 'skipped';
  readonly reason?: string;
  readonly originalBytes: number;
  readonly projectionBytes: number;
  readonly archiveBytes: number;
  readonly reclaimedBytes: number;
}

/** Result returned by rehydrating a slimmed replay checkpoint archive back to `engine-v1`. */
export interface RehydrateReplayCheckpointResult {
  readonly agentDir: string;
  readonly restored: boolean;
  readonly restoredBytes: number;
  readonly reason?: string;
}

function isColdCheckpointProjection(value: unknown): value is ColdCheckpointProjection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ColdCheckpointProjection>;
  return (
    candidate.format === 1 &&
    candidate.kind === 'cold-projection' &&
    typeof candidate.replayAbi === 'number' &&
    candidate.wire !== undefined &&
    typeof candidate.wire === 'object' &&
    Array.isArray(candidate.stateNames) &&
    Array.isArray(candidate.projectedStateNames) &&
    candidate.projectedGraph !== undefined &&
    typeof candidate.projectedGraph === 'object' &&
    (candidate.archiveKey === COLD_CHECKPOINT_ARCHIVE_ZST_KEY || candidate.archiveKey === COLD_CHECKPOINT_ARCHIVE_GZ_KEY) &&
    typeof candidate.archiveSha256 === 'string' &&
    /^[0-9a-f]{64}$/u.test(candidate.archiveSha256) &&
    typeof candidate.originalBytes === 'number' &&
    Number.isSafeInteger(candidate.originalBytes) &&
    candidate.originalBytes > 0
  );
}

function compressArchiveBytes(raw: Uint8Array): {
  readonly archiveKey: typeof COLD_CHECKPOINT_ARCHIVE_ZST_KEY | typeof COLD_CHECKPOINT_ARCHIVE_GZ_KEY;
  readonly compressed: Buffer;
} {
  if (typeof zstdCompressSync === 'function' && typeof zstdDecompressSync === 'function') {
    return { archiveKey: COLD_CHECKPOINT_ARCHIVE_ZST_KEY, compressed: zstdCompressSync(raw) };
  }
  return { archiveKey: COLD_CHECKPOINT_ARCHIVE_GZ_KEY, compressed: gzipSync(raw, { level: 6 }) };
}

function decompressArchiveBytes(
  compressed: Uint8Array,
  archiveKey: typeof COLD_CHECKPOINT_ARCHIVE_ZST_KEY | typeof COLD_CHECKPOINT_ARCHIVE_GZ_KEY,
): Buffer {
  if (archiveKey === COLD_CHECKPOINT_ARCHIVE_ZST_KEY) {
    return zstdDecompressSync(compressed);
  }
  return gunzipSync(compressed);
}

function parseFullEnvelope(raw: Uint8Array, expectedAbi: number): ReplayCheckpointEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(raw));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const envelope = parsed as Partial<ReplayCheckpointEnvelope>;
  if (
    envelope.format !== 1 ||
    envelope.replayAbi !== expectedAbi ||
    envelope.wire === undefined ||
    envelope.graph === undefined ||
    (envelope.stateNames !== undefined && !Array.isArray(envelope.stateNames))
  ) {
    return undefined;
  }
  return envelope as ReplayCheckpointEnvelope;
}

/** Reads a full replay checkpoint envelope from compressed archive storage when `engine-v1` has been slimmed. */
export async function readArchivedReplayCheckpointEnvelope(
  storage: IFileSystemStorageService,
  checkpointScope: string,
  expectedAbi: number,
): Promise<ReplayCheckpointEnvelope | undefined> {
  const projectionBytes = await storage.read(checkpointScope, COLD_CHECKPOINT_PROJECTION_KEY, { recoverMissing: false }).catch(() => undefined);
  let projection: ColdCheckpointProjection | undefined;
  if (projectionBytes !== undefined) {
    try {
      const parsed = JSON.parse(textDecoder.decode(projectionBytes));
      if (isColdCheckpointProjection(parsed) && parsed.replayAbi === expectedAbi) {
        projection = parsed;
      }
    } catch {
      projection = undefined;
    }
  }
  const archiveKeys: readonly (typeof COLD_CHECKPOINT_ARCHIVE_ZST_KEY | typeof COLD_CHECKPOINT_ARCHIVE_GZ_KEY)[] =
    projection !== undefined
      ? [projection.archiveKey]
      : [COLD_CHECKPOINT_ARCHIVE_ZST_KEY, COLD_CHECKPOINT_ARCHIVE_GZ_KEY];
  for (const key of archiveKeys) {
    const compressed = await storage.read(checkpointScope, key, { recoverMissing: false }).catch(() => undefined);
    if (compressed === undefined) continue;
    let raw: Buffer;
    try {
      raw = decompressArchiveBytes(compressed, key);
    } catch {
      continue;
    }
    if (projection !== undefined) {
      if (raw.byteLength !== projection.originalBytes) continue;
      if (createHash('sha256').update(raw).digest('hex') !== projection.archiveSha256) continue;
    }
    const envelope = parseFullEnvelope(raw, expectedAbi);
    if (envelope !== undefined) return envelope;
  }
  return undefined;
}

/** Reads requested checkpoint states from `engine-v1`, falling back to `cold-projection-v1.json` or compressed archive. */
export async function readCheckpointStatesFromStorage(
  storage: IFileSystemStorageService,
  checkpointScope: string,
  names: ReadonlySet<string>,
  expectedAbi: number,
): Promise<{ readonly wire: ReplayCheckpointWire; readonly states: ReadonlyMap<string, unknown> } | undefined> {
  const primary = await storage.read(checkpointScope, REPLAY_CHECKPOINT_PRIMARY_KEY).catch(() => undefined);
  if (primary !== undefined) {
    const envelope = parseFullEnvelope(primary, expectedAbi);
    if (envelope !== undefined) {
      try {
        return {
          wire: envelope.wire,
          states: decodeReplayCheckpointStates(envelope.graph, names),
        };
      } catch {
        return undefined;
      }
    }
  }
  const projectionBytes = await storage.read(checkpointScope, COLD_CHECKPOINT_PROJECTION_KEY, { recoverMissing: false }).catch(() => undefined);
  if (projectionBytes !== undefined) {
    let projection: ColdCheckpointProjection | undefined;
    try {
      const parsed = JSON.parse(textDecoder.decode(projectionBytes));
      if (isColdCheckpointProjection(parsed) && parsed.replayAbi === expectedAbi) {
        projection = parsed;
      }
    } catch {
      projection = undefined;
    }
    if (projection !== undefined) {
      const availableInProjection = new Set(projection.projectedStateNames);
      const presentInFull = new Set(projection.stateNames);
      const needsFullArchive = [...names].some((name) => presentInFull.has(name) && !availableInProjection.has(name));
      if (!needsFullArchive) {
        try {
          return {
            wire: projection.wire,
            states: decodeReplayCheckpointStates(projection.projectedGraph, names),
          };
        } catch {
        }
      }
    }
  }
  const archived = await readArchivedReplayCheckpointEnvelope(storage, checkpointScope, expectedAbi);
  if (archived === undefined) return undefined;
  try {
    return {
      wire: archived.wire,
      states: decodeReplayCheckpointStates(archived.graph, names),
    };
  } catch {
    return undefined;
  }
}

/** Reads requested checkpoint states from a direct filesystem path (`.../replay-checkpoints/engine-v1`), supporting slimmed cold projections and archives. */
export async function readCheckpointStatesFromPath(
  primaryFilePath: string,
  names: ReadonlySet<string>,
  expectedAbi: number,
  signal?: AbortSignal,
): Promise<{ readonly wire: ReplayCheckpointWire; readonly states: ReadonlyMap<string, unknown> } | undefined> {
  signal?.throwIfAborted();
  const dir = dirname(primaryFilePath);
  const primary = await readFile(primaryFilePath).catch(() => undefined);
  signal?.throwIfAborted();
  if (primary !== undefined) {
    const envelope = parseFullEnvelope(primary, expectedAbi);
    if (envelope !== undefined) {
      try {
        return {
          wire: envelope.wire,
          states: decodeReplayCheckpointStates(envelope.graph, names),
        };
      } catch {
        return undefined;
      }
    }
  }
  const projectionRaw = await readFile(join(dir, COLD_CHECKPOINT_PROJECTION_KEY)).catch(() => undefined);
  signal?.throwIfAborted();
  let projection: ColdCheckpointProjection | undefined;
  if (projectionRaw !== undefined) {
    try {
      const parsed = JSON.parse(textDecoder.decode(projectionRaw));
      if (isColdCheckpointProjection(parsed) && parsed.replayAbi === expectedAbi) {
        projection = parsed;
      }
    } catch {
      projection = undefined;
    }
  }
  if (projection !== undefined) {
    const availableInProjection = new Set(projection.projectedStateNames);
    const presentInFull = new Set(projection.stateNames);
    const needsFullArchive = [...names].some((name) => presentInFull.has(name) && !availableInProjection.has(name));
    if (!needsFullArchive) {
      try {
        return {
          wire: projection.wire,
          states: decodeReplayCheckpointStates(projection.projectedGraph, names),
        };
      } catch {
      }
    }
  }
  const archiveKeys: readonly (typeof COLD_CHECKPOINT_ARCHIVE_ZST_KEY | typeof COLD_CHECKPOINT_ARCHIVE_GZ_KEY)[] =
    projection !== undefined
      ? [projection.archiveKey]
      : [COLD_CHECKPOINT_ARCHIVE_ZST_KEY, COLD_CHECKPOINT_ARCHIVE_GZ_KEY];
  for (const key of archiveKeys) {
    const compressed = await readFile(join(dir, key)).catch(() => undefined);
    signal?.throwIfAborted();
    if (compressed === undefined) continue;
    let raw: Buffer;
    try {
      raw = decompressArchiveBytes(compressed, key);
    } catch {
      continue;
    }
    if (projection !== undefined) {
      if (raw.byteLength !== projection.originalBytes) continue;
      if (createHash('sha256').update(raw).digest('hex') !== projection.archiveSha256) continue;
    }
    const envelope = parseFullEnvelope(raw, expectedAbi);
    if (envelope === undefined) continue;
    try {
      return {
        wire: envelope.wire,
        states: decodeReplayCheckpointStates(envelope.graph, names),
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Losslessly slims a cold leaf agent's `replay-checkpoints/engine-v1` into a verified cold projection plus reversible compressed full archive. */
export async function slimColdReplayCheckpoint(
  agentDir: string,
  lightweightStateNames: ReadonlySet<string>,
  expectedAbi: number,
  signal?: AbortSignal,
): Promise<SlimReplayCheckpointResult> {
  signal?.throwIfAborted();
  const ckptDir = join(agentDir, REPLAY_CHECKPOINT_SUBSCOPE);
  const primaryPath = join(ckptDir, REPLAY_CHECKPOINT_PRIMARY_KEY);
  let rawBytes: Buffer;
  try {
    rawBytes = await readFile(primaryPath);
  } catch {
    return {
      agentDir,
      status: 'skipped',
      reason: 'primary_checkpoint_missing',
      originalBytes: 0,
      projectionBytes: 0,
      archiveBytes: 0,
      reclaimedBytes: 0,
    };
  }
  signal?.throwIfAborted();
  const originalBytes = rawBytes.byteLength;
  const envelope = parseFullEnvelope(rawBytes, expectedAbi);
  if (envelope === undefined) {
    return {
      agentDir,
      status: 'skipped',
      reason: 'unrecognized_checkpoint_format_or_abi',
      originalBytes,
      projectionBytes: 0,
      archiveBytes: 0,
      reclaimedBytes: 0,
    };
  }
  const decodedFull = decodeReplayCheckpointGraph(envelope.graph) as {
    readonly states?: readonly { readonly name: string; readonly value: unknown; readonly meta: unknown }[];
  };
  if (!Array.isArray(decodedFull?.states)) {
    return {
      agentDir,
      status: 'skipped',
      reason: 'invalid_checkpoint_graph',
      originalBytes,
      projectionBytes: 0,
      archiveBytes: 0,
      reclaimedBytes: 0,
    };
  }
  const projectedEntries = decodedFull.states.filter((entry) => lightweightStateNames.has(entry.name));
  const projectedGraph = encodeReplayCheckpointGraph({ states: projectedEntries });
  const originalSha256 = createHash('sha256').update(rawBytes).digest('hex');
  const { archiveKey, compressed } = compressArchiveBytes(rawBytes);

  const roundTrip = decompressArchiveBytes(compressed, archiveKey);
  if (
    roundTrip.byteLength !== originalBytes ||
    createHash('sha256').update(roundTrip).digest('hex') !== originalSha256
  ) {
    return {
      agentDir,
      status: 'skipped',
      reason: 'archive_verification_failed',
      originalBytes,
      projectionBytes: 0,
      archiveBytes: compressed.byteLength,
      reclaimedBytes: 0,
    };
  }

  const projection: ColdCheckpointProjection = {
    format: 1,
    kind: 'cold-projection',
    replayAbi: expectedAbi,
    wire: envelope.wire,
    stateNames: Array.isArray(envelope.stateNames)
      ? envelope.stateNames
      : decodedFull.states.map((entry) => entry.name),
    projectedStateNames: projectedEntries.map((entry) => entry.name),
    projectedGraph,
    archiveKey,
    archiveSha256: originalSha256,
    originalBytes,
    archivedAt: Date.now(),
  };
  const projectionBytes = textEncoder.encode(JSON.stringify(projection));
  if (projectionBytes.byteLength + compressed.byteLength >= originalBytes) {
    return {
      agentDir,
      status: 'skipped',
      reason: 'no_net_savings',
      originalBytes,
      projectionBytes: projectionBytes.byteLength,
      archiveBytes: compressed.byteLength,
      reclaimedBytes: 0,
    };
  }

  const archivePath = join(ckptDir, archiveKey);
  const projectionPath = join(ckptDir, COLD_CHECKPOINT_PROJECTION_KEY);
  await writeFileAtomicDurable(archivePath, compressed);
  await writeFileAtomicDurable(projectionPath, projectionBytes);

  const verifiedArchive = decompressArchiveBytes(await readFile(archivePath), archiveKey);
  if (
    verifiedArchive.byteLength !== originalBytes ||
    createHash('sha256').update(verifiedArchive).digest('hex') !== originalSha256
  ) {
    await unlink(projectionPath).catch(() => undefined);
    await unlink(archivePath).catch(() => undefined);
    return {
      agentDir,
      status: 'skipped',
      reason: 'post_write_verification_failed',
      originalBytes,
      projectionBytes: 0,
      archiveBytes: 0,
      reclaimedBytes: 0,
    };
  }
  let projectionReadbackOk = false;
  try {
    const readbackParsed = JSON.parse(textDecoder.decode(await readFile(projectionPath)));
    if (isColdCheckpointProjection(readbackParsed) && readbackParsed.replayAbi === expectedAbi) {
      decodeReplayCheckpointStates(readbackParsed.projectedGraph, new Set(readbackParsed.projectedStateNames));
      projectionReadbackOk = true;
    }
  } catch {
    projectionReadbackOk = false;
  }
  if (!projectionReadbackOk) {
    await unlink(projectionPath).catch(() => undefined);
    await unlink(archivePath).catch(() => undefined);
    return {
      agentDir,
      status: 'skipped',
      reason: 'projection_readback_failed',
      originalBytes,
      projectionBytes: 0,
      archiveBytes: 0,
      reclaimedBytes: 0,
    };
  }

  await unlink(primaryPath);
  return {
    agentDir,
    status: 'slimmed',
    originalBytes,
    projectionBytes: projectionBytes.byteLength,
    archiveBytes: compressed.byteLength,
    reclaimedBytes: originalBytes - (projectionBytes.byteLength + compressed.byteLength),
  };
}

/** Restores exact byte-identical `replay-checkpoints/engine-v1` from a slimmed archive for rollback or downgrade safety. */
export async function rehydrateColdReplayCheckpoint(
  agentDir: string,
  expectedAbi: number,
  signal?: AbortSignal,
): Promise<RehydrateReplayCheckpointResult> {
  signal?.throwIfAborted();
  const ckptDir = join(agentDir, REPLAY_CHECKPOINT_SUBSCOPE);
  const primaryPath = join(ckptDir, REPLAY_CHECKPOINT_PRIMARY_KEY);
  const existing = await stat(primaryPath).catch(() => undefined);
  if (existing !== undefined && existing.isFile()) {
    return { agentDir, restored: false, restoredBytes: 0, reason: 'already_present' };
  }
  const projectionPath = join(ckptDir, COLD_CHECKPOINT_PROJECTION_KEY);
  const projectionRaw = await readFile(projectionPath).catch(() => undefined);
  let projection: ColdCheckpointProjection | undefined;
  if (projectionRaw !== undefined) {
    try {
      const parsed = JSON.parse(textDecoder.decode(projectionRaw));
      if (isColdCheckpointProjection(parsed)) projection = parsed;
    } catch {
      projection = undefined;
    }
  }
  const archiveKeys: readonly (typeof COLD_CHECKPOINT_ARCHIVE_ZST_KEY | typeof COLD_CHECKPOINT_ARCHIVE_GZ_KEY)[] =
    projection !== undefined
      ? [projection.archiveKey]
      : [COLD_CHECKPOINT_ARCHIVE_ZST_KEY, COLD_CHECKPOINT_ARCHIVE_GZ_KEY];
  for (const key of archiveKeys) {
    const archivePath = join(ckptDir, key);
    const compressed = await readFile(archivePath).catch(() => undefined);
    if (compressed === undefined) continue;
    let raw: Buffer;
    try {
      raw = decompressArchiveBytes(compressed, key);
    } catch {
      continue;
    }
    if (projection !== undefined) {
      if (raw.byteLength !== projection.originalBytes) continue;
      if (createHash('sha256').update(raw).digest('hex') !== projection.archiveSha256) continue;
    }
    if (parseFullEnvelope(raw, expectedAbi) === undefined) continue;
    await writeFileAtomicDurable(primaryPath, raw);
    await unlink(projectionPath).catch(() => undefined);
    await unlink(archivePath).catch(() => undefined);
    return { agentDir, restored: true, restoredBytes: raw.byteLength };
  }
  return { agentDir, restored: false, restoredBytes: 0, reason: 'archive_missing_or_corrupt' };
}

/** Removes any stale cold projection or archive artifacts after a fresh primary `engine-v1` checkpoint is written. */
export async function cleanupColdCheckpointArchives(
  storage: IFileSystemStorageService,
  checkpointScope: string,
): Promise<void> {
  await Promise.all([
    storage.delete(checkpointScope, COLD_CHECKPOINT_PROJECTION_KEY).catch(() => undefined),
    storage.delete(checkpointScope, COLD_CHECKPOINT_ARCHIVE_ZST_KEY).catch(() => undefined),
    storage.delete(checkpointScope, COLD_CHECKPOINT_ARCHIVE_GZ_KEY).catch(() => undefined),
  ]);
}
