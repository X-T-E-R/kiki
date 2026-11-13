import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { produce } from 'immer';

import { event2FromRecord } from '#/app/event/event2';
import { Error2, ErrorCodes } from '#/errors';
import { logicalByteSize, readLogicalBytes } from '#/persistence/coldSegmentLog';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import { REPLAY_ABI_VERSION, verifyReplayCheckpointWire, type ReplayCheckpointWire } from '#/state/eventDispatcherService';
import { decodeReplayCheckpointStates, type ReplayCheckpointGraph } from '#/state/replayCheckpointCodec';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { JOURNAL_BOUNDARY_HASH_BYTES, JOURNAL_HEAD_HASH_BYTES } from '#/wire/wire';
import { goalKey, type GoalModelState } from './goalOps';
import { goalSnapshot } from './goalSnapshot';
import type { GoalSnapshot } from './types';

interface Checkpoint {
  readonly format: number;
  readonly replayAbi: number;
  readonly wire: ReplayCheckpointWire;
  readonly graph: ReplayCheckpointGraph;
}

interface GoalReadState {
  readonly source: string;
  readonly size: number;
  offset: number;
  goal: GoalModelState;
}

const READ_BYTES = 8 * 1024 * 1024;
const READ_RECORDS = 50_000;
const silent = { silent: true, checkpoint() {}, clearCheckpoints() {}, undoToCheckpoint() {}, emit() {} };

export class PersistedGoalReader {
  private readonly states = new Map<string, GoalReadState>();
  private readonly flights = new Map<string, Promise<GoalSnapshot | null>>();
  private readonly folds = new Map([...goalKey.replayable.folds].map(([event, fold]) => [event.type, { event, fold }]));

  constructor(
    private readonly logs: IAppendLogStore,
    private readonly docs: IAtomicDocumentStore,
    private readonly storage: IFileSystemStorageService,
  ) {}

  async readReady(scope: string): Promise<GoalSnapshot | null> {
    for (;;) {
      try { return await this.read(scope); }
      catch (error) {
        if (!(error instanceof Error2) || error.details?.['reason'] !== 'goal_history_preparing') throw error;
      }
      await yieldToEventLoop();
    }
  }

  read(scope: string): Promise<GoalSnapshot | null> {
    const current = this.flights.get(scope);
    if (current !== undefined) return current;
    const flight = this.readSlice(scope).finally(() => { this.flights.delete(scope); });
    this.flights.set(scope, flight);
    return flight;
  }

  private async source(scope: string) {
    await this.logs.flush(scope, AGENT_WIRE_RECORD_KEY);
    const generation = await this.logs.generation(scope, AGENT_WIRE_RECORD_KEY);
    const size = await logicalByteSize(this.storage, scope, AGENT_WIRE_RECORD_KEY) ?? 0;
    const mtimeMs = await this.storage.mtime(scope, AGENT_WIRE_RECORD_KEY) ?? 0;
    return { generation, size, mtimeMs, id: JSON.stringify([generation, size, mtimeMs]) };
  }

  private async checkpoint(scope: string, source: Awaited<ReturnType<PersistedGoalReader['source']>>) {
    try {
      const checkpoint = await this.docs.get<Checkpoint>(`${scope}/replay-checkpoints`, 'engine-v1');
      if (checkpoint?.format !== 1 || checkpoint.replayAbi !== REPLAY_ABI_VERSION) return undefined;
      const digest = async (start: number, end: number): Promise<string | undefined> => {
        if (end < start || end > source.size) return undefined;
        const hash = createHash('sha256');
        let bytes = 0;
        if (end > start) {
          for await (const chunk of readLogicalBytes(this.storage, scope, AGENT_WIRE_RECORD_KEY, { start, end: end - 1 })) {
            bytes += chunk.byteLength;
            hash.update(chunk);
          }
        }
        return bytes === end - start ? hash.digest('hex') : undefined;
      };
      const verified = await verifyReplayCheckpointWire(checkpoint.wire, {
        size: source.size,
        mtimeMs: source.mtimeMs,
        headHash: async () => (await digest(0, Math.min(source.size, JOURNAL_HEAD_HASH_BYTES)))?.slice(0, 32),
        storeGeneration: () => Promise.resolve(source.generation),
        boundarySha256: (end) => digest(Math.max(0, end - JOURNAL_BOUNDARY_HASH_BYTES), end),
        prefixSha256: (end) => digest(0, end),
      });
      if (verified === undefined) return undefined;
      const states = decodeReplayCheckpointStates(checkpoint.graph, new Set([goalKey.name]));
      if (!states.has(goalKey.name)) return undefined;
      return { offset: verified.offset, goal: goalKey.replayable.schema.parse(states.get(goalKey.name)) };
    } catch {
      return undefined;
    }
  }

  private async readSlice(scope: string): Promise<GoalSnapshot | null> {
    const source = await this.source(scope);
    let state = this.states.get(scope);
    if (state?.source !== source.id) {
      const checkpoint = await this.checkpoint(scope, source);
      state = { source: source.id, size: source.size, offset: checkpoint?.offset ?? 0, goal: checkpoint?.goal ?? null };
    }
    this.states.delete(scope);
    this.states.set(scope, state);
    while (this.states.size > 16) this.states.delete(this.states.keys().next().value!);
    let records = 0;
    const start = state.offset;
    let deadline = performance.now() + 4;
    if (state.offset < state.size) {
      let exhausted = true;
      for await (const record of this.logs.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY, {
        startOffset: state.offset, endOffset: state.size, onPosition: (offset) => { state.offset = offset; },
      })) {
        const entry = this.folds.get(record.type);
        if (entry !== undefined) {
          const event = event2FromRecord(entry.event, record);
          if (event !== undefined) state.goal = produce(state.goal, (draft) => entry.fold(draft, event, silent));
        }
        records++;
        if (performance.now() >= deadline) {
          await yieldToEventLoop();
          deadline = performance.now() + 4;
        }
        if (state.offset - start >= READ_BYTES || records >= READ_RECORDS) {
          exhausted = false;
          break;
        }
      }
      if (exhausted) state.offset = state.size;
    }
    if ((await this.source(scope)).id !== source.id) {
      this.states.delete(scope);
      throw preparing();
    }
    if (state.offset < state.size) throw preparing();
    if (state.goal === null) return null;
    const clock = state.goal.status === 'active' && state.goal.wallClockResumedAt !== undefined
      ? state.goal.wallClockMs + Math.max(0, Date.now() - state.goal.wallClockResumedAt) : state.goal.wallClockMs;
    return goalSnapshot(state.goal, clock);
  }
}

function preparing(): Error2 {
  return new Error2(ErrorCodes.SESSION_BUSY, 'Saved goal history is preparing; retry the read.', { details: { reason: 'goal_history_preparing' } });
}
