import { createHash } from 'node:crypto';
import { produce } from 'immer';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { event2FromRecord } from '#/app/event/event2';
import { promptQueueKey } from './promptService';
import { modelSwitchQueueKey, type QueuedModelSwitch } from './modelSwitchQueueOps';
import { expandedStateFolds } from '#/state/state';
import { decodeReplayCheckpointGraph, type ReplayCheckpointGraph } from '#/state/replayCheckpointCodec';
import { REPLAY_ABI_VERSION } from '#/state/eventDispatcherService';
import { isWireRecord, AGENT_WIRE_RECORD_KEY } from '#/wire/record';

const PREFIX = '\u0000model-switch:';
const READ_BYTES = 8 * 1024 * 1024;
const PROOF_BYTES = 64 * 1024;
type SwitchState = ReturnType<typeof modelSwitchQueueKey.initial>;
type QueueState = ReturnType<typeof promptQueueKey.initial>;
interface Checkpoint {
  readonly format: number;
  readonly replayAbi: number;
  readonly wire: { readonly size: number; readonly mtimeMs: number; readonly headHash?: string };
  readonly graph: ReplayCheckpointGraph;
}
interface ReaderHost {
  readonly docs: IAtomicDocumentStore;
  readonly storage: IFileSystemStorageService;
  readonly files?: Pick<IHostFileSystem, 'stat'>;
}
interface Source {
  readonly size: number;
  readonly mtimeMs: number;
  readonly identity?: number;
}
interface ReadState {
  source: Source;
  watermark: number;
  proof: string;
  switches: SwitchState;
  queue: QueueState;
  offset: number;
  pending: Buffer;
  skip: boolean;
  complete: boolean;
}

/** A bounded cold read has made progress but cannot yet claim an authoritative queue. */
export class ModelSwitchQueuePreparingError extends Error {
  constructor() { super('model_switch_queue_preparing'); }
}

/**
 * Reads a fixed durable watermark without materializing a session or draining operations;
 * subsequent reads fold the appended suffix. Append validation samples the prefix's first
 * and last 64 KiB; in-place rewrites of an unsampled middle followed by growth are outside
 * the append-only writer contract, rather than rehashing the entire prefix per slice.
 */
export class PersistedModelSwitchReader {
  private readonly states = new Map<string, ReadState>();
  private readonly flights = new Map<string, Promise<readonly (QueuedModelSwitch & { readonly queueIndex: number })[]>>();
  private readonly switchFolds = new Map([...expandedStateFolds(modelSwitchQueueKey)].map(([event, fold]) => [event.type, { event, fold }]));
  private readonly queueFolds = new Map([...expandedStateFolds(promptQueueKey)].map(([event, fold]) => [event.type, { event, fold }]));
  constructor(private readonly host: ReaderHost) {}

  read(scope: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const flight = this.flights.get(scope);
    if (flight !== undefined) return flight.then((list) => { signal?.throwIfAborted(); return list; });
    const promise = this.readPage(scope).catch((error: unknown) => {
      if (!(error instanceof ModelSwitchQueuePreparingError)) this.states.delete(scope);
      throw error;
    }).finally(() => { this.flights.delete(scope); });
    this.flights.set(scope, promise);
    return promise.then((list) => { signal?.throwIfAborted(); return list; });
  }

  async readReady(scope: string, signal?: AbortSignal) {
    for (;;) {
      signal?.throwIfAborted();
      try { return await this.read(scope, signal); }
      catch (error) {
        if (!(error instanceof ModelSwitchQueuePreparingError)) throw error;
      }
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
  }

  private async checkpoint(scope: string, size: number, mtimeMs: number) {
    const checkpoint = await this.host.docs.get<Checkpoint>(`${scope}/replay-checkpoints`, 'engine-v1');
    if (checkpoint?.format !== 1 || checkpoint.replayAbi !== REPLAY_ABI_VERSION ||
      size !== checkpoint.wire.size || mtimeMs !== checkpoint.wire.mtimeMs) return undefined;
    const hash = createHash('sha256');
    for await (const chunk of this.host.storage.readStream(scope, AGENT_WIRE_RECORD_KEY, { start: 0, end: 64 * 1024 - 1 })) hash.update(chunk);
    if (hash.digest('hex').slice(0, 32) !== checkpoint.wire.headHash) return undefined;
    try {
      const payload = decodeReplayCheckpointGraph(checkpoint.graph) as { states?: readonly { name: string; value: unknown }[] };
      const switches = payload.states?.find((state) => state.name === modelSwitchQueueKey.name)?.value;
      const queue = payload.states?.find((state) => state.name === promptQueueKey.name)?.value;
      if (!(switches instanceof Map) || typeof queue !== 'object' || queue === null || !('order' in queue) || !Array.isArray(queue.order)) return undefined;
      return { switches: switches as SwitchState, queue: queue as QueueState };
    } catch { return undefined; }
  }

  private fold(state: ReadState, bytes: Buffer) {
    if (bytes.length === 0) return;
    const record: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isWireRecord(record)) throw new Error('Malformed model switch queue history');
    const context = { silent: true, emit: () => {}, checkpoint: () => {}, clearCheckpoints: () => {}, undoToCheckpoint: () => {} };
    const switchFold = this.switchFolds.get(record.type);
    if (switchFold !== undefined) {
      const event = event2FromRecord(switchFold.event, record);
      if (event === undefined) throw new Error('Malformed model switch queue event');
      state.switches = produce(state.switches, (draft) => switchFold.fold(draft, event as never, context));
    }
    const queueFold = this.queueFolds.get(record.type);
    if (queueFold !== undefined) {
      const event = event2FromRecord(queueFold.event, record);
      if (event === undefined) throw new Error('Malformed prompt queue event');
      state.queue = produce(state.queue, (draft) => queueFold.fold(draft, event as never, context));
    }
  }

  private async source(scope: string): Promise<Source> {
    const size = await this.host.storage.size(scope, AGENT_WIRE_RECORD_KEY);
    const path = this.host.storage.pathFor?.(scope, AGENT_WIRE_RECORD_KEY);
    if (size !== undefined && path !== undefined && this.host.files !== undefined) {
      const stat = await this.host.files.stat(path);
      return { size: stat.size, mtimeMs: stat.mtimeMs ?? 0, identity: stat.ino };
    }
    return { size: size ?? 0, mtimeMs: await this.host.storage.mtime(scope, AGENT_WIRE_RECORD_KEY) ?? 0 };
  }

  private canAppend(previous: Source, current: Source) {
    return previous.identity === current.identity && current.size >= previous.size &&
      (current.size > previous.size || current.mtimeMs === previous.mtimeMs);
  }

  private invalidate(scope: string): never {
    this.states.delete(scope);
    throw new ModelSwitchQueuePreparingError();
  }

  private async prefixProof(scope: string, through: number) {
    const hash = createHash('sha256');
    const bytes = Math.min(through, PROOF_BYTES);
    for (const start of [0, Math.max(0, through - PROOF_BYTES)]) {
      let read = 0;
      if (bytes > 0) {
        for await (const chunk of this.host.storage.readStream(scope, AGENT_WIRE_RECORD_KEY,
          { start, end: start + bytes - 1 }, { chunkBytes: PROOF_BYTES })) {
          hash.update(chunk); read += chunk.length;
        }
      }
      if (read !== bytes) this.invalidate(scope);
    }
    return hash.digest('hex');
  }

  private async readPage(scope: string) {
    const source = await this.source(scope);
    let state = this.states.get(scope);
    const changed = state !== undefined && (!this.canAppend(state.source, source) || source.size < state.watermark ||
      await this.prefixProof(scope, state.watermark) !== state.proof);
    if (changed) state = undefined;
    if (state === undefined) {
      const proof = await this.prefixProof(scope, source.size);
      const checkpoint = changed ? undefined : await this.checkpoint(scope, source.size, source.mtimeMs);
      state = { source, watermark: source.size, proof, switches: checkpoint?.switches ?? modelSwitchQueueKey.initial(),
        queue: checkpoint?.queue ?? promptQueueKey.initial(), offset: checkpoint === undefined ? 0 : source.size,
        pending: Buffer.alloc(0), skip: false, complete: checkpoint !== undefined };
    } else if (state.complete && source.size > state.watermark) {
      state.watermark = source.size;
      state.proof = await this.prefixProof(scope, state.watermark);
      state.complete = false;
    }
    this.states.delete(scope); this.states.set(scope, state);
    while (this.states.size > 16) this.states.delete(this.states.keys().next().value!);
    if (!state.complete && state.offset < state.watermark) {
      const end = Math.min(state.watermark, state.offset + READ_BYTES) - 1;
      for await (const raw of this.host.storage.readStream(scope, AGENT_WIRE_RECORD_KEY, { start: state.offset, end })) {
        const chunk = Buffer.from(raw);
        state.offset += chunk.length;
        let start = 0;
        for (;;) {
          const newline = chunk.indexOf(10, start);
          const index = newline < 0 ? chunk.length : newline;
          const fragment = chunk.subarray(start, index);
          if (!state.skip) state.pending = Buffer.concat([state.pending, fragment]);
          if (state.pending.length >= 256) {
            const type = /^\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(state.pending.toString('utf8', 0, 256))?.[1];
            if (type !== undefined && !type.startsWith('prompt.')) { state.skip = true; state.pending = Buffer.alloc(0); }
          }
          if (index !== chunk.length) {
            if (!state.skip) this.fold(state, state.pending);
            state.pending = Buffer.alloc(0); state.skip = false;
          }
          if (index === chunk.length) break;
          start = index + 1;
        }
      }
      if (state.offset !== end + 1) throw new Error('Incomplete model switch queue source read');
    }
    const after = await this.source(scope);
    if (!this.canAppend(source, after) || after.size < state.watermark ||
      await this.prefixProof(scope, state.watermark) !== state.proof) this.invalidate(scope);
    const verified = await this.source(scope);
    if (!this.canAppend(after, verified)) this.invalidate(scope);
    state.source = verified;
    if (state.offset >= state.watermark) {
      state.complete = true;
      if (!state.skip && state.pending.length > 0) {
        try { this.fold(state, state.pending); }
        catch (error) {
          if (error instanceof SyntaxError && verified.size > state.watermark) throw new ModelSwitchQueuePreparingError();
          throw error;
        }
        state.pending = Buffer.alloc(0);
      }
    }
    if (!state.complete) throw new ModelSwitchQueuePreparingError();
    return [...state.switches.values()].map((entry) => ({ ...entry,
      queueIndex: state.queue.order.indexOf(`${PREFIX}${entry.input.operationId}`),
    }));
  }
}
