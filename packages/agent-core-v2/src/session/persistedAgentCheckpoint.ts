import { createHash } from 'node:crypto';
import { autoCompactOverrideKey } from '#/agent/fullCompaction/autoCompactOps';
import { contextStrategyOverrideKey } from '#/agent/fullCompaction/contextStrategyOps';
import { contextMemoryKey } from '#/agent/contextMemory/contextOps';
import { goalKey } from '#/agent/goal/goalOps';
import { turnKey } from '#/agent/loop/turnOps';
import { permissionModeConfiguredKey, permissionModeKey } from '#/agent/permissionMode/permissionModeOps';
import { profileActiveToolsKey, profileKey } from '#/agent/profile/profileOps';
import { runtimeBindingKey } from '#/agent/runtimeBinding/runtimeBindingOps';
import { tokenCountingKey } from '#/agent/tokenCounting/tokenCountingOps';
import { panelAccountingKey } from '#/agent/usage/panelAccounting';
import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import { planKey } from '#/features/plan/planOps';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import { readLogicalBytes } from '#/persistence/coldSegmentLog';
import { decodeReplayCheckpointStates, type ReplayCheckpointGraph } from '#/state/replayCheckpointCodec';
import { REPLAY_ABI_VERSION, verifyReplayCheckpointWire, type ReplayCheckpointWire } from '#/state/eventDispatcherService';
import { AGENT_WIRE_RECORD_KEY } from '#/wire/record';
import { JOURNAL_BOUNDARY_HASH_BYTES, JOURNAL_HEAD_HASH_BYTES } from '#/wire/wire';

interface Checkpoint {
  readonly format: number;
  readonly replayAbi: number;
  readonly wire: ReplayCheckpointWire;
  readonly graph: ReplayCheckpointGraph;
}

interface DecodedCheckpoint {
  readonly offset: number;
  readonly states: ReadonlyMap<string, unknown>;
}

const LIGHTWEIGHT_STATE_NAMES = new Set([
  tokenCountingKey.name,
  turnKey.name,
  panelAccountingKey.name,
  profileKey.name,
  profileActiveToolsKey.name,
  permissionModeKey.name,
  permissionModeConfiguredKey.name,
  planKey.name,
  runtimeBindingKey.name,
  goalKey.name,
  autoCompactOverrideKey.name,
  contextStrategyOverrideKey.name,
  'prompt.modelSwitches',
  'prompt.queue',
  'externalHooks.clock',
]);

const CHECKPOINT_SUBSCOPE = 'replay-checkpoints';
const CHECKPOINT_KEY = 'engine-v1';
const CHECKPOINT_CACHE_MAX_ENTRIES = 128;
const checkpointCaches = new WeakMap<IFileSystemStorageService, Map<string, DecodedCheckpoint | null>>();
const checkpointFlights = new WeakMap<IFileSystemStorageService, Map<string, Promise<DecodedCheckpoint | undefined>>>();

export interface PersistedCheckpointStatToken {
  readonly token: string;
  readonly distinguishable: boolean;
}

export async function readPersistedCheckpointStatToken(
  storage: IFileSystemStorageService,
  scope: string,
): Promise<PersistedCheckpointStatToken> {
  const checkpointScope = `${scope}/${CHECKPOINT_SUBSCOPE}`;
  const checkpointPath = typeof storage.pathFor === 'function'
    ? storage.pathFor(checkpointScope, CHECKPOINT_KEY)
    : undefined;
  if (checkpointPath === undefined) {
    return { token: 'untracked', distinguishable: false };
  }
  try {
    if (typeof storage.stat === 'function') {
      const info = await storage.stat(checkpointScope, CHECKPOINT_KEY);
      if (info === undefined) return { token: 'none', distinguishable: true };
      return {
        token: `${info.size}:${info.revision}:${info.identity ?? ''}`,
        distinguishable: true,
      };
    }
    const [ckptSize, ckptMtime] = await Promise.all([
      storage.size(checkpointScope, CHECKPOINT_KEY),
      storage.mtime(checkpointScope, CHECKPOINT_KEY),
    ]);
    if (ckptSize === undefined && ckptMtime === undefined) {
      return { token: 'none', distinguishable: true };
    }
    return {
      token: `${ckptSize ?? -1}:${ckptMtime ?? -1}`,
      distinguishable: true,
    };
  } catch {
    return { token: 'untracked', distinguishable: false };
  }
}

function projectRequestedStates(
  decoded: DecodedCheckpoint | undefined,
  names: ReadonlySet<string>,
): { readonly offset: number; readonly states: Map<string, unknown> } | undefined {
  if (decoded === undefined) return undefined;
  const states = new Map<string, unknown>();
  for (const name of names) {
    if (decoded.states.has(name)) states.set(name, decoded.states.get(name));
  }
  return { offset: decoded.offset, states };
}

async function decodeCheckpointSource(
  docs: IAtomicDocumentStore | undefined,
  storage: IFileSystemStorageService,
  scope: string,
  names: ReadonlySet<string>,
  workers: ICpuWorkerService | undefined,
  signal?: AbortSignal,
): Promise<{ readonly wire: ReplayCheckpointWire; readonly states: ReadonlyMap<string, unknown> } | undefined> {
  const checkpointScope = `${scope}/${CHECKPOINT_SUBSCOPE}`;
  const checkpointKey = CHECKPOINT_KEY;
  const checkpointPath = typeof storage.pathFor === 'function'
    ? storage.pathFor(checkpointScope, checkpointKey)
    : undefined;
  if (workers !== undefined && checkpointPath !== undefined) {
    return workers.request<{ readonly wire: ReplayCheckpointWire; readonly states: Map<string, unknown> } | undefined>(
      { type: 'checkpoint.read', path: checkpointPath, names: [...names] },
      { signal, priority: 'high' },
    );
  }
  const checkpoint = await docs?.get<Checkpoint>(checkpointScope, checkpointKey);
  if (checkpoint?.format !== 1 || checkpoint.replayAbi !== REPLAY_ABI_VERSION) return undefined;
  try {
    return {
      wire: checkpoint.wire,
      states: decodeReplayCheckpointStates(checkpoint.graph, names),
    };
  } catch {
    return undefined;
  }
}

export async function readPersistedAgentCheckpoint(
  docs: IAtomicDocumentStore | undefined,
  storage: IFileSystemStorageService,
  scope: string,
  size: number,
  mtimeMs: number,
  names: ReadonlySet<string>,
  workers?: ICpuWorkerService,
  signal?: AbortSignal,
): Promise<{ readonly offset: number; readonly states: Map<string, unknown> } | undefined> {
  signal?.throwIfAborted();
  const ckptStat = await readPersistedCheckpointStatToken(storage, scope);
  signal?.throwIfAborted();
  if (ckptStat.distinguishable && ckptStat.token === 'none') return undefined;
  const hasLargeState = names.has(contextMemoryKey.name);
  const fetchNames = new Set([...LIGHTWEIGHT_STATE_NAMES, ...names]);
  const extraNames = [...names].filter((name) => !LIGHTWEIGHT_STATE_NAMES.has(name)).sort().join(',');
  const baseKey = `${scope}:${size}:${mtimeMs}:ckpt:${ckptStat.token}`;
  const metaCacheKey = `${baseKey}:meta:`;
  const cacheKey = hasLargeState
    ? `${baseKey}:full:${[...names].sort().join(',')}`
    : `${baseKey}:meta:${extraNames}`;

  let cache = checkpointCaches.get(storage);
  if (cache === undefined) {
    cache = new Map();
    checkpointCaches.set(storage, cache);
  }
  if (!hasLargeState && ckptStat.distinguishable && cache.has(cacheKey)) {
    const cached = cache.get(cacheKey) ?? undefined;
    cache.delete(cacheKey);
    cache.set(cacheKey, cached ?? null);
    return projectRequestedStates(cached, names);
  }

  let flights = checkpointFlights.get(storage);
  if (flights === undefined) {
    flights = new Map();
    checkpointFlights.set(storage, flights);
  }
  let flight = flights.get(cacheKey);
  if (flight === undefined) {
    const sharedSignal = hasLargeState ? signal : undefined;
    flight = (async (): Promise<DecodedCheckpoint | undefined> => {
      const extracted = await decodeCheckpointSource(docs, storage, scope, fetchNames, workers, sharedSignal);
      if (extracted === undefined) {
        if (!hasLargeState && ckptStat.distinguishable) {
          const afterStat = await readPersistedCheckpointStatToken(storage, scope);
          if (afterStat.distinguishable && afterStat.token === ckptStat.token) {
            cache.delete(cacheKey);
            cache.set(cacheKey, null);
            if (cache.size > CHECKPOINT_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
          }
        }
        return undefined;
      }
      const digest = async (start: number, end: number) => {
        const hash = createHash('sha256');
        let read = 0;
        if (end > start) for await (const bytes of readLogicalBytes(storage, scope, AGENT_WIRE_RECORD_KEY, { start, end: end - 1 }, { chunkBytes: 64 * 1024 })) {
          hash.update(bytes);
          read += bytes.byteLength;
        }
        return read === end - start ? hash.digest('hex') : undefined;
      };
      const verified = await verifyReplayCheckpointWire(extracted.wire, {
        size, mtimeMs,
        headHash: async () => (await digest(0, Math.min(size, JOURNAL_HEAD_HASH_BYTES)))?.slice(0, 32),
        storeGeneration: async () => {
          const bytes = await storage.read(scope, `${AGENT_WIRE_RECORD_KEY}.generation`);
          return bytes === undefined ? 'legacy' : new TextDecoder().decode(bytes);
        },
        boundarySha256: (end) => digest(Math.max(0, end - JOURNAL_BOUNDARY_HASH_BYTES), end),
        prefixSha256: (end) => end < JOURNAL_HEAD_HASH_BYTES ? digest(0, end) : Promise.resolve(undefined),
      });
      const decoded = verified === undefined ? undefined : { offset: verified.offset, states: extracted.states };
      if (ckptStat.distinguishable) {
        const afterStat = await readPersistedCheckpointStatToken(storage, scope);
        if (afterStat.distinguishable && afterStat.token === ckptStat.token) {
          if (!hasLargeState) {
            cache.delete(cacheKey);
            cache.set(cacheKey, decoded ?? null);
            if (cache.size > CHECKPOINT_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
          } else {
            const lightDecoded = decoded === undefined
              ? null
              : projectRequestedStates(decoded, LIGHTWEIGHT_STATE_NAMES) ?? null;
            cache.delete(metaCacheKey);
            cache.set(metaCacheKey, lightDecoded);
            if (cache.size > CHECKPOINT_CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
          }
        }
      }
      return decoded;
    })().finally(() => {
      if (flights.get(cacheKey) === flight) flights.delete(cacheKey);
    });
    flights.set(cacheKey, flight);
  }
  const resolved = await flight;
  signal?.throwIfAborted();
  return projectRequestedStates(resolved, names);
}
