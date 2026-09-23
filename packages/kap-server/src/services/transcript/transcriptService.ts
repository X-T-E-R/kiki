import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import {
  IAgentActivityView,
  IAgentLifecycleService,
  IAgentPromptService,
  IConfigService,
  IFlagService,
  IQueryStore,
  ISessionIndex,
  ISessionMetadata,
  followSessionLifecycles,
  getLiveSessionById,
  type IDisposable,
  type Scope,
  type SessionMeta,
} from '@kiki/agent-core-v2';
import {
  AgentTranscript,
  AgentTranscriptDraft,
  TranscriptFactReducer,
  TranscriptStore,
  TranscriptWireAdapter,
  isPlainAgentId,
  type AgentDescriptor,
  type AgentTranscriptSnapshot,
  type TranscriptChangeEvent,
  type TranscriptCursor,
  type TranscriptMarker,
  type TranscriptOperation,
  type TranscriptResidentLimits,
  type TranscriptWireAdapterCheckpoint,
  type ToolCountSetOp,
  type TranscriptTaskRef,
  type TranscriptTurn,
} from '@kiki/transcript';

import {
  bindSessionTranscript,
  descriptorFromMeta,
  streamWireRecords,
  WIRE_COLD_READ_MAX_BYTES,
  WIRE_COLD_READ_MAX_LINE_BYTES,
  WIRE_COLD_READ_MAX_RECORDS,
  WIRE_READ_CHUNK_BYTES,
  type TranscriptBinding,
  type TranscriptBindingLogger,
  type WireRecordsIncompleteReason,
  type WireRecordsStreamOptions,
  type WireRecordsStreamResult,
} from '@kiki/transcript-live';

import {
  readWireRecordsBounded,
  type BoundedWireScanOptions,
} from './boundedWireScan';
import {
  DEFAULT_TRANSCRIPT_MEMORY_CONFIG,
  TRANSCRIPT_MEMORY_SECTION,
  TRANSCRIPT_RESIDENT_WINDOW_FLAG_ID,
  type TranscriptMemoryConfig,
} from './configSection';

const SESSIONS_ROOT = 'sessions';
const AGENTS_DIR = 'agents';
const MAIN_AGENT_ID = 'main';
const WIRE_FILE = 'wire.jsonl';
const STATE_FILE = 'state.json';
const TRANSCRIPT_CHECKPOINT_COLLECTION = '__transcript_projection_checkpoint__';
const TRANSCRIPT_CHECKPOINT_FORMAT = 2;
const TRANSCRIPT_CHECKPOINT_MIN_RECORDS = 256;
const OPS_JOURNAL_COMPACT_MIN_HEAD = 1024;
const OPS_JOURNAL_ESTIMATE_NODE_OVERHEAD_BYTES = 64;
const OPS_JOURNAL_ESTIMATE_SCALAR_BYTES = 8;
const OPS_JOURNAL_ESTIMATE_MAX_DEPTH = 24;
const DEFAULT_TOOL_CALL_COUNT_MAX_BYTES = 32 << 20;
const DEFAULT_TOOL_CALL_COUNT_MAX_FILES = 64;
const DEFAULT_TOOL_CALL_COUNT_CACHE_ENTRIES = 256;
const DEFAULT_TOOL_CALL_COUNT_CACHE_BYTES = 8 << 20;
const DEFAULT_TOOL_CALL_COUNT_READ_CHUNK_BYTES = 64 << 10;

export interface TranscriptToolCallCountLimits {
  readonly maxBytesPerRequest?: number;
  readonly maxFilesPerRequest?: number;
  readonly maxCacheEntries?: number;
  readonly maxCacheBytes?: number;
  readonly readChunkBytes?: number;
}

export interface TranscriptColdReadLimits {
  readonly maxBytes?: number;
  readonly maxRecords?: number;
  readonly maxLineBytes?: number;
  readonly chunkBytes?: number;
}

export interface TranscriptOpsJournalLimits {
  readonly maxAgentBytes?: number;
  readonly maxSessionBytes?: number;
  readonly maxTotalBytes?: number;
}

export interface TranscriptServiceDeps {
  readonly homeDir: string;
  readonly core: Scope;
  readonly logger?: TranscriptBindingLogger;
  readonly toolCallCountLimits?: TranscriptToolCallCountLimits;
  readonly toolCallCountReader?: (
    wirePath: string,
    fileSize: number,
    options: BoundedWireScanOptions,
  ) => Promise<number>;
  readonly coldReadLimits?: TranscriptColdReadLimits;
  readonly opsJournalLimits?: TranscriptOpsJournalLimits;
  readonly residentLimits?: TranscriptResidentLimits | false;
  readonly wireRecordReader?: (
    wirePath: string,
    options: WireRecordsStreamOptions,
  ) => Promise<WireRecordsStreamResult>;
}

interface LiveEntry {
  readonly store: TranscriptStore;
  readonly binding: TranscriptBinding;
  ready: Promise<void>;
  readonly agentBackfills: Map<string, Promise<void>>;
  readonly agentHistory: Map<string, AgentHistoryState>;
  readonly opsJournals: Map<string, AgentOpsJournal>;
  opsJournalSessionBytes: number;
  readonly agentToolCallStates: Map<string, MaterializedAgentToolCallState>;
  readonly agentDisposal: IDisposable;
}

interface AgentHistoryState {
  status: 'pending' | 'complete' | 'failed';
  failureSignature?: string;
}

interface MaterializedAgentToolCallState {
  readonly toolFrameIdsByTurn: Map<string, Set<string>>;
  toolCallCount: number;
}

interface PersistedToolCallState {
  readonly fingerprint: string;
  readonly state: MaterializedAgentToolCallState;
  readonly weight: number;
}

interface ToolCallReadResult {
  readonly fingerprint: string;
  readonly state?: MaterializedAgentToolCallState;
  readonly weight: number;
  readonly known: boolean;
  readonly reason?: 'budget' | 'missing' | 'failed';
  readonly error?: unknown;
}

interface ToolCallCountCandidate {
  readonly agentId: string;
  readonly wirePath: string;
  fingerprint?: string;
  size?: number;
  cached?: MaterializedAgentToolCallState;
  reason?: 'budget' | 'missing' | 'failed';
}

interface AgentOpsJournal {
  epoch: string;
  nextSeq: number;
  start: number;
  batches: JournaledOpsBatch[];
  bytes: number;
}

interface JournaledOpsBatch {
  readonly seq: number;
  readonly ops: TranscriptOperation[];
  readonly bytes: number;
}

interface TranscriptProjectionCheckpoint {
  readonly format: typeof TRANSCRIPT_CHECKPOINT_FORMAT;
  readonly fingerprint: string;
  readonly nextByteOffset: number;
  readonly recordCount: number;
  readonly snapshot: AgentTranscriptSnapshot;
  readonly adapter: TranscriptWireAdapterCheckpoint;
  readonly acceptedDurableFacts: readonly string[];
}

interface ColdSnapshotFlight {
  readonly controller: AbortController;
  readonly promise: Promise<AgentTranscriptSnapshot | undefined>;
  waiters: number;
  settled: boolean;
}

type TranscriptOpsListener = (event: TranscriptChangeEvent, cursor: TranscriptCursor) => void;

export const TRANSCRIPT_OPS_JOURNAL_CAPACITY = 2000;
export const TRANSCRIPT_OPS_JOURNAL_MAX_AGENT_BYTES = 2 << 20;
export const TRANSCRIPT_OPS_JOURNAL_MAX_SESSION_BYTES = 8 << 20;
export const TRANSCRIPT_OPS_JOURNAL_MAX_TOTAL_BYTES = 64 << 20;

export interface TranscriptMemoryReport {
  readonly liveSessions: number;
  readonly liveAgents: number;
  readonly residentTurns: number;
  readonly residentBytes: number;
  readonly trimmedTurns: number;
  readonly overBudgetAgents: number;
  readonly opsJournalBytes: number;
  readonly opsJournalBatches: number;
  readonly opsJournalDroppedBytes: number;
  readonly toolCallCacheEntries: number;
  readonly toolCallCacheBytes: number;
  readonly eventLoopDelay: {
    readonly meanMs: number;
    readonly maxMs: number;
    readonly p99Ms: number;
  };
  readonly coldReads: {
    readonly completed: number;
    readonly shared: number;
    readonly cancelled: number;
    readonly fenced: number;
    readonly bytes: number;
    readonly records: number;
    readonly durationMs: number;
  };
}

export interface TranscriptOpsCatchup {
  readonly epoch: string;
  readonly batches: readonly {
    readonly seq: number;
    readonly ops: readonly TranscriptOperation[];
  }[];
  readonly throughSeq: number;
  readonly complete: boolean;
}

export class TranscriptService {
  private readonly live = new Map<string, LiveEntry>();
  private readonly opsListeners = new Map<string, Set<TranscriptOpsListener>>();
  private readonly toolCallCountLimits: Required<TranscriptToolCallCountLimits>;
  private readonly persistedToolCallStates = new Map<string, PersistedToolCallState>();
  private persistedToolCallStateWeight = 0;
  private readonly persistedToolCallReads = new Map<string, Promise<ToolCallReadResult>>();
  private readonly persistedToolCallPins = new Map<string, number>();
  private readonly toolCallCountReader: NonNullable<TranscriptServiceDeps['toolCallCountReader']>;
  private readonly coldReadLimits: Required<TranscriptColdReadLimits>;
  private readonly opsJournalLimits: Required<TranscriptOpsJournalLimits>;
  private readonly wireRecordReader: NonNullable<TranscriptServiceDeps['wireRecordReader']>;
  private readonly coldSnapshotFlights = new Map<string, ColdSnapshotFlight>();
  private opsJournalTotalBytes = 0;
  private opsJournalDroppedBytes = 0;
  private coldReadsCompleted = 0;
  private coldReadsShared = 0;
  private coldReadsCancelled = 0;
  private coldReadsFenced = 0;
  private coldReadBytes = 0;
  private coldReadRecords = 0;
  private coldReadDurationMs = 0;
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });

  constructor(private readonly deps: TranscriptServiceDeps) {
    this.eventLoopDelay.enable();
    this.toolCallCountReader = deps.toolCallCountReader ?? readWireRecordsBounded;
    const limits = deps.toolCallCountLimits;
    this.toolCallCountLimits = {
      maxBytesPerRequest: nonNegativeLimit(limits?.maxBytesPerRequest, DEFAULT_TOOL_CALL_COUNT_MAX_BYTES),
      maxFilesPerRequest: nonNegativeLimit(limits?.maxFilesPerRequest, DEFAULT_TOOL_CALL_COUNT_MAX_FILES),
      maxCacheEntries: nonNegativeLimit(limits?.maxCacheEntries, DEFAULT_TOOL_CALL_COUNT_CACHE_ENTRIES),
      maxCacheBytes: nonNegativeLimit(limits?.maxCacheBytes, DEFAULT_TOOL_CALL_COUNT_CACHE_BYTES),
      readChunkBytes: positiveLimit(limits?.readChunkBytes, DEFAULT_TOOL_CALL_COUNT_READ_CHUNK_BYTES),
    };
    this.wireRecordReader = deps.wireRecordReader ?? streamWireRecords;
    const coldReadLimits = deps.coldReadLimits;
    this.coldReadLimits = {
      maxBytes: nonNegativeLimit(coldReadLimits?.maxBytes, WIRE_COLD_READ_MAX_BYTES),
      maxRecords: nonNegativeLimit(coldReadLimits?.maxRecords, WIRE_COLD_READ_MAX_RECORDS),
      maxLineBytes: nonNegativeLimit(coldReadLimits?.maxLineBytes, WIRE_COLD_READ_MAX_LINE_BYTES),
      chunkBytes: positiveLimit(coldReadLimits?.chunkBytes, WIRE_READ_CHUNK_BYTES),
    };
    const opsJournalLimits = deps.opsJournalLimits;
    this.opsJournalLimits = {
      maxAgentBytes: nonNegativeLimit(opsJournalLimits?.maxAgentBytes, TRANSCRIPT_OPS_JOURNAL_MAX_AGENT_BYTES),
      maxSessionBytes: nonNegativeLimit(opsJournalLimits?.maxSessionBytes, TRANSCRIPT_OPS_JOURNAL_MAX_SESSION_BYTES),
      maxTotalBytes: nonNegativeLimit(opsJournalLimits?.maxTotalBytes, TRANSCRIPT_OPS_JOURNAL_MAX_TOTAL_BYTES),
    };
    followSessionLifecycles(deps.core.accessor, (service) => {
      const d1 = service.onDidCloseSession(({ sessionId }) => this.dropSession(sessionId));
      const d2 = service.onDidArchiveSession(({ sessionId }) => this.dropSession(sessionId));
      return {
        dispose: () => {
          d1.dispose();
          d2.dispose();
        },
      };
    });
  }

  /**
   * Get (or create + bind) the transcript store for a session that is live in
   * this process. Returns `undefined` when the session is not in memory.
   */
  forSessionLive(sessionId: string): TranscriptStore | undefined {
    const existing = this.live.get(sessionId);
    if (existing !== undefined) {
      if (getLiveSessionById(this.deps.core.accessor, sessionId) !== undefined) {
        return existing.store;
      }
      this.dropSession(sessionId);
      return undefined;
    }
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    if (session === undefined) return undefined;
    const store = new TranscriptStore(sessionId, this.resolveResidentLimits());
    let binding: TranscriptBinding;
    try {
      binding = bindSessionTranscript(
        store,
        session,
        this.deps.logger,
        (event) => this.handleLiveOps(sessionId, event),
        true,
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'InstantiationService has been disposed') {
        return undefined;
      }
      throw error;
    }
    const entry: LiveEntry = {
      store,
      binding,
      ready: Promise.resolve(),
      agentBackfills: new Map(),
      agentHistory: new Map(),
      opsJournals: new Map(),
      opsJournalSessionBytes: 0,
      agentToolCallStates: new Map(),
      agentDisposal: session.accessor
        .get(IAgentLifecycleService)
        .onDidDispose((agentId) => this.evictAgent(sessionId, store, agentId)),
    };
    this.live.set(sessionId, entry);
    entry.ready = (async () => {
      await this.backfillMain(sessionId, store);
      if (this.live.get(sessionId)?.store === store) {
        binding.seedRunningTasks(MAIN_AGENT_ID);
        binding.seedPendingInteractions(MAIN_AGENT_ID);
        binding.seedPrompts(MAIN_AGENT_ID);
        this.reconcileQueuedPrompts(sessionId, store, MAIN_AGENT_ID);
      }
    })();
    return store;
  }

  /**
   * A released subagent keeps its roster entry, but its in-memory transcript,
   * ops journal, and backfill marker go away with the engine scope; the next
   * read rebuilds them from the persisted wire.
   */
  private evictAgent(sessionId: string, store: TranscriptStore, agentId: string): void {
    if (agentId === MAIN_AGENT_ID) return;
    const entry = this.live.get(sessionId);
    if (entry === undefined || entry.store !== store) return;
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    if (session?.accessor.get(IAgentLifecycleService).get(agentId) !== undefined) return;
    entry.agentBackfills.delete(agentId);
    entry.agentHistory.delete(agentId);
    const journal = entry.opsJournals.get(agentId);
    if (journal !== undefined) {
      this.disposeOpsJournal(entry, journal);
      entry.opsJournals.delete(agentId);
    }
    entry.agentToolCallStates.delete(agentId);
    store.evictAgentTranscript(agentId);
  }

  /**
   * Resolves when the session's initial history backfill has landed (or
   * immediately when the session has no live store). Full-read consumers
   * (REST route, WS subscribe) await this so the first answer carries the
   * established main-agent transcript.
   */
  async whenReady(sessionId: string): Promise<void> {
    await this.live.get(sessionId)?.ready;
  }

  /**
   * Ensure one agent's persisted history is replayed into the live store
   * (idempotent per agent; the main agent is already covered by the initial
   * backfill). Awaited by full-read consumers for the `agent_id` they serve,
   * so any agent's transcript — including subagents that are not
   * materialized in this process — comes back established.
   */
  async ensureAgentHistory(sessionId: string, agentId: string): Promise<void> {
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    await entry.ready;
    let backfill = entry.agentBackfills.get(agentId);
    const history = entry.agentHistory.get(agentId);
    if (history?.status === 'failed') {
      const changed = await this.historyFailureChanged(sessionId, agentId, history);
      if (!changed) return;
      if (entry.agentBackfills.get(agentId) === backfill) entry.agentBackfills.delete(agentId);
      backfill = entry.agentBackfills.get(agentId);
    }
    if (backfill === undefined) {
      if (agentId === MAIN_AGENT_ID && history?.status !== 'failed') return;
      entry.agentHistory.set(agentId, { status: 'pending' });
      backfill = this.backfillAgent(sessionId, entry.store, agentId);
      entry.agentBackfills.set(agentId, backfill);
    }
    await backfill;
    if (this.live.get(sessionId)?.store === entry.store) {
      entry.binding.seedRunningTasks(agentId);
      entry.binding.seedPendingInteractions(agentId);
      entry.binding.seedPrompts(agentId);
      this.reconcileQueuedPrompts(sessionId, entry.store, agentId);
    }
  }

  private reconcileQueuedPrompts(sessionId: string, store: TranscriptStore, agentId: string): void {
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    const agent = session?.accessor.get(IAgentLifecycleService).get(agentId);
    const prompts = agent?.accessor.get(IAgentPromptService);
    if (prompts === undefined) return;
    const transcript = store.getAgent(agentId);
    if (transcript === undefined) return;
    let snapshot: ReturnType<IAgentPromptService['list']>;
    try {
      snapshot = prompts.list();
    } catch {
      return;
    }
    const owned = new Set<string>();
    if (snapshot.active !== undefined) owned.add(snapshot.active.id);
    if (snapshot.launching !== undefined) owned.add(snapshot.launching.id);
    for (const pending of snapshot.pending) owned.add(pending.id);
    const ops: TranscriptOperation[] = [];
    for (const prompt of transcript.snapshot().prompts) {
      if (prompt.status !== 'queued' || owned.has(prompt.promptId)) continue;
      ops.push({ op: 'prompt.upsert', prompt: { ...prompt, status: 'aborted', abortedBeforeStart: true } });
    }
    if (ops.length === 0) return;
    const result = transcript.apply(ops);
    if (result.accepted.length > 0) this.dispatchOps(sessionId, { agentId, ops: result.accepted });
  }

  /** Initial backfill: main-agent history + the full roster from session metadata. */
  private async backfillMain(sessionId: string, store: TranscriptStore): Promise<void> {
    await this.backfillAgent(sessionId, store, MAIN_AGENT_ID);
    if (this.live.get(sessionId)?.store !== store) return;
    try {
      const session = getLiveSessionById(this.deps.core.accessor, sessionId);
      const meta = await session?.accessor.get(ISessionMetadata).read();
      for (const [agentId, agentMeta] of Object.entries(meta?.agents ?? {})) {
        store.describeAgent(descriptorFromMeta(agentId, agentMeta));
      }
    } catch {
    }
  }

  private liveActiveTurnId(sessionId: string, agentId: string): string | undefined {
    const session = getLiveSessionById(this.deps.core.accessor, sessionId);
    const agent = session?.accessor.get(IAgentLifecycleService).get(agentId);
    const view: IAgentActivityView | undefined = agent?.accessor.get(IAgentActivityView);
    const turnId = view?.state().turn?.turnId;
    return turnId === undefined ? undefined : `t${turnId}`;
  }

  private liveActiveTurnIds(
    sessionId: string,
    agentId: string,
    initialTurnId: string | undefined,
  ): string[] {
    const currentTurnId = this.liveActiveTurnId(sessionId, agentId);
    if (initialTurnId === undefined) return currentTurnId === undefined ? [] : [currentTurnId];
    if (currentTurnId === undefined || currentTurnId === initialTurnId) return [initialTurnId];
    return [initialTurnId, currentTurnId];
  }

  /**
   * Replay one agent's persisted wire records into its transcript. Everything
   * is an idempotent upsert (never `reset`), so live ops arriving while the
   * records are read from disk survive the merge; turn ordinals assigned by
   * the rebuild are 0-based like the engine's, so future live turns continue
   * without colliding.
   */
  private async backfillAgent(sessionId: string, store: TranscriptStore, agentId: string): Promise<void> {
    const entryAtStart = this.live.get(sessionId);
    if (entryAtStart?.store !== store) return;
    entryAtStart.agentHistory.set(agentId, { status: 'pending' });
    const transcript = store.ensureAgent(agentId);
    this.dispatchToolCallCount(sessionId, transcript, undefined, true);
    const initialActiveTurnId = this.liveActiveTurnId(sessionId, agentId);
    let snapshot: AgentTranscriptSnapshot | undefined;
    let failed = false;
    try {
      snapshot = await this.readColdSnapshot(
        sessionId,
        agentId,
        () => this.liveActiveTurnIds(sessionId, agentId, initialActiveTurnId),
      );
      if (snapshot === undefined) failed = true;
      if (snapshot !== undefined) {
        const result = transcript.apply(snapshotToOps(snapshot));
        if (result.gap !== undefined) {
          this.deps.logger?.warn({ sessionId, agentId, gap: result.gap }, 'transcript: backfill append gap');
        }
        if (result.accepted.length > 0) {
          this.dispatchOps(sessionId, { agentId, ops: result.accepted });
        }
        failed = !snapshotToolCallCountKnown(snapshot);
      }
    } catch (error) {
      failed = true;
      this.deps.logger?.warn(
        { sessionId, agentId, err: error instanceof Error ? error.message : error },
        'transcript: history backfill failed, continuing without it',
      );
    }
    const entry = this.live.get(sessionId);
    if (entry?.store !== store) return;
    const existing = store.agents().find((d) => d.agentId === agentId);
    const hasContent =
      snapshot !== undefined && (snapshot.items.length > 0 || snapshot.tasks.length > 0);
    if (existing !== undefined || hasContent) {
      store.describeAgent({
        agentId,
        type: existing?.type ?? (agentId === MAIN_AGENT_ID ? 'main' : 'sub'),
        parentAgentId: existing?.parentAgentId,
        label: existing?.label,
        createdAt: existing?.createdAt,
      });
    }
    const materialized = transcript.snapshot();
    entry.agentToolCallStates.set(agentId, toolCallStateFromSnapshot(materialized));
    const failureSignature = failed
      ? await this.historyFailureSignature(sessionId, agentId)
      : undefined;
    if (failed) {
      entry.agentHistory.set(agentId, { status: 'failed', failureSignature });
      this.dispatchToolCallCount(sessionId, transcript, undefined, true);
    } else {
      entry.agentHistory.set(agentId, { status: 'complete' });
      this.dispatchToolCallCount(sessionId, transcript, countToolCallFrames(materialized.items), true);
    }
    entry.binding.finishReplay(agentId);
  }

  onSessionOps(sessionId: string, listener: TranscriptOpsListener): IDisposable | undefined {
    if (this.forSessionLive(sessionId) === undefined) return undefined;
    let listeners = this.opsListeners.get(sessionId);
    if (listeners === undefined) {
      listeners = new Set();
      this.opsListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return {
      dispose: () => {
        const entry = this.opsListeners.get(sessionId);
        if (entry === undefined) return;
        entry.delete(listener);
        if (entry.size === 0) this.opsListeners.delete(sessionId);
      },
    };
  }

  private dispatchOps(sessionId: string, event: TranscriptChangeEvent): void {
    const cursor = this.journalOps(sessionId, event);
    if (cursor === undefined) return;
    const listeners = this.opsListeners.get(sessionId);
    if (listeners === undefined) return;
    for (const listener of listeners) {
      try {
        listener(event, cursor);
      } catch {
      }
    }
  }

  private journalFor(sessionId: string, agentId: string): AgentOpsJournal | undefined {
    const entry = this.live.get(sessionId);
    if (entry === undefined) return undefined;
    let journal = entry.opsJournals.get(agentId);
    if (journal === undefined) {
      journal = { epoch: randomUUID(), nextSeq: 1, start: 0, batches: [], bytes: 0 };
      entry.opsJournals.set(agentId, journal);
    }
    return journal;
  }

  private journalOps(sessionId: string, event: TranscriptChangeEvent): TranscriptCursor | undefined {
    if (event.ops.length === 0) return undefined;
    const entry = this.live.get(sessionId);
    const journal = this.journalFor(sessionId, event.agentId);
    if (entry === undefined || journal === undefined) return undefined;
    const seq = journal.nextSeq++;
    const bytes = estimateOpsJournalBatchBytes(event.ops, this.opsJournalLimits.maxAgentBytes);
    if (bytes <= this.opsJournalLimits.maxAgentBytes) {
      this.retainOpsJournalBatch(entry, journal, { seq, ops: [...event.ops], bytes });
    } else {
      this.evictOpsJournalBatchesBefore(entry, journal, seq);
    }
    return { epoch: journal.epoch, seq };
  }

  private opsJournalBatchCount(journal: AgentOpsJournal): number {
    return journal.batches.length - journal.start;
  }

  private retainOpsJournalBatch(
    entry: LiveEntry,
    journal: AgentOpsJournal,
    batch: JournaledOpsBatch,
  ): void {
    journal.batches.push(batch);
    journal.bytes += batch.bytes;
    entry.opsJournalSessionBytes += batch.bytes;
    this.opsJournalTotalBytes += batch.bytes;
    for (;;) {
      const overCapacity = this.opsJournalBatchCount(journal) > TRANSCRIPT_OPS_JOURNAL_CAPACITY;
      const overAgent = journal.bytes > this.opsJournalLimits.maxAgentBytes;
      const overSession = entry.opsJournalSessionBytes > this.opsJournalLimits.maxSessionBytes;
      const overTotal = this.opsJournalTotalBytes > this.opsJournalLimits.maxTotalBytes;
      if (!overCapacity && !overAgent && !overSession && !overTotal) return;
      if (!this.evictOpsJournalOldest(entry, journal)) return;
    }
  }

  private evictOpsJournalOldest(entry: LiveEntry, journal: AgentOpsJournal): boolean {
    if (journal.start >= journal.batches.length) return false;
    const batch = journal.batches[journal.start]!;
    journal.start += 1;
    journal.bytes -= batch.bytes;
    entry.opsJournalSessionBytes -= batch.bytes;
    this.opsJournalTotalBytes -= batch.bytes;
    this.opsJournalDroppedBytes += batch.bytes;
    if (
      journal.start >= OPS_JOURNAL_COMPACT_MIN_HEAD &&
      journal.start * 2 >= journal.batches.length
    ) {
      journal.batches.splice(0, journal.start);
      journal.start = 0;
    }
    return true;
  }

  private evictOpsJournalBatchesBefore(
    entry: LiveEntry,
    journal: AgentOpsJournal,
    beforeSeq: number,
  ): void {
    while (
      journal.start < journal.batches.length &&
      journal.batches[journal.start]!.seq < beforeSeq
    ) {
      this.evictOpsJournalOldest(entry, journal);
    }
  }

  private disposeOpsJournal(entry: LiveEntry, journal: AgentOpsJournal): void {
    this.evictOpsJournalBatchesBefore(entry, journal, journal.nextSeq);
  }

  getTranscriptCursor(sessionId: string, agentId: string): TranscriptCursor {
    const journal = this.journalFor(sessionId, agentId);
    return journal === undefined
      ? { epoch: undefined, seq: 0 }
      : { epoch: journal.epoch, seq: journal.nextSeq - 1 };
  }

  getSeqWatermark(sessionId: string, agentId: string): number {
    return this.getTranscriptCursor(sessionId, agentId).seq;
  }

  getOpsSince(
    sessionId: string,
    agentId: string,
    sinceInput: TranscriptCursor | number,
  ): TranscriptOpsCatchup | undefined {
    if (this.forSessionLive(sessionId) === undefined) return undefined;
    const journal = this.journalFor(sessionId, agentId);
    if (journal === undefined) return undefined;
    const since = typeof sinceInput === 'number' ? { epoch: undefined, seq: sinceInput } : sinceInput;
    const throughSeq = journal.nextSeq - 1;
    if ((since.epoch !== undefined && since.epoch !== journal.epoch) || since.seq > throughSeq) {
      return { epoch: journal.epoch, batches: [], throughSeq, complete: false };
    }
    const retained: JournaledOpsBatch[] = [];
    for (let index = journal.start; index < journal.batches.length; index += 1) {
      const batch = journal.batches[index]!;
      if (batch.seq > since.seq) retained.push(batch);
    }
    const complete =
      since.seq === throughSeq ||
      (retained.length > 0 && retained[0]!.seq <= since.seq + 1);
    const batches = retained.map((batch) => ({ seq: batch.seq, ops: batch.ops }));
    return { epoch: journal.epoch, batches, throughSeq, complete };
  }

  private handleLiveOps(sessionId: string, event: TranscriptChangeEvent): void {
    const entry = this.live.get(sessionId);
    if (entry === undefined) {
      this.dispatchOps(sessionId, event);
      return;
    }
    const transcript = entry.store.getAgent(event.agentId);
    let state = entry.agentToolCallStates.get(event.agentId);
    if (state === undefined && transcript !== undefined) {
      state = toolCallStateFromSnapshot(transcript.snapshot());
      entry.agentToolCallStates.set(event.agentId, state);
    }
    const before = state?.toolCallCount;
    if (state !== undefined) applyToolCallOps(state, event.ops);
    const countChanged = state !== undefined && before !== state.toolCallCount;
    if (!countChanged || transcript === undefined) {
      this.dispatchOps(sessionId, event);
      return;
    }
    if (state === undefined) {
      this.dispatchOps(sessionId, event);
      return;
    }
    const history = entry.agentHistory.get(event.agentId);
    const count = history?.status === 'complete' ? state.toolCallCount : undefined;
    const countOp = toolCallCountSetOperation(count);
    this.applyToolCallOperation(transcript, countOp);
    this.dispatchOps(sessionId, {
      agentId: event.agentId,
      ops: [...event.ops, countOp],
    });
  }

  getMaterializedAgentToolCallCounts(
    sessionId: string,
    agentIds: readonly string[],
  ): ReadonlyMap<string, number> {
    const result = new Map<string, number>();
    const entry = this.live.get(sessionId);
    if (entry === undefined) return result;
    for (const agentId of new Set(agentIds)) {
      if (entry.agentHistory.get(agentId)?.status !== 'complete') continue;
      const state = entry.agentToolCallStates.get(agentId);
      if (state !== undefined) {
        result.set(agentId, state.toolCallCount);
        continue;
      }
      const transcript = entry.store.getAgent(agentId);
      if (transcript !== undefined) result.set(agentId, countToolCallFrames(transcript.getItems()));
    }
    return result;
  }

  async getAgentToolCallCounts(
    sessionId: string,
    agentIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const counts = new Map<string, number>();
    const entry = this.live.get(sessionId);
    const candidateAgentIds: string[] = [];
    for (const agentId of new Set(agentIds)) {
      if (!isPlainAgentId(agentId)) continue;
      const history = entry?.agentHistory.get(agentId);
      if (history !== undefined) {
        if (history.status !== 'complete') continue;
        const state = entry?.agentToolCallStates.get(agentId);
        if (state !== undefined) {
          counts.set(agentId, state.toolCallCount);
          continue;
        }
        const transcript = entry?.store.getAgent(agentId);
        if (transcript !== undefined) {
          counts.set(agentId, countToolCallFrames(transcript.getItems()));
          continue;
        }
        continue;
      } else if (entry?.agentToolCallStates.has(agentId)) {
        continue;
      }
      candidateAgentIds.push(agentId);
    }
    if (candidateAgentIds.length === 0) return counts;
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return counts;
    const candidates: ToolCallCountCandidate[] = candidateAgentIds.map((agentId) => ({
      agentId,
      wirePath: join(
        this.deps.homeDir,
        SESSIONS_ROOT,
        summary.workspaceId,
        sessionId,
        AGENTS_DIR,
        agentId,
        WIRE_FILE,
      ),
    }));
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate.wirePath);
        if (!Number.isSafeInteger(info.size) || info.size < 0) {
          candidate.reason = 'failed';
          continue;
        }
        candidate.size = info.size;
        candidate.fingerprint = fileFingerprint(info);
        const cached = this.persistedToolCallStates.get(candidate.wirePath);
        if (cached?.fingerprint === candidate.fingerprint) {
          candidate.cached = cached.state;
          this.pinPersistedToolCallState(candidate.wirePath);
        } else if (cached !== undefined) {
          this.deletePersistedToolCallState(candidate.wirePath);
        }
      } catch (error) {
        candidate.reason = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'failed';
        this.deletePersistedToolCallState(candidate.wirePath);
        this.logToolCallCountFailure(sessionId, candidate.agentId, error);
      }
    }
    let remainingBytes = this.toolCallCountLimits.maxBytesPerRequest;
    let remainingFiles = this.toolCallCountLimits.maxFilesPerRequest;
    try {
      for (const candidate of candidates) {
        let persisted = candidate.cached;
        if (persisted === undefined && candidate.reason === undefined) {
          if (remainingFiles <= 0 || candidate.size === undefined) {
            candidate.reason = 'budget';
          } else {
            remainingFiles -= 1;
            if (candidate.size > remainingBytes) {
              candidate.reason = 'budget';
            } else {
              remainingBytes -= candidate.size;
              const read = await this.readPersistedToolCallState(
                candidate.wirePath,
                candidate.fingerprint as string,
                candidate.size,
                candidate.agentId,
                sessionId,
              );
              if (read.known) {
                persisted = read.state;
                if (persisted !== undefined) {
                  this.admitPersistedToolCallState(candidate.wirePath, {
                    fingerprint: read.fingerprint,
                    state: persisted,
                    weight: read.weight,
                  });
                }
              } else {
                candidate.reason = read.reason ?? 'failed';
              }
            }
          }
        }
        if (persisted !== undefined) {
          this.touchPersistedToolCallState(candidate.wirePath);
          const live = entry?.agentToolCallStates.get(candidate.agentId);
          counts.set(candidate.agentId, mergeToolCallCount(persisted, live));
        }
      }
    } finally {
      for (const candidate of candidates) {
        if (candidate.cached !== undefined) this.unpinPersistedToolCallState(candidate.wirePath);
      }
    }
    return counts;
  }

  private dispatchToolCallCount(
    sessionId: string,
    transcript: AgentTranscript,
    count: number | undefined,
    force: boolean,
  ): void {
    const op = toolCallCountSetOperation(count);
    const result = transcript.apply([op]);
    if (result.accepted.length > 0) {
      this.dispatchOps(sessionId, { agentId: transcript.agentId, ops: result.accepted });
    } else if (force) {
      this.dispatchOps(sessionId, { agentId: transcript.agentId, ops: [op] });
    }
  }

  private applyToolCallOperation(
    transcript: AgentTranscript,
    operation: TranscriptOperation,
  ): void {
    transcript.apply([operation]);
  }

  private async readPersistedToolCallState(
    wirePath: string,
    fingerprint: string,
    fileSize: number,
    agentId: string,
    sessionId: string,
  ): Promise<ToolCallReadResult> {
    const key = `${wirePath}\\0${fingerprint}`;
    const existing = this.persistedToolCallReads.get(key);
    if (existing !== undefined) return existing;
    const read = this.scanPersistedToolCallState(wirePath, fingerprint, fileSize, agentId);
    this.persistedToolCallReads.set(key, read);
    try {
      const result = await read;
      if (!result.known && result.reason === 'failed') {
        this.logToolCallCountFailure(sessionId, agentId, result.error);
      }
      return result;
    } finally {
      if (this.persistedToolCallReads.get(key) === read) this.persistedToolCallReads.delete(key);
    }
  }

  private async scanPersistedToolCallState(
    wirePath: string,
    fingerprint: string,
    fileSize: number,
    agentId: string,
  ): Promise<ToolCallReadResult> {
    const state: MaterializedAgentToolCallState = {
      toolFrameIdsByTurn: new Map(),
      toolCallCount: 0,
    };
    const adapter = new TranscriptWireAdapter(agentId);
    const acceptedDurableFacts = new Set<string>();
    try {
      await this.toolCallCountReader(wirePath, fileSize, {
        maxBytes: fileSize,
        chunkBytes: this.toolCallCountLimits.readChunkBytes,
        onRecord: (record) => {
          for (const fact of adapter.add(record)) {
            if (fact.durability === 'durable' && acceptedDurableFacts.has(fact.factId)) continue;
            applyToolCallOps(state, fact.operations);
            if (fact.durability === 'durable') acceptedDurableFacts.add(fact.factId);
          }
        },
      });
      return { fingerprint, state, weight: fileSize, known: true };
    } catch (error) {
      return { fingerprint, weight: fileSize, known: false, reason: 'failed', error };
    }
  }

  private pinPersistedToolCallState(wirePath: string): void {
    this.persistedToolCallPins.set(
      wirePath,
      (this.persistedToolCallPins.get(wirePath) ?? 0) + 1,
    );
  }

  private unpinPersistedToolCallState(wirePath: string): void {
    const count = this.persistedToolCallPins.get(wirePath);
    if (count === undefined || count <= 1) this.persistedToolCallPins.delete(wirePath);
    else this.persistedToolCallPins.set(wirePath, count - 1);
  }

  private touchPersistedToolCallState(wirePath: string): void {
    const entry = this.persistedToolCallStates.get(wirePath);
    if (entry === undefined) return;
    this.persistedToolCallStates.delete(wirePath);
    this.persistedToolCallStates.set(wirePath, entry);
  }

  private deletePersistedToolCallState(wirePath: string): void {
    const entry = this.persistedToolCallStates.get(wirePath);
    if (entry === undefined) return;
    this.persistedToolCallStates.delete(wirePath);
    this.persistedToolCallStateWeight -= entry.weight;
  }

  private admitPersistedToolCallState(
    wirePath: string,
    entry: PersistedToolCallState,
  ): void {
    if (
      this.toolCallCountLimits.maxCacheEntries <= 0 ||
      this.toolCallCountLimits.maxCacheBytes <= 0 ||
      entry.weight > this.toolCallCountLimits.maxCacheBytes
    ) {
      return;
    }
    this.deletePersistedToolCallState(wirePath);
    this.persistedToolCallStates.set(wirePath, entry);
    this.persistedToolCallStateWeight += entry.weight;
    for (;;) {
      const overEntries = this.persistedToolCallStates.size > this.toolCallCountLimits.maxCacheEntries;
      const overBytes = this.persistedToolCallStateWeight > this.toolCallCountLimits.maxCacheBytes;
      if (!overEntries && !overBytes) return;
      const oldest = this.oldestUnpinnedPersistedToolCallState();
      if (oldest === undefined) {
        this.deletePersistedToolCallState(wirePath);
        return;
      }
      this.deletePersistedToolCallState(oldest);
    }
  }

  private oldestUnpinnedPersistedToolCallState(): string | undefined {
    for (const wirePath of this.persistedToolCallStates.keys()) {
      if ((this.persistedToolCallPins.get(wirePath) ?? 0) === 0) return wirePath;
    }
    return undefined;
  }

  private logToolCallCountFailure(sessionId: string, agentId: string, error: unknown): void {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const detail = code ?? (error instanceof Error ? error.message : String(error));
    this.deps.logger?.warn(
      { sessionId, agentId, err: detail },
      'transcript: tool-call count unavailable',
    );
  }

  private logTranscriptFailure(sessionId: string, agentId: string, error: unknown): void {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const detail = code ?? (error instanceof Error ? error.message : String(error));
    this.deps.logger?.warn(
      { sessionId, agentId, err: detail },
      'transcript: history snapshot unavailable',
    );
  }

  private logColdReadFence(
    sessionId: string,
    agentId: string,
    reason: WireRecordsIncompleteReason | 'unknown',
  ): void {
    this.deps.logger?.warn(
      { sessionId, agentId, reason, ...this.coldReadLimits },
      'transcript: history snapshot unavailable (wire read fence tripped)',
    );
  }

  private async historyFailureChanged(
    sessionId: string,
    agentId: string,
    prior: AgentHistoryState,
  ): Promise<boolean> {
    const current = await this.historyFailureSignature(sessionId, agentId);
    return current !== prior.failureSignature;
  }

  private async historyFailureSignature(sessionId: string, agentId: string): Promise<string> {
    if (!isPlainAgentId(agentId)) return 'invalid';
    try {
      const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
      if (summary === undefined) return 'unknown';
      const wirePath = join(
        this.deps.homeDir,
        SESSIONS_ROOT,
        summary.workspaceId,
        sessionId,
        AGENTS_DIR,
        agentId,
        WIRE_FILE,
      );
      try {
        const info = await stat(wirePath);
        if (!Number.isSafeInteger(info.size) || info.size < 0) return 'invalid';
        return `file:${fileFingerprint(info)}`;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        return code === 'ENOENT' ? 'missing' : `error:${code ?? 'unknown'}`;
      }
    } catch {
      return 'unknown';
    }
  }

  /**
   * Roster for a cold session, read from the persisted session metadata
   * (`<sessionDir>/state.json`) and mapped like the live seeding
   * (`descriptorFromMeta`). Returns `undefined` when the session is unknown
   * to the index; an unreadable or missing metadata file yields an empty
   * roster (best-effort — transcripts work without descriptors).
   */
  async readColdRoster(sessionId: string): Promise<AgentDescriptor[] | undefined> {
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return undefined;
    let meta: SessionMeta;
    try {
      const raw = await readFile(
        join(this.deps.homeDir, SESSIONS_ROOT, summary.workspaceId, sessionId, STATE_FILE),
        'utf-8',
      );
      meta = JSON.parse(raw) as SessionMeta;
    } catch {
      return [];
    }
    return Object.entries(meta.agents ?? {}).map(([agentId, agentMeta]) =>
      descriptorFromMeta(agentId, agentMeta),
    );
  }

  /**
   * Rebuild one agent's transcript snapshot for a cold session from its
   * persisted wire records, streaming the wire under the cold-read fences.
   * Cold reads of the same session and agent that carry no `preserveOpenTurnIds`
   * share a single wire scan (that callback decides the projection, so callers
   * with one keep their own scan), and a shared scan is cancelled as soon as no
   * caller is left waiting for it.
   *
   * A tripped fence (`byte_budget` / `record_budget` / `line_budget`) is a read
   * failure, not a shorter history: the caller gets the unreadable-history
   * answer, never a wire prefix presented as a full transcript. A truncated
   * tail still answers with the readable prefix and an unknown tool-call count,
   * which is the historical shape. Returns `undefined` when the session is
   * unknown to the index.
   */
  async readColdSnapshot(
    sessionId: string,
    agentId: string = MAIN_AGENT_ID,
    preserveOpenTurnIds?: () => readonly string[],
    signal?: AbortSignal,
  ): Promise<AgentTranscriptSnapshot | undefined> {
    signal?.throwIfAborted();
    if (preserveOpenTurnIds !== undefined) {
      return this.loadColdSnapshot(
        sessionId,
        agentId,
        preserveOpenTurnIds,
        signal ?? new AbortController().signal,
      );
    }
    const key = `${sessionId}\0${agentId}`;
    let flight = this.coldSnapshotFlights.get(key);
    if (flight !== undefined && !flight.controller.signal.aborted) this.coldReadsShared += 1;
    if (flight === undefined || flight.controller.signal.aborted) {
      const controller = new AbortController();
      let created!: ColdSnapshotFlight;
      const promise = Promise.resolve()
        .then(() => this.loadColdSnapshot(sessionId, agentId, undefined, controller.signal))
        .finally(() => {
          created.settled = true;
          if (this.coldSnapshotFlights.get(key) === created) this.coldSnapshotFlights.delete(key);
        });
      created = { controller, promise, waiters: 0, settled: false };
      flight = created;
      this.coldSnapshotFlights.set(key, flight);
    }
    return this.awaitColdSnapshot(flight, signal);
  }

  private async awaitColdSnapshot(
    flight: ColdSnapshotFlight,
    signal?: AbortSignal,
  ): Promise<AgentTranscriptSnapshot | undefined> {
    signal?.throwIfAborted();
    flight.waiters += 1;
    let onAbort: (() => void) | undefined;
    try {
      if (signal === undefined) return await flight.promise;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          reject(signal.reason ?? new DOMException('The request was aborted', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([flight.promise, aborted]);
    } catch (error) {
      if (signal?.aborted === true) this.coldReadsCancelled += 1;
      throw error;
    } finally {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      flight.waiters -= 1;
      if (flight.waiters === 0 && !flight.settled) {
        flight.controller.abort(
          new DOMException('No cold transcript snapshot readers remain', 'AbortError'),
        );
      }
    }
  }

  private async loadColdSnapshot(
    sessionId: string,
    agentId: string,
    preserveOpenTurnIds: (() => readonly string[]) | undefined,
    signal: AbortSignal,
  ): Promise<AgentTranscriptSnapshot | undefined> {
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return undefined;
    if (!isPlainAgentId(agentId)) return unknownSnapshot();
    const wirePath = join(
      this.deps.homeDir,
      SESSIONS_ROOT,
      summary.workspaceId,
      sessionId,
      AGENTS_DIR,
      agentId,
      WIRE_FILE,
    );
    const transcript = new AgentTranscriptDraft(agentId);
    const reducer = new TranscriptFactReducer(transcript);
    const adapter = new TranscriptWireAdapter(agentId, {
      turn: (turnId) => transcript.getTurn(turnId),
      tool: (toolCallId) => transcript.getToolCall(toolCallId),
      task: (taskId) => transcript.getTask(taskId),
    });
    const info = await stat(wirePath).catch(() => undefined);
    const fingerprint = info === undefined ? undefined : fileIdentity(info);
    const checkpointKey = `${summary.workspaceId}\0${sessionId}\0${agentId}`;
    const checkpointStore = this.deps.core.accessor.get(IQueryStore) as IQueryStore | undefined;
    const checkpoint = fingerprint === undefined || preserveOpenTurnIds !== undefined
      ? undefined
      : await readTranscriptProjectionCheckpoint(
          checkpointStore,
          checkpointKey,
          fingerprint,
          info!.size,
        );
    if (checkpoint !== undefined) {
      transcript.seed(checkpoint.snapshot);
      adapter.restore(checkpoint.adapter);
      reducer.restore(checkpoint.acceptedDurableFacts);
    }
    let complete: boolean;
    let readResult: WireRecordsStreamResult | undefined;
    const startedAt = Date.now();
    try {
      const read = await this.wireRecordReader(wirePath, {
        startByteOffset: checkpoint?.nextByteOffset,
        chunkBytes: this.coldReadLimits.chunkBytes,
        maxBytes: this.coldReadLimits.maxBytes,
        maxRecords: this.coldReadLimits.maxRecords,
        maxLineBytes: this.coldReadLimits.maxLineBytes,
        signal,
        onRecord: (record) => reducer.apply(adapter.add(record)),
      });
      readResult = read;
      this.coldReadsCompleted += 1;
      this.coldReadBytes += read.bytesRead;
      this.coldReadRecords += read.recordCount;
      this.coldReadDurationMs += Date.now() - startedAt;
      if (!read.complete && read.incompleteReason !== 'partial_tail') {
        this.coldReadsFenced += 1;
        this.logColdReadFence(sessionId, agentId, read.incompleteReason ?? 'unknown');
        return unknownSnapshot();
      }
      complete = read.complete;
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('The cold transcript read was aborted', 'AbortError');
      }
      this.logTranscriptFailure(sessionId, agentId, error);
      return unknownSnapshot();
    }
    try {
      const preservedTurns: TranscriptTurn[] = [];
      for (const turnId of preserveOpenTurnIds?.() ?? []) {
        const candidate = transcript.getTurn(turnId);
        if (candidate?.state === 'running') preservedTurns.push(structuredClone(candidate));
      }
      if (
        preserveOpenTurnIds === undefined &&
        complete &&
        readResult !== undefined &&
        fingerprint !== undefined &&
        (checkpoint?.recordCount ?? 0) + readResult.recordCount >= TRANSCRIPT_CHECKPOINT_MIN_RECORDS
      ) {
        const seed = transcript.checkpoint();
        const checkpointPayload: TranscriptProjectionCheckpoint = {
          format: TRANSCRIPT_CHECKPOINT_FORMAT,
          fingerprint,
          nextByteOffset: readResult.nextByteOffset,
          recordCount: (checkpoint?.recordCount ?? 0) + readResult.recordCount,
          snapshot: seed,
          adapter: adapter.checkpoint(),
          acceptedDurableFacts: reducer.checkpoint(),
        };
        if (checkpointStore !== undefined) {
          await checkpointStore.put(
            TRANSCRIPT_CHECKPOINT_COLLECTION,
            checkpointKey,
            checkpointPayload,
          ).catch(() => undefined);
        }
      }
      reducer.apply(adapter.finish());
      for (const turn of preservedTurns) transcript.apply(snapshotTurnOps(turn));
      const snapshot = transcript.snapshot();
      return complete
        ? knownSnapshot(snapshot, countToolCallFrames(snapshot.items))
        : { ...snapshot, toolCallCount: undefined, toolCallCountKnown: false };
    } catch (error) {
      this.logTranscriptFailure(sessionId, agentId, error);
      return unknownSnapshot();
    }
  }

  private async invalidateProjectionCheckpoint(sessionId: string, agentId: string): Promise<void> {
    const store = this.deps.core.accessor.get(IQueryStore) as IQueryStore | undefined;
    if (store === undefined) return;
    const summary = await this.deps.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) return;
    const key = `${summary.workspaceId}\0${sessionId}\0${agentId}`;
    await store.delete(TRANSCRIPT_CHECKPOINT_COLLECTION, key).catch(() => undefined);
  }

  async reconcileAfterRewrite(sessionId: string, agentId: string = MAIN_AGENT_ID): Promise<void> {
    await this.invalidateProjectionCheckpoint(sessionId, agentId);
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    const transcript = entry.store.ensureAgent(agentId);
    entry.agentHistory.set(agentId, { status: 'pending' });
    this.dispatchToolCallCount(sessionId, transcript, undefined, true);
    const initialActiveTurnId = this.liveActiveTurnId(sessionId, agentId);
    let snapshot: AgentTranscriptSnapshot | undefined;
    try {
      snapshot = await this.readColdSnapshot(
        sessionId,
        agentId,
        () => this.liveActiveTurnIds(sessionId, agentId, initialActiveTurnId),
      );
    } catch (error) {
      this.logTranscriptFailure(sessionId, agentId, error);
    }
    if (
      snapshot === undefined ||
      !snapshotToolCallCountKnown(snapshot) ||
      this.live.get(sessionId) !== entry
    ) {
      const failureSignature = await this.historyFailureSignature(sessionId, agentId);
      entry.agentHistory.set(agentId, { status: 'failed', failureSignature });
      this.dispatchToolCallCount(sessionId, transcript, undefined, true);
      return;
    }
    transcript.apply([
      {
        op: 'reset',
        agentId,
        grade: 'delta',
        coverage: { kind: 'full', hasMoreOlder: false },
        snapshot,
      },
    ]);
    const materialized = transcript.snapshot();
    entry.agentToolCallStates.set(agentId, toolCallStateFromSnapshot(materialized));
    entry.agentHistory.set(agentId, { status: 'complete' });
    this.dispatchToolCallCount(sessionId, transcript, countToolCallFrames(materialized.items), true);
    const journal = entry.opsJournals.get(agentId);
    if (journal !== undefined) this.disposeOpsJournal(entry, journal);
    entry.opsJournals.set(agentId, { epoch: randomUUID(), nextSeq: 1, start: 0, batches: [], bytes: 0 });
  }

  private resolveResidentLimits(): TranscriptResidentLimits | undefined {
    if (this.deps.residentLimits === false) return undefined;
    if (this.deps.residentLimits !== undefined) return this.deps.residentLimits;
    const flags = this.deps.core.accessor.get(IFlagService) as IFlagService | undefined;
    if (flags?.enabled(TRANSCRIPT_RESIDENT_WINDOW_FLAG_ID) !== true) return undefined;
    const configured = (this.deps.core.accessor.get(IConfigService) as IConfigService | undefined)
      ?.get<TranscriptMemoryConfig>(TRANSCRIPT_MEMORY_SECTION);
    const config = { ...DEFAULT_TRANSCRIPT_MEMORY_CONFIG, ...(configured ?? {}) };
    return { tailTurns: config.tailTurns, maxBytes: config.maxAgentBytes };
  }

  memoryReport(): TranscriptMemoryReport {
    let liveAgents = 0;
    let residentTurns = 0;
    let residentBytes = 0;
    let trimmedTurns = 0;
    let overBudgetAgents = 0;
    let opsJournalBatches = 0;
    for (const entry of this.live.values()) {
      const agentIds = new Set([
        ...entry.store.agents().map((descriptor) => descriptor.agentId),
        ...entry.agentHistory.keys(),
      ]);
      liveAgents += agentIds.size;
      for (const agentId of agentIds) {
        const transcript = entry.store.getAgent(agentId);
        if (transcript !== undefined) {
          const report = transcript.residentReport();
          residentTurns += report.turns;
          residentBytes += report.estimatedBytes;
          trimmedTurns += report.trimmedTurns;
          if (report.overBudget) overBudgetAgents += 1;
        }
      }
      for (const journal of entry.opsJournals.values()) {
        opsJournalBatches += this.opsJournalBatchCount(journal);
      }
    }
    return {
      liveSessions: this.live.size,
      liveAgents,
      residentTurns,
      residentBytes,
      trimmedTurns,
      overBudgetAgents,
      opsJournalBytes: this.opsJournalTotalBytes,
      opsJournalBatches,
      opsJournalDroppedBytes: this.opsJournalDroppedBytes,
      toolCallCacheEntries: this.persistedToolCallStates.size,
      toolCallCacheBytes: this.persistedToolCallStateWeight,
      eventLoopDelay: {
        meanMs: Number.isFinite(this.eventLoopDelay.mean) ? this.eventLoopDelay.mean / 1e6 : 0,
        maxMs: this.eventLoopDelay.max / 1e6,
        p99Ms: this.eventLoopDelay.percentile(99) / 1e6,
      },
      coldReads: {
        completed: this.coldReadsCompleted,
        shared: this.coldReadsShared,
        cancelled: this.coldReadsCancelled,
        fenced: this.coldReadsFenced,
        bytes: this.coldReadBytes,
        records: this.coldReadRecords,
        durationMs: this.coldReadDurationMs,
      },
    };
  }

  dispose(): void {
    this.eventLoopDelay.disable();
    for (const sessionId of [...this.live.keys()]) this.dropSession(sessionId);
  }

  /** Dispose the live store + binding for a session (session closed / server shutdown). */
  dropSession(sessionId: string): void {
    this.opsListeners.delete(sessionId);
    const entry = this.live.get(sessionId);
    if (entry === undefined) return;
    this.live.delete(sessionId);
    for (const journal of entry.opsJournals.values()) {
      this.disposeOpsJournal(entry, journal);
    }
    entry.agentDisposal.dispose();
    entry.binding.dispose();
  }
}

export function countToolCallFrames(items: AgentTranscriptSnapshot['items']): number {
  let count = 0;
  for (const item of items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      count += step.frames.filter((frame) => frame.kind === 'tool').length;
    }
  }
  return count;
}

function toolCallStateFromSnapshot(
  snapshot: AgentTranscriptSnapshot,
): MaterializedAgentToolCallState {
  const toolCallState: MaterializedAgentToolCallState = {
    toolFrameIdsByTurn: new Map(),
    toolCallCount: 0,
  };
  for (const item of snapshot.items) {
    if (item.kind !== 'turn') continue;
    for (const step of item.steps) {
      for (const frame of step.frames) {
        if (frame.kind === 'tool') {
          addToolFrame(toolCallState, item.turnId, step.stepId, frame.frameId);
        }
      }
    }
  }
  return toolCallState;
}

function applyToolCallOps(
  toolCallState: MaterializedAgentToolCallState,
  ops: readonly TranscriptOperation[],
): void {
  for (const op of ops) {
    if (op.op === 'reset') {
      const replacement = toolCallStateFromSnapshot(op.snapshot);
      toolCallState.toolFrameIdsByTurn.clear();
      for (const [turnId, frameIds] of replacement.toolFrameIdsByTurn) {
        toolCallState.toolFrameIdsByTurn.set(turnId, frameIds);
      }
      toolCallState.toolCallCount = replacement.toolCallCount;
    } else if (op.op === 'frame.upsert') {
      if (op.frame.kind === 'tool') {
        addToolFrame(toolCallState, op.turnId, op.stepId, op.frame.frameId);
      } else {
        removeToolFrame(toolCallState, op.turnId, op.stepId, op.frame.frameId);
      }
    } else if (op.op === 'items.remove') {
      for (const itemId of op.ids) removeToolTurn(toolCallState, itemId);
    }
  }
}

function addToolFrame(
  toolCallState: MaterializedAgentToolCallState,
  turnId: string,
  stepId: string,
  frameId: string,
): void {
  let frameIds = toolCallState.toolFrameIdsByTurn.get(turnId);
  if (frameIds === undefined) {
    frameIds = new Set();
    toolCallState.toolFrameIdsByTurn.set(turnId, frameIds);
  }
  const key = `${stepId}\0${frameId}`;
  if (frameIds.has(key)) return;
  frameIds.add(key);
  toolCallState.toolCallCount += 1;
}

function removeToolFrame(
  toolCallState: MaterializedAgentToolCallState,
  turnId: string,
  stepId: string,
  frameId: string,
): void {
  const frameIds = toolCallState.toolFrameIdsByTurn.get(turnId);
  if (frameIds === undefined) return;
  if (!frameIds.delete(`${stepId}\0${frameId}`)) return;
  toolCallState.toolCallCount -= 1;
  if (frameIds.size === 0) toolCallState.toolFrameIdsByTurn.delete(turnId);
}

function removeToolTurn(
  toolCallState: MaterializedAgentToolCallState,
  turnId: string,
): void {
  const frameIds = toolCallState.toolFrameIdsByTurn.get(turnId);
  if (frameIds === undefined) return;
  toolCallState.toolCallCount -= frameIds.size;
  toolCallState.toolFrameIdsByTurn.delete(turnId);
}

/**
 * Flatten a snapshot into idempotent upsert ops (turn/step/frame upserts,
 * standalone items, tasks, meta). Deliberately never a `reset`: upserts merge
 * by id and keep ordinal order, so the backfill cannot clobber live ops that
 * landed while the records were being read. Global attachment entities flatten
 * too — without them a backfilled turn's `attachmentIds` would dangle.
 *
 * Standalone items (markers / taskrefs) carry a `beforeTurn` placement anchor:
 * the reducer's standalone path is append-only, so without an anchor a
 * historical marker replayed after live turns arrived would land past them.
 * The anchor is the ordinal of the snapshot turn directly following the item
 * (trailing items anchor past the last snapshot turn, which is where the
 * engine's next live turn lands); a turn-anchored insert places the item
 * before the first turn with `ordinal >= beforeTurn`.
 *
 * `turnOps` customizes the per-turn flattening (the backfill passes a
 * live-first merge; the default flattens wholesale for cold reads).
 */
export function snapshotToOps(
  snapshot: AgentTranscriptSnapshot,
  turnOps: (turn: TranscriptTurn) => TranscriptOperation[] = snapshotTurnOps,
): TranscriptOperation[] {
  const ops: TranscriptOperation[] = [];
  const pending: (TranscriptMarker | TranscriptTaskRef)[] = [];
  let lastTurnOrdinal: number | undefined;
  const flushPending = (beforeTurn?: number): void => {
    for (const item of pending) {
      ops.push(
        item.kind === 'marker'
          ? { op: 'marker.upsert', item, beforeTurn }
          : { op: 'taskref.upsert', item, beforeTurn },
      );
    }
    pending.length = 0;
  };
  for (const item of snapshot.items) {
    if (item.kind === 'turn') {
      flushPending(item.ordinal);
      lastTurnOrdinal = item.ordinal;
      ops.push(...turnOps(item));
    } else {
      pending.push(item);
    }
  }
  flushPending(lastTurnOrdinal === undefined ? undefined : lastTurnOrdinal + 1);
  for (const attachment of snapshot.attachments) {
    ops.push({ op: 'attachment.upsert', attachment });
  }
  for (const task of snapshot.tasks) {
    ops.push({ op: 'task.upsert', task });
  }
  for (const interaction of snapshot.interactions) {
    ops.push({ op: 'interaction.upsert', interaction });
  }
  for (const todo of snapshot.todos) {
    ops.push({ op: 'todo.upsert', todo });
  }
  for (const prompt of snapshot.prompts) {
    ops.push({ op: 'prompt.upsert', prompt });
  }
  ops.push({ op: 'meta.merge', meta: snapshot.meta });
  return ops;
}

/** One snapshot turn flattened wholesale (the cold / unseen-turn path). */
export function snapshotTurnOps(turn: TranscriptTurn): TranscriptOperation[] {
  const ops: TranscriptOperation[] = [];
  const { steps, ...header } = turn;
  ops.push({ op: 'turn.upsert', turn: header });
  for (const step of steps) {
    const { frames, ...stepHeader } = step;
    ops.push({ op: 'step.upsert', turnId: turn.turnId, step: stepHeader });
    for (const frame of frames) {
      ops.push({ op: 'frame.upsert', turnId: turn.turnId, stepId: step.stepId, frame });
    }
  }
  return ops;
}

function toolCallCountSetOperation(count: number | undefined): TranscriptOperation {
  const operation: ToolCountSetOp = { op: 'tool.count.set', count };
  return operation;
}

function snapshotToolCallCountKnown(snapshot: AgentTranscriptSnapshot): boolean {
  return snapshot.toolCallCountKnown !== false;
}

function knownSnapshot(snapshot: AgentTranscriptSnapshot, count: number): AgentTranscriptSnapshot {
  return {
    ...snapshot,
    toolCallCount: count,
    toolCallCountKnown: true,
  };
}

function unknownSnapshot(): AgentTranscriptSnapshot {
  return {
    items: [],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    toolCallCount: undefined,
    toolCallCountKnown: false,
    meta: {},
  };
}

function fileFingerprint(info: {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}): string {
  return `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

function fileIdentity(info: {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly birthtimeMs: number;
}): string {
  return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
}

async function readTranscriptProjectionCheckpoint(
  store: IQueryStore | undefined,
  key: string,
  fingerprint: string,
  fileSize: number,
): Promise<TranscriptProjectionCheckpoint | undefined> {
  if (store === undefined) return undefined;
  try {
    const value = await store.get<TranscriptProjectionCheckpoint>(
      TRANSCRIPT_CHECKPOINT_COLLECTION,
      key,
    );
    if (value === undefined) return undefined;
    if (
      value.format !== TRANSCRIPT_CHECKPOINT_FORMAT ||
      value.fingerprint !== fingerprint ||
      !Number.isSafeInteger(value.nextByteOffset) ||
      value.nextByteOffset < 0 ||
      value.nextByteOffset > fileSize ||
      (value.adapter?.version !== 1 && value.adapter?.version !== 2) ||
      !Array.isArray(value.acceptedDurableFacts)
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function mergeToolCallCount(
  persisted: MaterializedAgentToolCallState,
  live: MaterializedAgentToolCallState | undefined,
): number {
  let count = persisted.toolCallCount;
  for (const [turnId, frameIds] of live?.toolFrameIdsByTurn ?? []) {
    const prior = persisted.toolFrameIdsByTurn.get(turnId);
    for (const frameId of frameIds) if (!prior?.has(frameId)) count += 1;
  }
  return count;
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function nonNegativeLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function estimateOpsJournalBatchBytes(ops: readonly TranscriptOperation[], cap: number): number {
  let bytes = 0;
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [];
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    stack.push({ value: ops[index], depth: 0 });
  }
  while (stack.length > 0) {
    const node = stack.pop()!;
    const value = node.value;
    if (typeof value === 'string') {
      bytes += value.length * 2;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      bytes += OPS_JOURNAL_ESTIMATE_SCALAR_BYTES;
    } else if (typeof value === 'object' && value !== null) {
      bytes += OPS_JOURNAL_ESTIMATE_NODE_OVERHEAD_BYTES;
      if (node.depth < OPS_JOURNAL_ESTIMATE_MAX_DEPTH) {
        const depth = node.depth + 1;
        if (Array.isArray(value)) {
          for (let index = value.length - 1; index >= 0; index -= 1) {
            stack.push({ value: value[index], depth });
          }
        } else {
          for (const nested of Object.values(value)) {
            stack.push({ value: nested, depth });
          }
        }
      }
    }
    if (bytes > cap) return bytes;
  }
  return bytes;
}
