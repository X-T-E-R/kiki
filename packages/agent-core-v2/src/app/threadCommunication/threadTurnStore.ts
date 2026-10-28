import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import type { BridgeContentRef, BridgeReadView } from '@kiki/protocol';
import { createDecorator } from '#/_base/di/instantiation';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { abortable } from '#/_base/utils/abort';
import { LifecycleScope } from '#/app/scopes';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { LoopRecordedEvent } from '#/agent/contextMemory/loopEventFold';
import { Error2, ErrorCodes } from '#/errors';
import { IAppendLogStore, AppendLogCorruptedError } from '#/persistence/interface/appendLogStore';
import { IQueryStore, type WriteOp } from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { openPinnedLogicalRead, type PinnedLogicalRead } from '#/persistence/coldSegmentLog';
import { readPinnedRange } from '#/persistence/logicalWireFile';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import type { ThreadTurn } from './threadCommunication';

export interface ThreadTurnSource {
  readonly generation: string;
  readonly epoch: string;
  readonly watermark: number;
  readonly proof: string;
  readonly prepared?: number;
}

export interface ThreadTurnPage {
  readonly turns: readonly ThreadTurn[];
  readonly source: ThreadTurnSource;
  readonly preparing: boolean;
  readonly hasMore: boolean;
}

export interface IThreadTurnStore {
  readonly _serviceBrand: undefined;
  /** Reads completed turns at a fixed source watermark, preparing recent windows from the tail. Ambiguous layouts resume bounded forward preparation; source replacement or a rebuilt projection invalidates its cursors. */
  read(scope: string, before: number, limit: number, source?: ThreadTurnSource, signal?: AbortSignal): Promise<ThreadTurnPage>;
  content(scope: string, ref: BridgeContentRef, signal?: AbortSignal): Promise<NonNullable<BridgeReadView['segment']>>;
}

export const IThreadTurnStore = createDecorator<IThreadTurnStore>('threadTurnStore');

interface PendingTurn {
  readonly turnId: number;
  readonly origin: PromptOrigin;
  readonly startedAt?: number;
  readonly promptStart: number;
  readonly promptEnd: number;
  readonly promptDigest: string;
  readonly inputUnits: number;
  outputUnits: number;
  outputTail: string;
}

interface TurnRow extends Omit<ThreadTurn, 'input' | 'output' | 'contentRefs'> {
  readonly kind: 'turn';
  readonly generation: string;
  readonly epoch: string;
  readonly promptStart: number;
  readonly promptEnd: number;
  readonly promptDigest: string;
  readonly terminalStart: number;
  readonly terminalEnd: number;
  readonly terminalDigest: string;
  readonly inputUnits: number;
  readonly outputUnits: number;
}

interface TextRow {
  readonly kind: 'text';
  readonly text: string;
}

interface Head {
  readonly kind: 'head';
  readonly version: 2;
  readonly generation: string;
  readonly epoch: string;
  offset: number;
  covered: number;
  size: number;
  mtime?: number;
  boundary: string;
  nextTurnId: number;
  cancelled: number[];
  pending: PendingTurn[];
  tails?: number[];
}

interface TailPreparation {
  readonly kind: 'tail';
  offset: number;
  boundary: string;
  floor: number;
  complete: boolean;
  fallback: boolean;
  group: { terminal?: number; eventTurn?: number; ambiguous: boolean; end?: number };
  replay?: { head: Head; end: number; turnId: number };
}

const SCAN_BYTES = 4 * 1024 * 1024;
const SCAN_RECORDS = 10_000;
const SEGMENT_UNITS = 16_384;
const INLINE_UNITS = 4096;
const PREVIEW_UNITS = 512;

export class ThreadTurnStore implements IThreadTurnStore {
  declare readonly _serviceBrand: undefined;
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(
    @IAppendLogStore private readonly logs: IAppendLogStore,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
    @IQueryStore private readonly query: IQueryStore,
    @ILogService private readonly log: ILogService,
  ) {}

  read(scope: string, before: number, limit: number, source?: ThreadTurnSource, signal?: AbortSignal): Promise<ThreadTurnPage> {
    return this.exclusive(scope, signal, async () => {
      await this.logs.flush(scope, AGENT_WIRE_RECORD_KEY);
      signal?.throwIfAborted();
      const generation = await this.logs.generation(scope, AGENT_WIRE_RECORD_KEY);
      const pinned = await openPinnedLogicalRead(this.storage, scope, AGENT_WIRE_RECORD_KEY);
      try {
        const size = pinned.size ?? 0;
        const mtime = await this.storage.mtime(scope, AGENT_WIRE_RECORD_KEY);
        const collection = collectionOf(scope);
        let head = await this.query.get<Head>(collection, 'head', signal);
        if (head !== undefined && (head.version !== 2 || head.generation !== generation || size < head.offset ||
          size === head.size && mtime !== head.mtime || await proof(pinned, head.offset, signal) !== head.boundary)) {
          await this.query.dropCollection(collection);
          head = undefined;
        }
        const expectedHead = head;
        head ??= { kind: 'head', version: 2, generation, epoch: randomUUID(), offset: 0, covered: 0, size, mtime, boundary: '', nextTurnId: 0, cancelled: [], pending: [] };
        const selected = source ?? { generation, epoch: head.epoch, watermark: size, proof: await proof(pinned, size, signal) };
        await this.validate(scope, pinned, head, selected, signal);
        const tailKey = `tail:${selected.watermark}`;
        const tail = head.covered < selected.watermark ? await this.query.get<TailPreparation>(collection, tailKey, signal) : undefined;
        const useTail = head.covered < selected.watermark && tail?.fallback !== true;
        if (useTail) {
          const prepared = await this.prepareTail(scope, pinned, head, expectedHead, selected, before, limit, tail, mtime, signal);
          if (!prepared.ready) return { turns: [], source: { ...selected, prepared: prepared.offset }, preparing: true, hasMore: true };
        }
        if (!useTail && head.covered < selected.watermark) {
          const operations = new Map<string, WriteOp>();
          const next = structuredClone(head);
          const startedAt = Date.now();
          let records = 0;
          let consumed = 0;
          let yielded = 0;
          for await (const line of lines(pinned, next.offset, selected.watermark, signal)) {
            const record = parse(line.bytes, scope, line.start);
            records++;
            consumed += line.end - line.start;
            if (record !== undefined) this.fold(collection, next, record, line, operations);
            next.offset = line.end;
            if (line.bytes.byteLength > SCAN_BYTES) {
              this.log.warn('Thread history record exceeds preparation byte slice', {
                record_bytes: line.bytes.byteLength, cancellation_check_bytes: 64 * 1024, duration_ms: Date.now() - startedAt,
              });
            }
            if (consumed - yielded >= 64 * 1024 || records % 64 === 0) {
              await yieldToEventLoop(undefined, { signal });
              yielded = consumed;
            }
            if (records >= SCAN_RECORDS || consumed >= SCAN_BYTES) break;
          }
          if (next.offset >= selected.watermark || consumed < SCAN_BYTES && records < SCAN_RECORDS) {
            next.covered = Math.max(next.covered, selected.watermark);
          }
          const scannedAt = Date.now();
          next.size = size;
          next.mtime = mtime;
          next.boundary = await proof(pinned, next.offset, signal);
          await this.validate(scope, pinned, next, selected, signal);
          signal?.throwIfAborted();
          const validatedAt = Date.now();
          const ops: WriteOp[] = [...operations.values(), { kind: 'put', collection, key: 'head', value: next }];
          if (this.query.batchIf !== undefined) {
            if (!await this.query.batchIf([{ collection, key: 'head', value: expectedHead }], ops)) changed();
          } else await this.query.batch(ops);
          head = next;
          const committedAt = Date.now();
          this.log.info('Thread history preparation slice', {
            records_count: records, source_bytes: consumed, source_offset: head.offset,
            source_watermark: selected.watermark, duration_ms: committedAt - startedAt,
            scan_duration_ms: scannedAt - startedAt,
            validation_duration_ms: validatedAt - scannedAt,
            projection_commit_duration_ms: committedAt - validatedAt,
          });
        }
        if (!useTail && head.covered < selected.watermark) {
          return { turns: [], source: { ...selected, prepared: head.offset }, preparing: true, hasMore: true };
        }
        const page = await this.query.pageByColumn<TurnRow>(collection, {
          column: 'turnId', dir: 'desc', bounds: { lt: before },
          filter: { kind: 'turn', terminalEnd: { $lte: selected.watermark } }, limit: limit + 1,
        }, signal);
        const rows = page.items.slice(0, limit).toSorted((left, right) => left.turnId - right.turnId);
        const turns: ThreadTurn[] = [];
        for (const row of rows) {
          signal?.throwIfAborted();
          await this.record(pinned, scope, row.promptStart, row.promptEnd, row.promptDigest, signal);
          await this.record(pinned, scope, row.terminalStart, row.terminalEnd, row.terminalDigest, signal);
          const input = await this.text(scope, row, 'input', 0, row.inputUnits <= INLINE_UNITS ? INLINE_UNITS : PREVIEW_UNITS, signal);
          const output = await this.text(scope, row, 'output', 0, row.outputUnits <= INLINE_UNITS ? INLINE_UNITS : PREVIEW_UNITS, signal);
          const refs = [this.ref(scope, row, 'input', input.length), this.ref(scope, row, 'output', output.length)]
            .filter((value): value is BridgeContentRef => value !== undefined);
          turns.push({
            turnId: row.turnId, startedAt: row.startedAt, endedAt: row.endedAt, reason: row.reason,
            origin: row.origin, peer: row.peer, bridgedPeer: row.bridgedPeer, input, output,
            contentRefs: refs.length === 0 ? undefined : refs,
          });
        }
        await this.validate(scope, pinned, head, selected, signal);
        return { turns, source: selected, preparing: false, hasMore: page.items.length > limit };
      } finally {
        pinned.close();
      }
    });
  }

  content(scope: string, ref: BridgeContentRef, signal?: AbortSignal): Promise<NonNullable<BridgeReadView['segment']>> {
    return this.exclusive(scope, signal, async () => {
      const field = ref.path.length === 1 ? ref.path[0] : undefined;
      if (ref.source.kind !== 'turn' || !/^\d+$/.test(ref.source.id) || ref.kind !== 'text' ||
        !['input', 'output'].includes(String(field)) || ref.direction === 'backward') changed();
      const row = await this.query.get<TurnRow>(collectionOf(scope), `turn:${ref.source.id}`, signal);
      if (row === undefined || this.revision(scope, row) !== ref.revision ||
        ref.total !== (field === 'input' ? row.inputUnits : row.outputUnits) ||
        !Number.isSafeInteger(ref.offset) || ref.offset < 0 || ref.offset >= ref.total) changed();
      if (await this.logs.generation(scope, AGENT_WIRE_RECORD_KEY) !== row.generation) changed();
      const pinned = await openPinnedLogicalRead(this.storage, scope, AGENT_WIRE_RECORD_KEY);
      try {
        if ((pinned.size ?? 0) < row.terminalEnd) changed();
        await this.record(pinned, scope, row.terminalStart, row.terminalEnd, row.terminalDigest, signal);
        const value = await this.text(scope, row, field as 'input' | 'output', ref.offset, SEGMENT_UNITS, signal);
        const next = this.ref(scope, row, field as 'input' | 'output', ref.offset + value.length);
        signal?.throwIfAborted();
        if (await this.logs.generation(scope, AGENT_WIRE_RECORD_KEY) !== row.generation) changed();
        return { ref, value, next, contentRefs: [] };
      } finally {
        pinned.close();
      }
    });
  }

  private async prepareTail(
    scope: string, pinned: PinnedLogicalRead, head: Head, expectedHead: Head | undefined,
    source: ThreadTurnSource, before: number, limit: number, previous: TailPreparation | undefined, mtime: number | undefined, signal?: AbortSignal,
  ): Promise<{ ready: boolean; offset: number }> {
    const collection = collectionOf(scope);
    const key = `tail:${source.watermark}`;
    const tail: TailPreparation = previous === undefined ? {
      kind: 'tail', offset: source.watermark, boundary: source.proof,
      floor: Number.MAX_SAFE_INTEGER, complete: false, fallback: false, group: { ambiguous: false },
    } : structuredClone(previous);
    if (await proof(pinned, tail.offset, signal) !== tail.boundary) changed();
    const page = await this.query.pageByColumn<TurnRow>(collection, {
      column: 'turnId', dir: 'desc', bounds: { lt: before, gte: tail.floor },
      filter: { kind: 'turn', terminalEnd: { $lte: source.watermark } }, limit: limit + 1,
    }, signal);
    let count = page.items.length;
    if (count > limit || tail.complete) return { ready: true, offset: tail.offset };
    const startedAt = Date.now();
    const operations = new Map<string, WriteOp>();
    let consumed = 0;
    let records = 0;
    const available = (): boolean => consumed < SCAN_BYTES && records < SCAN_RECORDS;
    while (available() && count <= limit && !tail.complete && !tail.fallback) {
      if (tail.replay !== undefined) {
        const replay = tail.replay;
        for await (const line of lines(pinned, replay.head.offset, replay.end, signal)) {
          const record = parse(line.bytes, scope, line.start);
          if (record !== undefined) this.fold(collection, replay.head, record, line, operations);
          replay.head.offset = line.end;
          consumed += line.end - line.start;
          records++;
          await yieldToEventLoop(undefined, { signal });
          if (!available()) break;
        }
        if (replay.head.offset < replay.end) break;
        const row = operations.get(`turn:${replay.turnId}`);
        if (row?.kind === 'put' && replay.turnId < before) count++;
        tail.floor = Math.min(tail.floor, replay.turnId);
        tail.replay = undefined;
        if (tail.offset === 0) tail.complete = true;
        continue;
      }
      let progressed = false;
      for await (const line of reverseLines(pinned, tail.offset, signal)) {
        progressed = true;
        tail.offset = line.start;
        consumed += line.end - line.start;
        records++;
        const record = parse(line.bytes, scope, line.start);
        if (record?.type === 'turn.ended') {
          const id = number(record['turnId']);
          if (id !== undefined && ['completed', 'cancelled', 'failed', 'blocked'].includes(String(record['reason']))) {
            if (tail.group.terminal !== undefined && tail.group.terminal !== id) tail.group.ambiguous = true;
            tail.group.terminal = id;
            tail.group.end = line.end;
          }
        } else if (record?.type === 'context.append_loop_event') {
          const event = record['event'] as LoopRecordedEvent | undefined;
          const id = event?.type === 'tool.result' || event?.turnId === undefined ? undefined : Number.parseInt(event.turnId, 10);
          if (id !== undefined && Number.isSafeInteger(id)) {
            if (tail.group.eventTurn !== undefined && tail.group.eventTurn !== id) tail.group.ambiguous = true;
            tail.group.eventTurn = id;
          }
        } else if (record?.type === 'turn.prompt') {
          const group = tail.group;
          const id = group.terminal;
          tail.group = { ambiguous: false };
          if (group.ambiguous || number(record['turnId']) === undefined || id !== undefined && (
            group.eventTurn !== undefined && group.eventTurn !== id || number(record['turnId']) !== id || id >= tail.floor)) {
            tail.fallback = true;
          } else if (id !== undefined) {
            const existing = await this.query.get<TurnRow>(collection, `turn:${id}`, signal);
            if (existing !== undefined && (existing.promptStart !== line.start || existing.terminalEnd !== group.end)) {
              tail.fallback = true;
              break;
            }
            const origin = record['origin'] as PromptOrigin | undefined;
            if (origin !== undefined && origin !== null && publicOrigin(origin) !== undefined) {
              tail.replay = {
                head: { ...head, offset: line.start, nextTurnId: id, cancelled: [], pending: [] },
                end: group.end!, turnId: id,
              };
            } else tail.floor = id;
          } else if (tail.floor < Number.MAX_SAFE_INTEGER) tail.fallback = true;
          break;
        }
        if (!available()) break;
      }
      if ((!progressed || tail.offset === 0) && tail.replay === undefined) {
        if (tail.group.terminal !== undefined) tail.fallback = true;
        else tail.complete = true;
      }
    }
    const scannedAt = Date.now();
    tail.boundary = await proof(pinned, tail.offset, signal);
    const tails = [source.watermark, ...(head.tails ?? []).filter((value) => value !== source.watermark)];
    const nextHead = { ...head, size: pinned.size ?? 0, mtime, tails: tails.slice(0, 4) };
    await this.validate(scope, pinned, head, source, signal);
    signal?.throwIfAborted();
    const validatedAt = Date.now();
    const ops: WriteOp[] = [...operations.values()];
    ops.push(...tails.slice(4).map((value): WriteOp => ({ kind: 'delete', collection, key: `tail:${value}` })),
      { kind: 'put', collection, key, value: tail }, { kind: 'put', collection, key: 'head', value: nextHead });
    if (this.query.batchIf !== undefined) {
      if (!await this.query.batchIf([{ collection, key: 'head', value: expectedHead }, { collection, key, value: previous }], ops)) changed();
    } else await this.query.batch(ops);
    const committedAt = Date.now();
    this.log.info('Thread history tail preparation slice', {
      records_count: records, source_bytes: consumed, source_offset: tail.offset, source_watermark: source.watermark,
      duration_ms: committedAt - startedAt, scan_duration_ms: scannedAt - startedAt,
      validation_duration_ms: validatedAt - scannedAt, projection_commit_duration_ms: committedAt - validatedAt,
    });
    return { ready: !tail.fallback && (count > limit || tail.complete), offset: tail.offset };
  }

  private async validate(scope: string, pinned: PinnedLogicalRead, head: Head, source: ThreadTurnSource, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (source.epoch !== head.epoch || source.generation !== head.generation ||
      !Number.isSafeInteger(source.watermark) || source.watermark < 0 || source.watermark > (pinned.size ?? 0) ||
      await this.logs.generation(scope, AGENT_WIRE_RECORD_KEY) !== source.generation ||
      await proof(pinned, source.watermark, signal) !== source.proof) changed();
  }

  private fold(collection: string, head: Head, record: WireRecord, line: Line, operations: Map<string, WriteOp>): void {
    const cancelled = new Set(head.cancelled);
    const advance = (id: number): number => {
      for (const value of cancelled) if (value < id) cancelled.delete(value);
      while (cancelled.delete(id)) id++;
      return id;
    };
    if (record.type === 'turn.cancel') {
      const id = number(record['turnId']);
      if (id !== undefined && ['active', 'queued'].includes(String(record['target'])) && id >= head.nextTurnId) {
        cancelled.add(id);
        head.nextTurnId = advance(head.nextTurnId);
      }
      head.cancelled = [...cancelled];
      return;
    }
    if (record.type === 'turn.prompt') {
      const origin = record['origin'];
      if (origin !== null && typeof origin === 'object') {
        const text = contentText(record['input']);
        const turn: PendingTurn = {
          turnId: number(record['turnId']) ?? head.nextTurnId, origin: origin as PromptOrigin, startedAt: number(record['time']),
          promptStart: line.start, promptEnd: line.end, promptDigest: digest(line.bytes),
          inputUnits: text.length, outputUnits: 0, outputTail: '',
        };
        head.pending.push(turn);
        textOps(collection, turn.turnId, 'input', 0, text, operations);
      }
      head.nextTurnId = advance(Math.max(head.nextTurnId, number(record['turnId']) ?? head.nextTurnId) + 1);
      head.cancelled = [...cancelled];
      return;
    }
    if (record.type === 'context.append_loop_event') {
      const event = record['event'] as LoopRecordedEvent | undefined;
      const id = event?.type === 'tool.result' || event?.turnId === undefined ? undefined : Number.parseInt(event.turnId, 10);
      if (id !== undefined && Number.isInteger(id) && id >= head.nextTurnId) head.nextTurnId = advance(id + 1);
      head.cancelled = [...cancelled];
      if (event?.type !== 'content.part' || event.part.type !== 'text') return;
      const turn = head.pending.find((item) => item.turnId === id);
      if (turn !== undefined && event.part.text.length > 0) {
        const text = turn.outputTail + event.part.text;
        textOps(collection, turn.turnId, 'output', turn.outputUnits - turn.outputTail.length, text, operations);
        turn.outputUnits += event.part.text.length;
        turn.outputTail = text.slice(text.length - turn.outputUnits % SEGMENT_UNITS);
      }
      return;
    }
    if (record.type !== 'turn.ended') return;
    const id = number(record['turnId']);
    const reason = record['reason'];
    if (id === undefined || !['completed', 'cancelled', 'failed', 'blocked'].includes(String(reason))) return;
    const index = head.pending.findIndex((item) => item.turnId === id);
    if (index < 0) return;
    const [pending] = head.pending.splice(index, 1);
    const { outputTail: _, ...turn } = pending!;
    const origin = publicOrigin(turn.origin);
    if (origin === undefined) return;
    const row: TurnRow = {
      ...turn, ...origin, kind: 'turn', generation: head.generation, epoch: head.epoch,
      terminalStart: line.start, terminalEnd: line.end, terminalDigest: digest(line.bytes),
      endedAt: number(record['time']) ?? turn.startedAt ?? 0, reason: reason as ThreadTurn['reason'],
    };
    const key = `turn:${id}`;
    operations.set(key, { kind: 'put', collection, key, value: row, columns: { turnId: id } });
  }

  private async record(pinned: PinnedLogicalRead, scope: string, start: number, end: number, expected: string, signal?: AbortSignal): Promise<WireRecord> {
    const bytes = await readPinnedRange(pinned, start, end - start, signal);
    if (bytes.byteLength !== end - start || digest(bytes) !== expected) changed();
    return parse(bytes, scope, start) ?? changed();
  }

  private async text(scope: string, turn: TurnRow, field: 'input' | 'output', offset: number, limit: number, signal?: AbortSignal): Promise<string> {
    const total = field === 'input' ? turn.inputUnits : turn.outputUnits;
    if (offset >= total) return '';
    const output: string[] = [];
    let position = offset;
    while (position < total && position - offset < limit) {
      signal?.throwIfAborted();
      const start = Math.floor(position / SEGMENT_UNITS) * SEGMENT_UNITS;
      const chunk = await this.query.get<TextRow>(collectionOf(scope), `text:${turn.turnId}:${field}:${start}`, signal);
      if (chunk === undefined || typeof chunk.text !== 'string' || chunk.text.length !== Math.min(SEGMENT_UNITS, total - start)) changed();
      const end = Math.min(chunk.text.length, position - start + limit - (position - offset));
      const selected = chunk.text.slice(position - start, end);
      if (selected.length === 0) changed();
      output.push(selected);
      position += selected.length;
    }
    const text = output.join('');
    return position < total && /[\uD800-\uDBFF]$/u.test(text) ? text.slice(0, -1) : text;
  }

  private revision(scope: string, turn: TurnRow): string {
    return digest(Buffer.from(JSON.stringify([scope, turn.generation, turn.epoch, turn.promptStart, turn.terminalEnd, turn.terminalDigest])));
  }

  private ref(scope: string, turn: TurnRow, field: 'input' | 'output', offset: number): BridgeContentRef | undefined {
    const total = field === 'input' ? turn.inputUnits : turn.outputUnits;
    return offset >= total ? undefined : {
      source: { kind: 'turn', id: String(turn.turnId), turnId: String(turn.turnId) },
      kind: 'text', path: [field], revision: this.revision(scope, turn), offset, total,
    };
  }

  private exclusive<T>(scope: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(scope) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      const run = async (): Promise<T> => { signal?.throwIfAborted(); return operation(); };
      return this.query.batchIf !== undefined && this.query.withExclusive !== undefined ? this.query.withExclusive(run, collectionOf(scope)) : run();
    });
    this.operations.set(scope, current);
    void current.finally(() => {
      if (this.operations.get(scope) === current) this.operations.delete(scope);
    }).catch(() => {});
    return signal === undefined ? current : abortable(current, signal);
  }
}

interface Line { readonly start: number; readonly end: number; readonly bytes: Uint8Array }

async function* reverseLines(pinned: PinnedLogicalRead, end: number, signal?: AbortSignal): AsyncIterable<Line> {
  let position = end;
  let lineEnd = end;
  let parts: Uint8Array[] = [];
  const complete = (bytes: Uint8Array): boolean => {
    if (lineEnd !== end || bytes.at(-1) === 10) return true;
    try { JSON.parse(Buffer.from(bytes).toString('utf8')); return true; } catch { return false; }
  };
  while (position > 0) {
    const start = Math.max(0, position - 64 * 1024);
    const chunk = await readPinnedRange(pinned, start, position - start, signal);
    if (chunk.byteLength !== position - start) changed();
    let to = chunk.byteLength;
    for (let index = chunk.byteLength - 1; index >= 0; index--) {
      if (chunk[index] !== 10 || start + index + 1 === lineEnd) continue;
      const from = start + index + 1;
      const bytes = Buffer.concat([chunk.subarray(index + 1, to), ...parts.toReversed()]);
      if (complete(bytes)) yield { start: from, end: lineEnd, bytes };
      lineEnd = from;
      parts = [];
      to = index + 1;
    }
    if (to > 0) parts.push(chunk.subarray(0, to));
    position = start;
    await yieldToEventLoop(undefined, { signal });
  }
  if (parts.length > 0) {
    const bytes = Buffer.concat(parts.toReversed());
    if (complete(bytes)) yield { start: 0, end: lineEnd, bytes };
  }
}

async function* lines(pinned: PinnedLogicalRead, start: number, end: number, signal?: AbortSignal): AsyncIterable<Line> {
  if (start >= end) return;
  let offset = start;
  let parts: Uint8Array[] = [];
  for await (const chunk of pinned.read({ start, end: end - 1 }, { chunkBytes: 64 * 1024, signal })) {
    signal?.throwIfAborted();
    let from = 0;
    for (let index = 0; index < chunk.byteLength; index++) {
      if (chunk[index] !== 10) continue;
      parts.push(chunk.subarray(from, index + 1));
      const bytes = Buffer.concat(parts);
      yield { start: offset, end: offset + bytes.byteLength, bytes };
      offset += bytes.byteLength;
      parts = [];
      from = index + 1;
    }
    if (from < chunk.byteLength) parts.push(chunk.subarray(from));
    await yieldToEventLoop(undefined, { signal });
  }
  if (parts.length > 0) {
    const bytes = Buffer.concat(parts);
    try { JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { return; }
    yield { start: offset, end: offset + bytes.byteLength, bytes };
  }
}

function parse(bytes: Uint8Array, scope: string, offset: number): WireRecord | undefined {
  const text = Buffer.from(bytes).toString('utf8').trim();
  if (text.length === 0) return undefined;
  try { return JSON.parse(text) as WireRecord; } catch (error) {
    throw new AppendLogCorruptedError(scope, AGENT_WIRE_RECORD_KEY, offset, error);
  }
}

async function proof(pinned: PinnedLogicalRead, end: number, signal?: AbortSignal): Promise<string> {
  if (end === 0) return '';
  const start = Math.max(0, end - 64);
  return Buffer.from(await readPinnedRange(pinned, start, end - start, signal)).toString('hex');
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function collectionOf(scope: string): string { return `thread-turns-v1:${Buffer.from(scope).toString('base64url')}`; }
function changed(): never { throw new Error2(ErrorCodes.THREAD_CURSOR_INVALID, 'Thread history changed; restart from the first page.'); }
function contentText(value: unknown): string {
  return Array.isArray(value) ? value.filter((part) => part !== null && typeof part === 'object' && part.type === 'text').map((part) => part.text).join('') : '';
}

function textOps(collection: string, turnId: number, field: string, offset: number, text: string, operations: Map<string, WriteOp>): void {
  for (let start = 0; start < text.length; start += SEGMENT_UNITS) {
    const key = `text:${turnId}:${field}:${offset + start}`;
    operations.set(key, { kind: 'put', collection, key, value: { kind: 'text', text: text.slice(start, start + SEGMENT_UNITS) } satisfies TextRow });
  }
}

function publicOrigin(origin: PromptOrigin): Pick<ThreadTurn, 'origin' | 'peer' | 'bridgedPeer'> | undefined {
  if (origin.kind === 'bridged_peer') return { origin: 'bridged_peer', bridgedPeer: origin };
  if (origin.kind === 'peer_thread') return { origin: 'peer', peer: { source: origin.source, messageId: origin.messageId } };
  if (origin.kind === 'user') return { origin: 'user' };
  if (origin.kind === 'external_thread') return { origin: 'external' };
  if (origin.kind === 'merged') return { origin: 'mixed' };
  if (origin.kind === 'unknown') return { origin: 'unknown' };
  if (origin.kind === 'system_trigger' && origin.name === 'thread_create') return { origin: 'thread_created' };
  if ((origin.kind === 'skill_activation' || origin.kind === 'plugin_command') && origin.trigger === 'user-slash') return { origin: 'user' };
  return undefined;
}

registerScopedService(LifecycleScope.App, IThreadTurnStore, ThreadTurnStore, ScopeActivation.OnDemand, 'threadCommunication');
