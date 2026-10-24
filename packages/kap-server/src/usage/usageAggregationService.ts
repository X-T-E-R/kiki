import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import {
  AGENT_WIRE_RECORD_KEY,
  type UsageFact,
  type UsageFactTotals,
  type UsageFactReadBudget,
  IUsageFactStore,
  UsageFactCursorChangedError,
  IQueryStore,
  IAppendLogStore,
  IFileSystemStorageService,
  IRetainedUsageService,
  ISessionIndex,
  agentScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
  type EphemeralUsageTotal,
  type RetainedUsageRecord,
  type Scope,
  type SessionSummary,
  type TokenUsage,
} from '@kiki/agent-core-v2';
import type { UsageAggregateWire, UsageQuery, UsageResponse, UsageRescanStatus } from '@kiki/protocol';

import { IModelPricingService } from '../pricing/modelPricingService';
import type { UsageSourceChanges } from './usageSourceTracker';
import { UsageReadAllowance } from '@kiki/agent-core-v2/agent/usage/usageWireFramer';
import { readUsageWireTail, usageRecoveryPool, type UsageRecoveryPool, type WireLineContinuation } from './usageRecovery';
import { UsageRangeFold, type FoldBucketView, type FoldedUsageRecord } from './usageRangeFold';
import { appendProjectionAgent, appendStoredBuckets, bucketsFromAgents, buildRangeProjection, hasProjectionTurnEvidence, parseUsageRangeProjection, projectionFileName, projectionRows, projectionSessionOf, UsageProjectionFold, type UsageProjectionAgent, type UsageRangeProjection } from './usageRangeProjection';

const SOURCE_RECHECK_MS = 10 * 60_000;

const DEFAULT_PAGE_SIZE = 50;
const INDEX_PAGE_SIZE = 100;
const CHECKPOINT_READ_CONCURRENCY = 8;
const AGENT_STAT_CONCURRENCY = 16;
const PROJECTION_STAT_CONCURRENCY = 64;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PERSISTENCE_SCOPE = 'cache/usage-aggregation-v1';
const PERSISTENCE_VERSION = 1;
const BOUNDARY_BYTES = 4 * 1024;
const FACT_JOURNAL_KEY = 'facts.jsonl';
const DEFAULT_LIMITS: UsageAggregationLimits = {
  sessionScanLimit: 500,
  wireRecordBudget: Infinity,
  usageFactBudget: 200_000,
  deadlineMs: 10_000,
  cacheTtlMs: 0,
  cacheMaxEntries: 500,
  cacheMaxRecords: 200_000,
  cacheMaxEntryRecords: 100_000,
  cacheMaxBytes: 128 * 1024 * 1024,
  drilldownSessionLimit: 100,
  drilldownTurnLimit: 100,
};

export interface UsageAggregationLimits {
  readonly sessionScanLimit: number;
  readonly wireRecordBudget: number;
  readonly usageFactBudget: number;
  readonly deadlineMs: number;
  readonly cacheTtlMs: number;
  readonly cacheMaxEntries: number;
  readonly cacheMaxRecords: number;
  readonly cacheMaxEntryRecords: number;
  readonly cacheMaxBytes: number;
  readonly drilldownSessionLimit: number;
  readonly drilldownTurnLimit: number;
}

export type NormalizedUsageRecord = UsageFact & { readonly folded?: FoldedUsageRecord['folded'] };

export interface UsageExportSource {
  readonly key: string;
  readonly workspaceId: string;
  readonly kind: 'session' | 'ephemeral';
  readonly records: readonly NormalizedUsageRecord[];
}

interface SessionRecords {
  readonly summary: SessionSummary;
  readonly records: readonly NormalizedUsageRecord[];
  readonly complete: boolean;
  readonly deleted: boolean;
}

interface SessionCacheEntry {
  readonly expiresAt: number;
  readonly persisted: PersistentSessionRecords;
  readonly complete: boolean;
  readonly bytes: number;
  readonly view?: SessionCacheView;
  verifiedAt?: number;
}

interface SessionCacheView {
  readonly startAt: number;
  readonly endAt: number;
  readonly parts: readonly string[];
}

interface PreparedSession {
  readonly persisted: PersistentSessionRecords;
  readonly current: boolean;
  readonly view: boolean;
}

interface WireCheckpoint {
  readonly generation?: string;
  readonly offset: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly boundaryHash: string;
  readonly valid: boolean;
}

interface PersistentSessionRecords {
  readonly version: number;
  readonly sessionKey: string;
  readonly records: readonly NormalizedUsageRecord[];
  readonly agents: Readonly<Record<string, WireCheckpoint>>;
  readonly readComplete?: boolean;
  readonly incompleteReason?: 'deadline' | 'record_budget';
}

interface SessionLoadResult {
  readonly session: SessionRecords;
  readonly persisted: PersistentSessionRecords;
  readonly scannedRecordCount: number;
  readonly scannedFactCount?: number;
  readonly incompleteReason: UsageResponse['reliability']['incomplete_reason'];
  readonly targetedAgentIds?: readonly string[];
}

export interface AgentUsageProjection {
  readonly records: readonly NormalizedUsageRecord[];
  readonly totals?: UsageFactTotals;
  readonly complete: boolean;
}

export interface AgentUsageReadOptions {
  readonly signal?: AbortSignal;
  readonly maxRecords?: number;
  readonly maxFacts?: number;
  readonly summaryOnly?: boolean;
  readonly maxBytes?: number;
  readonly deadlineAt?: number;
  readonly rangeStart?: number;
}

interface ScanBudget {
  readonly signal?: AbortSignal;
  factSignal?: AbortSignal;
  factBudget?: UsageFactReadBudget;
  remainingRecords: number;
  remainingFacts?: number;
  readonly deadlineAt: number;
  sourcesComplete: boolean;
  incompleteReason: UsageResponse['reliability']['incomplete_reason'];
}

interface RangeBounds {
  readonly preset: UsageResponse['query']['range']['preset'];
  readonly startAt?: number;
  readonly endAt?: number;
  readonly defaultedToAllHistory: boolean;
}

interface NormalizedQuery {
  readonly granularity: UsageResponse['query']['granularity'];
  readonly range: RangeBounds;
  readonly dimension: UsageResponse['query']['dimension'];
  readonly models: readonly string[];
  readonly providers: readonly string[];
  readonly profiles: readonly string[];
  readonly agentIds: readonly string[];
  readonly workspaceIds: readonly string[];
  readonly includeArchived: boolean;
  readonly timezoneOffsetMinutes: number;
  readonly pageSize: number;
}

interface ListedSessions {
  readonly items: readonly SessionSummary[];
  readonly activeKeys: ReadonlySet<string>;
}

interface UsageFoldView {
  recordPage(cursor?: string): Promise<{ items: readonly { readonly sessionId: string; readonly record: NormalizedUsageRecord }[]; nextCursor?: string }>;
  buckets(keys: readonly string[]): Promise<{ values(): Iterable<FoldBucketView> }>;
}

interface RangeFoldSource {
  readonly agentId: string;
  readonly scope: string;
  checkpoint: WireCheckpoint;
  cursor?: string;
  done: boolean;
}

interface RangeFoldSession {
  readonly summary: SessionSummary;
  sources?: RangeFoldSource[];
  invalid: boolean;
  prepared: boolean;
}

interface RangeFoldHead {
  readonly version: 1;
  readonly fingerprint: string;
  readonly sessions: RangeFoldSession[];
  complete: boolean;
  inventoryComplete: boolean;
  invalidated: boolean;
}

interface AggregateAccumulator {
  usage: TokenUsage;
  cost: number;
  costUnknown: boolean;
  knownRecords: number;
  missingRecords: number;
  legacyZeroRecords: number;
}

interface GroupAccumulator extends AggregateAccumulator {
  readonly key: string;
  readonly providers: Set<string | null>;
  readonly modelAliases: Set<string | null>;
  readonly agentIds: Set<string | null>;
  readonly parentAgentIds: Set<string | null>;
  readonly profileNames: Set<string | null>;
}

interface DrilldownSessionAccumulator {
  readonly sessionId: string;
  readonly turnIds: Set<number>;
  unknownTurnRecords: number;
}

interface BucketAccumulator {
  readonly key: string;
  startAt: number;
  endAt: number;
  readonly groups: Map<string, GroupAccumulator>;
  readonly turnKeys: Set<string>;
  requestCount: number;
  readonly drilldownSessions: Map<string, DrilldownSessionAccumulator>;
  drilldownSessionsTruncated: boolean;
}

interface SessionAccumulator extends AggregateAccumulator {
  readonly summary: SessionSummary;
  readonly deleted: boolean;
  readonly unknownPriceModels: Set<string>;
  readonly modelCounts: Map<string, number>;
  readonly profileNames: Set<string>;
}

export class UsagePageTokenMismatchError extends Error {}

/** Incremental usage projection for managed append/rewrite stores. Tracked sources reuse complete verified checkpoints until an event or a ten-minute safety recheck; untracked sources, export and rescan validate inventories, sizes and mtimes. Bounded views never replace full checkpoints. External rewrites preserving size and mtime remain outside the consistency contract. A bounded range does not read a source whose filesystem mtime is an epoch millisecond older than the range start: usage record time is assigned before that write, and a later append moves mtime. A complete bounded query stores an unpriced folded projection; the next process reads it back when every in-range watermark still matches, and a pure append folds only its tail. A default-budget fold replays fact journals from a byte cursor and pages those facts before opening further sources. */
export class UsageAggregationService {
  private readonly cache = new Map<string, SessionCacheEntry>();
  private readonly pendingWireLines = new Map<string, WireLineContinuation>();
  private readonly sessionFlights = new Map<string, Promise<SessionLoadResult>>();
  private readonly queryFlights = new Map<string, {
    controller: AbortController; promise: Promise<UsageResponse>; waiters: number; settled: boolean;
  }>();
  private readonly limits: UsageAggregationLimits;
  private cachedRecordCount = 0;
  private cachedBytes = 0;
  private rescan: UsageRescanStatus = {
    state: 'idle', scanned_sessions: 0, total_sessions: 0, scanned_records: 0,
    started_at: null, finished_at: null, error: null,
  };
  private fullScanKeys: ReadonlySet<string> | undefined;
  private inventoryReady: Promise<void> | undefined;
  private exportRetainedIterator: AsyncGenerator<import('@kiki/agent-core-v2').RetainedUsageExportEvent> | undefined;
  private readonly exportEphemeralRecords = new Map<string, NormalizedUsageRecord[]>();
  private exportRetainedIncomplete = false;
  private exportCursor: string | undefined;
  private exportAtRetained = false;
  private readonly exportActiveKeys = new Set<string>();

  rescanStatus(): UsageRescanStatus {
    return { ...this.rescan };
  }

  startFullRescan(): UsageRescanStatus {
    if (this.rescan.state === 'running') return this.rescanStatus();
    this.rescan = {
      state: 'running', scanned_sessions: 0, total_sessions: 0, scanned_records: 0,
      started_at: this.now(), finished_at: null, error: null,
    };
    void this.runFullRescan().then(() => {
      this.rescan = { ...this.rescan, state: 'completed', finished_at: this.now() };
    }, (error: unknown) => {
      this.rescan = {
        ...this.rescan, state: 'failed', finished_at: this.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    });
    return this.rescanStatus();
  }

  private async prepareInventory(): Promise<void> {
    this.inventoryReady ??= (async () => {
      try {
        const bytes = await this.core.accessor.get(IFileSystemStorageService).read(PERSISTENCE_SCOPE, 'full-scan.json');
        if (bytes === undefined) return;
        const keys: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
        if (Array.isArray(keys) && keys.every((key) => typeof key === 'string')) {
          this.fullScanKeys = new Set(keys);
        }
      } catch {}
    })();
    await this.inventoryReady;
  }

  private async runFullRescan(): Promise<void> {
    await this.prepareInventory();
    const listed = await this.listSessions(normalizeQuery({ include_archived: 'true' }, this.now()), {
      remainingRecords: Infinity, deadlineAt: Infinity, sourcesComplete: true, incompleteReason: null,
    }, true);
    this.rescan = { ...this.rescan, total_sessions: listed.items.length };
    const keys = new Set<string>();
    for (const summary of listed.items) {
      const key = sessionKey(summary);
      await this.sessionFlights.get(key);
      const flight = this.loadSessionIncremental(summary, Infinity, Infinity, () => {
        this.rescan = { ...this.rescan, scanned_records: this.rescan.scanned_records + 1 };
      });
      this.sessionFlights.set(key, flight);
      let result: SessionLoadResult;
      try {
        result = await flight;
      } finally {
        if (this.sessionFlights.get(key) === flight) this.sessionFlights.delete(key);
      }
      this.cacheSession(key, result.persisted, result.session.complete);
      this.rescan = { ...this.rescan, scanned_sessions: this.rescan.scanned_sessions + 1 };
      if (!result.session.complete) throw new Error(`Usage checkpoint is incomplete for session ${summary.id}`);
      keys.add(key);
      await yieldToEventLoop();
    }
    await this.core.accessor.get(IFileSystemStorageService).write(
      PERSISTENCE_SCOPE, 'full-scan.json', Buffer.from(JSON.stringify([...keys])), { atomic: true },
    );
    this.fullScanKeys = keys;
  }

  constructor(
    private readonly core: Scope,
    private readonly now: () => number = Date.now,
    limits: Partial<UsageAggregationLimits> = {},
    private readonly sourceChanges?: UsageSourceChanges,
    private readonly recovery: UsageRecoveryPool = usageRecoveryPool(core),
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.sourceSubscription = sourceChanges?.onDidChange((key) => {
      this.replayEpoch++;
      if (this.loadedProjection !== undefined) this.loadedProjection = { ...this.loadedProjection, verifiedAt: 0 };
      if (key === undefined || this.sourceRevisions.size >= 4096) {
        this.sourceRevision++;
        this.sourceRevisions.clear();
        for (const entry of this.cache.values()) entry.verifiedAt = undefined;
      } else {
        this.sourceRevisions.set(key, (this.sourceRevisions.get(key) ?? 0) + 1);
        const entry = this.cache.get(key);
        if (entry !== undefined) entry.verifiedAt = undefined;
      }
    });
  }

  private sourceRevision = 0;
  private replayEpoch = 0;
  private loadedProjection: { fingerprint: string; projection: UsageRangeProjection; epoch: number; verifiedAt: number } | undefined;
  private readonly sourceRevisions = new Map<string, number>();
  private readonly sourceSubscription?: { dispose(): void };

  dispose(): void {
    this.sourceSubscription?.dispose();
    for (const flight of this.queryFlights.values()) flight.controller.abort();
    this.queryFlights.clear();
    this.pendingWireLines.clear();
    this.recovery.dispose();
  }

  private revisionOf(key: string): string {
    return `${this.sourceRevision}:${this.sourceRevisions.get(key) ?? 0}`;
  }

  private rememberVerified(key: string, persisted: PersistentSessionRecords, revision: string): void {
    const entry = this.cache.get(key);
    if (entry?.complete && entry.persisted.agents === persisted.agents && revision === this.revisionOf(key) &&
      (entry.verifiedAt === undefined || this.now() - entry.verifiedAt >= SOURCE_RECHECK_MS)) {
      entry.verifiedAt = this.now();
    }
  }

  cacheStatus(): { readonly entries: number; readonly records: number } {
    return { entries: this.cache.size, records: this.cachedRecordCount };
  }

  async readAgentUsage(
    workspaceId: string,
    sessionId: string,
    agentIds: readonly string[],
    options: AgentUsageReadOptions = {},
  ): Promise<Readonly<Record<string, AgentUsageProjection>>> {
    options.signal?.throwIfAborted();
    const deadline = new AbortController();
    const duration = (options.deadlineAt ?? Infinity) - this.now();
    const timer = Number.isFinite(duration) ? setTimeout(() => { deadline.abort(new DOMException('Agent usage deadline', 'TimeoutError')); }, Math.max(0, duration)) : undefined;
    timer?.unref();
    const factSignal = options.signal === undefined ? deadline.signal : AbortSignal.any([options.signal, deadline.signal]);
    const bounded = Number.isFinite(duration) || options.maxFacts !== undefined || options.maxRecords !== undefined || options.maxBytes !== undefined;
    const factBudget = bounded ? { remainingRecords: options.maxFacts ?? this.limits.usageFactBudget ?? Infinity } : undefined;
    const rows: Record<string, AgentUsageProjection> = {};
    try {
      await waitForSource(this.readAgentUsageSources(workspaceId, sessionId, agentIds, { ...options, factSignal, factBudget }, rows), factSignal);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!deadline.signal.aborted) throw error;
    } finally { if (timer !== undefined) clearTimeout(timer); }
    for (const id of agentIds) rows[id] ??= { records: [], complete: false };
    return rows;
  }

  private async readAgentUsageSources(
    workspaceId: string,
    sessionId: string,
    agentIds: readonly string[],
    options: AgentUsageReadOptions & { factSignal?: AbortSignal; factBudget?: UsageFactReadBudget },
    rows: Record<string, AgentUsageProjection>,
  ): Promise<Readonly<Record<string, AgentUsageProjection>>> {
    const summary: SessionSummary = { id: sessionId, workspaceId, createdAt: 0, updatedAt: 0, archived: false };
    const key = sessionKey(summary);
    for (;;) {
      const pending = this.sessionFlights.get(key);
      if (pending === undefined) break;
      try {
        await waitForSource(pending, options.factSignal);
      } catch (error) {
        options.factSignal?.throwIfAborted();
        if (!(error instanceof Error) || (error.name !== 'AbortError' && error.name !== 'TimeoutError')) throw error;
      }
    }
    options.factSignal?.throwIfAborted();
    const ids = [...new Set(agentIds)];
    if (options.summaryOnly) {
      const facts = this.core.accessor.get(IUsageFactStore);
      const storage = this.core.accessor.get(IFileSystemStorageService);
      const logs = this.core.accessor.get(IAppendLogStore);
      const sessionScope = sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId);
      for (const id of ids) {
        options.factSignal?.throwIfAborted();
        if (this.now() >= (options.deadlineAt ?? Infinity)) return rows;
        const scope = agentScopeOf(sessionScope, id);
        const generation = await waitForSource(logs.generation(scope, AGENT_WIRE_RECORD_KEY), options.factSignal);
        const [size, mtimeMs, projected] = await waitForSource(Promise.all([storage.size(scope, AGENT_WIRE_RECORD_KEY), storage.mtime(scope, AGENT_WIRE_RECORD_KEY), facts.summary(scope, options.factSignal, { budget: options.factBudget })]), options.factSignal);
        if (projected.readComplete === false) return rows;
        const checkpoint = projected.checkpoint;
        if (checkpoint?.valid && checkpoint.offset === (size ?? 0) && checkpoint.size === (size ?? 0) && checkpoint.mtimeMs === (mtimeMs ?? 0) && checkpoint.generation === generation && projected.totals !== undefined && await waitForSource(logs.generation(scope, AGENT_WIRE_RECORD_KEY), options.factSignal) === generation) {
          rows[id] = { records: [], totals: projected.totals, complete: true };
        }
      }
    }
    const missing = ids.filter((id) => rows[id] === undefined);
    if (missing.length === 0 || this.now() >= (options.deadlineAt ?? Infinity) || (options.factBudget?.remainingRecords ?? Infinity) <= 0) return rows;
    const flight = this.loadSessionIncremental(
      summary, options.maxRecords ?? Infinity, options.deadlineAt ?? Infinity,
      undefined, false, undefined, missing, options,
    );
    this.sessionFlights.set(key, flight);
    try {
      const result = await flight;
      options.factSignal?.throwIfAborted();
      if (result.persisted.readComplete !== false) this.cacheSession(key, result.persisted, false);
      const grouped = new Map<string | undefined, NormalizedUsageRecord[]>();
      for (const record of result.session.records) {
        const records = grouped.get(record.sourceAgentId) ?? [];
        records.push(record);
        grouped.set(record.sourceAgentId, records);
      }
      for (const id of missing) {
        const checkpoint = result.persisted.agents[id];
        rows[id] = {
          records: grouped.get(id) ?? [],
          complete: result.session.complete && checkpoint?.valid === true && checkpoint.offset === checkpoint.size,
        };
      }
      return rows;
    } finally {
      if (this.sessionFlights.get(key) === flight) this.sessionFlights.delete(key);
    }
  }

  async resetExportRead(): Promise<void> {
    await this.exportRetainedIterator?.return(undefined); this.exportRetainedIterator = undefined; this.exportEphemeralRecords.clear(); this.exportRetainedIncomplete = false;
    this.exportCursor = undefined; this.exportAtRetained = false; this.exportActiveKeys.clear();
  }

  async invalidateExportCheckpoints(): Promise<void> {
    await this.resetExportRead();
    this.cache.clear(); this.cachedRecordCount = 0; this.cachedBytes = 0;
    const storage = this.core.accessor.get(IFileSystemStorageService);
    for (const key of await storage.list(PERSISTENCE_SCOPE)) await storage.delete(PERSISTENCE_SCOPE, key);
    this.fullScanKeys = undefined;
  }

  async readExportSources(
    consume: (source: UsageExportSource) => Promise<void>,
    includeEphemeral = false,
  ): Promise<{ complete: boolean; reason: string | null; sources: number }> {
    const budget: ScanBudget = { remainingRecords: this.limits.wireRecordBudget, deadlineAt: this.now() + this.limits.deadlineMs, sourcesComplete: true, incompleteReason: null };
    const index = this.core.accessor.get(ISessionIndex);
    const active = this.exportActiveKeys; let sources = 0;
    while (!this.exportAtRetained) {
      const page = await index.listRecent({ includeArchived: true, limit: INDEX_PAGE_SIZE, before: this.exportCursor });
      for (const summary of page.items) {
        if (this.now() >= budget.deadlineAt) return { complete: false, reason: 'deadline', sources };
        const key = sessionKey(summary); active.add(key);
        const session = await this.readSession(summary, budget, true);
        if (session === undefined || !session.complete) {
          if (budget.incompleteReason === 'record_budget' || budget.incompleteReason === 'deadline') return { complete: false, reason: budget.incompleteReason, sources };
          this.exportRetainedIncomplete = true;
        } else { await consume({ key, workspaceId: summary.workspaceId, kind: 'session', records: session.records }); sources++; }
        this.exportCursor = summary.id;
        await yieldToEventLoop();
      }
      if (page.nextCursor === undefined) this.exportAtRetained = true;
    }
    const retained = this.core.accessor.get(IRetainedUsageService);
    if (retained.readExportUsage !== undefined) {
      this.exportRetainedIterator ??= retained.readExportUsage(includeEphemeral);
      while (budget.remainingRecords > 0 && this.now() < budget.deadlineAt) {
        const event = await this.exportRetainedIterator.next();
        if (event.done) {
          for (const [workspaceId, records] of this.exportEphemeralRecords) { await consume({ key: `ephemeral\0${workspaceId}`, workspaceId, kind: 'ephemeral', records }); sources++; }
          this.exportEphemeralRecords.clear(); this.exportRetainedIterator = undefined;
          const complete = !this.exportRetainedIncomplete; this.exportRetainedIncomplete = false;
          this.exportCursor = undefined; this.exportAtRetained = false; this.exportActiveKeys.clear();
          return { complete, reason: complete ? null : 'retained-incomplete', sources };
        }
        if (event.value.kind === 'progress') { budget.remainingRecords--; if (budget.remainingRecords % 1024 === 0) await yieldToEventLoop(); }
        else if (event.value.kind === 'session') {
          const snapshot = event.value.snapshot; const key = sessionKey(snapshot); if (active.has(key)) continue;
          if (!snapshot.complete) { this.exportRetainedIncomplete = true; continue; }
          await consume({ key, workspaceId: snapshot.workspaceId, kind: 'session', records: snapshot.records.map(normalizeRetainedRecord) }); sources++;
        } else if (event.value.kind === 'ephemeral') {
          const record = event.value.record; const records = this.exportEphemeralRecords.get(record.workspaceId) ?? []; records.push(normalizeRetainedRecord(record)); this.exportEphemeralRecords.set(record.workspaceId, records);
        } else this.exportRetainedIncomplete = true;
      }
      return { complete: false, reason: budget.remainingRecords <= 0 ? 'record_budget' : 'deadline', sources };
    }
    const deleted = await retained.listDeletedSessions({ deadlineAt: budget.deadlineAt, recordLimit: budget.remainingRecords });
    for (const snapshot of deleted.items) {
      const key = sessionKey(snapshot); if (active.has(key)) continue;
      if (!snapshot.complete) return { complete: false, reason: 'retained-incomplete', sources };
      await consume({ key, workspaceId: snapshot.workspaceId, kind: 'session', records: snapshot.records.map(normalizeRetainedRecord) }); sources++;
      await yieldToEventLoop();
    }
    budget.remainingRecords -= deleted.scannedRecords;
    if (!deleted.complete) return { complete: false, reason: deleted.incompleteReason ?? 'retained-incomplete', sources };
    if (includeEphemeral && retained.listEphemeralUsage !== undefined) {
      const ephemeral = await retained.listEphemeralUsage({ deadlineAt: budget.deadlineAt, recordLimit: budget.remainingRecords });
      const workspaces = new Map<string, NormalizedUsageRecord[]>();
      for (const record of ephemeral.items) {
        const records = workspaces.get(record.workspaceId) ?? []; records.push(normalizeRetainedRecord(record)); workspaces.set(record.workspaceId, records);
      }
      for (const [workspaceId, records] of workspaces) { await consume({ key: `ephemeral\0${workspaceId}`, workspaceId, kind: 'ephemeral', records }); sources++; }
      if (!ephemeral.complete) return { complete: false, reason: ephemeral.incompleteReason ?? 'ephemeral-incomplete', sources };
    }
    const complete = !this.exportRetainedIncomplete; this.exportRetainedIncomplete = false;
    this.exportCursor = undefined; this.exportAtRetained = false; this.exportActiveKeys.clear();
    return { complete, reason: complete ? null : 'retained-incomplete', sources };
  }

  async query(raw: UsageQuery, signal?: AbortSignal): Promise<UsageResponse> {
    signal?.throwIfAborted();
    const key = JSON.stringify(Object.entries(raw).sort(([left], [right]) => left.localeCompare(right)));
    let flight = this.queryFlights.get(key);
    if (flight === undefined || flight.controller.signal.aborted) {
      const controller = new AbortController();
      const created = { controller, promise: Promise.resolve(undefined as unknown as UsageResponse), waiters: 0, settled: false };
      created.promise = this.querySources(raw, controller.signal).finally(() => {
        created.settled = true;
        if (this.queryFlights.get(key) === created) this.queryFlights.delete(key);
      });
      flight = created;
      this.queryFlights.set(key, flight);
    }
    flight.waiters++;
    try { return await waitForSource(flight.promise, signal); }
    finally {
      flight.waiters--;
      if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
    }
  }

  private readonly rangeOperations = new Map<string, Promise<unknown>>();

  private async querySources(raw: UsageQuery, signal: AbortSignal): Promise<UsageResponse> {
    const normalized = normalizeQuery(raw, this.now());
    const fingerprint = queryFingerprint(normalized);
    const prior = this.rangeOperations.get(fingerprint) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(async () => {
      signal.throwIfAborted();
      const replayed = await this.replayRangeProjection(raw, normalized, fingerprint, signal);
      if (replayed !== undefined) return replayed;
      const resumable = await waitForSource(this.core.accessor.get(IQueryStore).get('usage-range-routing-v1', fingerprint), signal);
      return resumable === undefined ? this.querySourcesRecordLevel(raw, signal) : this.queryFoldedSources(raw, normalized, fingerprint, signal);
    });
    this.rangeOperations.set(fingerprint, next);
    void next.finally(() => { if (this.rangeOperations.get(fingerprint) === next) this.rangeOperations.delete(fingerprint); }).catch(() => undefined);
    return waitForSource(next, signal);
  }

  private async queryFoldedSources(raw: UsageQuery, query: NormalizedQuery, fingerprint: string, signal: AbortSignal): Promise<UsageResponse> {
    const persistProjection = this.factJournalReplayEnabled() && this.rescan.state !== 'running';
    await waitForSource(this.core.accessor.get(IModelPricingService).ready, signal);
    await waitForSource(this.prepareInventory(), signal);
    const now = this.now();
    const cursor = raw.page_token === undefined ? undefined : decodePageToken(raw.page_token, fingerprint);
    const budget: ScanBudget = { signal, remainingRecords: this.limits.wireRecordBudget, remainingFacts: this.limits.usageFactBudget, deadlineAt: now + this.limits.deadlineMs, sourcesComplete: true, incompleteReason: null };
    const deadline = new AbortController();
    const timer = setTimeout(() => { deadline.abort(new DOMException('Usage query deadline', 'TimeoutError')); }, this.limits.deadlineMs);
    timer.unref();
    budget.factSignal = AbortSignal.any([signal, deadline.signal]);
    budget.factBudget = { get remainingRecords() { return budget.remainingFacts ?? Infinity; }, set remainingRecords(value: number) { budget.remainingFacts = value; } };
    const fold = new UsageRangeFold(this.core.accessor.get(IQueryStore), `usage-range-v1:${fingerprint}`, this.limits.drilldownSessionLimit, this.limits.drilldownTurnLimit);
    let head: RangeFoldHead | undefined;
    let listed: ListedSessions | undefined;
    const retained: SessionRecords[] = [];
    let ephemeral: readonly EphemeralUsageTotal[] = [];
    try {
      const store = this.core.accessor.get(IQueryStore);
      await store.put('usage-range-routing-v1', fingerprint, { version: 1, fingerprint, touchedAt: now }, { columns: { touchedAt: now } });
      const routes = await waitForSource(store.query<{ fingerprint: string; touchedAt: number }>('usage-range-routing-v1').whereColumn('touchedAt', {}).limit(17).execute(), budget.factSignal);
      let excess = Math.max(0, routes.items.length - 16);
      for (const entry of routes.items) {
        if (this.rangeOperations.has(entry.fingerprint) || (excess <= 0 && entry.touchedAt >= now - SOURCE_RECHECK_MS)) continue;
        budget.factSignal.throwIfAborted();
        await store.dropCollection(`usage-range-v1:${entry.fingerprint}`);
        await store.delete('usage-range-routing-v1', entry.fingerprint);
        excess--;
      }
      listed = await waitForSource(this.listSessions(query, budget), budget.factSignal);
      head = await waitForSource(fold.head<RangeFoldHead>(), budget.factSignal);
      const inventory = new Set(listed.items.map(sessionKey));
      const sameInventory = budget.incompleteReason === null && head !== undefined && (!head.complete || head.sessions.length === listed.items.length) && head.sessions.every((session) => inventory.has(sessionKey(session.summary)));
      const current = head !== undefined && sameInventory ? await waitForSource(this.rangeSourcesCurrent(head, budget.factSignal), budget.factSignal) : false;
      const aligned = head !== undefined && head.version === 1 && head.fingerprint === fingerprint && !head.invalidated && sameInventory && current;
      if (!aligned) {
        const advanced = head !== undefined && head.complete && head.version === 1 && head.fingerprint === fingerprint && !head.invalidated && sameInventory
          ? await this.advanceCompleteFold(head, fold, query, budget)
          : false;
        if (!advanced) {
          await fold.reset();
          head = { version: 1, fingerprint, sessions: listed.items.map((summary) => ({ summary, invalid: false, prepared: false })), complete: false, inventoryComplete: budget.incompleteReason === null, invalidated: false };
          await fold.saveHead(head);
        }
      }
      if (head === undefined) throw new Error('usage range has no fold head');
      const facts = this.core.accessor.get(IUsageFactStore);
      const storage = this.core.accessor.get(IFileSystemStorageService);
      const replayJournal = this.factJournalReplayEnabled();
      const foldHead = head;
      const pageOpened = async (): Promise<void> => {
        for (const session of foldHead.sessions) {
          for (const source of session.sources ?? []) {
            if (source.cursor === undefined) continue;
            while (!source.done) {
              if (this.now() >= budget.deadlineAt) { budget.incompleteReason = 'deadline'; return; }
              if ((budget.remainingFacts ?? Infinity) <= 0) { budget.incompleteReason = 'record_budget'; return; }
              if (source.cursor?.startsWith('journal:') === true) {
                const hold = { cursor: source.cursor };
                const replayed = await this.replayFactJournal(source.scope, source.cursor, query.range, budget, hold, async (records) => {
                  source.cursor = hold.cursor;
                  session.invalid ||= records.some((record) => record.invalid);
                  await fold.addPage(session.summary, records, (record) => resolveBucket(record.time, session.summary, query).key, (record) => inRange(record.time, query.range) && matchesFilters(record, query), foldHead, budget.factSignal);
                });
                if (replayed === undefined) source.cursor = undefined;
                else {
                  source.done = replayed.done;
                  source.cursor = replayed.done ? undefined : replayed.cursor;
                  if (!replayed.done) return;
                  continue;
                }
              }
              const page = await facts.read(source.scope, query.range, budget.factSignal, { budget: budget.factBudget, cursor: source.cursor, pageSize: 256 });
              if (page.readComplete === false && page.nextCursor === undefined) { budget.incompleteReason = 'record_budget'; return; }
              if (page.checkpoint === undefined) { foldHead.invalidated = true; budget.sourcesComplete = false; return; }
              source.checkpoint = page.checkpoint;
              source.cursor = page.nextCursor;
              source.done = page.readComplete !== false;
              session.invalid ||= !page.checkpoint.valid || page.records.some((record) => record.invalid);
              await fold.addPage(session.summary, page.records, (record) => resolveBucket(record.time, session.summary, query).key, (record) => inRange(record.time, query.range) && matchesFilters(record, query), foldHead, budget.factSignal);
            }
          }
        }
      };
      await pageOpened();
      for (const session of head.sessions) {
        if (session.prepared) continue;
        if (this.now() >= budget.deadlineAt) { budget.incompleteReason = 'deadline'; break; }
        if ((budget.remainingFacts ?? Infinity) <= 0 || budget.remainingRecords <= 0) { budget.incompleteReason = 'record_budget'; break; }
        const scope = sessionScopeOf(workspacePersistenceScope('sessions', session.summary.workspaceId), session.summary.id);
        const listedAgents = await storage.list(`${scope}/agents`);
        const known = new Set((session.sources ?? []).map((source) => source.agentId));
        const pending = session.sources === undefined ? undefined : listedAgents.filter((agentId) => !known.has(agentId));
        if (pending === undefined || pending.length > 0) {
          const prepared = pending === undefined ? undefined : {
            version: PERSISTENCE_VERSION,
            sessionKey: sessionKey(session.summary),
            records: [],
            agents: Object.fromEntries((session.sources ?? []).map((source) => [source.agentId, source.checkpoint])),
            readComplete: true,
          };
          const recovered = await this.loadSessionIncremental(session.summary, budget.remainingRecords, budget.deadlineAt, undefined, false, prepared, pending, { signal, factSignal: budget.factSignal, factBudget: budget.factBudget, maxFacts: budget.remainingFacts, projectionOnly: true, rangeStart: query.range.startAt });
          budget.remainingRecords -= recovered.scannedRecordCount;
          if (budget.remainingFacts !== undefined) budget.remainingFacts -= recovered.scannedFactCount ?? 0;
          const sources = session.sources ?? [];
          const present = new Set(sources.map((source) => source.agentId));
          for (const [agentId, checkpoint] of Object.entries(recovered.persisted.agents)) {
            if (present.has(agentId) || checkpoint.offset !== checkpoint.size) continue;
            const excluded = mtimeExcludesRange(checkpoint.mtimeMs, query.range.startAt);
            sources.push({ agentId, scope: agentScopeOf(scope, agentId), checkpoint, done: excluded, ...(replayJournal && !excluded ? { cursor: 'journal:0:0' } : {}) });
            present.add(agentId);
          }
          session.sources = sources;
          const covered = listedAgents.every((agentId) => present.has(agentId));
          if (covered && recovered.incompleteReason === null && recovered.persisted.readComplete !== false) session.invalid = !recovered.session.complete;
          if (!covered || recovered.incompleteReason !== null || recovered.persisted.readComplete === false) {
            budget.incompleteReason = recovered.incompleteReason ?? 'record_budget';
            await fold.saveHead(head);
            break;
          }
        }
        let opened = true;
        for (const source of session.sources ?? []) {
          if (source.cursor !== undefined || source.done) continue;
          if (replayJournal) { source.cursor = 'journal:0:0'; continue; }
          if (this.now() >= budget.deadlineAt || (budget.remainingFacts ?? Infinity) <= 0) {
            opened = false;
            budget.incompleteReason = this.now() >= budget.deadlineAt ? 'deadline' : 'record_budget';
            break;
          }
          const frozen = await facts.read(source.scope, query.range, budget.factSignal, { budget: budget.factBudget, pageSize: 0 });
          if (frozen.checkpoint === undefined) { opened = false; budget.incompleteReason = 'record_budget'; break; }
          source.checkpoint = frozen.checkpoint;
          source.cursor = frozen.nextCursor;
          source.done = frozen.readComplete !== false;
        }
        const sourceIds = new Set((session.sources ?? []).map((source) => source.agentId));
        session.prepared = opened && listedAgents.every((agentId) => sourceIds.has(agentId)) && (session.sources ?? []).every((source) => source.done || source.cursor !== undefined);
        await fold.saveHead(head);
        if (!session.prepared) {
          budget.incompleteReason ??= 'record_budget';
          break;
        }
      }
      await pageOpened();
      head.complete = head.sessions.every((session) => session.prepared && session.sources?.every((source) => source.done));
      await fold.saveHead(head);
      budget.sourcesComplete = head.complete && head.inventoryComplete && !head.invalidated;
      if (head.complete && budget.incompleteReason === null) {
        retained.push(...await this.readRetainedSessions(query, budget, listed.activeKeys, head.sessions.filter((session) => !this.fullScanKeys?.has(sessionKey(session.summary))).length));
        const service = this.core.accessor.get(IRetainedUsageService);
        if (service.listEphemeralUsage !== undefined && budget.incompleteReason === null) {
          const anonymous = await service.listEphemeralUsage({ workspaceIds: query.workspaceIds.length === 0 ? undefined : query.workspaceIds, deadlineAt: budget.deadlineAt, recordLimit: budget.remainingFacts ?? Infinity, signal });
          ephemeral = anonymous.items;
          if (!anonymous.complete) budget.sourcesComplete = false;
          if (anonymous.incompleteReason !== undefined) budget.incompleteReason = anonymous.incompleteReason;
        }
      }
    } catch (error) {
      if (signal.aborted) { clearTimeout(timer); signal.throwIfAborted(); }
      if (error instanceof UsageFactCursorChangedError) {
        await fold.reset();
        head = undefined;
        budget.sourcesComplete = false;
      } else if (deadline.signal.aborted) {
        budget.incompleteReason = 'deadline';
        budget.sourcesComplete = false;
        if (head !== undefined) await fold.saveHead(head);
        budget.factSignal = signal;
      } else { clearTimeout(timer); throw error; }
    }
    if (deadline.signal.aborted && !signal.aborted) budget.factSignal = signal;
    try {
      const summaries = new Map(listed?.items.map((summary) => [sessionKey(summary), summary]));
      const sessions: SessionRecords[] = (head?.sessions ?? []).map((session) => ({ summary: summaries.get(sessionKey(session.summary)) ?? session.summary, records: [], complete: session.prepared && session.sources?.every((source) => source.done) === true && !session.invalid, deleted: false }));
      const response = await this.aggregate(query, [...sessions, ...retained], fingerprint, cursor, budget, ephemeral, fold);
      if (persistProjection && response.reliability.complete && head?.complete === true && listed !== undefined) await this.saveFoldProjection(query, fingerprint, listed.items, head, fold);
      return response;
    } finally { clearTimeout(timer); }
  }

  private async rangeSourcesCurrent(head: RangeFoldHead, signal?: AbortSignal): Promise<boolean> {
    const storage = this.core.accessor.get(IFileSystemStorageService);
    const logs = this.core.accessor.get(IAppendLogStore);
    for (const session of head.sessions) {
      if (session.prepared) {
        signal?.throwIfAborted();
        const scope = sessionScopeOf(workspacePersistenceScope('sessions', session.summary.workspaceId), session.summary.id);
        const agents = await waitForSource(storage.list(`${scope}/agents`), signal);
        if (session.sources?.some((source) => !agents.includes(source.agentId)) || (head.complete && agents.length !== session.sources?.length)) return false;
      }
      for (const source of session.sources ?? []) {
        signal?.throwIfAborted();
        const [size, mtime, generation] = await Promise.all([storage.size(source.scope, AGENT_WIRE_RECORD_KEY), storage.mtime(source.scope, AGENT_WIRE_RECORD_KEY), logs.generation(source.scope, AGENT_WIRE_RECORD_KEY)]);
        const checkpoint = source.checkpoint;
        if (generation !== (checkpoint.generation ?? 'legacy') || (size ?? 0) < checkpoint.offset) return false;
        if (head.complete && (size !== checkpoint.size || mtime !== checkpoint.mtimeMs)) return false;
        if (!head.complete && (size !== checkpoint.size || mtime !== checkpoint.mtimeMs)) {
          if (size === checkpoint.offset || await this.boundaryHash(storage, source.scope, checkpoint.offset) !== checkpoint.boundaryHash) return false;
        }
      }
    }
    return true;
  }

  private async querySourcesRecordLevel(raw: UsageQuery, signal: AbortSignal): Promise<UsageResponse> {
    const persistProjection = this.projectionWritable();
    await waitForSource(this.core.accessor.get(IModelPricingService).ready, signal);
    await waitForSource(this.prepareInventory(), signal);
    const now = this.now();
    this.pruneExpired(now);
    const query = normalizeQuery(raw, now);
    const fingerprint = queryFingerprint(query);
    const cursor = raw.page_token === undefined ? undefined : decodePageToken(raw.page_token, fingerprint);
    const budget: ScanBudget = {
      signal,
      remainingRecords: this.limits.wireRecordBudget,
      remainingFacts: this.limits.usageFactBudget,
      deadlineAt: now + this.limits.deadlineMs,
      sourcesComplete: true,
      incompleteReason: null,
    };
    const deadline = new AbortController();
    const timer = setTimeout(() => { deadline.abort(new DOMException('Usage query deadline', 'TimeoutError')); }, this.limits.deadlineMs);
    timer.unref();
    budget.factSignal = AbortSignal.any([signal, deadline.signal]);
    budget.factBudget = {
      get remainingRecords() { return budget.remainingFacts ?? Infinity; },
      set remainingRecords(value: number) { budget.remainingFacts = value; },
    };
    const sessions: SessionRecords[] = [];
    try {
      const listed = await this.listSessions(query, budget);
      sessionLoop: for (let offset = 0; offset < listed.items.length; offset += CHECKPOINT_READ_CONCURRENCY) {
        signal.throwIfAborted();
        if (this.now() >= budget.deadlineAt) {
          budget.incompleteReason = 'deadline';
          break;
        }
        const batch = listed.items.slice(offset, offset + CHECKPOINT_READ_CONCURRENCY);
        const prepared = await Promise.all(batch.map(async (summary) => {
          const key = sessionKey(summary);
          const cached = this.readCachedSession(key, query.range);
          const indexedRange = query.range.startAt !== undefined && query.range.endAt !== undefined ? query.range : undefined;
          const persisted = cached?.persisted ?? await this.readPersistentSession(
            this.core.accessor.get(IFileSystemStorageService), key, indexedRange, budget.factSignal, undefined, budget.factBudget,
          );
          if (persisted.readComplete === false && persisted.incompleteReason !== 'deadline') await this.core.accessor.get(IQueryStore).put('usage-range-routing-v1', fingerprint, { version: 1, fingerprint, touchedAt: now }, { columns: { touchedAt: now } });
          const revision = this.revisionOf(key);
          const current = persisted.readComplete !== false && await waitForSource(this.cacheIsCurrent(summary, persisted, this.rescan.state !== 'running'), budget.factSignal);
          if (current && !cached?.view && this.rescan.state !== 'running') {
            this.cacheSessionRange(key, persisted, true, query.range);
          }
          if (current) this.rememberVerified(key, persisted, revision);
          if (current && !cached?.view && (query.range.startAt !== undefined || query.range.endAt !== undefined)) {
            return {
              persisted: { ...persisted, records: persisted.records.filter((record) => record.invalid || inRange(record.time, query.range)) },
              current,
              view: true,
            };
          }
          return { persisted, current, view: cached?.view ?? indexedRange !== undefined };
        }));
        for (const [index, summary] of batch.entries()) {
          if (index > 0 && this.now() >= budget.deadlineAt) {
            budget.incompleteReason = 'deadline';
            break sessionLoop;
          }
          const session = await this.readSession(summary, budget, false, prepared[index], query.range);
          if (session !== undefined) sessions.push(session);
          if (budget.incompleteReason === 'record_budget' && (budget.remainingFacts ?? Infinity) <= 0) await this.core.accessor.get(IQueryStore).put('usage-range-routing-v1', fingerprint, { version: 1, fingerprint, touchedAt: now }, { columns: { touchedAt: now } });
          if (budget.incompleteReason === 'record_budget' || budget.incompleteReason === 'deadline') break sessionLoop;
        }
        await yieldToEventLoop();
      }
      let ephemeralUsage: readonly EphemeralUsageTotal[] = [];
      if (budget.incompleteReason === null) {
        const uncachedSessionCount = sessions.filter((session) => !this.fullScanKeys?.has(sessionKey(session.summary))).length;
        for (const session of await this.readRetainedSessions(query, budget, listed.activeKeys, uncachedSessionCount)) {
          sessions.push(session);
        }
      }
      const retainedUsage = this.core.accessor.get(IRetainedUsageService);
      if (budget.incompleteReason === null && retainedUsage.listEphemeralUsage !== undefined) {
        const anonymous = await retainedUsage.listEphemeralUsage({
          workspaceIds: query.workspaceIds.length === 0 ? undefined : query.workspaceIds,
          deadlineAt: budget.deadlineAt,
          recordLimit: budget.remainingFacts ?? Infinity,
          signal: budget.signal,
        });
        ephemeralUsage = anonymous.items;
        if (budget.remainingFacts !== undefined) budget.remainingFacts -= anonymous.scannedRecords;
        if (!anonymous.complete) budget.sourcesComplete = false;
        if (anonymous.incompleteReason !== undefined) budget.incompleteReason = anonymous.incompleteReason;
      }
      const response = await this.aggregate(query, sessions, fingerprint, cursor, budget, ephemeralUsage);
      if (persistProjection && response.reliability.complete) await this.saveRecordProjection(query, fingerprint, listed.items, sessions);
      return response;
    } catch (error) {
      signal.throwIfAborted();
      if (!deadline.signal.aborted) throw error;
      budget.incompleteReason = 'deadline';
      budget.sourcesComplete = false;
      return await this.aggregate(query, sessions, fingerprint, cursor, budget, []);
    } finally { clearTimeout(timer); }
  }

  private async listSessions(
    query: NormalizedQuery,
    budget: ScanBudget,
    fullScan = false,
  ): Promise<ListedSessions> {
    const index = this.core.accessor.get(ISessionIndex);
    const items: SessionSummary[] = [];
    const activeKeys = new Set<string>();
    let before: string | undefined;
    let uncachedSessions = 0;
    for (;;) {
      budget.signal?.throwIfAborted();
      const page = await index.listRecent({
        workspaceIds: query.workspaceIds.length === 0 ? undefined : query.workspaceIds,
        includeArchived: true,
        limit: INDEX_PAGE_SIZE,
        before,
      });
      for (const item of page.items) {
        const key = sessionKey(item);
        activeKeys.add(key);
        if (!query.includeArchived && item.archived) continue;
        if (!fullScan && !this.fullScanKeys?.has(key)) {
          uncachedSessions += 1;
          if (uncachedSessions > this.limits.sessionScanLimit) {
            budget.incompleteReason = 'session_cap';
            return { items, activeKeys };
          }
        }
        items.push(item);
      }
      if (page.nextCursor === undefined) break;
      before = page.nextCursor;
      if (this.now() >= budget.deadlineAt) {
        budget.incompleteReason = 'deadline';
        break;
      }
    }
    return { items, activeKeys };
  }

  private async readSession(
    summary: SessionSummary,
    budget: ScanBudget,
    preserveMissingSources = false,
    prepared?: PreparedSession,
    range?: RangeBounds,
  ): Promise<SessionRecords | undefined> {
    budget.signal?.throwIfAborted();
    const cacheKey = sessionKey(summary);
    const cached = prepared === undefined ? this.readCachedSession(cacheKey, range) : undefined;
    if (prepared?.persisted.readComplete === false) {
      budget.incompleteReason = prepared.persisted.incompleteReason ?? 'record_budget';
      budget.sourcesComplete = false;
      return { summary, records: prepared.persisted.records, complete: false, deleted: false };
    }
    if (this.rescan.state === 'running') {
      const persisted = prepared?.persisted ?? cached?.persisted ?? await this.readPersistentSession(
        this.core.accessor.get(IFileSystemStorageService), cacheKey,
      );
      const complete = prepared?.current ?? await this.cacheIsCurrent(summary, persisted, false);
      if (!complete) budget.sourcesComplete = false;
      return { summary, records: persisted.records, complete, deleted: false };
    }
    if (prepared?.current) {
      return { summary, records: prepared.persisted.records, complete: true, deleted: false };
    }
    if (prepared === undefined && cached?.complete && await this.cacheIsCurrent(summary, cached.persisted, !preserveMissingSources)) {
      return { summary, records: cached.persisted.records, complete: true, deleted: false };
    }
    const revision = this.sessionFlights.has(cacheKey) ? undefined : this.revisionOf(cacheKey);
    let flight = this.sessionFlights.get(cacheKey);
    if (flight === undefined) {
      flight = this.loadSessionIncremental(summary, budget.remainingRecords, budget.deadlineAt, undefined, preserveMissingSources, prepared?.view ? undefined : prepared?.persisted, undefined, { signal: budget.signal, maxFacts: budget.remainingFacts, factSignal: budget.factSignal, factBudget: budget.factBudget, rangeStart: range?.startAt });
      this.sessionFlights.set(cacheKey, flight);
      const clearFlight = (): void => {
        if (this.sessionFlights.get(cacheKey) === flight) this.sessionFlights.delete(cacheKey);
      };
      void flight.then(clearFlight, clearFlight);
    }
    let result: SessionLoadResult;
    try {
      result = await waitForSource(flight, budget.signal);
    } catch (error) {
      budget.signal?.throwIfAborted();
      budget.factSignal?.throwIfAborted();
      if (!(error instanceof Error) || (error.name !== 'AbortError' && error.name !== 'TimeoutError')) throw error;
      if (this.sessionFlights.get(cacheKey) === flight) this.sessionFlights.delete(cacheKey);
      return this.readSession(summary, budget, preserveMissingSources, undefined, range);
    }
    if (result.targetedAgentIds !== undefined) {
      if (this.sessionFlights.get(cacheKey) === flight) this.sessionFlights.delete(cacheKey);
      return this.readSession(summary, budget, preserveMissingSources, undefined, range);
    }
    if (result.scannedRecordCount > budget.remainingRecords) {
      budget.incompleteReason = 'record_budget';
      return undefined;
    }
    budget.remainingRecords -= result.scannedRecordCount;
    if (budget.remainingFacts !== undefined) budget.remainingFacts -= result.scannedFactCount ?? 0;
    if (result.incompleteReason !== null) budget.incompleteReason = result.incompleteReason;
    if (result.persisted.readComplete !== false) {
      this.cacheSessionRange(cacheKey, result.persisted, result.session.complete, range);
      if (revision !== undefined) this.rememberVerified(cacheKey, result.persisted, revision);
    }
    if (range !== undefined && (range.startAt !== undefined || range.endAt !== undefined)) {
      return { ...result.session, records: result.session.records.filter((record) => record.invalid || inRange(record.time, range)) };
    }
    return result.session;
  }

  private async cacheIsCurrent(summary: SessionSummary, persisted: PersistentSessionRecords, allowTracked = true): Promise<boolean> {
    const cached = this.cache.get(sessionKey(summary));
    if (allowTracked && this.sourceChanges?.ready && cached?.complete &&
      cached.persisted.agents === persisted.agents && cached.verifiedAt !== undefined &&
      this.now() - cached.verifiedAt < SOURCE_RECHECK_MS) return true;
    const storage = this.core.accessor.get(IFileSystemStorageService);
    const sessionScope = sessionScopeOf(workspacePersistenceScope('sessions', summary.workspaceId), summary.id);
    const agentIds = await storage.list(`${sessionScope}/agents`);
    if (agentIds.length !== Object.keys(persisted.agents).length) return false;
    for (let offset = 0; offset < agentIds.length; offset += AGENT_STAT_CONCURRENCY) {
      const current = await Promise.all(agentIds.slice(offset, offset + AGENT_STAT_CONCURRENCY).map(async (agentId) => {
        const checkpoint = persisted.agents[agentId];
        if (checkpoint === undefined || !checkpoint.valid || checkpoint.offset !== checkpoint.size) return false;
        const wireScope = agentScopeOf(sessionScope, agentId);
        const [size, mtimeMs, generation] = await Promise.all([
          storage.size(wireScope, AGENT_WIRE_RECORD_KEY),
          storage.mtime(wireScope, AGENT_WIRE_RECORD_KEY),
          this.core.accessor.get(IAppendLogStore).generation(wireScope, AGENT_WIRE_RECORD_KEY),
        ]);
        return (size ?? 0) === checkpoint.size && (mtimeMs ?? 0) === checkpoint.mtimeMs && generation === (checkpoint.generation ?? 'legacy');
      }));
      if (current.some((value) => !value)) return false;
    }
    return true;
  }

  private async loadSessionIncremental(
    summary: SessionSummary,
    recordLimit: number,
    deadlineAt: number,
    onScannedRecord?: () => void,
    preserveMissingSources = false,
    prepared?: PersistentSessionRecords,
    targetedAgentIds?: readonly string[],
    options: AgentUsageReadOptions & { factSignal?: AbortSignal; factBudget?: UsageFactReadBudget; projectionOnly?: boolean } = {},
  ): Promise<SessionLoadResult> {
    const storage = this.core.accessor.get(IFileSystemStorageService);
    const facts = this.core.accessor.get(IUsageFactStore);
    const logs = this.core.accessor.get(IAppendLogStore);
    const cacheKey = sessionKey(summary);
    const cached = options.projectionOnly ? undefined : this.readCachedSession(cacheKey)?.persisted;
    const persisted = cached ?? prepared ?? await this.readPersistentSession(storage, cacheKey, undefined, options.factSignal ?? options.signal, targetedAgentIds, options.factBudget, options.projectionOnly);
    if (persisted.readComplete === false) return { session: { summary, records: persisted.records, complete: false, deleted: false }, persisted, scannedRecordCount: 0, incompleteReason: persisted.incompleteReason ?? 'record_budget' };
    const sessionScope = sessionScopeOf(workspacePersistenceScope('sessions', summary.workspaceId), summary.id);
    options.signal?.throwIfAborted();
    const agentIds = targetedAgentIds ?? await storage.list(`${sessionScope}/agents`);
    const agentSet = new Set(agentIds);
    if (preserveMissingSources && Object.keys(persisted.agents).some((agent) => !agentSet.has(agent))) return { session: { summary, records: persisted.records, complete: false, deleted: false }, persisted, scannedRecordCount: 0, incompleteReason: null };
    const recordsByAgent = new Map<string | undefined, NormalizedUsageRecord[]>();
    for (const record of persisted.records) {
      if (targetedAgentIds === undefined && record.sourceAgentId !== undefined && !agentSet.has(record.sourceAgentId)) continue;
      const records = recordsByAgent.get(record.sourceAgentId) ?? [];
      records.push(record);
      recordsByAgent.set(record.sourceAgentId, records);
    }
    const agents: Record<string, WireCheckpoint> = targetedAgentIds === undefined ? {} : { ...persisted.agents };
    const sources = new Map<string, { size?: number; mtimeMs: number; generation: string; stable: boolean; excluded?: boolean }>();
    for (let offset = 0; offset < agentIds.length; offset += AGENT_STAT_CONCURRENCY) {
      options.signal?.throwIfAborted();
      await Promise.all(agentIds.slice(offset, offset + AGENT_STAT_CONCURRENCY).map(async (agentId) => {
        const scope = agentScopeOf(sessionScope, agentId);
        const [size, mtimeMs] = await Promise.all([storage.size(scope, AGENT_WIRE_RECORD_KEY), storage.mtime(scope, AGENT_WIRE_RECORD_KEY)]);
        if (mtimeExcludesRange(mtimeMs ?? 0, options.rangeStart)) {
          sources.set(agentId, { size, mtimeMs: mtimeMs ?? 0, generation: 'legacy', stable: true, excluded: true });
          return;
        }
        const generation = await logs.generation(scope, AGENT_WIRE_RECORD_KEY);
        const stable = await logs.generation(scope, AGENT_WIRE_RECORD_KEY) === generation;
        sources.set(agentId, { size, mtimeMs: mtimeMs ?? 0, generation, stable });
      }));
    }
    let scannedRecordCount = 0;
    let incompleteReason: UsageResponse['reliability']['incomplete_reason'] = null;
    let complete = true;
    let stored = true;
    let scannedFactCount = 0;
    const remainingBytes = options.maxBytes ?? Infinity;
    const jobs: { agentId: string; wireScope: string; size: number; mtimeMs: number; generation: string; checkpoint?: WireCheckpoint; hasFacts: boolean; offset: number }[] = [];
    for (const agentId of agentIds) {
      options.signal?.throwIfAborted();
      if (this.now() >= deadlineAt || remainingBytes <= 0) { incompleteReason = 'deadline'; complete = false; break; }
      if (scannedRecordCount >= recordLimit) { incompleteReason = 'record_budget'; complete = false; break; }
      const wireScope = agentScopeOf(sessionScope, agentId);
      const source = sources.get(agentId)!;
      if (!source.stable) { recordsByAgent.delete(agentId); complete = false; continue; }
      const size = source.size ?? 0;
      const { mtimeMs, generation } = source;
      if (source.excluded) {
        recordsByAgent.delete(agentId);
        const existing = persisted.agents[agentId];
        if (existing?.valid && existing.offset === existing.size && existing.size === size && existing.mtimeMs === mtimeMs) {
          agents[agentId] = { ...existing, generation: existing.generation ?? generation };
        } else {
          const coveredGeneration = await logs.generation(wireScope, AGENT_WIRE_RECORD_KEY);
          agents[agentId] = { generation: coveredGeneration, offset: size, size, mtimeMs, boundaryHash: '', valid: true };
        }
        continue;
      }
      let snapshot;
      try {
        snapshot = options.factBudget !== undefined && persisted.agents[agentId] !== undefined
          ? { checkpoint: persisted.agents[agentId], records: recordsByAgent.get(agentId) ?? [], readComplete: true }
          : options.projectionOnly
            ? { ...await facts.summary(wireScope, options.factSignal ?? options.signal, { budget: options.factBudget }), records: [] }
            : await facts.read(wireScope, undefined, options.factSignal ?? options.signal, { budget: options.factBudget });
      } catch (error) {
        options.signal?.throwIfAborted();
        if (!options.factSignal?.aborted && this.now() < deadlineAt) throw error;
        incompleteReason = 'deadline';
        complete = false;
        break;
      }
      if (snapshot.readComplete === false) {
        recordsByAgent.set(agentId, [...snapshot.records]);
        const records = [...recordsByAgent.values()].flat();
        return { session: { summary, records, complete: false, deleted: false }, persisted: { ...persisted, records, agents, readComplete: false }, scannedRecordCount, scannedFactCount, incompleteReason: 'record_budget', targetedAgentIds };
      }
      let checkpoint = persisted.agents[agentId];
      if (snapshot.checkpoint !== undefined && snapshot.checkpoint.generation === generation && snapshot.checkpoint.offset > size && (await storage.size(wireScope, AGENT_WIRE_RECORD_KEY) ?? 0) > size) {
        recordsByAgent.delete(agentId);
        complete = false;
        continue;
      }
      let hasFacts = false;
      if (snapshot.checkpoint !== undefined && snapshot.checkpoint.offset <= size && snapshot.checkpoint.generation === generation) {
        checkpoint = snapshot.checkpoint;
        recordsByAgent.set(agentId, [...snapshot.records]);
        hasFacts = true;
      }
      if (preserveMissingSources && source.size === undefined && (checkpoint?.size ?? 0) > 0) return { session: { summary, records: persisted.records, complete: false, deleted: false }, persisted, scannedRecordCount, incompleteReason: null };
      let reset = checkpoint !== undefined && (size < checkpoint.offset || (checkpoint.generation ?? 'legacy') !== generation);
      if (checkpoint !== undefined && !reset && (size !== checkpoint.size || mtimeMs !== checkpoint.mtimeMs)) {
        const boundaryHash = await this.boundaryHash(storage, wireScope, checkpoint.offset);
        reset = boundaryHash !== checkpoint.boundaryHash || (size === checkpoint.offset && mtimeMs !== checkpoint.mtimeMs);
      }
      if (reset) { recordsByAgent.set(agentId, []); checkpoint = undefined; hasFacts = false; }
      if (checkpoint !== undefined && checkpoint.offset === size && checkpoint.size === size && checkpoint.mtimeMs === mtimeMs) {
        const current = { ...checkpoint, generation };
        agents[agentId] = current;
        if (!current.valid) complete = false;
        if (!hasFacts) {
          try { await facts.commit(wireScope, 0, current, recordsByAgent.get(agentId) ?? []); }
          catch { stored = false; complete = false; }
        }
        continue;
      }
      jobs.push({ agentId, wireScope, size, mtimeMs, generation, checkpoint, hasFacts, offset: checkpoint?.offset ?? 0 });
    }
    const allowance = new UsageReadAllowance(recordLimit, options.factBudget?.remainingRecords ?? options.maxFacts ?? Infinity, remainingBytes);
    const ordered = jobs.toSorted((left, right) => (right.size - right.offset) - (left.size - left.offset));
    try {
      await this.recovery.run(ordered, async (job, worker, laneSignal) => {
        if (incompleteReason !== null || this.now() >= deadlineAt) { incompleteReason ??= 'deadline'; complete = false; return; }
        const { agentId, wireScope, size, mtimeMs, generation, checkpoint, offset } = job;
        let hasFacts = job.hasFacts;
        const baseRecords = recordsByAgent.get(agentId) ?? [];
        let committedOffset = hasFacts ? offset : 0;
        let committedFacts = 0;
        let lastPrefix: WireCheckpoint | undefined;
        const commitPrefix = async (end: number, tailRecords: readonly NormalizedUsageRecord[], valid: boolean): Promise<void> => {
          options.signal?.throwIfAborted();
          if (laneSignal.aborted && !(laneSignal.reason instanceof Error && laneSignal.reason.name === 'TimeoutError')) laneSignal.throwIfAborted();
          if (await logs.generation(wireScope, AGENT_WIRE_RECORD_KEY) !== generation) { complete = false; stored = false; return; }
          const prefix = { generation, offset: end, size, mtimeMs, boundaryHash: await this.boundaryHash(storage, wireScope, end), valid: (checkpoint?.valid ?? true) && valid };
          const records = hasFacts ? tailRecords.slice(committedFacts) : [...baseRecords, ...tailRecords];
          try {
            await facts.commit(wireScope, committedOffset, prefix, records);
            committedOffset = end;
            committedFacts = tailRecords.length;
            hasFacts = true;
            lastPrefix = prefix;
            recordsByAgent.set(agentId, [...baseRecords, ...tailRecords]);
            agents[agentId] = prefix;
          } catch { stored = false; complete = false; }
        };
        const tail = await readUsageWireTail(storage, wireScope, offset, size, allowance, deadlineAt, this.now, agentId, laneSignal, commitPrefix, this.pendingWireLines, JSON.stringify([generation, size, mtimeMs]), worker, onScannedRecord, options.signal);
        if (!tail.complete || tail.offset < size) complete = false;
        if (await logs.generation(wireScope, AGENT_WIRE_RECORD_KEY) !== generation) {
          recordsByAgent.delete(agentId);
          delete agents[agentId];
          complete = false;
          return;
        }
        if (tail.offset !== committedOffset || !hasFacts) await commitPrefix(tail.offset, tail.records, tail.valid);
        const next = lastPrefix?.offset === tail.offset ? lastPrefix : { generation, offset: tail.offset, size, mtimeMs, boundaryHash: checkpoint?.boundaryHash ?? '', valid: (checkpoint?.valid ?? true) && tail.valid };
        recordsByAgent.set(agentId, [...baseRecords, ...tail.records]);
        agents[agentId] = next;
        if (!next.valid) complete = false;
        if (tail.incompleteReason !== null) incompleteReason = tail.incompleteReason;
      }, options.factSignal ?? options.signal, ordered.reduce((sum, job) => sum + job.size - job.offset, 0) >= 16 * 1024 * 1024);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!options.factSignal?.aborted && this.now() < deadlineAt) throw error;
      incompleteReason = 'deadline';
      complete = false;
    }
    const counts = allowance.counts();
    scannedRecordCount = counts.raw;
    scannedFactCount = counts.facts;
    for (const agentId of agentIds) {
      if (agents[agentId] === undefined && persisted.agents[agentId] !== undefined) agents[agentId] = persisted.agents[agentId];
    }
    const records = [...recordsByAgent.values()].flat();
    const next: PersistentSessionRecords = { version: PERSISTENCE_VERSION, sessionKey: cacheKey, records, agents };
    return { session: { summary, records, complete, deleted: false }, persisted: stored ? next : persisted, scannedRecordCount, scannedFactCount, incompleteReason, targetedAgentIds };
  }

  private async readPersistentSession(
    storage: IFileSystemStorageService,
    cacheKey: string,
    range?: RangeBounds,
    signal?: AbortSignal,
    targetedAgentIds?: readonly string[],
    budget?: UsageFactReadBudget,
    projectionOnly = false,
  ): Promise<PersistentSessionRecords> {
    const [workspaceId, sessionId] = cacheKey.split('\0');
    const scope = sessionScopeOf(workspacePersistenceScope('sessions', workspaceId!), sessionId!);
    const facts = this.core.accessor.get(IUsageFactStore);
    const logs = this.core.accessor.get(IAppendLogStore);
    const agentIds = targetedAgentIds ?? await waitForSource(storage.list(`${scope}/agents`), signal);
    const agents: Record<string, WireCheckpoint> = {};
    const records: NormalizedUsageRecord[] = [];
    let readComplete = true;
    for (let start = 0; start < agentIds.length; start += CHECKPOINT_READ_CONCURRENCY) {
      if (signal?.aborted) {
        if ((signal.reason as { name?: string } | undefined)?.name !== 'TimeoutError') signal.throwIfAborted();
        return { version: PERSISTENCE_VERSION, sessionKey: cacheKey, records, agents, readComplete: false, incompleteReason: 'deadline' };
      }
      let snapshots;
      try {
        snapshots = await waitForSource(Promise.all(agentIds.slice(start, start + CHECKPOINT_READ_CONCURRENCY).map(async (agentId) => {
        const wireScope = agentScopeOf(scope, agentId);
        if (range?.startAt !== undefined && mtimeExcludesRange(await storage.mtime(wireScope, AGENT_WIRE_RECORD_KEY) ?? 0, range.startAt)) {
          return { agentId, snapshot: { records: [] as readonly NormalizedUsageRecord[], readComplete: true } };
        }
        return { agentId, snapshot: projectionOnly
          ? this.factJournalReplayEnabled()
            ? { checkpoint: await this.factJournalCheckpoint(wireScope), records: [] as readonly NormalizedUsageRecord[], readComplete: true }
            : { ...await facts.summary(wireScope, signal, { budget }), records: [] as readonly NormalizedUsageRecord[] }
          : await facts.read(wireScope, range, signal, { budget }) };
      })), signal);
      } catch (error) {
        if (signal?.aborted && (signal.reason as { name?: string } | undefined)?.name !== 'TimeoutError') throw error;
        return { version: PERSISTENCE_VERSION, sessionKey: cacheKey, records, agents, readComplete: false, incompleteReason: signal?.aborted ? 'deadline' : 'record_budget' };
      }
      for (const { agentId, snapshot } of snapshots) {
        if (snapshot.readComplete === false) readComplete = false;
        if (snapshot.checkpoint !== undefined) agents[agentId] = snapshot.checkpoint;
        for (const record of snapshot.records) records.push(record);
      }
      if (!readComplete) return { version: PERSISTENCE_VERSION, sessionKey: cacheKey, records, agents, readComplete: false, incompleteReason: 'record_budget' };
    }
    if (Object.keys(agents).length !== agentIds.length) {
      let legacy: PersistentSessionRecords | undefined;
      try {
        const bytes = await storage.read(PERSISTENCE_SCOPE, persistenceKey(cacheKey));
        if (bytes !== undefined) legacy = parsePersistentSession(JSON.parse(Buffer.from(bytes).toString('utf8')), cacheKey);
      } catch {}
      if (legacy !== undefined) {
        const grouped = new Map<string, NormalizedUsageRecord[]>();
        for (const record of legacy.records) {
          if (record.sourceAgentId === undefined) continue;
          const group = grouped.get(record.sourceAgentId) ?? [];
          group.push(record);
          grouped.set(record.sourceAgentId, group);
        }
        for (const agentId of agentIds) {
          const checkpoint = legacy.agents[agentId];
          if (agents[agentId] !== undefined || checkpoint === undefined) continue;
          const wireScope = agentScopeOf(scope, agentId);
          const generation = await logs.generation(wireScope, AGENT_WIRE_RECORD_KEY);
          if (generation !== (checkpoint.generation ?? 'legacy')) continue;
          const sourceRecords = grouped.get(agentId) ?? [];
          agents[agentId] = { ...checkpoint, generation };
          for (const record of sourceRecords) if (range === undefined || record.invalid || inRange(record.time, range)) records.push(record);
          const [size, mtimeMs] = await Promise.all([storage.size(wireScope, AGENT_WIRE_RECORD_KEY), storage.mtime(wireScope, AGENT_WIRE_RECORD_KEY)]);
          if (size === checkpoint.size && mtimeMs === checkpoint.mtimeMs) {
            await facts.commit(wireScope, 0, { ...checkpoint, generation }, sourceRecords);
          }
        }
      }
    }
    return { version: PERSISTENCE_VERSION, sessionKey: cacheKey, records, agents };
  }

  private async factJournalCheckpoint(wireScope: string): Promise<WireCheckpoint | undefined> {
    const storage = this.core.accessor.get(IFileSystemStorageService);
    const directory = factJournalDirectory(wireScope);
    const size = await storage.size(directory, FACT_JOURNAL_KEY) ?? 0;
    if (size === 0) return undefined;
    const bytes = await readKeyedRange(storage, directory, FACT_JOURNAL_KEY, Math.max(0, size - Math.min(size, 1024 * 1024)), size - 1);
    const end = bytes.lastIndexOf(10);
    const start = bytes.lastIndexOf(10, Math.max(0, end - 1));
    if (end <= start) return undefined;
    try {
      const batch = JSON.parse(bytes.subarray(start + 1, end).toString('utf8')) as { checkpoint?: WireCheckpoint };
      const checkpoint = batch.checkpoint;
      if (checkpoint !== undefined && Number.isSafeInteger(checkpoint.offset) && checkpoint.offset >= 0 && Number.isSafeInteger(checkpoint.size) && checkpoint.size >= checkpoint.offset && typeof checkpoint.mtimeMs === 'number' && Number.isFinite(checkpoint.mtimeMs) && typeof checkpoint.boundaryHash === 'string' && typeof checkpoint.valid === 'boolean') return checkpoint;
    } catch { return undefined; }
    return undefined;
  }

  private async replayFactJournal(
    wireScope: string,
    cursor: string,
    range: RangeBounds,
    budget: ScanBudget,
    hold: { cursor: string },
    emit: (records: readonly UsageFact[]) => Promise<void>,
  ): Promise<{ done: boolean; cursor: string } | undefined> {
    const parts = cursor.split(':');
    const startOffset = Number(parts[1]);
    let skip = Number(parts[2]);
    if (!Number.isSafeInteger(startOffset) || startOffset < 0 || !Number.isSafeInteger(skip) || skip < 0) return undefined;
    const storage = this.core.accessor.get(IFileSystemStorageService);
    const directory = factJournalDirectory(wireScope);
    const size = await storage.size(directory, FACT_JOURNAL_KEY) ?? 0;
    if (size === 0 || startOffset > size) return undefined;
    hold.cursor = `journal:${startOffset}:${skip}`;
    if (startOffset === size) return { done: true, cursor: hold.cursor };
    let pending = Buffer.alloc(0);
    let lineStart = startOffset;
    let invalid = false;
    const mark = (offset: number, index: number): void => { hold.cursor = `journal:${offset}:${index}`; };
    const consume = async (line: Buffer): Promise<boolean> => {
      let records: UsageFact[];
      try { records = (JSON.parse(line.toString('utf8')) as { records?: UsageFact[] }).records ?? []; }
      catch { invalid = true; return true; }
      const selected: UsageFact[] = [];
      for (let index = skip; index < records.length; index += 1) {
        if (this.now() >= budget.deadlineAt || (budget.remainingFacts ?? Infinity) <= 0) {
          mark(lineStart, index);
          if (selected.length > 0) await emit(selected);
          budget.incompleteReason = this.now() >= budget.deadlineAt ? 'deadline' : 'record_budget';
          return true;
        }
        if (budget.remainingFacts !== undefined) budget.remainingFacts -= 1;
        const record = records[index]!;
        if (record.invalid || inRange(record.time, range)) selected.push(record);
        if (selected.length === 256) { mark(lineStart, index + 1); await emit(selected); selected.length = 0; }
      }
      mark(lineStart + line.byteLength + 1, 0);
      if (selected.length > 0) await emit(selected);
      skip = 0;
      return false;
    };
    try {
      for await (const chunk of storage.readStream(directory, FACT_JOURNAL_KEY, { start: startOffset, end: size - 1 }, { signal: budget.factSignal })) {
        pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, Buffer.from(chunk)]);
        let newline = pending.indexOf(10);
        while (newline >= 0) {
          const line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          if (line.length > 0 && await consume(line)) return invalid ? undefined : { done: false, cursor: hold.cursor };
          lineStart += line.byteLength + 1;
          newline = pending.indexOf(10);
        }
      }
    } catch (error) {
      budget.signal?.throwIfAborted();
      if (budget.factSignal?.aborted || this.now() >= budget.deadlineAt) {
        budget.incompleteReason = 'deadline';
        return { done: false, cursor: hold.cursor };
      }
      throw error;
    }
    if (pending.length > 0 && await consume(pending)) return invalid ? undefined : { done: false, cursor: hold.cursor };
    return invalid ? undefined : { done: true, cursor: hold.cursor };
  }

  private async boundaryHash(
    storage: IFileSystemStorageService,
    scope: string,
    offset: number,
  ): Promise<string> {
    if (offset === 0) return '';
    const start = Math.max(0, offset - BOUNDARY_BYTES);
    const bytes = await readRange(storage, scope, start, offset - 1);
    return createHash('sha256').update(bytes).digest('base64url');
  }

  private async readRetainedSessions(
    query: NormalizedQuery,
    budget: ScanBudget,
    activeKeys: ReadonlySet<string>,
    activeSessionCount: number,
  ): Promise<readonly SessionRecords[]> {
    const retained = await this.core.accessor.get(IRetainedUsageService).listDeletedSessions({
      workspaceIds: query.workspaceIds.length === 0 ? undefined : query.workspaceIds,
      deadlineAt: budget.deadlineAt,
      recordLimit: budget.remainingFacts ?? Infinity,
      signal: budget.signal,
    });
    if (budget.remainingFacts !== undefined) budget.remainingFacts -= retained.scannedRecords;
    if (!retained.complete) budget.sourcesComplete = false;
    if (retained.incompleteReason !== undefined) {
      budget.incompleteReason = retained.incompleteReason;
    }
    const sessions: SessionRecords[] = [];
    for (const snapshot of retained.items) {
      if (activeKeys.has(sessionKey(snapshot))) continue;
      if (!query.includeArchived && snapshot.archived) continue;
      if (this.now() >= budget.deadlineAt) {
        budget.incompleteReason = 'deadline';
        break;
      }
      if (activeSessionCount + sessions.length >= this.limits.sessionScanLimit) {
        budget.incompleteReason = 'session_cap';
        break;
      }
      sessions.push({
        summary: snapshot,
        records: snapshot.records.map(normalizeRetainedRecord),
        complete: snapshot.complete,
        deleted: true,
      });
    }
    return sessions;
  }

  private pruneExpired(now: number): void {
    if (this.limits.cacheTtlMs === 0) return;
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.deleteCacheEntry(key, entry);
    }
  }

  private readCachedSession(key: string, range?: RangeBounds): {
    persisted: PersistentSessionRecords; complete: boolean; view: boolean;
  } | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;
    if (entry.view === undefined) {
      this.cache.delete(key);
      this.cache.set(key, entry);
      return { persisted: entry.persisted, complete: entry.complete, view: false };
    }
    if (range?.startAt === undefined || range.endAt === undefined ||
      range.startAt < entry.view.startAt || range.endAt > entry.view.endAt) return undefined;
    const parts: SessionCacheEntry[] = [];
    for (const partKey of entry.view.parts) {
      const part = this.cache.get(partKey);
      if (part === undefined) return undefined;
      parts.push(part);
    }
    const records: NormalizedUsageRecord[] = [...entry.persisted.records];
    for (const [index, part] of parts.entries()) {
      for (const record of part.persisted.records) records.push(record);
      const partKey = entry.view.parts[index] as string;
      this.cache.delete(partKey);
      this.cache.set(partKey, part);
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return { persisted: { ...entry.persisted, records }, complete: entry.complete, view: true };
  }

  private cacheSessionRange(
    key: string, persisted: PersistentSessionRecords, complete: boolean, range?: RangeBounds,
  ): void {
    if (range?.startAt === undefined || range.endAt === undefined) {
      this.cacheSession(key, persisted, complete);
      return;
    }
    const existing = this.cache.get(key);
    const verifiedAt = existing?.persisted.agents === persisted.agents ? existing.verifiedAt : undefined;
    if (existing !== undefined) this.deleteCacheEntry(key, existing);
    const records = persisted.records.filter((record) => record.invalid || inRange(record.time, range));
    if (records.length > this.limits.cacheMaxRecords || this.limits.cacheMaxEntryRecords <= 0) return;
    if (records.length <= this.limits.cacheMaxEntryRecords) {
      this.cacheSession(key, { ...persisted, records }, complete, {
        startAt: range.startAt, endAt: range.endAt, parts: [],
      });
      const cached = this.cache.get(key);
      if (cached !== undefined) cached.verifiedAt = verifiedAt;
      return;
    }
    const parts: string[] = [];
    for (let offset = 0; offset < records.length; offset += this.limits.cacheMaxEntryRecords) {
      const partKey = `${key}\0view:${range.startAt}:${range.endAt}:${offset}`;
      this.cacheSession(partKey, {
        ...persisted, records: records.slice(offset, offset + this.limits.cacheMaxEntryRecords), agents: {},
      }, complete);
      parts.push(partKey);
    }
    this.cacheSession(key, { ...persisted, records: [] }, complete, {
      startAt: range.startAt, endAt: range.endAt, parts,
    });
    const cached = this.cache.get(key);
    if (cached !== undefined) cached.verifiedAt = verifiedAt;
  }

  private cacheSession(
    key: string, persisted: PersistentSessionRecords, complete: boolean, view?: SessionCacheView,
  ): void {
    const existing = this.cache.get(key);
    if (existing !== undefined) this.deleteCacheEntry(key, existing);
    const records = persisted.records;
    if (records.length > this.limits.cacheMaxEntryRecords) return;
    const bytes = records.reduce((total, record) => total + 384 + 2 * (
      (record.sourceAgentId?.length ?? 0) + record.model.length +
      (record.agentId?.length ?? 0) + (record.parentAgentId?.length ?? 0) +
      (record.provider?.length ?? 0) + (record.modelAlias?.length ?? 0) +
      (record.profileName?.length ?? 0)
    ), 256 + Object.keys(persisted.agents).length * 256 +
      (view?.parts.reduce((total, part) => total + 32 + part.length * 2, 0) ?? 0));
    if (bytes > this.limits.cacheMaxBytes) return;
    while (
      this.cache.size >= this.limits.cacheMaxEntries ||
      this.cachedRecordCount + records.length > this.limits.cacheMaxRecords ||
      this.cachedBytes + bytes > this.limits.cacheMaxBytes
    ) {
      const oldest = this.cache.entries().next().value;
      if (oldest === undefined) return;
      this.deleteCacheEntry(oldest[0], oldest[1]);
    }
    this.cache.set(key, {
      expiresAt: this.now() + this.limits.cacheTtlMs,
      persisted,
      complete,
      bytes,
      view,
      verifiedAt: existing?.persisted.agents === persisted.agents ? existing.verifiedAt : undefined,
    });
    this.cachedRecordCount += records.length;
    this.cachedBytes += bytes;
  }

  private deleteCacheEntry(key: string, entry: SessionCacheEntry): void {
    this.cache.delete(key);
    this.cachedRecordCount -= entry.persisted.records.length;
    this.cachedBytes -= entry.bytes;
    for (const partKey of entry.view?.parts ?? []) {
      const part = this.cache.get(partKey);
      if (part !== undefined) this.deleteCacheEntry(partKey, part);
    }
  }

  private factJournalReplayEnabled(): boolean {
    return this.limits.usageFactBudget >= DEFAULT_LIMITS.usageFactBudget && this.limits.deadlineMs >= DEFAULT_LIMITS.deadlineMs;
  }

  private projectionWritable(): boolean {
    return this.cache.size === 0 && this.limits.usageFactBudget >= DEFAULT_LIMITS.usageFactBudget && this.limits.deadlineMs >= DEFAULT_LIMITS.deadlineMs && this.rescan.state !== 'running';
  }

  private async replayRangeProjection(raw: UsageQuery, query: NormalizedQuery, fingerprint: string, signal: AbortSignal): Promise<UsageResponse | undefined> {
    if (query.range.startAt === undefined || query.range.endAt === undefined || !this.projectionWritable() && this.loadedProjection === undefined) return undefined;
    if (this.limits.usageFactBudget < DEFAULT_LIMITS.usageFactBudget || this.limits.deadlineMs < DEFAULT_LIMITS.deadlineMs || this.rescan.state === 'running') return undefined;
    const tracked = this.sourceChanges?.ready === true;
    const hot = this.loadedProjection;
    if (hot?.fingerprint === fingerprint && hot.epoch === this.replayEpoch && tracked && this.now() - hot.verifiedAt < SOURCE_RECHECK_MS && raw.page_token === undefined) {
      return this.aggregateProjection(hot.projection, raw, query, fingerprint, signal);
    }
    if (this.cache.size !== 0 && hot?.fingerprint !== fingerprint) return undefined;
    let projection = hot?.fingerprint === fingerprint ? hot.projection : undefined;
    if (projection === undefined) {
      if (this.cache.size !== 0) return undefined;
      const bytes = await this.core.accessor.get(IFileSystemStorageService).read(PERSISTENCE_SCOPE, projectionFileName(fingerprint));
      const parsed = bytes === undefined ? undefined : parseUsageRangeProjection(bytes);
      if (parsed === undefined || parsed.fingerprint !== fingerprint || !hasProjectionTurnEvidence(parsed)) return undefined;
      projection = parsed;
    }
    if (!hasProjectionTurnEvidence(projection)) return undefined;
    await this.prepareInventory();
    const budget: ScanBudget = { signal, remainingRecords: this.limits.wireRecordBudget, deadlineAt: this.now() + this.limits.deadlineMs, sourcesComplete: true, incompleteReason: null };
    const listed = await this.listSessions(query, budget);
    if (budget.incompleteReason !== null) return undefined;
    const changes = await this.changedProjectionAgents(projection, query, listed.items, signal);
    if (changes === undefined) return undefined;
    if (changes.length > 0) {
      const updated = await this.updateProjectionAgents(projection, changes, query, listed.items, signal);
      if (updated === undefined) return undefined;
      projection = updated;
      try { await this.writeProjection(fingerprint, projection); } catch {}
    }
    const response = await this.aggregateProjection(projection, raw, query, fingerprint, signal);
    if (response?.reliability.complete) this.loadedProjection = { fingerprint, projection, epoch: this.replayEpoch, verifiedAt: this.now() };
    return response;
  }

  private async changedProjectionAgents(
    projection: UsageRangeProjection,
    query: NormalizedQuery,
    listed: readonly SessionSummary[],
    signal: AbortSignal,
  ): Promise<{ scope: string; sessionId: string; size: number; mtimeMs: number; generation: string; previous?: UsageProjectionAgent; append: boolean }[] | undefined> {
    const storage = this.core.accessor.get(IFileSystemStorageService);
    const logs = this.core.accessor.get(IAppendLogStore);
    const stored = new Map(projection.agents.map((agent) => [agent.scope, agent]));
    const seen = new Set<string>();
    const changes: { scope: string; sessionId: string; size: number; mtimeMs: number; generation: string; previous?: UsageProjectionAgent; append: boolean }[] = [];
    const jobs: { summary: SessionSummary; scope: string }[] = [];
    for (let offset = 0; offset < listed.length; offset += PROJECTION_STAT_CONCURRENCY) {
      signal.throwIfAborted();
      const pages = await Promise.all(listed.slice(offset, offset + PROJECTION_STAT_CONCURRENCY).map(async (summary) => {
        const sessionScope = sessionScopeOf(workspacePersistenceScope('sessions', summary.workspaceId), summary.id);
        const agentIds = await storage.list(`${sessionScope}/agents`);
        return agentIds.map((agentId) => ({ summary, scope: agentScopeOf(sessionScope, agentId) }));
      }));
      for (const page of pages) jobs.push(...page);
    }
    for (let offset = 0; offset < jobs.length; offset += PROJECTION_STAT_CONCURRENCY) {
      signal.throwIfAborted();
      const slice = jobs.slice(offset, offset + PROJECTION_STAT_CONCURRENCY);
      const stats = await Promise.all(slice.map(async (job) => {
        seen.add(job.scope);
        const [size, mtimeMs] = await Promise.all([storage.size(job.scope, AGENT_WIRE_RECORD_KEY), storage.mtime(job.scope, AGENT_WIRE_RECORD_KEY)]);
        const mtime = mtimeMs ?? 0;
        const bytes = size ?? 0;
        if (mtimeExcludesRange(mtime, query.range.startAt)) return { job, bytes, mtime, generation: undefined as string | undefined };
        return { job, bytes, mtime, generation: await logs.generation(job.scope, AGENT_WIRE_RECORD_KEY) };
      }));
      for (const { job, bytes, mtime, generation } of stats) {
        if (generation === undefined) {
          if (stored.has(job.scope)) changes.push({ scope: job.scope, sessionId: job.summary.id, size: bytes, mtimeMs: mtime, generation: 'legacy', append: false });
          continue;
        }
        const previous = stored.get(job.scope);
        if (previous !== undefined && previous.watermark.size === bytes && previous.watermark.mtimeMs === mtime && previous.watermark.generation === generation) continue;
        const append = previous !== undefined && previous.watermark.generation === generation && bytes > previous.watermark.size && await this.boundaryHash(storage, job.scope, previous.watermark.size) === previous.watermark.boundaryHash;
        changes.push({ scope: job.scope, sessionId: job.summary.id, size: bytes, mtimeMs: mtime, generation, previous, append });
      }
    }
    for (const agent of projection.agents) if (!seen.has(agent.scope)) changes.push({ scope: agent.scope, sessionId: agent.sessionId, size: 0, mtimeMs: 0, generation: agent.watermark.generation, previous: agent, append: false });
    return changes;
  }

  private async updateProjectionAgents(
    projection: UsageRangeProjection,
    changes: readonly { scope: string; sessionId: string; size: number; mtimeMs: number; generation: string; previous?: UsageProjectionAgent; append: boolean }[],
    query: NormalizedQuery,
    listed: readonly SessionSummary[],
    signal: AbortSignal,
  ): Promise<UsageRangeProjection | undefined> {
    if (!hasProjectionTurnEvidence(projection) || changes.some((change) => !change.append || change.previous === undefined)) return undefined;
    const storage = this.core.accessor.get(IFileSystemStorageService);
    const facts = this.core.accessor.get(IUsageFactStore);
    const tails: { scope: string; sessionId: string; records: UsageFact[] }[] = [];
    let next = projection;
    for (const change of changes) {
      const previous = change.previous;
      if (previous === undefined) return undefined;
      const summary = listed.find((item) => item.id === change.sessionId) ?? { id: change.sessionId, workspaceId: '', createdAt: 0, updatedAt: 0, archived: false };
      const allowance = new UsageReadAllowance(Infinity, Infinity, Infinity);
      const tail = await readUsageWireTail(storage, change.scope, previous.watermark.size, change.size, allowance, this.now() + this.limits.deadlineMs, this.now, change.scope.split('/').at(-1), signal, undefined, this.pendingWireLines, JSON.stringify([change.generation, change.size, change.mtimeMs]), undefined, undefined, signal);
      if (!tail.complete || !tail.valid || tail.offset < change.size) return undefined;
      const records = tail.records.filter((record) => !record.invalid && inRange(record.time, query.range) && matchesFilters(record, query));
      tails.push({ scope: change.scope, sessionId: change.sessionId, records });
      const boundaryHash = await this.boundaryHash(storage, change.scope, change.size);
      const updated = appendProjectionAgent(next, change.scope, { size: change.size, mtimeMs: change.mtimeMs, generation: change.generation, boundaryHash }, records, (record) => resolveBucket(record.time, summary, query).key);
      if (updated === undefined) return undefined;
      next = updated;
      try {
        await facts.commit(change.scope, previous.watermark.size, { generation: change.generation, offset: change.size, size: change.size, mtimeMs: change.mtimeMs, boundaryHash, valid: true }, tail.records);
      } catch {}
    }
    if (!next.storedBuckets) return next;
    return {
      ...next,
      buckets: appendStoredBuckets(projection.buckets, projection.agents, tails, (sessionId, record) => {
        const summary = listed.find((item) => item.id === sessionId) ?? { id: sessionId, workspaceId: '', createdAt: 0, updatedAt: 0, archived: false };
        return resolveBucket(record.time, summary, query).key;
      }, this.limits.drilldownSessionLimit, this.limits.drilldownTurnLimit),
    };
  }

  private async aggregateProjection(projection: UsageRangeProjection, raw: UsageQuery, query: NormalizedQuery, fingerprint: string, signal: AbortSignal): Promise<UsageResponse> {
    const now = this.now();
    const budget: ScanBudget = { signal, remainingRecords: this.limits.wireRecordBudget, remainingFacts: this.limits.usageFactBudget, deadlineAt: now + this.limits.deadlineMs, sourcesComplete: true, incompleteReason: null };
    const listed = await this.listSessions(query, budget);
    const active = new Set(listed.items.map((summary) => sessionKey(summary)));
    const agents = projection.agents.filter((agent) => {
      const parts = agent.scope.split('/');
      return active.has(`${parts[1] ?? ''}\0${parts[2] ?? ''}`);
    });
    const sessions: SessionRecords[] = listed.items.map((summary) => ({ summary, records: [], complete: true, deleted: false }));
    const fold = new UsageProjectionFold(projectionRows({ ...projection, agents }), projection.storedBuckets ? projection.buckets : bucketsFromAgents(agents, this.limits.drilldownSessionLimit, this.limits.drilldownTurnLimit));
    if (budget.incompleteReason === null) {
      const uncached = listed.items.filter((summary) => !this.fullScanKeys?.has(sessionKey(summary))).length;
      sessions.push(...await this.readRetainedSessions(query, budget, listed.activeKeys, uncached));
    }
    let ephemeral: readonly EphemeralUsageTotal[] = [];
    const retainedUsage = this.core.accessor.get(IRetainedUsageService);
    if (budget.incompleteReason === null && retainedUsage.listEphemeralUsage !== undefined) {
      const anonymous = await retainedUsage.listEphemeralUsage({ workspaceIds: query.workspaceIds.length === 0 ? undefined : query.workspaceIds, deadlineAt: budget.deadlineAt, recordLimit: budget.remainingFacts ?? Infinity, signal });
      ephemeral = anonymous.items;
      if (!anonymous.complete) budget.sourcesComplete = false;
      if (anonymous.incompleteReason !== undefined) budget.incompleteReason = anonymous.incompleteReason;
    }
    const cursor = raw.page_token === undefined ? undefined : decodePageToken(raw.page_token, fingerprint);
    return this.aggregate(query, sessions, fingerprint, cursor, budget, ephemeral, fold);
  }

  private async saveRecordProjection(query: NormalizedQuery, fingerprint: string, listed: readonly SessionSummary[], sessions: readonly SessionRecords[]): Promise<void> {
    try {
      const sources = await this.recordProjectionSources(query, listed, sessions);
      if (sources === undefined) return;
      const projection = buildRangeProjection(fingerprint, listed.map(projectionSessionOf), sources, (sessionId, record) => {
        const summary = listed.find((item) => item.id === sessionId) ?? { id: sessionId, workspaceId: '', createdAt: record.time, updatedAt: record.time, archived: false };
        return resolveBucket(record.time, summary, query).key;
      });
      await this.writeProjection(fingerprint, projection);
    } catch { /* the next process repeats the bounded read */ }
  }

  private async recordProjectionSources(query: NormalizedQuery, listed: readonly SessionSummary[], sessions: readonly SessionRecords[]): Promise<{ scope: string; sessionId: string; watermark: UsageProjectionAgent['watermark']; records: readonly UsageFact[] }[] | undefined> {
    const storage = this.core.accessor.get(IFileSystemStorageService);
    const logs = this.core.accessor.get(IAppendLogStore);
    const recordsByScope = new Map<string, UsageFact[]>();
    for (const session of sessions) {
      if (session.deleted) continue;
      if (!session.complete) return undefined;
      const sessionScope = sessionScopeOf(workspacePersistenceScope('sessions', session.summary.workspaceId), session.summary.id);
      const cachedAgents = Object.keys(this.cache.get(sessionKey(session.summary))?.persisted.agents ?? {});
      for (const record of session.records) {
        if (record.invalid) return undefined;
        const agentId = record.sourceAgentId ?? record.agentId ?? (cachedAgents.length === 1 ? cachedAgents[0] : undefined);
        if (agentId === undefined) return undefined;
        const scope = agentScopeOf(sessionScope, agentId);
        const bucket = recordsByScope.get(scope) ?? [];
        bucket.push(record);
        recordsByScope.set(scope, bucket);
      }
    }
    const sources: { scope: string; sessionId: string; watermark: UsageProjectionAgent['watermark']; records: readonly UsageFact[] }[] = [];
    for (const summary of listed) {
      const cached = this.cache.get(sessionKey(summary));
      if (cached === undefined || !cached.complete) return undefined;
      const sessionScope = sessionScopeOf(workspacePersistenceScope('sessions', summary.workspaceId), summary.id);
      const agentIds = await storage.list(`${sessionScope}/agents`);
      if (agentIds.length !== Object.keys(cached.persisted.agents).length) return undefined;
      for (const agentId of agentIds) {
        const scope = agentScopeOf(sessionScope, agentId);
        const checkpoint = cached.persisted.agents[agentId];
        if (checkpoint === undefined || !checkpoint.valid || checkpoint.offset !== checkpoint.size) return undefined;
        const [size, mtimeMs, generation] = await Promise.all([storage.size(scope, AGENT_WIRE_RECORD_KEY), storage.mtime(scope, AGENT_WIRE_RECORD_KEY), logs.generation(scope, AGENT_WIRE_RECORD_KEY)]);
        if ((size ?? 0) !== checkpoint.size || (mtimeMs ?? 0) !== checkpoint.mtimeMs || generation !== (checkpoint.generation ?? 'legacy')) return undefined;
        if (mtimeExcludesRange(mtimeMs ?? 0, query.range.startAt)) {
          if ((recordsByScope.get(scope)?.length ?? 0) > 0) return undefined;
          continue;
        }
        sources.push({ scope, sessionId: summary.id, watermark: { size: size ?? 0, mtimeMs: mtimeMs ?? 0, generation, boundaryHash: checkpoint.boundaryHash }, records: recordsByScope.get(scope) ?? [] });
      }
    }
    return sources;
  }

  private async saveFoldProjection(query: NormalizedQuery, fingerprint: string, listed: readonly SessionSummary[], head: RangeFoldHead, fold: UsageRangeFold): Promise<void> {
    try {
      const storage = this.core.accessor.get(IFileSystemStorageService);
      const logs = this.core.accessor.get(IAppendLogStore);
      const pending: { session: RangeFoldSession; source: RangeFoldSource }[] = [];
      for (const session of head.sessions) {
        for (const source of session.sources ?? []) {
          if (!mtimeExcludesRange(source.checkpoint.mtimeMs, query.range.startAt)) pending.push({ session, source });
        }
      }
      const agents: UsageProjectionAgent[] = [];
      for (let offset = 0; offset < pending.length; offset += AGENT_STAT_CONCURRENCY) {
        const slice = pending.slice(offset, offset + AGENT_STAT_CONCURRENCY);
        const stats = await Promise.all(slice.map(async ({ source }) => {
          const [size, mtimeMs, generation] = await Promise.all([storage.size(source.scope, AGENT_WIRE_RECORD_KEY), storage.mtime(source.scope, AGENT_WIRE_RECORD_KEY), logs.generation(source.scope, AGENT_WIRE_RECORD_KEY)]);
          return { size: size ?? 0, mtimeMs: mtimeMs ?? 0, generation };
        }));
        for (let index = 0; index < slice.length; index += 1) {
          const { session, source } = slice[index]!;
          const stat = stats[index]!;
          if (stat.size !== source.checkpoint.size || stat.mtimeMs !== source.checkpoint.mtimeMs || stat.generation !== (source.checkpoint.generation ?? 'legacy')) return;
          agents.push({ scope: source.scope, sessionId: session.summary.id, watermark: { size: source.checkpoint.size, mtimeMs: source.checkpoint.mtimeMs, generation: source.checkpoint.generation ?? 'legacy', boundaryHash: source.checkpoint.boundaryHash }, rows: [], turns: [] });
        }
      }
      const rows: { sessionId: string; record: FoldedUsageRecord }[] = [];
      const keys = new Set<string>();
      const listedById = new Map(listed.map((summary) => [summary.id, summary]));
      let cursor: string | undefined;
      do {
        const page = await fold.recordPage(cursor);
        for (const row of page.items) {
          rows.push(row);
          const summary = listedById.get(row.sessionId) ?? { id: row.sessionId, workspaceId: '', createdAt: row.record.time, updatedAt: row.record.time, archived: false };
          keys.add(resolveBucket(row.record.time, summary, query).key);
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      const stored = keys.size === 0 ? new Map<string, FoldBucketView>() : await fold.buckets([...keys]);
      const proved = [...stored.values()].filter((bucket): bucket is FoldBucketView => bucket !== undefined && typeof bucket.key === 'string');
      if (proved.length !== keys.size || proved.some((bucket) => bucket.turnAgents !== true || bucket.sessions.some((session) => !Array.isArray(session.agents)))) return;
      const rowsByScope = new Map<string, FoldedUsageRecord[]>();
      const agentsBySession = new Map<string, UsageProjectionAgent[]>();
      for (const agent of agents) {
        const group = agentsBySession.get(agent.sessionId) ?? [];
        group.push(agent);
        agentsBySession.set(agent.sessionId, group);
      }
      for (const row of rows) {
        if (!listedById.has(row.sessionId)) return;
        const identity = row.record.sourceAgentId ?? row.record.agentId;
        const inSession = agentsBySession.get(row.sessionId) ?? [];
        const matches = identity === undefined ? [] : inSession.filter((agent) => agent.scope.slice(agent.scope.lastIndexOf('/') + 1) === identity);
        const agent = matches.length === 1 ? matches[0] : matches.length === 0 ? inSession[0] : undefined;
        if (agent === undefined) return;
        const bucket = rowsByScope.get(agent.scope) ?? [];
        bucket.push(row.record);
        rowsByScope.set(agent.scope, bucket);
      }
      const turnsByScope = new Map<string, { bucket: string; turnIds: number[]; unknownTurnRecords: number }[]>();
      for (const value of proved) {
        for (const session of value.sessions) {
          for (const entry of session.agents ?? []) {
            const inSession = agentsBySession.get(session.sessionId) ?? [];
            const matched = inSession.filter((agent) => agent.scope.slice(agent.scope.lastIndexOf('/') + 1) === entry.agentId);
            const agent = matched.length === 1 ? matched[0] : undefined;
            if (agent === undefined) continue;
            const turns = turnsByScope.get(agent.scope) ?? [];
            turns.push({ bucket: value.key, turnIds: [...entry.turnIds], unknownTurnRecords: entry.unknownTurnRecords });
            turnsByScope.set(agent.scope, turns);
          }
        }
      }
      const projection: UsageRangeProjection = {
        version: 2,
        fingerprint,
        folded: true,
        storedBuckets: true,
        sessions: listed.map(projectionSessionOf),
        buckets: proved.map((bucket) => ({
          key: bucket.key,
          turnCount: bucket.turnCount,
          sessionsTruncated: bucket.sessionsTruncated,
          sessions: bucket.sessions.map((session) => ({
            sessionId: session.sessionId,
            turnIds: [...session.turnIds],
            turnCount: session.turnCount,
            unknownTurnRecords: session.unknownTurnRecords,
          })),
        })),
        agents: agents.map((agent) => ({ ...agent, rows: rowsByScope.get(agent.scope) ?? [], turns: turnsByScope.get(agent.scope) ?? [] })),
      };
      await this.writeProjection(fingerprint, projection);
    } catch {}
  }

  private async advanceCompleteFold(head: RangeFoldHead, fold: UsageRangeFold, query: NormalizedQuery, budget: ScanBudget): Promise<boolean> {
    const storage = this.core.accessor.get(IFileSystemStorageService);
    const logs = this.core.accessor.get(IAppendLogStore);
    const facts = this.core.accessor.get(IUsageFactStore);
    const changed: { session: RangeFoldSession; source: RangeFoldSource; size: number; mtimeMs: number; generation: string }[] = [];
    for (const session of head.sessions) {
      if (!session.prepared || session.sources === undefined) return false;
      budget.signal?.throwIfAborted();
      const scope = sessionScopeOf(workspacePersistenceScope('sessions', session.summary.workspaceId), session.summary.id);
      const agentIds = await storage.list(`${scope}/agents`);
      if (agentIds.length !== session.sources.length || session.sources.some((source) => !agentIds.includes(source.agentId))) return false;
      for (const source of session.sources) {
        const [size, mtimeMs, generation] = await Promise.all([storage.size(source.scope, AGENT_WIRE_RECORD_KEY), storage.mtime(source.scope, AGENT_WIRE_RECORD_KEY), logs.generation(source.scope, AGENT_WIRE_RECORD_KEY)]);
        const bytes = size ?? 0;
        const mtime = mtimeMs ?? 0;
        const checkpoint = source.checkpoint;
        if (generation !== (checkpoint.generation ?? 'legacy') || bytes < checkpoint.offset) return false;
        if (bytes === checkpoint.size && mtime === checkpoint.mtimeMs) continue;
        if (mtimeExcludesRange(mtime, query.range.startAt) && mtimeExcludesRange(checkpoint.mtimeMs, query.range.startAt)) {
          source.checkpoint = { ...checkpoint, size: bytes, mtimeMs: mtime, generation };
          continue;
        }
        if (bytes < checkpoint.size || await this.boundaryHash(storage, source.scope, checkpoint.offset) !== checkpoint.boundaryHash) return false;
        if (bytes === checkpoint.size) return false;
        changed.push({ session, source, size: bytes, mtimeMs: mtime, generation });
      }
    }
    for (const job of changed) {
      const checkpoint = job.source.checkpoint;
      const allowance = new UsageReadAllowance(budget.remainingRecords, budget.remainingFacts ?? Infinity, Infinity);
      const tail = await readUsageWireTail(storage, job.source.scope, checkpoint.offset, job.size, allowance, budget.deadlineAt, this.now, job.source.agentId, budget.factSignal, undefined, this.pendingWireLines, JSON.stringify([job.generation, job.size, job.mtimeMs]), undefined, undefined, budget.signal);
      if (!tail.complete || !tail.valid || tail.offset < job.size) return false;
      const records = tail.records.filter((record) => !record.invalid && inRange(record.time, query.range) && matchesFilters(record, query));
      if (records.length > 0) await fold.addPage(job.session.summary, records, (record) => resolveBucket(record.time, job.session.summary, query).key, (record) => inRange(record.time, query.range) && matchesFilters(record, query), head, budget.factSignal);
      const boundaryHash = await this.boundaryHash(storage, job.source.scope, job.size);
      const prefix = { generation: job.generation, offset: job.size, size: job.size, mtimeMs: job.mtimeMs, boundaryHash, valid: checkpoint.valid && tail.valid };
      try { await facts.commit(job.source.scope, checkpoint.offset, prefix, tail.records); } catch { return false; }
      job.source.checkpoint = prefix;
      job.source.done = true;
      budget.remainingRecords -= tail.scannedRecordCount;
      if (budget.remainingFacts !== undefined) budget.remainingFacts -= tail.scannedFactCount;
    }
    head.complete = head.sessions.every((session) => session.prepared && session.sources?.every((source) => source.done));
    await fold.saveHead(head);
    return head.complete;
  }

  private writeProjection(fingerprint: string, projection: UsageRangeProjection): Promise<void> {
    return this.core.accessor.get(IFileSystemStorageService).write(PERSISTENCE_SCOPE, projectionFileName(fingerprint), Buffer.from(JSON.stringify(projection)), { atomic: true });
  }

  private async aggregate(
    query: NormalizedQuery,
    sessions: readonly SessionRecords[],
    fingerprint: string,
    cursor: readonly [number, string] | undefined,
    budget: ScanBudget,
    ephemeralUsage: readonly EphemeralUsageTotal[] = [],
    fold?: UsageFoldView,
  ): Promise<UsageResponse> {
    const total = emptyAggregate();
    const buckets = new Map<string, BucketAccumulator>();
    const sessionAccumulators = new Map<string, SessionAccumulator>();
    const unknownPriceModels = new Set<string>();
    const incompleteSessionIds = new Set(
      sessions.filter((session) => !session.complete).map((session) => session.summary.id),
    );
    let earliestAt: number | undefined;
    let latestAt: number | undefined;
    const includesDeletedSessions = sessions.some((session) => session.deleted);
    const pricing = this.core.accessor.get(IModelPricingService);
    const scanIncomplete = budget.incompleteReason !== null;
    let processedRecords = 0;
    const foldedBuckets = new Map<string, FoldBucketView>();
    const now = this.now;
    async function* inputs(): AsyncGenerator<SessionRecords> {
      yield* sessions;
      if (fold === undefined) return;
      const byId = new Map(sessions.map((session) => [session.summary.id, session]));
      let pageCursor: string | undefined;
      do {
        budget.signal?.throwIfAborted();
        try {
          const page = await waitForSource(fold.recordPage(pageCursor), budget.factSignal);
          for (const row of page.items) {
            const session = byId.get(row.sessionId);
            if (session !== undefined) yield { ...session, records: [row.record] };
          }
          pageCursor = page.nextCursor;
        } catch (error) {
          budget.signal?.throwIfAborted();
          if (!budget.factSignal?.aborted) throw error;
          budget.incompleteReason = 'deadline'; budget.sourcesComplete = false; return;
        }
      } while (pageCursor !== undefined);
    }

    sessionLoop: for await (const session of inputs()) {
      for (const record of session.records) {
        if (record.invalid) { incompleteSessionIds.add(session.summary.id); continue; }
        if (fold === undefined && processedRecords > 0 && this.now() >= budget.deadlineAt) {
          budget.incompleteReason = 'deadline';
          budget.sourcesComplete = false;
          incompleteSessionIds.add(session.summary.id);
          break sessionLoop;
        }
        processedRecords += 1;
        if (processedRecords % 1024 === 0) await yieldToEventLoop(undefined, { signal: budget.signal });
        budget.signal?.throwIfAborted();
        if (!inRange(record.time, query.range) || !matchesFilters(record, query)) continue;
        const cost = pricing.calculate(record.model, record.usage);
        addAggregate(total, record, cost);
        if (cost === undefined) unknownPriceModels.add(record.model);
        earliestAt = earliestAt === undefined ? record.time : Math.min(earliestAt, record.time);
        const lastTime = record.folded?.latestAt ?? record.time;
        latestAt = latestAt === undefined ? lastTime : Math.max(latestAt, lastTime);

        const bucket = resolveBucket(record.time, session.summary, query);
        let bucketAcc = buckets.get(bucket.key);
        if (bucketAcc === undefined) {
          bucketAcc = {
            key: bucket.key,
            startAt: bucket.startAt,
            endAt: bucket.endAt,
            groups: new Map(),
            turnKeys: new Set(),
            requestCount: 0,
            drilldownSessions: new Map(),
            drilldownSessionsTruncated: false,
          };
          buckets.set(bucket.key, bucketAcc);
        } else if (query.granularity === 'session') {
          bucketAcc.startAt = Math.min(bucketAcc.startAt, record.time);
          bucketAcc.endAt = Math.max(bucketAcc.endAt, lastTime + 1);
        }
        if (query.granularity === 'session') bucketAcc.endAt = Math.max(bucketAcc.endAt, lastTime + 1);
        bucketAcc.requestCount += record.folded?.records ?? 1;
        if (record.turnId !== undefined) {
          bucketAcc.turnKeys.add(`${session.summary.id}\0${record.agentId ?? record.sourceAgentId ?? ''}\0${record.turnId}`);
        }
        const groupKey = dimensionKey(query.dimension, record, session.summary);
        let group = bucketAcc.groups.get(groupKey);
        if (group === undefined) {
          group = {
            key: groupKey,
            ...emptyAggregate(),
            providers: new Set(),
            modelAliases: new Set(),
            agentIds: new Set(),
            parentAgentIds: new Set(),
            profileNames: new Set(),
          };
          bucketAcc.groups.set(groupKey, group);
        }
        addAggregate(group, record, cost);
        group.providers.add(record.provider ?? null);
        group.modelAliases.add(record.modelAlias ?? null);
        group.agentIds.add(record.agentId ?? null);
        group.parentAgentIds.add(record.parentAgentId ?? null);
        group.profileNames.add(record.profileName ?? null);
        if (record.folded === undefined) {
          let drilldown = bucketAcc.drilldownSessions.get(session.summary.id);
          if (drilldown === undefined && bucketAcc.drilldownSessions.size < this.limits.drilldownSessionLimit) {
            drilldown = { sessionId: session.summary.id, turnIds: new Set(), unknownTurnRecords: 0 };
            bucketAcc.drilldownSessions.set(session.summary.id, drilldown);
          }
          if (drilldown === undefined) bucketAcc.drilldownSessionsTruncated = true;
          else if (record.turnId === undefined) drilldown.unknownTurnRecords += 1;
          else drilldown.turnIds.add(record.turnId);
        }

        let sessionAcc = sessionAccumulators.get(session.summary.id);
        if (sessionAcc === undefined) {
          sessionAcc = {
            summary: session.summary,
            deleted: session.deleted,
            ...emptyAggregate(),
            unknownPriceModels: new Set(),
            modelCounts: new Map(),
            profileNames: new Set(),
          };
          sessionAccumulators.set(session.summary.id, sessionAcc);
        }
        addAggregate(sessionAcc, record, cost);
        if (cost === undefined) sessionAcc.unknownPriceModels.add(record.model);
        sessionAcc.modelCounts.set(record.model, (sessionAcc.modelCounts.get(record.model) ?? 0) + (record.folded?.records ?? 1));
        if (record.profileName !== undefined) sessionAcc.profileNames.add(record.profileName);
      }
    }
    for (const entry of ephemeralUsage) {
      processedRecords += 1;
      if (processedRecords % 1024 === 0) await yieldToEventLoop();
      if (!inRange(entry.time, query.range)) continue;
      if (query.workspaceIds.length > 0 && !query.workspaceIds.includes(entry.workspaceId)) continue;
      if (query.agentIds.length > 0 || query.providers.length > 0 || query.profiles.length > 0) continue;
      if (query.models.length > 0 && !query.models.includes(entry.model)) continue;
      const record: NormalizedUsageRecord = entry;
      const cost = pricing.calculate(record.model, record.usage);
      addAggregate(total, record, cost);
      if (cost === undefined) unknownPriceModels.add(record.model);
      earliestAt = earliestAt === undefined ? record.time : Math.min(earliestAt, record.time);
      latestAt = latestAt === undefined ? record.time : Math.max(latestAt, record.time);
      if (query.granularity === 'session') continue;
      const period = resolveBucket(record.time, {
        id: 'ephemeral', workspaceId: entry.workspaceId, createdAt: record.time,
        updatedAt: record.time, archived: false,
      }, query);
      let bucket = buckets.get(period.key);
      if (bucket === undefined) {
        bucket = {
          ...period, groups: new Map(),
          turnKeys: new Set(), requestCount: 0, drilldownSessions: new Map(),
          drilldownSessionsTruncated: false,
        };
        buckets.set(period.key, bucket);
      }
      bucket.requestCount += 1;
      const groupKey = query.dimension === 'project' ? entry.workspaceId
        : query.dimension === 'model' ? entry.model
        : query.dimension === 'provider' || query.dimension === 'profile' ? `${query.dimension}:null`
        : 'ephemeral';
      let group = bucket.groups.get(groupKey);
      if (group === undefined) {
        group = {
          key: groupKey, ...emptyAggregate(), providers: new Set(), modelAliases: new Set(),
          agentIds: new Set(), parentAgentIds: new Set(), profileNames: new Set(),
        };
        bucket.groups.set(groupKey, group);
      }
      addAggregate(group, record, cost);
      group.modelAliases.add(entry.model);
      if (query.dimension === 'provider' || query.dimension === 'profile') {
        group.providers.add(null);
        group.profileNames.add(null);
        group.agentIds.add(null);
        group.parentAgentIds.add(null);
      }
    }
    if (budget.incompleteReason === null && fold === undefined && this.now() >= budget.deadlineAt) {
      budget.incompleteReason = 'deadline';
    }

    const sessionItems = [...sessionAccumulators.values()].toSorted(compareSessions);
    const pageStart = cursor === undefined ? 0 : findPageStart(sessionItems, cursor);
    const pageItems = sessionItems.slice(pageStart, pageStart + query.pageSize);
    const hasMore = pageStart + pageItems.length < sessionItems.length;
    const last = pageItems.at(-1);

    if (fold !== undefined && !budget.factSignal?.aborted) {
      const keys = [...buckets.keys()];
      try {
        for (let offset = 0; offset < keys.length; offset += 64) {
          if (this.now() >= budget.deadlineAt) { budget.incompleteReason = 'deadline'; budget.sourcesComplete = false; break; }
          const page = await waitForSource(fold.buckets(keys.slice(offset, offset + 64)), budget.factSignal);
          for (const value of page.values()) {
            const bucket = buckets.get(value.key)!;
            const combined = [...value.sessions, ...[...bucket.drilldownSessions.values()].map((session) => ({ ...session, turnIds: [...session.turnIds], turnCount: session.turnIds.size }))];
            foldedBuckets.set(value.key, {
              ...value, turnCount: value.turnCount + bucket.turnKeys.size,
              sessions: combined.slice(0, this.limits.drilldownSessionLimit),
              sessionsTruncated: value.sessionsTruncated || bucket.drilldownSessionsTruncated || combined.length > this.limits.drilldownSessionLimit,
            });
          }
        }
      } catch (error) {
        budget.signal?.throwIfAborted();
        if (!budget.factSignal?.aborted) throw error;
        budget.incompleteReason = 'deadline'; budget.sourcesComplete = false;
      }
    }
    return {
      query: {
        granularity: query.granularity,
        range: {
          preset: query.range.preset,
          start_at: query.range.startAt ?? null,
          end_at: query.range.endAt ?? null,
          defaulted_to_all_history: query.range.defaultedToAllHistory,
        },
        dimension: query.dimension,
        models: [...query.models],
        providers: [...query.providers],
        profiles: [...query.profiles],
        agent_ids: [...query.agentIds],
        workspace_ids: [...query.workspaceIds],
        include_archived: query.includeArchived,
        timezone_offset_minutes: query.timezoneOffsetMinutes,
      },
      summary: { ...aggregateWire(total), session_count: sessionAccumulators.size },
      trend: [...buckets.values()]
        .toSorted((a, b) => a.startAt - b.startAt || a.key.localeCompare(b.key))
        .map((bucket) => ({
          key: bucket.key,
          start_at: bucket.startAt,
          end_at: bucket.endAt,
          turn_count: foldedBuckets?.get(bucket.key)?.turnCount ?? bucket.turnKeys.size,
          request_count: bucket.requestCount,
          groups: [...bucket.groups.values()]
            .toSorted((a, b) => b.cost - a.cost || a.key.localeCompare(b.key))
            .map((group) => ({
              key: group.key,
              ...aggregateWire(group),
              provider: singleValue(group.providers),
              model_alias: singleValue(group.modelAliases),
              agent_id: singleValue(group.agentIds),
              parent_agent_id: singleValue(group.parentAgentIds),
              profile_name: singleValue(group.profileNames),
            })),
          drilldown: {
            sessions: (foldedBuckets?.get(bucket.key)?.sessions ?? [...bucket.drilldownSessions.values()])
              .toSorted((a, b) => a.sessionId.localeCompare(b.sessionId))
              .map((session) => {
                const turnIds = [...session.turnIds].toSorted((a, b) => a - b);
                const turnCount = 'turnCount' in session ? session.turnCount : turnIds.length;
                return {
                  session_id: session.sessionId,
                  turn_ids: turnIds.slice(0, this.limits.drilldownTurnLimit),
                  turn_count: turnCount,
                  unknown_turn_records: session.unknownTurnRecords,
                  turn_ids_truncated: turnCount > this.limits.drilldownTurnLimit,
                };
              }),
            sessions_truncated: foldedBuckets?.get(bucket.key)?.sessionsTruncated ?? bucket.drilldownSessionsTruncated,
          },
        })),
      sessions: {
        items: pageItems.map((item) => ({
          id: item.summary.id,
          workspace_id: item.summary.workspaceId,
          title: item.summary.title ?? null,
          created_at: item.summary.createdAt,
          updated_at: item.summary.updatedAt,
          archived: item.summary.archived,
          deleted: item.deleted,
          usage: aggregateWire(item),
          primary_model: [...item.modelCounts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null,
          profile_names: [...item.profileNames].toSorted(),
          unknown_price_models: [...item.unknownPriceModels].toSorted(),
        })),
        total: sessionItems.length,
        has_more: hasMore,
        next_page_token:
          hasMore && last !== undefined ? encodePageToken(fingerprint, last.cost, last.summary.id) : null,
      },
      reliability: {
        complete:
          budget.sourcesComplete &&
          budget.incompleteReason === null &&
          incompleteSessionIds.size === 0,
        coverage: { earliest_at: earliestAt ?? null, latest_at: latestAt ?? null },
        usage_coverage: {
          known_records: total.knownRecords,
          missing_records: total.missingRecords,
          legacy_zero_records: total.legacyZeroRecords,
        },
        scanned_sessions: sessions.length,
        incomplete_sessions: incompleteSessionIds.size,
        unknown_price_models: [...unknownPriceModels].toSorted(),
        includes_deleted_sessions: includesDeletedSessions,
        incomplete_reason: budget.incompleteReason,
      },
    };
  }
}

async function waitForSource<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (signal === undefined) return promise;
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(signal.reason ?? new DOMException('The request was aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', abort); }
}

function factJournalDirectory(wireScope: string): string {
  return `cache/usage-facts-v1/${createHash('sha256').update(wireScope).digest('hex')}`;
}

async function readKeyedRange(
  storage: IFileSystemStorageService,
  scope: string,
  key: string,
  start: number,
  end: number,
): Promise<Buffer> {
  if (end < start) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of storage.readStream(scope, key, { start, end })) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readRange(
  storage: IFileSystemStorageService,
  scope: string,
  start: number,
  end: number,
): Promise<Buffer> {
  if (end < start) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of storage.readStream(
    scope,
    AGENT_WIRE_RECORD_KEY,
    { start, end },
  )) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parsePersistentSession(
  value: unknown,
  cacheKey: string,
): PersistentSessionRecords | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw['version'] !== PERSISTENCE_VERSION ||
    raw['sessionKey'] !== cacheKey ||
    !Array.isArray(raw['records']) ||
    !raw['records'].every(isNormalizedUsageRecord) ||
    raw['agents'] === null ||
    typeof raw['agents'] !== 'object' ||
    Array.isArray(raw['agents'])
  ) {
    return undefined;
  }
  const agents = raw['agents'] as Record<string, unknown>;
  if (!Object.values(agents).every(isWireCheckpoint)) return undefined;
  return value as PersistentSessionRecords;
}

function isNormalizedUsageRecord(value: unknown): value is NormalizedUsageRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const usage = record['usage'];
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return false;
  const tokens = usage as Record<string, unknown>;
  return typeof record['time'] === 'number' &&
    Number.isFinite(record['time']) &&
    typeof record['model'] === 'string' &&
    nonnegativeFinite(tokens['inputOther']) !== undefined &&
    nonnegativeFinite(tokens['output']) !== undefined &&
    nonnegativeFinite(tokens['inputCacheRead']) !== undefined &&
    nonnegativeFinite(tokens['inputCacheCreation']) !== undefined &&
    (record['sourceAgentId'] === undefined || typeof record['sourceAgentId'] === 'string');
}

function isWireCheckpoint(value: unknown): value is WireCheckpoint {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const checkpoint = value as Record<string, unknown>;
  return nonnegativeInteger(checkpoint['offset']) !== undefined &&
    nonnegativeInteger(checkpoint['size']) !== undefined &&
    typeof checkpoint['mtimeMs'] === 'number' &&
    Number.isFinite(checkpoint['mtimeMs']) &&
    typeof checkpoint['boundaryHash'] === 'string' &&
    typeof checkpoint['valid'] === 'boolean';
}

function persistenceKey(cacheKey: string): string {
  return `${createHash('sha256').update(cacheKey).digest('hex')}.json`;
}

function mtimeExcludesRange(mtimeMs: number, startAt: number | undefined): boolean {
  return startAt !== undefined && mtimeMs >= 1_000_000_000_000 && mtimeMs < startAt;
}

function normalizeQuery(raw: UsageQuery, now: number): NormalizedQuery {
  const timezoneOffsetMinutes = raw.timezone_offset_minutes ?? 0;
  const preset = raw.range ?? 'all';
  return {
    granularity: raw.granularity ?? 'day',
    range: resolveRange(preset, raw.start_at, raw.end_at, timezoneOffsetMinutes, now, raw.range === undefined),
    dimension: raw.dimension ?? 'model',
    models: normalizeRepeated(raw.model),
    providers: normalizeRepeated(raw.provider),
    profiles: normalizeRepeated(raw.profile),
    agentIds: normalizeRepeated(raw['agent.id']),
    workspaceIds: normalizeRepeated(raw['workspace.id']),
    includeArchived: raw.include_archived === 'true',
    timezoneOffsetMinutes,
    pageSize: raw.page_size ?? DEFAULT_PAGE_SIZE,
  };
}

function normalizeRepeated(value: string | string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return [...new Set(Array.isArray(value) ? value : [value])].toSorted();
}

function resolveRange(
  preset: RangeBounds['preset'],
  startAt: number | undefined,
  endAt: number | undefined,
  offsetMinutes: number,
  now: number,
  defaultedToAllHistory: boolean,
): RangeBounds {
  if (preset === 'all') return { preset, defaultedToAllHistory };
  if (preset === 'custom') return { preset, startAt, endAt, defaultedToAllHistory };
  if (preset === 'today') {
    const start = startOfDay(now, offsetMinutes);
    return { preset, startAt: start, endAt: start + DAY_MS, defaultedToAllHistory };
  }
  if (preset === 'last_7_days') {
    const end = startOfDay(now, offsetMinutes) + DAY_MS;
    return { preset, startAt: end - 7 * DAY_MS, endAt: end, defaultedToAllHistory };
  }
  if (preset === 'this_week') {
    const start = startOfWeek(now, offsetMinutes);
    return { preset, startAt: start, endAt: start + 7 * DAY_MS, defaultedToAllHistory };
  }
  const shifted = new Date(now + offsetMinutes * 60_000);
  const start = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - offsetMinutes * 60_000;
  const end = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - offsetMinutes * 60_000;
  return { preset, startAt: start, endAt: end, defaultedToAllHistory };
}

function startOfDay(time: number, offsetMinutes: number): number {
  const shifted = new Date(time + offsetMinutes * 60_000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offsetMinutes * 60_000;
}

function startOfWeek(time: number, offsetMinutes: number): number {
  const day = startOfDay(time, offsetMinutes);
  const shifted = new Date(day + offsetMinutes * 60_000);
  const daysSinceMonday = (shifted.getUTCDay() + 6) % 7;
  return day - daysSinceMonday * DAY_MS;
}

function normalizeRetainedRecord(record: RetainedUsageRecord): NormalizedUsageRecord {
  return {
    time: record.time,
    model: record.model,
    usage: record.usage,
    usageKnown: record.usageKnown,
    turnId: record.turnId,
    agentId: record.agentId,
    parentAgentId: record.parentAgentId,
    provider: record.provider,
    modelAlias: record.modelAlias,
    profileName: record.profileName,
  };
}

function nonnegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function inRange(time: number, range: RangeBounds): boolean {
  return (range.startAt === undefined || time >= range.startAt) &&
    (range.endAt === undefined || time < range.endAt);
}

function matchesFilters(record: NormalizedUsageRecord, query: NormalizedQuery): boolean {
  if (
    query.models.length > 0 &&
    !query.models.includes(record.model) &&
    (record.modelAlias === undefined || !query.models.includes(record.modelAlias))
  ) return false;
  if (
    query.providers.length > 0 &&
    (record.provider === undefined || !query.providers.includes(record.provider))
  ) return false;
  if (
    query.profiles.length > 0 &&
    (record.profileName === undefined || !query.profiles.includes(record.profileName))
  ) return false;
  if (
    query.agentIds.length > 0 &&
    (record.agentId === undefined || !query.agentIds.includes(record.agentId))
  ) return false;
  return true;
}

function sessionKey(summary: Pick<SessionSummary, 'id' | 'workspaceId'>): string {
  return `${summary.workspaceId}\0${summary.id}`;
}

function dimensionKey(
  dimension: NormalizedQuery['dimension'],
  record: NormalizedUsageRecord,
  session: SessionSummary,
): string {
  if (dimension === 'agent') return record.agentId ?? 'unknown';
  if (dimension === 'model') return record.modelAlias ?? 'unknown';
  if (dimension === 'provider') return `provider:${JSON.stringify(record.provider ?? null)}`;
  if (dimension === 'profile') return `profile:${JSON.stringify(record.profileName ?? null)}`;
  if (dimension === 'project') return session.workspaceId;
  return session.id;
}

function resolveBucket(
  time: number,
  session: SessionSummary,
  query: NormalizedQuery,
): { key: string; startAt: number; endAt: number } {
  if (query.granularity === 'session') {
    return { key: session.id, startAt: time, endAt: time + 1 };
  }
  if (query.granularity === 'day') {
    const startAt = startOfDay(time, query.timezoneOffsetMinutes);
    return { key: String(startAt), startAt, endAt: startAt + DAY_MS };
  }
  if (query.granularity === 'week') {
    const startAt = startOfWeek(time, query.timezoneOffsetMinutes);
    return { key: String(startAt), startAt, endAt: startAt + 7 * DAY_MS };
  }
  if (query.granularity === 'five_hour') {
    const shifted = time + query.timezoneOffsetMinutes * 60_000;
    const shiftedStart = Math.floor(shifted / FIVE_HOURS_MS) * FIVE_HOURS_MS;
    const startAt = shiftedStart - query.timezoneOffsetMinutes * 60_000;
    return { key: String(startAt), startAt, endAt: startAt + FIVE_HOURS_MS };
  }
  const shifted = new Date(time + query.timezoneOffsetMinutes * 60_000);
  const startAt = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - query.timezoneOffsetMinutes * 60_000;
  const endAt = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - query.timezoneOffsetMinutes * 60_000;
  return { key: String(startAt), startAt, endAt };
}

function emptyUsage(): TokenUsage {
  return { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
}

function emptyAggregate(): AggregateAccumulator {
  return { usage: emptyUsage(), cost: 0, costUnknown: false, knownRecords: 0, missingRecords: 0, legacyZeroRecords: 0 };
}

function addAggregate(target: AggregateAccumulator, record: NormalizedUsageRecord, cost: number | undefined): void {
  const { usage, usageKnown } = record;
  if (record.folded !== undefined) {
    target.knownRecords += record.folded.known;
    target.missingRecords += record.folded.missing;
    target.legacyZeroRecords += record.folded.legacyZero;
    for (const key of ['inputOther', 'output', 'inputCacheRead', 'inputCacheCreation'] as const) target.usage[key] += usage[key];
    if (cost !== undefined) target.cost += cost;
    if (cost === undefined || record.folded.missing > 0 || record.folded.legacyZero > 0) target.costUnknown = true;
    return;
  }
  const legacyZero = usageKnown === undefined &&
    usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation === 0;
  const tokensUnknown = usageKnown === false || legacyZero;
  if (usageKnown === false) target.missingRecords += 1;
  else if (legacyZero) target.legacyZeroRecords += 1;
  else target.knownRecords += 1;
  if (!tokensUnknown) {
    target.usage.inputOther += usage.inputOther;
    target.usage.output += usage.output;
    target.usage.inputCacheRead += usage.inputCacheRead;
    target.usage.inputCacheCreation += usage.inputCacheCreation;
  }
  if (cost === undefined || tokensUnknown) {
    target.costUnknown = true;
  } else {
    target.cost += cost;
  }
}

function aggregateWire(value: AggregateAccumulator): UsageAggregateWire {
  return {
    tokens: {
      input_other: value.usage.inputOther,
      output: value.usage.output,
      input_cache_read: value.usage.inputCacheRead,
      input_cache_creation: value.usage.inputCacheCreation,
    },
    tokens_unknown: value.missingRecords > 0 || value.legacyZeroRecords > 0,
    cost_usd_estimated: value.cost,
    cost_unknown: value.costUnknown,
  };
}

function singleValue(values: ReadonlySet<string | null>): string | null {
  return values.size === 1 ? [...values][0] ?? null : null;
}

function compareSessions(a: SessionAccumulator, b: SessionAccumulator): number {
  if (a.cost !== b.cost) return b.cost - a.cost;
  return b.summary.id.localeCompare(a.summary.id);
}

function findPageStart(
  items: readonly SessionAccumulator[],
  cursor: readonly [number, string],
): number {
  const index = items.findIndex((item) => item.cost === cursor[0] && item.summary.id === cursor[1]);
  if (index < 0) {
    throw new UsagePageTokenMismatchError(
      'page_token position is no longer available; discard it and restart from the first page',
    );
  }
  return index + 1;
}

const PAGE_TOKEN_VERSION = 1;

function queryFingerprint(query: NormalizedQuery): string {
  return createHash('sha256')
    .update(JSON.stringify([
      query.granularity,
      query.range.preset,
      query.range.startAt ?? null,
      query.range.endAt ?? null,
      query.dimension,
      query.models,
      query.providers,
      query.agentIds,
      query.workspaceIds,
      query.includeArchived,
      query.timezoneOffsetMinutes,
      query.pageSize,
      ...(query.profiles.length > 0 ? [query.profiles] : []),
    ]))
    .digest('base64url')
    .slice(0, 16);
}

function encodePageToken(fingerprint: string, cost: number, id: string): string {
  return Buffer.from(JSON.stringify({ v: PAGE_TOKEN_VERSION, f: fingerprint, k: [cost, id] })).toString('base64url');
}

function decodePageToken(raw: string, fingerprint: string): readonly [number, string] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new UsagePageTokenMismatchError(
      'page_token is corrupted; discard it and restart from the first page',
    );
  }
  const token = parsed as { v?: unknown; f?: unknown; k?: unknown };
  const key = Array.isArray(token.k) ? token.k : undefined;
  if (
    token.v !== PAGE_TOKEN_VERSION ||
    token.f !== fingerprint ||
    key === undefined ||
    key.length !== 2 ||
    typeof key[0] !== 'number' ||
    typeof key[1] !== 'string'
  ) {
    throw new UsagePageTokenMismatchError(
      'page_token does not match the query conditions; discard it and restart from the first page',
    );
  }
  return [key[0], key[1]];
}
