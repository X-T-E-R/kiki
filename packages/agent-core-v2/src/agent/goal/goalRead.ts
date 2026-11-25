import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { produce } from 'immer';

import type { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import { CpuWorkerError } from '#/app/cpuWorker/host';
import type { WireGoalScanOperation, WireGoalScanResult } from '#/app/cpuWorker/goalScanTask';
import { event2FromRecord } from '#/app/event/event2';
import { Error2, ErrorCodes } from '#/errors';
import { logicalByteSize, openPinnedLogicalRead, type PinnedLogicalScanPlan } from '#/persistence/coldSegmentLog';
import { AppendLogCorruptedError, type IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import { readPersistedAgentCheckpoint } from '#/session/persistedAgentCheckpoint';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { goalKey, type GoalModelState } from './goalOps';
import { goalSnapshot } from './goalSnapshot';
import type { GoalSnapshot } from './types';

interface GoalReadState {
  readonly source: string;
  readonly size: number;
  offset: number;
  goal: GoalModelState;
}

const READ_BYTES = 128 * 1024 * 1024;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const READ_RECORDS = 50_000;
const WORKER_SCAN_MIN_BYTES = 4 * 1024 * 1024;
const MAX_PARALLEL_GOAL_WORKERS = 6;
const DENSE_WORKER_SLICE_BYTES = 32 * 1024 * 1024;
const GOAL_RAW_SUBSTRINGS: readonly Uint8Array[] = [Buffer.from('"goal.'), Buffer.from('"forked"')];
const silent = { silent: true, checkpoint() {}, clearCheckpoints() {}, undoToCheckpoint() {}, emit() {} };

function containsGoalRawMarker(buf: Buffer): boolean {
  return buf.indexOf(GOAL_RAW_SUBSTRINGS[0]!) !== -1 || buf.indexOf(GOAL_RAW_SUBSTRINGS[1]!) !== -1;
}

function stripTrailingCr(buf: Buffer): Buffer {
  return buf.byteLength > 0 && buf[buf.byteLength - 1] === 0x0d
    ? buf.subarray(0, buf.byteLength - 1)
    : buf;
}

function buildWorkerGoalScanOperations(
  scope: string,
  plan: PinnedLogicalScanPlan,
  startOffset: number,
  endOffset: number,
): WireGoalScanOperation[] {
  if (plan.kind === 'dense') {
    const total = endOffset - startOffset;
    const workers = Math.min(MAX_PARALLEL_GOAL_WORKERS, Math.max(1, Math.ceil(total / DENSE_WORKER_SLICE_BYTES)));
    const sliceBytes = Math.ceil(total / workers);
    const ops: WireGoalScanOperation[] = [];
    for (let i = 0; i < workers; i += 1) {
      const denseStart = startOffset + i * sliceBytes;
      const denseEnd = Math.min(endOffset, denseStart + sliceBytes);
      if (denseEnd <= denseStart) break;
      ops.push({
        type: 'wire.goalScan',
        scope,
        key: AGENT_WIRE_RECORD_KEY,
        densePath: plan.wirePath,
        denseStart,
        denseEnd,
        startOffset: denseStart,
        endOffset: denseEnd,
      });
    }
    return ops;
  }
  const needed = plan.segments.filter((seg) => seg.logicalStart < endOffset && seg.logicalEnd > startOffset);
  const hasHotTail = endOffset > plan.sealedCut;
  const hotStart = Math.max(startOffset, plan.sealedCut);
  if (needed.length === 0) {
    if (!hasHotTail) return [];
    return [{
      type: 'wire.goalScan',
      scope,
      key: AGENT_WIRE_RECORD_KEY,
      densePath: plan.wirePath,
      denseStart: hotStart,
      denseEnd: endOffset,
      startOffset: hotStart,
      endOffset,
    }];
  }
  const workers = Math.min(MAX_PARALLEL_GOAL_WORKERS, needed.length);
  const ops: WireGoalScanOperation[] = [];
  for (let i = 0; i < workers; i += 1) {
    const segStart = Math.floor((i * needed.length) / workers);
    const segEnd = Math.floor(((i + 1) * needed.length) / workers);
    const sliceSegments = needed.slice(segStart, segEnd);
    if (sliceSegments.length === 0) continue;
    const isLast = i === workers - 1;
    ops.push({
      type: 'wire.goalScan',
      scope,
      key: AGENT_WIRE_RECORD_KEY,
      codec: plan.codec,
      segments: sliceSegments,
      densePath: isLast && hasHotTail ? plan.wirePath : undefined,
      denseStart: isLast && hasHotTail ? hotStart : undefined,
      denseEnd: isLast && hasHotTail ? endOffset : undefined,
      startOffset,
      endOffset,
    });
  }
  return ops;
}

export class PersistedGoalReader {
  private readonly states = new Map<string, GoalReadState>();
  private readonly flights = new Map<string, Promise<GoalSnapshot | null>>();
  private readonly folds = new Map([...goalKey.replayable.folds].map(([event, fold]) => [event.type, { event, fold }]));

  constructor(
    private readonly logs: IAppendLogStore,
    private readonly docs: IAtomicDocumentStore,
    private readonly storage: IFileSystemStorageService,
    private readonly workers?: ICpuWorkerService,
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
      const checkpoint = await readPersistedAgentCheckpoint(
        this.docs,
        this.storage,
        scope,
        source.size,
        source.mtimeMs,
        new Set([goalKey.name]),
        this.workers,
      );
      if (checkpoint === undefined || !checkpoint.states.has(goalKey.name)) return undefined;
      return { offset: checkpoint.offset, goal: goalKey.replayable.schema.parse(checkpoint.states.get(goalKey.name)) };
    } catch {
      return undefined;
    }
  }

  private foldGoalRecord(state: GoalReadState, record: WireRecord): void {
    const entry = this.folds.get(record.type);
    if (entry === undefined) return;
    const event = event2FromRecord(entry.event, record);
    if (event !== undefined) state.goal = produce(state.goal, (draft) => entry.fold(draft, event, silent));
  }

  private async tryWorkerScan(scope: string, state: GoalReadState): Promise<boolean> {
    if (this.workers === undefined || state.size - state.offset < WORKER_SCAN_MIN_BYTES) return false;
    const pinned = await openPinnedLogicalRead(this.storage, scope, AGENT_WIRE_RECORD_KEY);
    let results: WireGoalScanResult[];
    try {
      const plan = pinned.scanPlan;
      if (plan === undefined || pinned.size !== state.size) return false;
      const operations = buildWorkerGoalScanOperations(scope, plan, state.offset, state.size);
      if (operations.length === 0) {
        state.offset = state.size;
        return true;
      }
      try {
        results = await Promise.all(
          operations.map((operation) => this.workers!.request<WireGoalScanResult>(operation, { priority: 'high' })),
        );
      } catch (error) {
        if (error instanceof CpuWorkerError) return false;
        throw error;
      }
    } finally {
      pinned.close();
    }
    if (results.some((result) => result.overflow)) return false;
    const completeLines: string[] = [];
    let carry: Buffer[] = [];
    let carryBytes = 0;
    for (const result of results) {
      const leading = result.leading === undefined
        ? undefined
        : Buffer.from(result.leading.buffer, result.leading.byteOffset, result.leading.byteLength);
      if (!result.hasNewline) {
        if (leading !== undefined && leading.byteLength > 0) {
          carry.push(leading);
          carryBytes += leading.byteLength;
        }
        continue;
      }
      if (leading !== undefined && leading.byteLength > 0) {
        carry.push(leading);
        carryBytes += leading.byteLength;
      }
      if (carryBytes > 0) {
        const merged = carry.length === 1 ? carry[0]! : Buffer.concat(carry, carryBytes);
        const lineBuf = stripTrailingCr(merged);
        if (lineBuf.byteLength > 0 && containsGoalRawMarker(lineBuf)) {
          completeLines.push(lineBuf.toString('utf8'));
        }
        carry = [];
        carryBytes = 0;
      }
      for (const line of result.matchedLines) completeLines.push(line);
      if (result.trailing !== undefined && result.trailing.byteLength > 0) {
        const trailing = Buffer.from(result.trailing.buffer, result.trailing.byteOffset, result.trailing.byteLength);
        carry.push(trailing);
        carryBytes = trailing.byteLength;
      }
    }
    let lineIndex = 0;
    for (const line of completeLines) {
      lineIndex += 1;
      let record: WireRecord;
      try {
        record = JSON.parse(line) as WireRecord;
      } catch (error) {
        throw new AppendLogCorruptedError(scope, AGENT_WIRE_RECORD_KEY, lineIndex, error);
      }
      this.foldGoalRecord(state, record);
    }
    if (carryBytes > 0) {
      const merged = carry.length === 1 ? carry[0]! : Buffer.concat(carry, carryBytes);
      const lineBuf = stripTrailingCr(merged);
      if (lineBuf.byteLength > 0 && containsGoalRawMarker(lineBuf)) {
        try {
          const record = JSON.parse(lineBuf.toString('utf8')) as WireRecord;
          this.foldGoalRecord(state, record);
        } catch {}
      }
    }
    state.offset = state.size;
    return true;
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
    if (state.offset < state.size && !(await this.tryWorkerScan(scope, state))) {
      let exhausted = true;
      let pendingYield = false;
      const sliceAbort = new AbortController();
      try {
        for await (const record of this.logs.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY, {
          startOffset: state.offset,
          endOffset: state.size,
          chunkBytes: READ_CHUNK_BYTES,
          signal: sliceAbort.signal,
          rawSubstrings: GOAL_RAW_SUBSTRINGS,
          lineFilter: (line) => {
            const keep = line.includes('"goal.') || line.includes('"forked"');
            pendingYield = keep;
            return keep;
          },
          onPosition: (offset) => {
            state.offset = offset;
            if (!pendingYield) {
              records++;
              if (offset - start >= READ_BYTES || records >= READ_RECORDS) {
                exhausted = false;
                sliceAbort.abort();
              }
            }
            pendingYield = false;
          },
        })) {
          this.foldGoalRecord(state, record);
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
      } catch (error) {
        if (!sliceAbort.signal.aborted) throw error;
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
