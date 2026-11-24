import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'pathe';

import { replaceFileNonDestructive, syncDir, writeFileAtomicDurable } from '#/_base/utils/fs';
import { ContentAddressedStoreService } from '#/persistence/backends/node-fs/contentAddressedStoreService';
import { SESSION_LOCK_SCOPE, sessionLockKey } from '#/persistence/backends/node-fs/fileLock';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { LIGHTWEIGHT_STATE_NAMES } from '#/session/persistedAgentCheckpoint';
import {
  COLD_CHECKPOINT_ARCHIVE_GZ_KEY,
  COLD_CHECKPOINT_ARCHIVE_ZST_KEY,
  COLD_CHECKPOINT_PROJECTION_KEY,
  REPLAY_CHECKPOINT_PRIMARY_KEY,
  REPLAY_CHECKPOINT_SUBSCOPE,
  rehydrateColdReplayCheckpoint,
  slimColdReplayCheckpoint,
} from '#/session/replayCheckpointArchive';
import { REPLAY_ABI_VERSION } from '#/state/eventDispatcherService';

const STREAM_CHUNK_BYTES = 64 * 1024;
const QUARANTINE_RETENTION_DAYS = 14;
const DEFAULT_SLIM_MIN_AGE_DAYS = 30;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'ascii');
const TERMINAL_AGENT_STATUSES = new Set(['completed', 'failed', 'cancelled', 'killed']);

/** Exact allowlist of retired derived storage roots eligible for gated quarantine cleanup. */
export const RETIRED_STORAGE_ALLOWLIST = [
  {
    relativePath: 'cache/query-store-v3',
    successorRelativePath: 'cache/query-store-sqlite-v1/index.sqlite',
    kind: 'query_store_legacy',
  },
  {
    relativePath: 'cache/query-store-v4',
    successorRelativePath: 'cache/query-store-sqlite-v1/index.sqlite',
    kind: 'query_store_legacy',
  },
  {
    relativePath: 'search-index',
    successorRelativePath: 'search-index-v2/index.sqlite',
    kind: 'search_index_legacy',
  },
] as const;

/** Aggregate file count and logical/physical byte measurements for one storage bucket. */
export interface StorageBucketStats {
  readonly files: number;
  readonly logicalBytes: number;
  readonly physicalBytes: number;
}

/** Inspection state of one allowlisted retired derived storage root. */
export interface RetiredRootStatus {
  readonly relativePath: string;
  readonly exists: boolean;
  readonly files: number;
  readonly bytes: number;
  readonly successorRelativePath: string;
  readonly successorReady: boolean;
  readonly successorReason?: string;
}

/** Read-only visibility entry for a user workspace root (permanently excluded from automated cleanup). */
export interface WorkspaceStorageEntry {
  readonly name: string;
  readonly files: number;
  readonly bytes: number;
}

/** Full read-only storage governance report for one Kiki home directory. */
export interface StorageStatusReport {
  readonly schemaVersion: 1;
  readonly homeDir: string;
  readonly sessions: {
    readonly total: StorageBucketStats;
    readonly wires: StorageBucketStats;
    readonly media: StorageBucketStats;
    readonly agentBlobs: StorageBucketStats;
    readonly attachments: StorageBucketStats;
    readonly mediaOriginals: StorageBucketStats;
    readonly replayCheckpoints: StorageBucketStats;
  };
  readonly blobs: StorageBucketStats;
  readonly replayCheckpoints: {
    readonly primaryCount: number;
    readonly primaryBytes: number;
    readonly slimmedCount: number;
    readonly slimmedBytes: number;
  };
  readonly cache: {
    readonly total: StorageBucketStats;
    readonly pluginMediaInputs: StorageBucketStats;
    readonly pluginMediaStaging: StorageBucketStats;
    readonly mediaPreviews: StorageBucketStats;
    readonly stagedFiles: StorageBucketStats;
  };
  readonly retired: readonly RetiredRootStatus[];
  readonly quarantine: StorageBucketStats;
  readonly workspaces: {
    readonly excludedFromCleanup: true;
    readonly totalFiles: number;
    readonly totalBytes: number;
    readonly entries: readonly WorkspaceStorageEntry[];
  };
}

/** Options controlling `deduplicate()` execution. */
export interface StorageDeduplicateOptions {
  readonly apply?: boolean;
  readonly signal?: AbortSignal;
}

/** Per-item outcome recorded in the deduplication manifest and plan report. */
export interface DeduplicateItemRecord {
  readonly path: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly key: string;
  readonly size: number;
  readonly rawSha256?: string;
  readonly inodeKey?: string;
  readonly phase: 'planned' | 'already_deduplicated' | 'excluded' | 'skipped' | 'committed' | 'failed';
  readonly reason?: string;
}

/** Result returned by `deduplicate()` in dry-run or `--apply` mode. */
export interface StorageDeduplicateReport {
  readonly schemaVersion: 1;
  readonly homeDir: string;
  readonly applied: boolean;
  readonly scannedFiles: number;
  readonly candidateFiles: number;
  readonly uniqueDigests: number;
  readonly alreadyDeduplicatedFiles: number;
  readonly excludedFiles: number;
  readonly skippedFiles: number;
  readonly committedFiles: number;
  readonly reclaimableBytes: number;
  readonly reclaimedBytes: number;
  readonly manifestPath?: string;
  readonly items: readonly DeduplicateItemRecord[];
}

/** Options controlling `cleanRetired()` execution. */
export interface StorageCleanRetiredOptions {
  readonly apply?: boolean;
  readonly purgeQuarantine?: boolean;
  readonly rollbackRunId?: string;
  readonly minQuarantineAgeDays?: number;
  readonly signal?: AbortSignal;
}

/** Per-root outcome of retired index cleanup, quarantine, or rollback. */
export interface CleanRetiredItemResult {
  readonly relativePath: string;
  readonly bytes: number;
  readonly files: number;
  readonly status: 'planned' | 'quarantined' | 'skipped' | 'restored' | 'purged' | 'absent';
  readonly quarantinePath?: string;
  readonly reason?: string;
}

/** Result returned by `cleanRetired()`. */
export interface StorageCleanRetiredReport {
  readonly schemaVersion: 1;
  readonly homeDir: string;
  readonly applied: boolean;
  readonly runId?: string;
  readonly quarantinedBytes: number;
  readonly freedBytes: number;
  readonly restoredBytes: number;
  readonly rollbackManifestPath?: string;
  readonly items: readonly CleanRetiredItemResult[];
}

/** Options controlling `slimCheckpoints()` execution. */
export interface StorageSlimCheckpointsOptions {
  readonly apply?: boolean;
  readonly rehydrate?: boolean;
  readonly minAgeDays?: number;
  readonly signal?: AbortSignal;
}

/** Result returned by `slimCheckpoints()`. */
export interface StorageSlimCheckpointsReport {
  readonly schemaVersion: 1;
  readonly homeDir: string;
  readonly applied: boolean;
  readonly rehydrated: boolean;
  readonly minAgeDays: number;
  readonly scannedCount: number;
  readonly eligibleCount: number;
  readonly slimmedCount: number;
  readonly rehydratedCount: number;
  readonly skippedCount: number;
  readonly originalBytes: number;
  readonly slimmedBytes: number;
  readonly reclaimedBytes: number;
  readonly restoredBytes: number;
}

interface QuarantineManifest {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly homeDir: string;
  readonly createdAt: number;
  readonly retentionDays: number;
  readonly items: readonly {
    readonly relativePath: string;
    readonly quarantinePath: string;
    readonly bytes: number;
    readonly files: number;
    readonly successorRelativePath: string;
  }[];
}

interface SessionMetadataShape {
  readonly id?: unknown;
  readonly private?: unknown;
  readonly agents?: Readonly<Record<string, {
    readonly type?: unknown;
    readonly status?: unknown;
    readonly taskId?: unknown;
    readonly parentAgentId?: unknown;
    readonly delegator?: unknown;
  }>>;
}

function emptyBucket(): { files: number; logicalBytes: number; physicalBytes: number; seenInodes: Set<string> } {
  return { files: 0, logicalBytes: 0, physicalBytes: 0, seenInodes: new Set<string>() };
}

function finalizeBucket(bucket: { files: number; logicalBytes: number; physicalBytes: number }): StorageBucketStats {
  return {
    files: bucket.files,
    logicalBytes: bucket.logicalBytes,
    physicalBytes: bucket.physicalBytes,
  };
}

function inodeKeyOf(info: { readonly dev: number | bigint; readonly ino: number | bigint }): string | undefined {
  const ino = BigInt(info.ino);
  const dev = BigInt(info.dev);
  return ino > 0n ? `${dev.toString(16)}:${ino.toString(16)}` : undefined;
}

function addFileToBucket(
  bucket: { files: number; logicalBytes: number; physicalBytes: number; seenInodes: Set<string> },
  size: number,
  inodeKey: string | undefined,
): void {
  bucket.files += 1;
  bucket.logicalBytes += size;
  if (inodeKey === undefined || !bucket.seenInodes.has(inodeKey)) {
    if (inodeKey !== undefined) bucket.seenInodes.add(inodeKey);
    bucket.physicalBytes += size;
  }
}

async function walkRegularFiles(
  rootDir: string,
  onFile: (fullPath: string, relPath: string, info: Awaited<ReturnType<typeof lstat>>) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const rootInfo = await lstat(rootDir, { bigint: true }).catch(() => undefined);
  if (rootInfo === undefined || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return;
  const stack: Array<{ readonly dir: string; readonly rel: string }> = [{ dir: rootDir, rel: '' }];
  while (stack.length > 0) {
    signal?.throwIfAborted();
    const current = stack.pop()!;
    const entries = await readdir(current.dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(current.dir, entry.name);
      const relPath = current.rel.length === 0 ? entry.name : `${current.rel}/${entry.name}`;
      const info = await lstat(fullPath, { bigint: true }).catch(() => undefined);
      if (info === undefined || info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        stack.push({ dir: fullPath, rel: relPath });
      } else if (info.isFile()) {
        await onFile(fullPath, relPath, info);
      }
    }
  }
}

async function digestFileSha256(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath, { highWaterMark: STREAM_CHUNK_BYTES, signal });
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      hash.update(chunk as Uint8Array);
    }
    return hash.digest('hex');
  } finally {
    stream.destroy();
  }
}

async function verifyColdRangeRead(filePath: string, expectedSize: number, expectedSha256: string, signal?: AbortSignal): Promise<boolean> {
  const info = await stat(filePath).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.size !== expectedSize) return false;
  if (expectedSize > 0) {
    const handle = await open(filePath, 'r');
    try {
      const probe = Buffer.alloc(Math.min(64, expectedSize));
      const offsets = [0, Math.floor(expectedSize / 2), Math.max(0, expectedSize - probe.byteLength)];
      for (const offset of offsets) {
        const toRead = Math.min(probe.byteLength, expectedSize - offset);
        const { bytesRead } = await handle.read(probe, 0, toRead, offset);
        if (bytesRead !== toRead) return false;
      }
    } finally {
      await handle.close();
    }
  }
  const actualSha = await digestFileSha256(filePath, signal).catch(() => undefined);
  return actualSha === expectedSha256;
}

async function checkSqliteSuccessorReady(
  homeDir: string,
  successorRelativePath: string,
): Promise<{ readonly ready: boolean; readonly reason?: string }> {
  const fullPath = join(homeDir, successorRelativePath);
  const info = await lstat(fullPath).catch(() => undefined);
  if (info === undefined || info.isSymbolicLink() || !info.isFile()) {
    return { ready: false, reason: 'successor_missing' };
  }
  if (info.size < 100) {
    return { ready: false, reason: 'successor_too_small' };
  }
  const handle = await open(fullPath, 'r').catch(() => undefined);
  if (handle === undefined) {
    return { ready: false, reason: 'successor_unreadable' };
  }
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, 16, 0);
    if (bytesRead !== 16 || !header.equals(SQLITE_MAGIC)) {
      return { ready: false, reason: 'successor_invalid_sqlite_header' };
    }
    return { ready: true };
  } finally {
    await handle.close();
  }
}

async function readSessionMetadata(sessionDir: string): Promise<SessionMetadataShape | undefined> {
  const raw =
    (await readFile(join(sessionDir, 'state.json'), 'utf8').catch(() => undefined)) ??
    (await readFile(join(sessionDir, 'metadata.json'), 'utf8').catch(() => undefined));
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as SessionMetadataShape)
      : undefined;
  } catch {
    return undefined;
  }
}

function isInsideHome(homeDir: string, targetPath: string): boolean {
  const normHome = resolve(homeDir).replaceAll('\\', '/').replace(/\/+$/u, '');
  const normTarget = resolve(targetPath).replaceAll('\\', '/');
  const lhs = process.platform === 'win32' ? normHome.toLowerCase() : normHome;
  const rhs = process.platform === 'win32' ? normTarget.toLowerCase() : normTarget;
  return rhs === lhs || rhs.startsWith(`${lhs}/`);
}

/** Standalone storage inspection, safe blob deduplication, retired index quarantine, and cold leaf checkpoint slimming service. */
export class StorageGovernanceService {
  private readonly homeDir: string;

  constructor(homeDir: string) {
    this.homeDir = resolve(homeDir);
  }

  async status(signal?: AbortSignal): Promise<StorageStatusReport> {
    signal?.throwIfAborted();
    const sessionsTotal = emptyBucket();
    const wires = emptyBucket();
    const media = emptyBucket();
    const agentBlobs = emptyBucket();
    const attachments = emptyBucket();
    const mediaOriginals = emptyBucket();
    const replayCheckpoints = emptyBucket();
    let primaryCount = 0;
    let primaryBytes = 0;
    let slimmedCount = 0;
    let slimmedBytes = 0;

    await walkRegularFiles(join(this.homeDir, 'sessions'), (_fullPath, relPath, info) => {
      const size = Number(info.size);
      const inodeKey = inodeKeyOf(info);
      addFileToBucket(sessionsTotal, size, inodeKey);
      const parts = relPath.split('/');
      const name = parts.at(-1) ?? '';
      if (name === 'wire.jsonl' || parts.includes('wire.jsonl.segments')) {
        addFileToBucket(wires, size, inodeKey);
      } else if (parts.includes('media')) {
        addFileToBucket(media, size, inodeKey);
      } else if (parts.includes('blobs')) {
        addFileToBucket(agentBlobs, size, inodeKey);
      } else if (parts.includes('attachments')) {
        addFileToBucket(attachments, size, inodeKey);
      } else if (parts.includes('media-originals')) {
        addFileToBucket(mediaOriginals, size, inodeKey);
      } else if (parts.includes(REPLAY_CHECKPOINT_SUBSCOPE)) {
        addFileToBucket(replayCheckpoints, size, inodeKey);
        if (name === REPLAY_CHECKPOINT_PRIMARY_KEY) {
          primaryCount += 1;
          primaryBytes += size;
        } else if (
          name === COLD_CHECKPOINT_PROJECTION_KEY ||
          name === COLD_CHECKPOINT_ARCHIVE_ZST_KEY ||
          name === COLD_CHECKPOINT_ARCHIVE_GZ_KEY
        ) {
          if (name === COLD_CHECKPOINT_PROJECTION_KEY) slimmedCount += 1;
          slimmedBytes += size;
        }
      }
    }, signal);

    const blobsBucket = emptyBucket();
    await walkRegularFiles(join(this.homeDir, 'blobs', 'v2'), (_fullPath, _relPath, info) => {
      addFileToBucket(blobsBucket, Number(info.size), inodeKeyOf(info));
    }, signal);

    const retiredSet = new Set<string>(RETIRED_STORAGE_ALLOWLIST.map((item) => item.relativePath));
    const cacheTotal = emptyBucket();
    const pluginMediaInputs = emptyBucket();
    const pluginMediaStaging = emptyBucket();
    const mediaPreviews = emptyBucket();
    const quarantineBucket = emptyBucket();
    await walkRegularFiles(join(this.homeDir, 'cache'), (_fullPath, relPath, info) => {
      const top = relPath.split('/')[0] ?? '';
      if (retiredSet.has(`cache/${top}`)) return;
      const size = Number(info.size);
      const inodeKey = inodeKeyOf(info);
      if (top === '.quarantine-retired') {
        addFileToBucket(quarantineBucket, size, inodeKey);
        return;
      }
      addFileToBucket(cacheTotal, size, inodeKey);
      if (top === 'plugin-media-v1') {
        const second = relPath.split('/')[1] ?? '';
        if (second === 'inputs') addFileToBucket(pluginMediaInputs, size, inodeKey);
        else addFileToBucket(pluginMediaStaging, size, inodeKey);
      } else if (top === 'media-previews-v1') {
        addFileToBucket(mediaPreviews, size, inodeKey);
      }
    }, signal);

    const stagedFiles = emptyBucket();
    await walkRegularFiles(join(this.homeDir, 'files'), (_fullPath, _relPath, info) => {
      addFileToBucket(stagedFiles, Number(info.size), inodeKeyOf(info));
    }, signal);

    const retired: RetiredRootStatus[] = [];
    for (const item of RETIRED_STORAGE_ALLOWLIST) {
      const targetDir = join(this.homeDir, item.relativePath);
      const rootInfo = await lstat(targetDir).catch(() => undefined);
      const exists = rootInfo !== undefined && !rootInfo.isSymbolicLink();
      let files = 0;
      let bytes = 0;
      if (exists && rootInfo.isDirectory()) {
        await walkRegularFiles(targetDir, (_fp, _rp, info) => {
          files += 1;
          bytes += Number(info.size);
        }, signal);
      } else if (exists && rootInfo.isFile()) {
        files = 1;
        bytes = rootInfo.size;
      }
      const successor = await checkSqliteSuccessorReady(this.homeDir, item.successorRelativePath);
      retired.push({
        relativePath: item.relativePath,
        exists,
        files,
        bytes,
        successorRelativePath: item.successorRelativePath,
        successorReady: successor.ready,
        successorReason: successor.reason,
      });
    }

    const workspacesDir = join(this.homeDir, 'workspaces');
    const workspaceEntries: WorkspaceStorageEntry[] = [];
    let workspacesTotalFiles = 0;
    let workspacesTotalBytes = 0;
    const wsTop = await readdir(workspacesDir, { withFileTypes: true }).catch(() => []);
    for (const entry of wsTop) {
      if (entry.isSymbolicLink()) continue;
      let files = 0;
      let bytes = 0;
      const entryPath = join(workspacesDir, entry.name);
      const info = await lstat(entryPath, { bigint: true }).catch(() => undefined);
      if (info === undefined || info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await walkRegularFiles(entryPath, (_fp, _rp, fileInfo) => {
          files += 1;
          bytes += Number(fileInfo.size);
        }, signal);
      } else if (info.isFile()) {
        files = 1;
        bytes = Number(info.size);
      }
      workspacesTotalFiles += files;
      workspacesTotalBytes += bytes;
      workspaceEntries.push({ name: entry.name, files, bytes });
    }
    workspaceEntries.sort((a, b) => b.bytes - a.bytes);

    return {
      schemaVersion: 1,
      homeDir: this.homeDir,
      sessions: {
        total: finalizeBucket(sessionsTotal),
        wires: finalizeBucket(wires),
        media: finalizeBucket(media),
        agentBlobs: finalizeBucket(agentBlobs),
        attachments: finalizeBucket(attachments),
        mediaOriginals: finalizeBucket(mediaOriginals),
        replayCheckpoints: finalizeBucket(replayCheckpoints),
      },
      blobs: finalizeBucket(blobsBucket),
      replayCheckpoints: {
        primaryCount,
        primaryBytes,
        slimmedCount,
        slimmedBytes,
      },
      cache: {
        total: finalizeBucket(cacheTotal),
        pluginMediaInputs: finalizeBucket(pluginMediaInputs),
        pluginMediaStaging: finalizeBucket(pluginMediaStaging),
        mediaPreviews: finalizeBucket(mediaPreviews),
        stagedFiles: finalizeBucket(stagedFiles),
      },
      retired,
      quarantine: finalizeBucket(quarantineBucket),
      workspaces: {
        excludedFromCleanup: true,
        totalFiles: workspacesTotalFiles,
        totalBytes: workspacesTotalBytes,
        entries: workspaceEntries,
      },
    };
  }

  async deduplicate(options: StorageDeduplicateOptions = {}): Promise<StorageDeduplicateReport> {
    const apply = options.apply === true;
    const signal = options.signal;
    signal?.throwIfAborted();
    const storage = new FileStorageService(this.homeDir, 0o700, 0o600);
    const cas = new ContentAddressedStoreService(storage);
    const items: DeduplicateItemRecord[] = [];
    const byDigest = new Map<string, Array<{
      readonly path: string;
      readonly sessionScope: string;
      readonly sessionId: string;
      readonly agentId: string;
      readonly key: string;
      readonly size: number;
      readonly mtimeNs: bigint;
      readonly inodeKey?: string;
    }>>();

    const sessionsRoot = join(this.homeDir, 'sessions');
    const workspaces = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
    let scannedFiles = 0;
    let excludedFiles = 0;

    for (const wsEntry of workspaces) {
      if (wsEntry.isSymbolicLink() || !wsEntry.isDirectory()) continue;
      const wsDir = join(sessionsRoot, wsEntry.name);
      const sessions = await readdir(wsDir, { withFileTypes: true }).catch(() => []);
      for (const sessionEntry of sessions) {
        signal?.throwIfAborted();
        if (sessionEntry.isSymbolicLink() || !sessionEntry.isDirectory()) continue;
        const sessionDir = join(wsDir, sessionEntry.name);
        const sessionScope = `sessions/${wsEntry.name}/${sessionEntry.name}`;
        const metadata = await readSessionMetadata(sessionDir);
        const isPublic =
          metadata !== undefined &&
          typeof metadata.id === 'string' &&
          metadata.id.length > 0 &&
          metadata.private !== true;
        const agentsDir = join(sessionDir, 'agents');
        const agents = await readdir(agentsDir, { withFileTypes: true }).catch(() => []);
        for (const agentEntry of agents) {
          if (agentEntry.isSymbolicLink() || !agentEntry.isDirectory()) continue;
          const blobsDir = join(agentsDir, agentEntry.name, 'blobs');
          const blobEntries = await readdir(blobsDir, { withFileTypes: true }).catch(() => []);
          for (const blobEntry of blobEntries) {
            signal?.throwIfAborted();
            if (blobEntry.isSymbolicLink()) continue;
            const fullPath = join(blobsDir, blobEntry.name);
            const info = await lstat(fullPath, { bigint: true }).catch(() => undefined);
            if (info === undefined || info.isSymbolicLink() || !info.isFile()) continue;
            scannedFiles += 1;
            const size = Number(info.size);
            if (!isPublic) {
              excludedFiles += 1;
              items.push({
                path: fullPath,
                sessionId: sessionEntry.name,
                agentId: agentEntry.name,
                key: blobEntry.name,
                size,
                phase: 'excluded',
                reason: 'private_or_indeterminate_session',
              });
              continue;
            }
            const rawSha256 = await digestFileSha256(fullPath, signal);
            const inodeKey = inodeKeyOf(info);
            let group = byDigest.get(rawSha256);
            if (group === undefined) {
              group = [];
              byDigest.set(rawSha256, group);
            }
            group.push({
              path: fullPath,
              sessionScope,
              sessionId: sessionEntry.name,
              agentId: agentEntry.name,
              key: blobEntry.name,
              size,
              mtimeNs: info.mtimeNs,
              inodeKey,
            });
          }
        }
      }
    }

    let candidateFiles = 0;
    let alreadyDeduplicatedFiles = 0;
    let skippedFiles = 0;
    let committedFiles = 0;
    let reclaimableBytes = 0;
    let reclaimedBytes = 0;

    const maintenanceLock = apply
      ? await storage.acquireLock('store/storage-governance', 'dedup.lock', { waitForMs: 0, signal })
      : undefined;
    const manifestPath = apply ? join(this.homeDir, 'store', 'storage-governance', 'dedup-manifest.json') : undefined;

    try {
      for (const [rawSha256, group] of byDigest) {
        const casPath = cas.objectPath(rawSha256);
        const casInfo = casPath === undefined ? undefined : await lstat(casPath, { bigint: true }).catch(() => undefined);
        const casInode = casInfo !== undefined && casInfo.isFile() ? inodeKeyOf(casInfo) : undefined;
        const distinctInodes = new Set<string>();
        for (const entry of group) {
          if (entry.inodeKey !== undefined) distinctInodes.add(entry.inodeKey);
        }
        const alreadySharedWithCas = casInode !== undefined && group.every((entry) => entry.inodeKey === casInode);
        if (alreadySharedWithCas) {
          alreadyDeduplicatedFiles += group.length;
          for (const entry of group) {
            items.push({
              path: entry.path,
              sessionId: entry.sessionId,
              agentId: entry.agentId,
              key: entry.key,
              size: entry.size,
              rawSha256,
              inodeKey: entry.inodeKey,
              phase: 'already_deduplicated',
            });
          }
          continue;
        }
        const groupSize = group[0]?.size ?? 0;
        const extraInodeCopies = casInode !== undefined
          ? [...distinctInodes].filter((inode) => inode !== casInode).length
          : Math.max(0, distinctInodes.size - 1);
        reclaimableBytes += extraInodeCopies * groupSize;
        candidateFiles += group.length;

        if (!apply) {
          for (const entry of group) {
            items.push({
              path: entry.path,
              sessionId: entry.sessionId,
              agentId: entry.agentId,
              key: entry.key,
              size: entry.size,
              rawSha256,
              inodeKey: entry.inodeKey,
              phase: 'planned',
            });
          }
          continue;
        }

        const rep = group[0]!;
        const stored = await cas.putFromFile(rep.path, { signal });
        if (stored.sha256 !== rawSha256) {
          skippedFiles += group.length;
          for (const entry of group) {
            items.push({
              path: entry.path,
              sessionId: entry.sessionId,
              agentId: entry.agentId,
              key: entry.key,
              size: entry.size,
              rawSha256,
              inodeKey: entry.inodeKey,
              phase: 'skipped',
              reason: 'source_changed_before_commit',
            });
          }
          continue;
        }
        const publishedCasPath = cas.objectPath(rawSha256)!;
        const committedInodes = new Set<string>();
        if (casInode !== undefined) committedInodes.add(casInode);

        for (const entry of group) {
          signal?.throwIfAborted();
          let sessionLock;
          try {
            sessionLock = await storage.acquireLock(SESSION_LOCK_SCOPE, sessionLockKey(entry.sessionScope), {
              waitForMs: 0,
              signal,
              owner: { op: 'storage.deduplicate', sessionId: entry.sessionId },
            });
          } catch {
            skippedFiles += 1;
            items.push({
              path: entry.path,
              sessionId: entry.sessionId,
              agentId: entry.agentId,
              key: entry.key,
              size: entry.size,
              rawSha256,
              inodeKey: entry.inodeKey,
              phase: 'skipped',
              reason: 'session_locked',
            });
            continue;
          }
          try {
            const currentInfo = await lstat(entry.path, { bigint: true }).catch(() => undefined);
            if (
              currentInfo === undefined ||
              !currentInfo.isFile() ||
              currentInfo.isSymbolicLink() ||
              Number(currentInfo.size) !== entry.size ||
              currentInfo.mtimeNs !== entry.mtimeNs
            ) {
              skippedFiles += 1;
              items.push({
                path: entry.path,
                sessionId: entry.sessionId,
                agentId: entry.agentId,
                key: entry.key,
                size: entry.size,
                rawSha256,
                inodeKey: entry.inodeKey,
                phase: 'skipped',
                reason: 'source_changed_under_lock',
              });
              continue;
            }
            const currentSha = await digestFileSha256(entry.path, signal);
            if (currentSha !== rawSha256) {
              skippedFiles += 1;
              items.push({
                path: entry.path,
                sessionId: entry.sessionId,
                agentId: entry.agentId,
                key: entry.key,
                size: entry.size,
                rawSha256,
                inodeKey: entry.inodeKey,
                phase: 'skipped',
                reason: 'digest_changed_under_lock',
              });
              continue;
            }
            const tempAlias = `${entry.path}.dedup.${process.pid}.${randomUUID()}`;
            try {
              await link(publishedCasPath, tempAlias);
              await replaceFileNonDestructive(tempAlias, entry.path, signal);
              await chmod(entry.path, 0o400).catch(() => undefined);
              await syncDir(dirname(entry.path));
            } catch (swapError) {
              await unlink(tempAlias).catch(() => undefined);
              skippedFiles += 1;
              items.push({
                path: entry.path,
                sessionId: entry.sessionId,
                agentId: entry.agentId,
                key: entry.key,
                size: entry.size,
                rawSha256,
                inodeKey: entry.inodeKey,
                phase: 'failed',
                reason: swapError instanceof Error ? swapError.message : String(swapError),
              });
              continue;
            }
            const verified = await verifyColdRangeRead(entry.path, entry.size, rawSha256, signal);
            if (!verified) {
              skippedFiles += 1;
              items.push({
                path: entry.path,
                sessionId: entry.sessionId,
                agentId: entry.agentId,
                key: entry.key,
                size: entry.size,
                rawSha256,
                inodeKey: entry.inodeKey,
                phase: 'failed',
                reason: 'post_swap_verification_failed',
              });
              continue;
            }
            committedFiles += 1;
            if (entry.inodeKey !== undefined) {
              if (committedInodes.size > 0 && !committedInodes.has(entry.inodeKey)) {
                reclaimedBytes += entry.size;
              }
              committedInodes.add(entry.inodeKey);
            }
            items.push({
              path: entry.path,
              sessionId: entry.sessionId,
              agentId: entry.agentId,
              key: entry.key,
              size: entry.size,
              rawSha256,
              inodeKey: entry.inodeKey,
              phase: 'committed',
            });
          } finally {
            await sessionLock.release();
          }
        }
      }

      if (apply && manifestPath !== undefined) {
        await mkdir(dirname(manifestPath), { recursive: true });
        await writeFileAtomicDurable(
          manifestPath,
          JSON.stringify(
            {
              schemaVersion: 1,
              homeDir: this.homeDir,
              updatedAt: Date.now(),
              committedFiles,
              reclaimedBytes,
              items,
            },
            null,
            2,
          ),
        );
      }

      return {
        schemaVersion: 1,
        homeDir: this.homeDir,
        applied: apply,
        scannedFiles,
        candidateFiles,
        uniqueDigests: byDigest.size,
        alreadyDeduplicatedFiles,
        excludedFiles,
        skippedFiles,
        committedFiles,
        reclaimableBytes,
        reclaimedBytes,
        manifestPath,
        items,
      };
    } finally {
      await maintenanceLock?.release();
      await storage.close();
    }
  }

  async cleanRetired(options: StorageCleanRetiredOptions = {}): Promise<StorageCleanRetiredReport> {
    const signal = options.signal;
    signal?.throwIfAborted();
    if (options.rollbackRunId !== undefined) {
      return this.rollbackRetiredQuarantine(options.rollbackRunId, signal);
    }
    if (options.purgeQuarantine === true) {
      return this.purgeExpiredQuarantine(options.apply === true, options.minQuarantineAgeDays ?? QUARANTINE_RETENTION_DAYS, signal);
    }
    const apply = options.apply === true;
    const runId = apply ? `retired-${Date.now()}-${randomUUID().slice(0, 8)}` : undefined;
    const items: CleanRetiredItemResult[] = [];
    const manifestItems: QuarantineManifest['items'][number][] = [];
    let quarantinedBytes = 0;

    for (const entry of RETIRED_STORAGE_ALLOWLIST) {
      signal?.throwIfAborted();
      const targetPath = join(this.homeDir, entry.relativePath);
      if (!isInsideHome(this.homeDir, targetPath)) {
        items.push({ relativePath: entry.relativePath, bytes: 0, files: 0, status: 'skipped', reason: 'outside_home' });
        continue;
      }
      const rootInfo = await lstat(targetPath).catch(() => undefined);
      if (rootInfo === undefined) {
        items.push({ relativePath: entry.relativePath, bytes: 0, files: 0, status: 'absent' });
        continue;
      }
      if (rootInfo.isSymbolicLink()) {
        items.push({ relativePath: entry.relativePath, bytes: 0, files: 0, status: 'skipped', reason: 'symlink_refused' });
        continue;
      }
      let files = 0;
      let bytes = 0;
      if (rootInfo.isDirectory()) {
        await walkRegularFiles(targetPath, (_fp, _rp, info) => {
          files += 1;
          bytes += Number(info.size);
        }, signal);
      } else if (rootInfo.isFile()) {
        files = 1;
        bytes = rootInfo.size;
      }
      const successor = await checkSqliteSuccessorReady(this.homeDir, entry.successorRelativePath);
      if (!successor.ready) {
        items.push({
          relativePath: entry.relativePath,
          bytes,
          files,
          status: 'skipped',
          reason: successor.reason ?? 'successor_not_ready',
        });
        continue;
      }
      if (!apply) {
        items.push({ relativePath: entry.relativePath, bytes, files, status: 'planned' });
        continue;
      }
      const quarantinePath = join(this.homeDir, 'cache', '.quarantine-retired', runId!, entry.relativePath);
      await mkdir(dirname(quarantinePath), { recursive: true });
      await rename(targetPath, quarantinePath);
      quarantinedBytes += bytes;
      manifestItems.push({
        relativePath: entry.relativePath,
        quarantinePath,
        bytes,
        files,
        successorRelativePath: entry.successorRelativePath,
      });
      items.push({
        relativePath: entry.relativePath,
        bytes,
        files,
        status: 'quarantined',
        quarantinePath,
      });
    }

    let rollbackManifestPath: string | undefined;
    if (apply && runId !== undefined && manifestItems.length > 0) {
      rollbackManifestPath = join(this.homeDir, 'store', 'storage-governance', 'quarantine', `${runId}.json`);
      await mkdir(dirname(rollbackManifestPath), { recursive: true });
      const manifest: QuarantineManifest = {
        schemaVersion: 1,
        runId,
        homeDir: this.homeDir,
        createdAt: Date.now(),
        retentionDays: QUARANTINE_RETENTION_DAYS,
        items: manifestItems,
      };
      await writeFileAtomicDurable(rollbackManifestPath, JSON.stringify(manifest, null, 2));
    }

    return {
      schemaVersion: 1,
      homeDir: this.homeDir,
      applied: apply,
      runId,
      quarantinedBytes,
      freedBytes: 0,
      restoredBytes: 0,
      rollbackManifestPath,
      items,
    };
  }

  async slimCheckpoints(options: StorageSlimCheckpointsOptions = {}): Promise<StorageSlimCheckpointsReport> {
    const apply = options.apply === true;
    const rehydrate = options.rehydrate === true;
    const minAgeDays = options.minAgeDays ?? DEFAULT_SLIM_MIN_AGE_DAYS;
    const cutoffMs = Date.now() - minAgeDays * 86_400_000;
    const signal = options.signal;
    signal?.throwIfAborted();

    const storage = new FileStorageService(this.homeDir, 0o700, 0o600);
    let scannedCount = 0;
    let eligibleCount = 0;
    let slimmedCount = 0;
    let rehydratedCount = 0;
    let skippedCount = 0;
    let originalBytes = 0;
    let slimmedBytes = 0;
    let reclaimedBytes = 0;
    let restoredBytes = 0;

    try {
      const sessionsRoot = join(this.homeDir, 'sessions');
      const workspaces = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
      for (const wsEntry of workspaces) {
        if (wsEntry.isSymbolicLink() || !wsEntry.isDirectory()) continue;
        const wsDir = join(sessionsRoot, wsEntry.name);
        const sessions = await readdir(wsDir, { withFileTypes: true }).catch(() => []);
        for (const sessionEntry of sessions) {
          signal?.throwIfAborted();
          if (sessionEntry.isSymbolicLink() || !sessionEntry.isDirectory()) continue;
          const sessionDir = join(wsDir, sessionEntry.name);
          const sessionScope = `sessions/${wsEntry.name}/${sessionEntry.name}`;
          const pauseDocExists = (await lstat(join(sessionDir, 'execution-pause.json')).catch(() => undefined)) !== undefined;
          const metadata = await readSessionMetadata(sessionDir);
          const agentsMeta = metadata?.agents ?? {};
          const delegatorIds = new Set<string>();
          for (const entry of Object.values(agentsMeta)) {
            if (typeof entry?.parentAgentId === 'string' && entry.parentAgentId.length > 0) {
              delegatorIds.add(entry.parentAgentId);
            }
            if (typeof entry?.delegator === 'string' && entry.delegator.length > 0) {
              delegatorIds.add(entry.delegator);
            } else if (
              entry?.delegator !== null &&
              typeof entry?.delegator === 'object' &&
              (entry.delegator as { readonly kind?: unknown }).kind === 'agent' &&
              typeof (entry.delegator as { readonly agentId?: unknown }).agentId === 'string'
            ) {
              delegatorIds.add((entry.delegator as { readonly agentId: string }).agentId);
            }
          }
          const agentsDir = join(sessionDir, 'agents');
          const agentEntries = await readdir(agentsDir, { withFileTypes: true }).catch(() => []);
          for (const agentEntry of agentEntries) {
            signal?.throwIfAborted();
            if (agentEntry.isSymbolicLink() || !agentEntry.isDirectory()) continue;
            const agentId = agentEntry.name;
            const agentDir = join(agentsDir, agentId);
            const ckptDir = join(agentDir, REPLAY_CHECKPOINT_SUBSCOPE);

            if (rehydrate) {
              const hasArchive =
                (await lstat(join(ckptDir, COLD_CHECKPOINT_ARCHIVE_ZST_KEY)).catch(() => undefined)) !== undefined ||
                (await lstat(join(ckptDir, COLD_CHECKPOINT_ARCHIVE_GZ_KEY)).catch(() => undefined)) !== undefined;
              if (!hasArchive) continue;
              scannedCount += 1;
              eligibleCount += 1;
              if (!apply) continue;
              const result = await rehydrateColdReplayCheckpoint(agentDir, REPLAY_ABI_VERSION, signal);
              if (result.restored) {
                rehydratedCount += 1;
                restoredBytes += result.restoredBytes;
              } else {
                skippedCount += 1;
              }
              continue;
            }

            const primaryPath = join(ckptDir, REPLAY_CHECKPOINT_PRIMARY_KEY);
            const primaryInfo = await lstat(primaryPath).catch(() => undefined);
            if (primaryInfo === undefined || primaryInfo.isSymbolicLink() || !primaryInfo.isFile()) continue;
            scannedCount += 1;
            const agentMeta = agentsMeta[agentId];
            const isMain = agentId === 'main' || agentMeta?.type === 'main';
            const hasChildren = delegatorIds.has(agentId);
            const hasTerminalOutcome =
              typeof agentMeta?.status === 'string' &&
              TERMINAL_AGENT_STATUSES.has(agentMeta.status) &&
              typeof agentMeta?.taskId === 'string' &&
              agentMeta.taskId.length > 0;
            const wireInfo = await lstat(join(agentDir, 'wire.jsonl')).catch(() => undefined);
            const latestMtime = Math.max(primaryInfo.mtimeMs, wireInfo?.mtimeMs ?? 0);
            if (isMain || hasChildren || !hasTerminalOutcome || pauseDocExists || latestMtime > cutoffMs) {
              skippedCount += 1;
              continue;
            }
            eligibleCount += 1;
            originalBytes += primaryInfo.size;
            if (!apply) continue;
            let sessionLock;
            try {
              sessionLock = await storage.acquireLock(SESSION_LOCK_SCOPE, sessionLockKey(sessionScope), {
                waitForMs: 0,
                signal,
                owner: { op: 'storage.slimCheckpoints', sessionId: sessionEntry.name },
              });
            } catch {
              skippedCount += 1;
              continue;
            }
            try {
              const res = await slimColdReplayCheckpoint(agentDir, LIGHTWEIGHT_STATE_NAMES, REPLAY_ABI_VERSION, signal);
              if (res.status === 'slimmed') {
                slimmedCount += 1;
                slimmedBytes += res.projectionBytes + res.archiveBytes;
                reclaimedBytes += res.reclaimedBytes;
              } else {
                skippedCount += 1;
              }
            } finally {
              await sessionLock.release();
            }
          }
        }
      }

      return {
        schemaVersion: 1,
        homeDir: this.homeDir,
        applied: apply,
        rehydrated: rehydrate,
        minAgeDays,
        scannedCount,
        eligibleCount,
        slimmedCount,
        rehydratedCount,
        skippedCount,
        originalBytes,
        slimmedBytes,
        reclaimedBytes,
        restoredBytes,
      };
    } finally {
      await storage.close();
    }
  }

  private async rollbackRetiredQuarantine(runId: string, signal?: AbortSignal): Promise<StorageCleanRetiredReport> {
    const manifestPath = join(this.homeDir, 'store', 'storage-governance', 'quarantine', `${runId}.json`);
    const raw = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as QuarantineManifest;
    const items: CleanRetiredItemResult[] = [];
    let restoredBytes = 0;
    for (const entry of manifest.items) {
      signal?.throwIfAborted();
      const targetPath = join(this.homeDir, entry.relativePath);
      if (!isInsideHome(this.homeDir, targetPath) || !isInsideHome(this.homeDir, entry.quarantinePath)) {
        items.push({ relativePath: entry.relativePath, bytes: entry.bytes, files: entry.files, status: 'skipped', reason: 'outside_home' });
        continue;
      }
      const existingTarget = await lstat(targetPath).catch(() => undefined);
      if (existingTarget !== undefined) {
        items.push({ relativePath: entry.relativePath, bytes: entry.bytes, files: entry.files, status: 'skipped', reason: 'target_already_exists' });
        continue;
      }
      const existingQuarantine = await lstat(entry.quarantinePath).catch(() => undefined);
      if (existingQuarantine === undefined) {
        items.push({ relativePath: entry.relativePath, bytes: entry.bytes, files: entry.files, status: 'absent' });
        continue;
      }
      await mkdir(dirname(targetPath), { recursive: true });
      await rename(entry.quarantinePath, targetPath);
      restoredBytes += entry.bytes;
      items.push({ relativePath: entry.relativePath, bytes: entry.bytes, files: entry.files, status: 'restored' });
    }
    return {
      schemaVersion: 1,
      homeDir: this.homeDir,
      applied: true,
      runId,
      quarantinedBytes: 0,
      freedBytes: 0,
      restoredBytes,
      rollbackManifestPath: manifestPath,
      items,
    };
  }

  private async purgeExpiredQuarantine(
    apply: boolean,
    minAgeDays: number,
    signal?: AbortSignal,
  ): Promise<StorageCleanRetiredReport> {
    const manifestsDir = join(this.homeDir, 'store', 'storage-governance', 'quarantine');
    const names = await readdir(manifestsDir).catch(() => []);
    const cutoff = Date.now() - minAgeDays * 86_400_000;
    const items: CleanRetiredItemResult[] = [];
    let freedBytes = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const manifestPath = join(manifestsDir, name);
      const raw = await readFile(manifestPath, 'utf8').catch(() => undefined);
      if (raw === undefined) continue;
      let manifest: QuarantineManifest;
      try {
        manifest = JSON.parse(raw) as QuarantineManifest;
      } catch {
        continue;
      }
      if (manifest.createdAt > cutoff) {
        for (const entry of manifest.items) {
          items.push({
            relativePath: entry.relativePath,
            bytes: entry.bytes,
            files: entry.files,
            status: 'skipped',
            quarantinePath: entry.quarantinePath,
            reason: 'within_retention_window',
          });
        }
        continue;
      }
      for (const entry of manifest.items) {
        signal?.throwIfAborted();
        const successor = await checkSqliteSuccessorReady(this.homeDir, entry.successorRelativePath);
        if (!successor.ready) {
          items.push({
            relativePath: entry.relativePath,
            bytes: entry.bytes,
            files: entry.files,
            status: 'skipped',
            quarantinePath: entry.quarantinePath,
            reason: successor.reason ?? 'successor_not_ready',
          });
          continue;
        }
        if (!apply) {
          items.push({
            relativePath: entry.relativePath,
            bytes: entry.bytes,
            files: entry.files,
            status: 'planned',
            quarantinePath: entry.quarantinePath,
          });
          continue;
        }
        if (!isInsideHome(this.homeDir, entry.quarantinePath)) continue;
        await rm(entry.quarantinePath, { recursive: true, force: true });
        freedBytes += entry.bytes;
        items.push({
          relativePath: entry.relativePath,
          bytes: entry.bytes,
          files: entry.files,
          status: 'purged',
          quarantinePath: entry.quarantinePath,
        });
      }
      if (apply) {
        await rm(join(this.homeDir, 'cache', '.quarantine-retired', manifest.runId), { recursive: true, force: true }).catch(() => undefined);
        await unlink(manifestPath).catch(() => undefined);
      }
    }
    return {
      schemaVersion: 1,
      homeDir: this.homeDir,
      applied: apply,
      quarantinedBytes: 0,
      freedBytes,
      restoredBytes: 0,
      items,
    };
  }
}

/** Creates a standalone `StorageGovernanceService` bound to `homeDir`. */
export function createStorageGovernanceService(homeDir: string): StorageGovernanceService {
  return new StorageGovernanceService(homeDir);
}
