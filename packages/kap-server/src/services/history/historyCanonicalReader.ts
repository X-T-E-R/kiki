import { open, stat, type FileHandle } from 'node:fs/promises';

import { openLogicalWire, readLogicalInto, type LogicalWire } from './logicalWireRead';

import { AgentTranscriptDraft, TranscriptFactReducer, TranscriptWireAdapter,
  type AgentTranscriptSnapshot, type ContentSource, type ToolCallFrame, type TranscriptFrame, type TranscriptTurn } from '@kiki/transcript';
import type { HistoryNavManifest, HistoryNavigationDb, LazyHistoryNavigationDb } from './historyNavigationDb';
import { historyNavigationProof, matchesNavigationProof, type HistoryNavigationProof } from './historyNavigationProof';
import { hashHistoryRecord } from './historySource';
import type { HistoryNavScan } from './historyLocatorStore';
import type { TranscriptService } from '../transcript/transcriptService';

async function readAddressedBytes(
  logical: LogicalWire | undefined,
  handle: FileHandle | undefined,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<number> {
  if (logical !== undefined) return readLogicalInto(logical, buffer, offset, length, position);
  return (await handle!.read(buffer, offset, length, position)).bytesRead;
}

const CACHE_BYTES = 4 << 20;
const CACHE_ENTRIES = 32;
const TARGET_BYTES = 64 << 20;
const TARGET_RECORDS = 100_000;
const OVERSIZED_CACHE_IDLE_MS = 30_000;

export type CanonicalToolLookup = { readonly status: 'found'; readonly turnId: string;
  readonly stepId: string; readonly frame: ToolCallFrame } |
  { readonly status: 'preparing' | 'not_found' };
export type CanonicalEntityLookup = { readonly status: 'found'; readonly entity: object } |
  { readonly status: 'preparing' | 'not_found' };

/** A source-backed detail read is not yet covered by the navigation watermark. */
export class CanonicalEntityPreparingError extends Error {
  constructor() { super('history_canonical_preparing'); this.name = 'CanonicalEntityPreparingError'; }
}

interface Prepared {
  readonly db: HistoryNavigationDb;
  readonly scope: string;
  readonly wirePath: string;
  readonly manifest: HistoryNavManifest;
}
interface SourceContext {
  readonly scope: string;
  readonly wirePath: string;
}
interface CacheEntry { readonly fingerprint: string; readonly entity: TranscriptTurn | TranscriptFrame; readonly bytes: number }
interface PreparationFlight {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

function sourceFingerprint(manifest: HistoryNavManifest): string {
  return JSON.stringify([manifest.generation, manifest.incarnation, manifest.offset, manifest.source]);
}

function directSourceFingerprint(proof: HistoryNavigationProof): string {
  return JSON.stringify(['wire', proof.identity, proof.size, proof.mtimeNs, proof.ctimeNs, proof.head, proof.tail]);
}

function directCacheKey(scope: string, turnId: string): string {
  return `${scope}\0direct\0${turnId}`;
}

interface Flight {
  readonly controller: AbortController;
  readonly promise: Promise<TranscriptTurn | undefined>;
  waiters: number;
  settled: boolean;
}

/** Replays only source spans belonging to a requested turn; SQLite stores no canonical body blobs. */
export class HistoryCanonicalReader {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly flights = new Map<string, Flight>();
  private readonly preparationFlights = new Map<string, PreparationFlight>();
  private cacheBytes = 0;
  private oversizedCacheKey?: string;
  private oversizedExpiresAt = 0;
  private oversizedTimer?: ReturnType<typeof setTimeout>;
  private replayBytes = 0;
  private replayRecords = 0;
  private replays = 0;
  private cacheHits = 0;
  private projectionBytes = 0;
  private projectionRecords = 0;
  private preparationsCompleted = 0;
  private preparationsFailed = 0;
  private preparationsCancelled = 0;
  private readonly projectedScans = new WeakSet<HistoryNavScan>();

  constructor(private readonly database: LazyHistoryNavigationDb, private readonly transcript: TranscriptService,
    private readonly scan: (session: string, agent: string, signal?: AbortSignal) => Promise<HistoryNavScan | undefined>) {}

  private generation = 0;

  invalidate(): void {
    this.generation += 1;
    for (const flight of this.flights.values()) flight.controller.abort();
    this.flights.clear();
    for (const flight of this.preparationFlights.values()) flight.controller.abort();
    this.preparationFlights.clear();
    if (this.oversizedCacheKey !== undefined) this.deleteCached(this.oversizedCacheKey);
    this.cache.clear();
    this.cacheBytes = 0;
  }

  report() {
    this.expireOversized();
    const oversizedCacheBytes = this.oversizedCacheKey === undefined ? 0 : this.cache.get(this.oversizedCacheKey)?.bytes ?? 0;
    return { cacheBytes: this.cacheBytes, cacheEntries: this.cache.size, oversizedCacheBytes,
      oversizedCacheEntries: oversizedCacheBytes === 0 ? 0 : 1,
      cacheBudgetBytes: CACHE_BYTES + this.transcript.detailCacheBudgetBytes(), replayBytes: this.replayBytes,
      replayRecords: this.replayRecords, replays: this.replays, cacheHits: this.cacheHits,
      projectionBytes: this.projectionBytes, projectionRecords: this.projectionRecords,
      preparationsActive: this.preparationFlights.size, preparationsCompleted: this.preparationsCompleted,
      preparationsFailed: this.preparationsFailed, preparationsCancelled: this.preparationsCancelled };
  }

  async lookupToolCall(session: string, agent: string, callId: string, signal?: AbortSignal): Promise<CanonicalToolLookup> {
    const prepared = await this.prepare(session, agent, signal);
    if (prepared === undefined) return { status: 'preparing' };
    const tool = prepared.db.scalarState(prepared.scope).tools.get(callId);
    if (tool === undefined) {
      if (prepared.db.hasUnlocatedCanonicalCall(prepared.scope, callId)) throw new Error('history_canonical_locator_incomplete');
      return { status: 'not_found' };
    }
    const frame = await this.readFrame(prepared, agent, tool.turnId, tool.stepId, tool.frameId, signal);
    if (frame?.kind !== 'tool') throw new Error('history_canonical_locator_incomplete');
    return { status: 'found', turnId: tool.turnId, stepId: tool.stepId, frame };
  }

  async readTurnHeader(session: string, agent: string, turnId: string, signal?: AbortSignal): Promise<
    { status: 'found'; turn: TranscriptTurn; attachments: ReturnType<AgentTranscriptDraft['snapshot']>['attachments'] } |
    { status: 'preparing' | 'not_found' }> {
    const generation = this.generation;
    const context = await this.sourceContext(session, agent, signal);
    const db = await this.database.ready();
    const manifest = db.readManifest(context.scope);
    if (manifest === undefined || !db.hasCanonicalSources(context.scope)) return { status: 'preparing' };
    const seed = db.canonicalSeed(context.scope, turnId);
    if (seed === undefined) return { status: manifest.complete ? 'not_found' : 'preparing' };
    const spans = db.canonicalSources(context.scope, turnId, -1, 32);
    const draft = new AgentTranscriptDraft(agent);
    const reducer = new TranscriptFactReducer(draft);
    const adapter = new TranscriptWireAdapter(agent);
    adapter.restore({ ...adapter.checkpoint(), legacyTurnOrdinal: seed.legacyTurn, recordOrdinal: seed.ordinal });
    let logical: LogicalWire | undefined;
    let handle: FileHandle | undefined;
    const releaseRead = async (): Promise<void> => {
      const currentLogical = logical;
      const currentHandle = handle;
      logical = undefined;
      handle = undefined;
      currentLogical?.close();
      if (currentHandle !== undefined) await currentHandle.close();
    };
    let bytesRead = 0;
    try {
      logical = await openLogicalWire(context.wirePath);
      handle = logical === undefined ? await open(context.wirePath, 'r') : undefined;
      for (const span of spans) {
        signal?.throwIfAborted();
        const size = span.end - span.start;
        if (!Number.isSafeInteger(size) || size <= 0) throw new Error('history_canonical_invalid_span');
        if (bytesRead + size > (1 << 20)) return { status: 'preparing' };
        const bytes = Buffer.allocUnsafe(size);
        let offset = 0;
        while (offset < size) {
          signal?.throwIfAborted();
          const readCount = await readAddressedBytes(logical, handle, bytes, offset, size - offset, span.start + offset);
          if (readCount === 0) throw new Error('history_source_changed');
          offset += readCount;
          bytesRead += readCount;
          this.replayBytes += readCount;
        }
        if (hashHistoryRecord(bytes) !== span.digest) throw new Error('history_source_changed');
        adapter.restore({ ...adapter.checkpoint(), recordOrdinal: span.ordinal });
        reducer.apply(adapter.add(JSON.parse(bytes.toString('utf8'))));
        this.replayRecords += 1;
        const turn = draft.getTurn(turnId);
        if (turn !== undefined && (turn.prompt !== undefined || (turn.attachmentIds?.length ?? 0) > 0)) {
          await releaseRead();
          signal?.throwIfAborted();
          const proof = await historyNavigationProof(context.wirePath, manifest.offset);
          signal?.throwIfAborted();
          if (generation !== this.generation || !matchesNavigationProof(manifest.source, proof) ||
            db.readManifest(context.scope)?.generation !== manifest.generation || db.readManifest(context.scope)?.offset !== manifest.offset) throw new Error('history_source_changed');
          return { status: 'found', turn: { ...turn, steps: [] }, attachments: draft.snapshot().attachments };
        }
      }
      return { status: manifest.complete && spans.length < 32 ? 'not_found' : 'preparing' };
    } finally {
      await releaseRead();
    }
  }

  async readEntity(session: string, agent: string, source: ContentSource, signal?: AbortSignal): Promise<CanonicalEntityLookup> {
    if (source.kind !== 'turn' && source.kind !== 'frame') throw new Error('history_canonical_unsupported_source');
    const turnId = source.kind === 'turn' ? source.id : source.turnId;
    if (turnId === undefined) throw new Error('history_canonical_turn_required');
    if (signal !== undefined) {
      const cached = await this.readDirectCached(session, agent, source, signal);
      if (cached !== undefined) return { status: 'found', entity: cached };
    }
    const retained = await this.transcript.readRetainedColdTurn(session, agent, turnId, signal);
    if (retained !== undefined) {
      const entity = source.kind === 'turn' ? retained : retained.steps.find((step) => step.stepId === source.stepId)
        ?.frames.find((frame) => frame.frameId === source.id);
      if (entity !== undefined) return { status: 'found', entity };
    }
    const prepared = await this.prepare(session, agent, signal);
    if (prepared === undefined) {
      if (signal === undefined) return { status: 'preparing' };
      const entity = await this.readColdEntity(session, agent, source, signal);
      return entity === undefined ? { status: 'not_found' } : { status: 'found', entity };
    }
    const entity = source.kind === 'turn' ? await this.readTurn(prepared, agent, turnId, signal, true) :
      await this.readFrame(prepared, agent, turnId, source.stepId, source.id, signal);
    return entity === undefined ? { status: 'not_found' } : { status: 'found', entity };
  }

  async readDurableTurn(session: string, agent: string, turnId: string, signal: AbortSignal): Promise<
    { status: 'found'; snapshot: AgentTranscriptSnapshot } | { status: 'preparing' | 'not_found' | 'over_budget' }> {
    const input = await this.transcript.scheduleHistoryRead(signal, owned => this.prepare(session, agent, owned));
    if (input === undefined) return { status: 'preparing' };
    if (input.db.canonicalSeed(input.scope, turnId) === undefined) return { status: 'not_found' };
    const snapshot = await this.transcript.scheduleHistoryRead(signal, owned => this.replaySnapshot(input, agent, turnId, owned, 8 << 20));
    return snapshot === undefined ? { status: 'over_budget' } : { status: 'found', snapshot };
  }

  private async prepare(session: string, agent: string, signal?: AbortSignal): Promise<Prepared | undefined> {
    const generation = this.generation;
    signal?.throwIfAborted();
    const location = await this.transcript.historyWireLocation(session, agent);
    if (location === undefined) throw new Error('history_canonical_source_missing');
    const db = await this.database.ready();
    const scope = `${location.workspaceId}\0${session}\0${agent}`;
    this.expireOversized();
    const retained = db.readManifest(scope);
    if (retained?.complete && [...this.cache].some(([key, entry]) =>
      key.startsWith(`${scope}\0`) && entry.fingerprint === sourceFingerprint(retained))) {
      const proof = await historyNavigationProof(location.wirePath, retained.offset).catch((error: unknown) => {
        if (error instanceof Error && error.message === 'history_source_changed') return undefined;
        throw error;
      });
      signal?.throwIfAborted();
      if (generation !== this.generation) throw new DOMException('Detail scope changed', 'AbortError');
      const current = db.readManifest(scope);
      if (proof !== undefined && retained.offset === proof.size && matchesNavigationProof(retained.source, proof) &&
          current !== undefined && sourceFingerprint(current) === sourceFingerprint(retained) && db.hasCanonicalSources(scope)) {
        return { db, scope, wirePath: location.wirePath, manifest: retained };
      }
    }
    const scan = await this.scan(session, agent, signal);
    signal?.throwIfAborted();
    if (generation !== this.generation) throw new DOMException('Detail scope changed', 'AbortError');
    if (scan === undefined) throw new Error('history_canonical_source_missing');
    this.recordProjection(scan);
    if (!scan.complete) {
      if (scan.recordsRead === 0) throw new Error(`history_canonical_source_no_progress:${scan.incompleteReason ?? 'unknown'}`);
      if (scan.incompleteReason !== 'byte_budget' && scan.incompleteReason !== 'record_budget') {
        throw new Error(`history_canonical_source_incomplete:${scan.incompleteReason ?? 'unknown'}`);
      }
      return undefined;
    }
    const manifest = db.readManifest(scope);
    if (manifest === undefined || !db.hasCanonicalSources(scope)) throw new Error('history_canonical_locator_incomplete');
    const proof = await historyNavigationProof(location.wirePath, manifest.offset);
    signal?.throwIfAborted();
    if (!manifest.complete || !matchesNavigationProof(manifest.source, proof)) {
      throw new Error('history_source_changed');
    }
    if (generation !== this.generation) throw new DOMException('Detail scope changed', 'AbortError');
    return { db, scope, wirePath: location.wirePath, manifest };
  }

  private recordProjection(scan: HistoryNavScan): void {
    if (this.projectedScans.has(scan)) return;
    this.projectedScans.add(scan);
    this.projectionBytes += scan.bytesRead;
    this.projectionRecords += scan.recordsRead;
  }

  private async sourceContext(session: string, agent: string, signal?: AbortSignal): Promise<SourceContext> {
    signal?.throwIfAborted();
    const location = await this.transcript.historyWireLocation(session, agent);
    if (location === undefined) throw new Error('history_canonical_source_missing');
    return { scope: `${location.workspaceId}\0${session}\0${agent}`, wirePath: location.wirePath };
  }

  private async fullWireProof(wirePath: string, signal?: AbortSignal): Promise<HistoryNavigationProof> {
    const info = await stat(wirePath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('history_canonical_source_missing');
      throw error;
    });
    if (!Number.isSafeInteger(info.size) || info.size < 0) throw new Error('history_source_changed');
    const proof = await historyNavigationProof(wirePath, info.size);
    signal?.throwIfAborted();
    return proof;
  }

  private async readDirectCached(session: string, agent: string, source: ContentSource,
    signal: AbortSignal): Promise<TranscriptTurn | TranscriptFrame | undefined> {
    const turnId = source.kind === 'turn' ? source.id : source.turnId;
    if (turnId === undefined) return undefined;
    const context = await this.sourceContext(session, agent, signal);
    const key = directCacheKey(context.scope, turnId);
    if (!this.cache.has(key)) return undefined;
    let proof: HistoryNavigationProof;
    try { proof = await this.fullWireProof(context.wirePath, signal); }
    catch (error) {
      if (error instanceof Error && error.message === 'history_source_changed') {
        this.deleteCached(key);
        return undefined;
      }
      throw error;
    }
    const cached = this.getCached(key, directSourceFingerprint(proof));
    if (cached?.entity.kind !== 'turn') return undefined;
    if (source.kind === 'turn') return cached.entity;
    return cached.entity.steps.find((step) => step.stepId === source.stepId)?.frames.find((frame) => frame.frameId === source.id);
  }

  private async readColdEntity(session: string, agent: string, source: ContentSource,
    signal: AbortSignal): Promise<TranscriptTurn | TranscriptFrame | undefined> {
    const turnId = source.kind === 'turn' ? source.id : source.turnId;
    if (turnId === undefined) return undefined;
    const generation = this.generation;
    const context = await this.sourceContext(session, agent, signal);
    const before = await this.fullWireProof(context.wirePath, signal);
    const retained = await this.transcript.readRetainedColdTurn(session, agent, turnId, signal);
    if (retained !== undefined) {
      const proof = await historyNavigationProof(context.wirePath, before.size);
      signal.throwIfAborted();
      if (generation !== this.generation) throw new DOMException('Detail scope changed', 'AbortError');
      if (!matchesNavigationProof(before, proof)) throw new Error('history_source_changed');
      const entity = source.kind === 'turn' ? retained : retained.steps.find((step) => step.stepId === source.stepId)
        ?.frames.find((frame) => frame.frameId === source.id);
      if (entity !== undefined) {
        this.admit(directCacheKey(context.scope, turnId), directSourceFingerprint(before), retained, true);
        return entity;
      }
    }
    const snapshotTurn = await this.transcript.readProjectedColdTurn(session, agent, turnId, signal);
    if (snapshotTurn !== undefined) {
      const proof = await historyNavigationProof(context.wirePath, before.size);
      signal.throwIfAborted();
      if (generation !== this.generation) throw new DOMException('Detail scope changed', 'AbortError');
      if (!matchesNavigationProof(before, proof)) throw new Error('history_source_changed');
      const entity = source.kind === 'turn' ? snapshotTurn : snapshotTurn.steps.find((step) => step.stepId === source.stepId)
        ?.frames.find((frame) => frame.frameId === source.id);
      if (entity !== undefined) {
        this.admit(directCacheKey(context.scope, turnId), directSourceFingerprint(before), snapshotTurn, true);
        return entity;
      }
    }
    return undefined;
  }

  private async readFrame(input: Prepared, agent: string, turnId: string, stepId: string | undefined,
    frameId: string, signal?: AbortSignal): Promise<TranscriptFrame | undefined> {
    signal?.throwIfAborted();
    const fingerprint = sourceFingerprint(input.manifest);
    const key = `${input.scope}\0${turnId}\0${stepId ?? ''}\0${frameId}`;
    const cached = this.getCached(key, fingerprint);
    if (cached !== undefined && cached.entity.kind !== 'turn') return cached.entity;
    const generation = this.generation;
    const turn = await this.readTurn(input, agent, turnId, signal);
    signal?.throwIfAborted();
    if (generation !== this.generation) throw new DOMException('Detail scope changed', 'AbortError');
    const current = input.db.readManifest(input.scope);
    if (current?.generation !== input.manifest.generation || current.offset !== input.manifest.offset) throw new Error('history_source_changed');
    const frame = turn?.steps.find((step) => step.stepId === stepId)?.frames.find((value) => value.frameId === frameId);
    if (frame !== undefined && !this.cache.has(`${input.scope}\0${turnId}`)) this.admit(key, fingerprint, frame, true);
    return frame;
  }

  private async readTurn(input: Prepared, agent: string, turnId: string, signal?: AbortSignal,
    allowOversized = false): Promise<TranscriptTurn | undefined> {
    const generation = this.generation;
    signal?.throwIfAborted();
    const { scope, manifest } = input;
    const fingerprint = sourceFingerprint(manifest);
    const key = `${scope}\0${turnId}`;
    const cached = this.getCached(key, fingerprint);
    if (cached !== undefined && cached.entity.kind === 'turn') return cached.entity;
    const flightKey = `${key}\0${fingerprint}`;
    let flight = this.flights.get(flightKey);
    if (flight === undefined || flight.controller.signal.aborted) {
      const controller = new AbortController();
      const promise = this.transcript.scheduleHistoryRead(controller.signal, signal => this.replay(input, agent, turnId, signal)).then((turn) => {
        controller.signal.throwIfAborted();
        if (turn !== undefined && input.db.readManifest(scope)?.generation === manifest.generation &&
            input.db.readManifest(scope)?.offset === manifest.offset) this.admit(key, fingerprint, turn);
        return turn;
      });
      flight = { controller, promise, waiters: 0, settled: false };
      this.flights.set(flightKey, flight);
      const own = flight;
      void promise.finally(() => { own.settled = true;
        if (this.flights.get(flightKey) === own) this.flights.delete(flightKey);
      }).catch(() => undefined);
    }
    const turn = await this.wait(flight, signal);
    signal?.throwIfAborted();
    if (generation !== this.generation) throw new DOMException('Detail scope changed', 'AbortError');
    if (allowOversized && turn !== undefined) {
      const current = input.db.readManifest(scope);
      if (current?.generation !== manifest.generation || current.offset !== manifest.offset) throw new Error('history_source_changed');
      if (!this.cache.has(key)) this.admit(key, fingerprint, turn, true);
    }
    return turn;
  }

  private async wait(flight: Flight, signal?: AbortSignal): Promise<TranscriptTurn | undefined> {
    signal?.throwIfAborted();
    flight.waiters += 1;
    let abort: (() => void) | undefined;
    try {
      return await (signal === undefined ? flight.promise : Promise.race([flight.promise,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason ?? new DOMException('Detail read aborted', 'AbortError'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        })]));
    } finally {
      if (abort !== undefined) signal?.removeEventListener('abort', abort);
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
    }
  }

  private async replay(input: Prepared, agent: string, turnId: string, signal: AbortSignal): Promise<TranscriptTurn | undefined> {
    return (await this.replaySnapshot(input, agent, turnId, signal))?.items.find((item): item is TranscriptTurn => item.kind === 'turn' && item.turnId === turnId);
  }

  private async replaySnapshot(input: Prepared, agent: string, turnId: string, signal: AbortSignal,
    maxBytes?: number): Promise<AgentTranscriptSnapshot | undefined> {
    const seed = input.db.canonicalSeed(input.scope, turnId);
    if (seed === undefined) return undefined;
    const draft = new AgentTranscriptDraft(agent);
    const reducer = new TranscriptFactReducer(draft);
    const adapter = new TranscriptWireAdapter(agent, { turn: (id) => draft.getTurn(id),
      tool: (id) => draft.getToolCall(id), task: (id) => draft.getTask(id) });
    adapter.restore({ ...adapter.checkpoint(), legacyTurnOrdinal: seed.legacyTurn, recordOrdinal: seed.ordinal });
    let logical: LogicalWire | undefined;
    let handle: FileHandle | undefined;
    const releaseRead = async (): Promise<void> => {
      const currentLogical = logical;
      const currentHandle = handle;
      logical = undefined;
      handle = undefined;
      currentLogical?.close();
      if (currentHandle !== undefined) await currentHandle.close();
    };
    let sliceBytes = 0;
    let sliceRecords = 0;
    let totalBytes = 0;
    let totalRecords = 0;
    let ordinal = -1;
    let expectedOrdinal = seed.ordinal;
    this.replays += 1;
    try {
      logical = await openLogicalWire(input.wirePath);
      handle = logical === undefined ? await open(input.wirePath, 'r') : undefined;
      for (;;) {
        signal.throwIfAborted();
        const page = input.db.canonicalSources(input.scope, turnId, ordinal, 128);
        if (page.length === 0) break;
        for (const span of page) {
          signal.throwIfAborted();
          const size = span.end - span.start;
          if (!Number.isSafeInteger(size) || size <= 0) throw new Error('history_canonical_invalid_span');
          if (maxBytes !== undefined && (totalBytes + size > maxBytes || totalRecords >= 50_000)) return undefined;
          if (sliceBytes >= TARGET_BYTES || sliceRecords >= TARGET_RECORDS) {
            await new Promise<void>((resolve) => { setImmediate(resolve); });
            signal.throwIfAborted();
            sliceBytes = 0;
            sliceRecords = 0;
          }
          const bytes = Buffer.allocUnsafe(size);
          let offset = 0;
          while (offset < size) {
            signal.throwIfAborted();
            const readCount = await readAddressedBytes(logical, handle, bytes, offset, size - offset, span.start + offset);
            this.replayBytes += readCount;
            sliceBytes += readCount;
            totalBytes += readCount;
            if (readCount === 0) throw new Error('history_source_changed');
            offset += readCount;
          }
          if (hashHistoryRecord(bytes) !== span.digest) throw new Error('history_source_changed');
          if (span.ordinal !== expectedOrdinal) adapter.restore({ ...adapter.checkpoint(), recordOrdinal: span.ordinal });
          const record = JSON.parse(bytes.toString('utf8')) as { type: string; [key: string]: unknown };
          reducer.apply(adapter.add(record));
          expectedOrdinal = span.ordinal + 1;
          ordinal = span.ordinal;
          sliceRecords += 1;
          totalRecords += 1;
          this.replayRecords += 1;
        }
        if (page.length < 128) break;
      }
      await releaseRead();
      signal.throwIfAborted();
      const proof = await historyNavigationProof(input.wirePath, input.manifest.offset);
      signal.throwIfAborted();
      if (!matchesNavigationProof(input.manifest.source, proof) ||
          input.db.readManifest(input.scope)?.generation !== input.manifest.generation ||
          input.db.readManifest(input.scope)?.offset !== input.manifest.offset) throw new Error('history_source_changed');
      const turn = draft.getTurn(turnId);
      if (turn === undefined) throw new Error('history_canonical_locator_incomplete');
      return { ...draft.snapshot(), items: [turn] };
    } finally {
      await releaseRead();
    }
  }

  private getCached(key: string, fingerprint: string): CacheEntry | undefined {
    this.expireOversized();
    const cached = this.cache.get(key);
    if (cached === undefined) return undefined;
    if (cached.fingerprint !== fingerprint) { this.deleteCached(key); return undefined; }
    this.cache.delete(key);
    this.cache.set(key, cached);
    if (key === this.oversizedCacheKey) this.touchOversized();
    this.cacheHits += 1;
    return cached;
  }

  private deleteCached(key: string): void {
    const cached = this.cache.get(key);
    if (cached === undefined) return;
    this.cache.delete(key);
    this.cacheBytes -= cached.bytes;
    if (key === this.oversizedCacheKey) {
      this.oversizedCacheKey = undefined;
      this.oversizedExpiresAt = 0;
      clearTimeout(this.oversizedTimer);
      this.oversizedTimer = undefined;
    }
  }

  private expireOversized(): void {
    if (this.oversizedCacheKey !== undefined && (Date.now() >= this.oversizedExpiresAt ||
        (this.cache.get(this.oversizedCacheKey)?.bytes ?? 0) > this.transcript.detailCacheBudgetBytes())) this.deleteCached(this.oversizedCacheKey);
  }

  private touchOversized(): void {
    this.oversizedExpiresAt = Date.now() + OVERSIZED_CACHE_IDLE_MS;
    clearTimeout(this.oversizedTimer);
    this.scheduleOversizedExpiry();
  }

  private scheduleOversizedExpiry(): void {
    this.oversizedTimer = setTimeout(() => {
      this.expireOversized();
      if (this.oversizedCacheKey !== undefined) this.scheduleOversizedExpiry();
    }, Math.max(1, this.oversizedExpiresAt - Date.now()));
    this.oversizedTimer.unref();
  }

  private admit(key: string, fingerprint: string, entity: TranscriptTurn | TranscriptFrame, allowOversized = false): void {
    const bytes = Buffer.byteLength(JSON.stringify(entity)) * 2;
    if (bytes > CACHE_BYTES && (!allowOversized || bytes > this.transcript.detailCacheBudgetBytes())) return;
    this.expireOversized();
    this.deleteCached(key);
    if (bytes > CACHE_BYTES && this.oversizedCacheKey !== undefined) this.deleteCached(this.oversizedCacheKey);
    const regularBytes = (): number => this.cacheBytes -
      (this.oversizedCacheKey === undefined ? 0 : this.cache.get(this.oversizedCacheKey)?.bytes ?? 0);
    const extraRegularBytes = bytes <= CACHE_BYTES ? bytes : 0;
    while (this.cache.size >= CACHE_ENTRIES || regularBytes() + extraRegularBytes > CACHE_BYTES) {
      const oldest = [...this.cache.keys()].find((value) => value !== this.oversizedCacheKey);
      if (oldest === undefined) break;
      this.deleteCached(oldest);
    }
    this.cache.set(key, { fingerprint, entity, bytes });
    this.cacheBytes += bytes;
    if (bytes > CACHE_BYTES) {
      this.oversizedCacheKey = key;
      this.touchOversized();
    }
  }
}
