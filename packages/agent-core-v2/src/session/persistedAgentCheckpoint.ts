import { createHash } from 'node:crypto';
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

export async function readPersistedAgentCheckpoint(
  docs: IAtomicDocumentStore | undefined,
  storage: IFileSystemStorageService,
  scope: string,
  size: number,
  mtimeMs: number,
  names: ReadonlySet<string>,
): Promise<{ readonly offset: number; readonly states: Map<string, unknown> } | undefined> {
  const checkpoint = await docs?.get<Checkpoint>(`${scope}/replay-checkpoints`, 'engine-v1');
  if (checkpoint?.format !== 1 || checkpoint.replayAbi !== REPLAY_ABI_VERSION) return undefined;
  const digest = async (start: number, end: number) => {
    const hash = createHash('sha256');
    let read = 0;
    if (end > start) for await (const bytes of readLogicalBytes(storage, scope, AGENT_WIRE_RECORD_KEY, { start, end: end - 1 })) {
      hash.update(bytes);
      read += bytes.byteLength;
    }
    return read === end - start ? hash.digest('hex') : undefined;
  };
  const verified = await verifyReplayCheckpointWire(checkpoint.wire, {
    size, mtimeMs,
    headHash: async () => (await digest(0, Math.min(size, JOURNAL_HEAD_HASH_BYTES)))?.slice(0, 32),
    storeGeneration: async () => {
      const bytes = await storage.read(scope, `${AGENT_WIRE_RECORD_KEY}.generation`);
      return bytes === undefined ? 'legacy' : new TextDecoder().decode(bytes);
    },
    boundarySha256: (end) => digest(Math.max(0, end - JOURNAL_BOUNDARY_HASH_BYTES), end),
    prefixSha256: (end) => end < JOURNAL_HEAD_HASH_BYTES ? digest(0, end) : Promise.resolve(undefined),
  });
  if (verified === undefined) return undefined;
  try {
    return { offset: verified.offset, states: new Map(decodeReplayCheckpointStates(checkpoint.graph, names)) };
  } catch { return undefined; }
}
