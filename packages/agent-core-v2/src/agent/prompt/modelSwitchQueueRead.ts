import { createHash } from 'node:crypto';
import { produce } from 'immer';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IFileSystemStorageService } from '#/persistence/interface/storage';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { event2FromRecord } from '#/app/event/event2';
import { promptQueueKey } from './promptService';
import { modelSwitchQueueKey, type QueuedModelSwitch } from './modelSwitchQueueOps';
import { expandedStateFolds } from '#/state/state';
import { decodeReplayCheckpointStates, type ReplayCheckpointGraph } from '#/state/replayCheckpointCodec';
import {
  REPLAY_ABI_VERSION,
  verifyReplayCheckpointWire,
  type ReplayCheckpointWire,
} from '#/state/eventDispatcherService';
import { logicalByteSize, readLogicalBytes } from '#/persistence/coldSegmentLog';
import { isWireRecord, AGENT_WIRE_RECORD_KEY } from '#/wire/record';
import { JOURNAL_BOUNDARY_HASH_BYTES, JOURNAL_HEAD_HASH_BYTES } from '#/wire/wire';

const PREFIX = '\u0000model-switch:';
const READ_BYTES = 8 * 1024 * 1024;
const PROOF_BYTES = 64 * 1024;
const WIRE_TYPE_HEAD = Buffer.from('{"type":"');
const WIRE_PROMPT_PREFIX = Buffer.from('{"type":"prompt.');
const MODEL_SWITCH_NEEDLE = Buffer.from('prompt.model_switch', 'utf8');
const CHECKPOINT_STATE_NAMES = new Set([modelSwitchQueueKey.name, promptQueueKey.name]);

function isNonPromptWireLine(bytes: Buffer): boolean {
  let len = bytes.length;
  if (len > 0 && bytes[len - 1] === 0x0d) len -= 1;
  if (len < WIRE_TYPE_HEAD.length + 2 || bytes[len - 1] !== 0x7d) return false;
  if (bytes.subarray(0, WIRE_TYPE_HEAD.length).equals(WIRE_TYPE_HEAD)) {
    return len < WIRE_PROMPT_PREFIX.length || !bytes.subarray(0, WIRE_PROMPT_PREFIX.length).equals(WIRE_PROMPT_PREFIX);
  }
  const type = /^\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(bytes.toString('utf8', 0, Math.min(256, len)))?.[1];
  return type !== undefined && !type.startsWith('prompt.');
}
type SwitchState = ReturnType<typeof modelSwitchQueueKey.initial>;
type QueueState = ReturnType<typeof promptQueueKey.initial>;
interface Checkpoint {
  readonly format: number;
  readonly replayAbi: number;
  readonly wire: ReplayCheckpointWire;
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
    const fastEmpty = await this.tryFastEmptyScan(scope, signal);
    if (fastEmpty) return [];
    for (;;) {
      signal?.throwIfAborted();
      try { return await this.read(scope, signal); }
      catch (error) {
        if (!(error instanceof ModelSwitchQueuePreparingError)) throw error;
      }
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
  }

  private async tryFastEmptyScan(scope: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const current = await this.source(scope);
    signal?.throwIfAborted();
    if (current.size <= READ_BYTES * 2) return false;
    const cached = this.states.get(scope);
    if (cached !== undefined && cached.complete && cached.switches.size === 0 && this.canAppend(cached.source, current) && current.size === cached.source.size) {
      return true;
    }
    const overlap = MODEL_SWITCH_NEEDLE.length - 1;
    let carry = Buffer.alloc(0);
    for await (const raw of readLogicalBytes(this.host.storage, scope, AGENT_WIRE_RECORD_KEY, { start: 0, end: current.size - 1 }, { chunkBytes: 1024 * 1024 })) {
      signal?.throwIfAborted();
      const chunk = Buffer.from(raw);
      const combined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      if (combined.indexOf(MODEL_SWITCH_NEEDLE) !== -1) {
        return false;
      }
      carry = overlap > 0 ? Buffer.from(combined.subarray(Math.max(0, combined.length - overlap))) : Buffer.alloc(0);
    }
    const after = await this.source(scope);
    if (!this.canAppend(current, after) || after.size !== current.size) {
      return false;
    }
    const proof = await this.prefixProof(scope, current.size);
    this.states.delete(scope);
    this.states.set(scope, {
      source: after,
      watermark: current.size,
      proof,
      switches: modelSwitchQueueKey.initial(),
      queue: promptQueueKey.initial(),
      offset: current.size,
      pending: Buffer.alloc(0),
      skip: false,
      complete: true,
    });
    while (this.states.size > 16) this.states.delete(this.states.keys().next().value!);
    return true;
  }

  private async checkpoint(scope: string, size: number, mtimeMs: number) {
    const checkpoint = await this.host.docs.get<Checkpoint>(`${scope}/replay-checkpoints`, 'engine-v1');
    if (checkpoint?.format !== 1 || checkpoint.replayAbi !== REPLAY_ABI_VERSION) return undefined;
    const digestRange = async (start: number, byteLength: number): Promise<string | undefined> => {
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > size || start < 0 || start > byteLength) {
        return undefined;
      }
      const hash = createHash('sha256');
      let read = 0;
      if (start < byteLength) {
        for await (const chunk of readLogicalBytes(this.host.storage, scope, AGENT_WIRE_RECORD_KEY, { start, end: byteLength - 1 })) {
          hash.update(chunk);
          read += chunk.byteLength;
        }
      }
      if (read !== byteLength - start) return undefined;
      return hash.digest('hex');
    };
    const verified = await verifyReplayCheckpointWire(checkpoint.wire, {
      size,
      mtimeMs,
      headHash: async () => {
        const hash = createHash('sha256');
        for await (const chunk of readLogicalBytes(this.host.storage, scope, AGENT_WIRE_RECORD_KEY, { start: 0, end: JOURNAL_HEAD_HASH_BYTES - 1 })) {
          hash.update(chunk);
        }
        return hash.digest('hex').slice(0, 32);
      },
      storeGeneration: async () => {
        const genBytes = await this.host.storage.read(scope, `${AGENT_WIRE_RECORD_KEY}.generation`);
        return genBytes === undefined ? 'legacy' : new TextDecoder().decode(genBytes);
      },
      boundarySha256: (byteLength) => digestRange(Math.max(0, byteLength - JOURNAL_BOUNDARY_HASH_BYTES), byteLength),
      prefixSha256: (byteLength) => digestRange(0, byteLength),
    });
    if (verified === undefined) return undefined;
    try {
      const states = decodeReplayCheckpointStates(checkpoint.graph, CHECKPOINT_STATE_NAMES);
      const switches = states.get(modelSwitchQueueKey.name);
      const queue = states.get(promptQueueKey.name);
      if (!(switches instanceof Map) || typeof queue !== 'object' || queue === null || !('order' in queue) || !Array.isArray(queue.order)) return undefined;
      return { switches: switches as SwitchState, queue: queue as QueueState, offset: verified.offset };
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
    const size = await logicalByteSize(this.host.storage, scope, AGENT_WIRE_RECORD_KEY);
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
        for await (const chunk of readLogicalBytes(this.host.storage, scope, AGENT_WIRE_RECORD_KEY,
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
      const offset = checkpoint?.offset ?? 0;
      state = { source, watermark: source.size, proof, switches: checkpoint?.switches ?? modelSwitchQueueKey.initial(),
        queue: checkpoint?.queue ?? promptQueueKey.initial(), offset,
        pending: Buffer.alloc(0), skip: false, complete: checkpoint !== undefined && offset >= source.size };
    } else if (state.complete && source.size > state.watermark) {
      state.watermark = source.size;
      state.proof = await this.prefixProof(scope, state.watermark);
      state.complete = false;
    }
    this.states.delete(scope); this.states.set(scope, state);
    while (this.states.size > 16) this.states.delete(this.states.keys().next().value!);
    if (!state.complete && state.offset < state.watermark) {
      const end = Math.min(state.watermark, state.offset + READ_BYTES) - 1;
      for await (const raw of readLogicalBytes(this.host.storage, scope, AGENT_WIRE_RECORD_KEY, { start: state.offset, end })) {
        const chunk = Buffer.from(raw);
        state.offset += chunk.length;
        let start = 0;
        for (;;) {
          const newline = chunk.indexOf(10, start);
          const index = newline < 0 ? chunk.length : newline;
          const fragment = chunk.subarray(start, index);
          if (state.pending.length === 0 && index !== chunk.length) {
            if (!state.skip && fragment.length > 0 && !isNonPromptWireLine(fragment)) {
              this.fold(state, fragment);
            }
            state.skip = false;
          } else {
            if (!state.skip) state.pending = state.pending.length === 0 ? Buffer.from(fragment) : Buffer.concat([state.pending, fragment]);
            if (!state.skip && state.pending.length >= 256) {
              const type = /^\s*\{\s*"type"\s*:\s*"([^"]+)"/.exec(state.pending.toString('utf8', 0, 256))?.[1];
              if (type !== undefined && !type.startsWith('prompt.')) { state.skip = true; state.pending = Buffer.alloc(0); }
            }
            if (index !== chunk.length) {
              if (!state.skip && state.pending.length > 0 && !isNonPromptWireLine(state.pending)) this.fold(state, state.pending);
              state.pending = Buffer.alloc(0); state.skip = false;
            }
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
