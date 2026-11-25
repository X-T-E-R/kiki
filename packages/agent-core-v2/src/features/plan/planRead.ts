import { createHash } from 'node:crypto';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { produce } from 'immer';
import { join } from 'pathe';

import { unwrapErrorCause } from '#/_base/errors/errors';
import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import { event2FromRecord } from '#/app/event/event2';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { logicalByteSize, readLogicalBytes } from '#/persistence/coldSegmentLog';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { StorageError, StorageErrors, type IFileSystemStorageService } from '#/persistence/interface/storage';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { readPersistedAgentCheckpoint } from '#/session/persistedAgentCheckpoint';
import { REPLAY_ABI_VERSION, verifyReplayCheckpointWire, type ReplayCheckpointWire } from '#/state/eventDispatcherService';
import { decodeReplayCheckpointStates, type ReplayCheckpointGraph } from '#/state/replayCheckpointCodec';
import { expandedStateFolds } from '#/state/state';
import { AGENT_WIRE_RECORD_KEY, isWireRecord, isWireMetadataRecord } from '#/wire/record';
import { migrateV1_4ToV1_5, migrateWireRecord, resolveWireMigrations, type WireMigration } from '#/wire/migration/migration';
import { JOURNAL_BOUNDARY_HASH_BYTES, JOURNAL_HEAD_HASH_BYTES } from '#/wire/wire';
import type { PlanData } from './plan';
import { planKey, type PlanState } from './planOps';

const DEFAULT_MAX_TAIL_BYTES = 8 << 20;
const HOST_CHECKPOINT_CACHE_MAX = 64;

interface HostCheckpointEnvelope {
  readonly format: number;
  readonly replayAbi: number;
  readonly wire: ReplayCheckpointWire;
  readonly graph: ReplayCheckpointGraph;
}

interface PlanCheckpointSeed {
  readonly offset: number;
  readonly state: PlanState;
}

const hostPlanCheckpointCache = new Map<string, PlanCheckpointSeed | null>();

export interface ReadPersistedPlanOptions {
  readonly docs?: IAtomicDocumentStore;
  readonly storage?: IFileSystemStorageService;
  readonly workers?: ICpuWorkerService;
  readonly maxTailBytes?: number;
}

export function planFilePath(sessionDir: string, agentId: string, id: string): string {
  return join(sessionDir, 'agents', agentId, 'plans', `${id}.md`);
}

export async function readPlanData(hostFs: IHostFileSystem, sessionDir: string, agentId: string, state: PlanState): Promise<PlanData> {
  if (!state.active || state.id === undefined) return null;
  const path = planFilePath(sessionDir, agentId, state.id);
  let content = '';
  try {
    content = await hostFs.readText(path);
  } catch (error) {
    const cause = unwrapErrorCause(error);
    if (cause === null || typeof cause !== 'object' || (cause as { code?: unknown }).code !== 'ENOENT') throw error;
  }
  return { id: state.id, content, path };
}

function cacheHostCheckpoint(key: string, value: PlanCheckpointSeed | null): void {
  hostPlanCheckpointCache.delete(key);
  hostPlanCheckpointCache.set(key, value);
  if (hostPlanCheckpointCache.size > HOST_CHECKPOINT_CACHE_MAX) {
    const oldest = hostPlanCheckpointCache.keys().next().value;
    if (oldest !== undefined) hostPlanCheckpointCache.delete(oldest);
  }
}

async function readHostPlanCheckpoint(
  hostFs: IHostFileSystem,
  agentDir: string,
  wirePath: string,
  size: number,
  mtimeMs: number,
  signal?: AbortSignal,
): Promise<PlanCheckpointSeed | undefined> {
  signal?.throwIfAborted();
  let ckptPath = join(agentDir, 'replay-checkpoints', 'engine-v1');
  let mode: 'primary' | 'projection' | 'zst' | 'gz' = 'primary';
  let ckptStat: Awaited<ReturnType<IHostFileSystem['stat']>>;
  try {
    ckptStat = await hostFs.stat(ckptPath);
  } catch {
    const fallbacks: ReadonlyArray<{ readonly file: string; readonly mode: 'projection' | 'zst' | 'gz' }> = [
      { file: 'cold-projection-v1.json', mode: 'projection' },
      { file: 'engine-v1.archive.zst', mode: 'zst' },
      { file: 'engine-v1.archive.gz', mode: 'gz' },
    ];
    let foundStat: Awaited<ReturnType<IHostFileSystem['stat']>> | undefined;
    for (const candidate of fallbacks) {
      const candidatePath = join(agentDir, 'replay-checkpoints', candidate.file);
      try {
        foundStat = await hostFs.stat(candidatePath);
        ckptPath = candidatePath;
        mode = candidate.mode;
        break;
      } catch {
      }
    }
    if (foundStat === undefined) return undefined;
    ckptStat = foundStat;
  }
  if (!ckptStat.isFile) return undefined;
  const cacheKey = `${ckptPath}:${ckptStat.size}:${ckptStat.mtimeMs ?? 0}:${size}:${mtimeMs}`;
  if (hostPlanCheckpointCache.has(cacheKey)) {
    const hit = hostPlanCheckpointCache.get(cacheKey) ?? undefined;
    cacheHostCheckpoint(cacheKey, hit ?? null);
    return hit;
  }
  let raw: string;
  try {
    if (mode === 'zst' || mode === 'gz') {
      const compressed = await hostFs.readBytes(ckptPath, ckptStat.size, 0);
      raw = (mode === 'zst' ? zstdDecompressSync(compressed) : gunzipSync(compressed)).toString('utf8');
    } else {
      raw = await hostFs.readText(ckptPath);
    }
  } catch {
    return undefined;
  }
  signal?.throwIfAborted();
  let checkpoint: (HostCheckpointEnvelope & { readonly projectedGraph?: HostCheckpointEnvelope['graph'] }) | undefined;
  try {
    checkpoint = JSON.parse(raw) as HostCheckpointEnvelope & { readonly projectedGraph?: HostCheckpointEnvelope['graph'] };
  } catch {
    cacheHostCheckpoint(cacheKey, null);
    return undefined;
  }
  const graph = mode === 'projection' ? checkpoint?.projectedGraph : checkpoint?.graph;
  if (checkpoint?.format !== 1 || checkpoint.replayAbi !== REPLAY_ABI_VERSION || graph === undefined) {
    cacheHostCheckpoint(cacheKey, null);
    return undefined;
  }
  const digest = async (start: number, end: number): Promise<string | undefined> => {
    if (end < start || end > size) return undefined;
    const hash = createHash('sha256');
    if (end > start) {
      const bytes = await hostFs.readBytes(wirePath, end - start, start);
      if (bytes.byteLength !== end - start) return undefined;
      hash.update(bytes);
    }
    return hash.digest('hex');
  };
  const verified = await verifyReplayCheckpointWire(checkpoint.wire, {
    size,
    mtimeMs,
    headHash: async () => (await digest(0, Math.min(size, JOURNAL_HEAD_HASH_BYTES)))?.slice(0, 32),
    storeGeneration: async () => {
      try {
        return await hostFs.readText(join(agentDir, `${AGENT_WIRE_RECORD_KEY}.generation`));
      } catch {
        return 'legacy';
      }
    },
    boundarySha256: (end) => digest(Math.max(0, end - JOURNAL_BOUNDARY_HASH_BYTES), end),
    prefixSha256: (end) => (end < JOURNAL_HEAD_HASH_BYTES ? digest(0, end) : Promise.resolve(undefined)),
  });
  if (verified === undefined) {
    cacheHostCheckpoint(cacheKey, null);
    return undefined;
  }
  try {
    const states = decodeReplayCheckpointStates(graph, new Set([planKey.name]));
    const planState = states.get(planKey.name) as PlanState | undefined;
    if (planState === undefined) {
      cacheHostCheckpoint(cacheKey, null);
      return undefined;
    }
    const seed: PlanCheckpointSeed = { offset: verified.offset, state: planState };
    cacheHostCheckpoint(cacheKey, seed);
    return seed;
  } catch {
    cacheHostCheckpoint(cacheKey, null);
    return undefined;
  }
}

async function foldTailBytes(
  chunks: AsyncIterable<Uint8Array>,
  folds: ReadonlyMap<string, { readonly event: Parameters<typeof event2FromRecord>[0]; readonly fold: (draft: PlanState, event: never, ctx: { silent: boolean; emit: () => void; checkpoint: () => void; clearCheckpoints: () => void; undoToCheckpoint: (count: number) => void }) => PlanState | void }>,
  initialState: PlanState,
  skipFirstLine: boolean,
  signal?: AbortSignal,
): Promise<PlanState> {
  const markers = [...folds.keys()].map((type) => `"type":"${type}"`);
  let state = initialState;
  let checkpoints: PlanState[] = [];
  const decoder = new TextDecoder();
  let pending = '';
  let skipped = !skipFirstLine;
  let deadline = performance.now() + 4;
  const foldLine = (line: string) => {
    if (line.length === 0) return;
    const head = line.slice(0, 96);
    if (!markers.some((marker) => head.includes(marker))) return;
    let candidate: unknown;
    try { candidate = JSON.parse(line); } catch { return; }
    if (!isWireRecord(candidate)) return;
    const entry = folds.get(candidate.type);
    if (entry === undefined) return;
    const event = event2FromRecord(entry.event, candidate);
    if (event === undefined) return;
    let checkpoint = false;
    let clear = false;
    let undo: number | undefined;
    const next = produce(state, (draft) => entry.fold(draft, event as never, {
      silent: true,
      emit: () => {},
      checkpoint: () => { checkpoint = true; },
      clearCheckpoints: () => { clear = true; },
      undoToCheckpoint: (count) => { undo = count; },
    }));
    if (undo !== undefined) {
      const index = checkpoints.length - undo;
      if (index >= 0) {
        state = checkpoints[index]!;
        checkpoints = checkpoints.slice(0, index);
      }
    } else {
      state = next;
      if (clear) checkpoints = [];
      if (checkpoint) checkpoints.push(state);
    }
  };
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    if (performance.now() >= deadline) {
      await yieldToEventLoop(undefined, { signal });
      deadline = performance.now() + 4;
    }
    pending += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (!skipped) { skipped = true; continue; }
      foldLine(line);
    }
  }
  pending += decoder.decode();
  if (skipped && pending.length > 0) foldLine(pending.replace(/\r$/, ''));
  return state;
}

/** Read the canonical plan folds, including conversation undo, without creating an agent or rewriting its journal. The caller establishes agent identity. */
export async function readPersistedPlan(
  context: ISessionContext,
  agentId: string,
  log: IAppendLogStore,
  hostFs: IHostFileSystem,
  signal?: AbortSignal,
  options?: ReadPersistedPlanOptions,
): Promise<PlanData> {
  signal?.throwIfAborted();
  const folds = new Map([...expandedStateFolds(planKey)].map(([event, fold]) => [event.type, { event, fold }]));
  const scope = context.scope(`agents/${agentId}`);
  const maxTailBytes = options?.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES;
  let state: PlanState = planKey.initial();
  let startOffset = 0;
  let seededFromCheckpoint = false;
  let wireSize: number | undefined;
  let hostWirePath: string | undefined;
  let hostHasColdSegments = false;

  if (options?.storage !== undefined) {
    const [size, mtime] = await Promise.all([
      logicalByteSize(options.storage, scope, AGENT_WIRE_RECORD_KEY),
      options.storage.mtime(scope, AGENT_WIRE_RECORD_KEY),
    ]);
    wireSize = size;
    if (size !== undefined && size > 0) {
      const checkpoint = await readPersistedAgentCheckpoint(
        options.docs,
        options.storage,
        scope,
        size,
        mtime ?? 0,
        new Set([planKey.name]),
        options.workers,
        signal,
      );
      const seeded = checkpoint?.states.get(planKey.name) as PlanState | undefined;
      if (checkpoint !== undefined && seeded !== undefined) {
        state = seeded;
        startOffset = checkpoint.offset;
        seededFromCheckpoint = true;
      }
    }
  } else if (
    typeof hostFs.stat === 'function' &&
    typeof hostFs.readText === 'function' &&
    typeof hostFs.readBytes === 'function'
  ) {
    const agentDir = join(context.sessionDir, 'agents', agentId);
    const wirePath = join(agentDir, AGENT_WIRE_RECORD_KEY);
    try {
      const wireStat = await hostFs.stat(wirePath);
      if (wireStat.isFile) {
        hostWirePath = wirePath;
        wireSize = wireStat.size;
        try {
          const manifestRaw = await hostFs.readText(join(agentDir, `${AGENT_WIRE_RECORD_KEY}.cold.json`));
          const manifest = JSON.parse(manifestRaw) as { readonly sealedCut?: unknown };
          if (typeof manifest.sealedCut === 'number' && manifest.sealedCut > 0) {
            hostHasColdSegments = true;
          }
        } catch {}
        if (!hostHasColdSegments && wireStat.size > 0) {
          const seed = await readHostPlanCheckpoint(hostFs, agentDir, wirePath, wireStat.size, wireStat.mtimeMs ?? 0, signal);
          if (seed !== undefined) {
            state = seed.state;
            startOffset = seed.offset;
            seededFromCheckpoint = true;
          }
        }
      }
    } catch {}
  }

  if (wireSize !== undefined && startOffset >= wireSize) {
    return readPlanData(hostFs, context.sessionDir, agentId, state);
  }

  if (wireSize !== undefined && wireSize - startOffset > maxTailBytes) {
    const tailStart = Math.max(startOffset, wireSize - maxTailBytes);
    if (options?.storage !== undefined) {
      state = await foldTailBytes(
        readLogicalBytes(options.storage, scope, AGENT_WIRE_RECORD_KEY, { start: tailStart, end: wireSize - 1 }),
        folds as never,
        state,
        tailStart > 0,
        signal,
      );
      return readPlanData(hostFs, context.sessionDir, agentId, state);
    }
    if (hostWirePath !== undefined && !hostHasColdSegments) {
      const targetPath = hostWirePath;
      const tailLen = wireSize - tailStart;
      const chunks = (async function* () {
        const chunkSize = 1 << 20;
        let offset = tailStart;
        let remaining = tailLen;
        while (remaining > 0) {
          signal?.throwIfAborted();
          const readLen = Math.min(chunkSize, remaining);
          const bytes = await hostFs.readBytes(targetPath, readLen, offset);
          if (bytes.byteLength === 0) break;
          yield bytes;
          offset += bytes.byteLength;
          remaining -= bytes.byteLength;
        }
      })();
      state = await foldTailBytes(chunks, folds as never, state, tailStart > 0, signal);
      return readPlanData(hostFs, context.sessionDir, agentId, state);
    }
    return readPlanData(hostFs, context.sessionDir, agentId, state);
  }

  let checkpoints: PlanState[] = [];
  let migrations: readonly WireMigration[] = [];
  let first = startOffset === 0;
  let deadline = performance.now() + 4;
  for await (const candidate of log.read<unknown>(scope, AGENT_WIRE_RECORD_KEY, {
    signal,
    startOffset: startOffset > 0 ? startOffset : undefined,
  })) {
    signal?.throwIfAborted();
    if (performance.now() >= deadline) {
      await yieldToEventLoop(undefined, { signal });
      deadline = performance.now() + 4;
    }
    if (!isWireRecord(candidate)) throw new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, 'Malformed plan history record');
    if (first) {
      first = false;
      if (candidate.type !== 'metadata') migrations = [migrateV1_4ToV1_5];
      else if (!isWireMetadataRecord(candidate)) throw new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, 'Malformed plan history metadata');
      else migrations = resolveWireMigrations(candidate.protocol_version);
    }
    const record = migrateWireRecord(candidate, migrations);
    const entry = folds.get(record.type);
    if (entry === undefined) continue;
    const event = event2FromRecord(entry.event, record);
    if (event === undefined) throw new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, 'Malformed plan state event');
    let checkpoint = false;
    let clear = false;
    let undo: number | undefined;
    const next = produce(state, (draft) => entry.fold(draft, event, {
      silent: true,
      emit: () => {},
      checkpoint: () => { checkpoint = true; },
      clearCheckpoints: () => { clear = true; },
      undoToCheckpoint: (count) => { undo = count; },
    }));
    if (undo !== undefined) {
      const index = checkpoints.length - undo;
      if (index < 0) {
        if (!seededFromCheckpoint) throw new StorageError(StorageErrors.codes.STORAGE_CORRUPTED, 'Plan undo exceeds available history');
      } else {
        state = checkpoints[index]!;
        checkpoints = checkpoints.slice(0, index);
      }
    } else {
      state = next;
      if (clear) checkpoints = [];
      if (checkpoint) checkpoints.push(state);
    }
  }
  return readPlanData(hostFs, context.sessionDir, agentId, state);
}
