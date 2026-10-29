import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import {
  AGENT_WIRE_RECORD_KEY,
  type UsageFact,
  type UsageFactTotals,
  summarizeUsageFacts,
  type UsageFactReadBudget,
  IUsageFactStore,
  IUsageReadModel,
  type UsageReadModelAggregate,
  type UsageReadModelQuote,
  IAppendLogStore,
  IFileSystemStorageService,
  readLogicalBytes,
  IRetainedUsageService,
  ISessionIndex,
  agentScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
  type RetainedUsageRecord,
  type Scope,
  type SessionSummary,
  type TokenUsage,
} from '@kiki/agent-core-v2';
import type { UsageAccountingSnapshot, UsageAggregateWire, UsageQuery, UsageResponse, UsageRescanStatus } from '@kiki/protocol';

import { IModelPricingService } from '../pricing/modelPricingService';
import type { UsageSourceChanges } from './usageSourceTracker';
import { UsageReadAllowance } from '@kiki/agent-core-v2/agent/usage/usageWireFramer';
import { readUsageWireTail, usageRecoveryPool, type UsageRecoveryPool, type WireLineContinuation } from './usageRecovery';
import { parseUsageRangeProjection, projectionFileName, type UsageRangeProjection } from './usageRangeProjection';

const SOURCE_RECHECK_MS = 10 * 60_000;

const DEFAULT_PAGE_SIZE = 50;
const INDEX_PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const PERSISTENCE_SCOPE = 'cache/usage-aggregation-v1';
const BOUNDARY_BYTES = 4 * 1024;
const DEFAULT_LIMITS: UsageAggregationLimits = {
  sessionScanLimit: 500,
  sourceScanLimit: 2048,
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
  readonly sourceScanLimit: number;
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

export type NormalizedUsageRecord = UsageFact;

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

interface SourceReadOptions extends AgentUsageReadOptions {
  readonly verifyBoundary?: boolean;
  readonly factBudget?: UsageFactReadBudget;
  readonly recoveryBudget?: { remainingRecords: number; remainingBytes: number };
  readonly onScannedRecord?: () => void;
}

interface UsageInventorySession {
  readonly summary: SessionSummary;
  readonly version: number | undefined;
  readonly agents: readonly string[];
  readonly sources: { source: string; workspaceId: string; sessionId: string }[];
  nextAgent: number;
  pending?: { source: string; agentId: string; generation: string; size: number; mtimeMs: number; aligned: boolean }[];
}

interface UsageInventory {
  readonly full: boolean;
  readonly revision: number;
  readonly startAt: number;
  readonly summaries: Map<string, SessionSummary>;
  readonly sources: Map<string, { source: string; workspaceId: string; sessionId: string }>;
  readonly dirtyKeys: readonly string[];
  readonly prepared: Map<string, { agents: readonly string[]; version?: number }>;
  readonly heads: Map<string, Awaited<ReturnType<IUsageReadModel['source']>>>;
  page: readonly SessionSummary[];
  nextSession: number;
  before?: string;
  exhausted: boolean;
  current?: UsageInventorySession;
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

interface AggregateAccumulator {
  usage: TokenUsage;
  cost: number;
  costUnknown: boolean;
  knownRecords: number;
  missingRecords: number;
  legacyZeroRecords: number;
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

export class UsagePageTokenMismatchError extends Error {}

/** Usage aggregation reads canonical usage facts through the core SQL-backed read model and fact store. */
export class UsageAggregationService {
  private readonly pendingWireLines = new Map<string, WireLineContinuation>();
  private readonly queryFlights = new Map<string, {
    controller: AbortController; promise: Promise<UsageResponse>; waiters: number; settled: boolean;
  }>();
  private readonly limits: UsageAggregationLimits;
  private rescan: UsageRescanStatus = {
    state: 'idle', scanned_sessions: 0, total_sessions: 0, scanned_records: 0,
    started_at: null, finished_at: null, error: null,
  };
  private exportRetainedIterator: AsyncGenerator<import('@kiki/agent-core-v2').RetainedUsageExportEvent> | undefined;
  private readonly exportEphemeralRecords = new Map<string, NormalizedUsageRecord[]>();
  private exportRetainedIncomplete = false;
  private exportVerifyBoundary = false;
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

  private async runFullRescan(): Promise<void> {
    await this.modelPreparing;
    this.modelReady = false;
    this.preparationController = new AbortController();
    await this.startReadModelPreparation(true);
    if (!this.modelReady) throw new Error('Usage sources remain incomplete; retry the rescan');
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
      if (key === undefined) this.inventoryRevision++;
      else { this.dirtySessions.set(key, this.replayEpoch); this.sessionVersions.set(key, (this.sessionVersions.get(key) ?? 0) + 1); }
      this.modelReady = false;
    });
  }

  private replayEpoch = 0;
  private readonly sourceSubscription?: { dispose(): void };

  dispose(): void {
    this.modelController.abort();
    this.sourceSubscription?.dispose();
    for (const flight of this.queryFlights.values()) flight.controller.abort();
    this.queryFlights.clear();
    this.pendingWireLines.clear();
    this.recovery.dispose();
  }

  cacheStatus(): { readonly entries: number; readonly records: number } {
    return { entries: 0, records: 0 };
  }

  private readonly sessionVersions = new Map<string, number>();
  private readonly sessionAccounting = new Map<string, {
    version: string; agents?: readonly string[]; rows: Record<string, AgentUsageProjection>; revisions: Map<string, string>;
    snapshot?: UsageAccountingSnapshot; snapshotVersion?: string; pricingReady: boolean; flight?: Promise<UsageAccountingSnapshot>;
  }>();

  private sessionVersion(key: string): string { return `${this.inventoryRevision}:${this.sessionVersions.get(key) ?? 0}`; }

  readSessionAccountingSnapshot(workspaceId: string, sessionId: string, fallback?: UsageAccountingSnapshot): UsageAccountingSnapshot {
    const key = `${workspaceId}\0${sessionId}`;
    const saved = this.sessionAccounting.get(key);
    const snapshot = saved?.snapshot;
    if (saved === undefined || snapshot === undefined) return { ...(fallback ?? { version: 2, subject: { session_id: sessionId, scope: 'session' }, covered_at: 0, complete: false, tokens: { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 }, tokens_unknown: false, cost_usd_estimated: 0, cost_unknown: true }), freshness: fallback === undefined ? 'unverified' : 'stale' };
    const freshness = saved.snapshotVersion === this.sessionVersion(key) && this.now() - snapshot.covered_at < SOURCE_RECHECK_MS ? 'current' : 'stale';
    return { ...snapshot, freshness };
  }

  async readSessionAccounting(workspaceId: string, sessionId: string, signal?: AbortSignal): Promise<UsageAccountingSnapshot> {
    signal?.throwIfAborted();
    void this.sourceChanges?.ready;
    const key = `${workspaceId}\0${sessionId}`;
    let saved = this.sessionAccounting.get(key);
    if (saved?.flight !== undefined) return waitForSource(saved.flight, signal);
    const version = this.sessionVersion(key);
    if (saved === undefined || saved.version !== version || saved.snapshot !== undefined && this.now() - saved.snapshot.covered_at >= SOURCE_RECHECK_MS) {
      saved = { version, rows: {}, revisions: new Map(), pricingReady: false, snapshot: saved?.snapshot };
      this.sessionAccounting.set(key, saved);
    }
    if (saved.snapshot?.complete && saved.snapshotVersion === version) {
      saved.snapshot = { ...saved.snapshot, ...this.sessionAccountingTotals(Object.values(saved.rows), saved.pricingReady) };
      return this.readSessionAccountingSnapshot(workspaceId, sessionId);
    }
    const state = saved;
    const flight = (async () => {
      const deadlineAt = this.now() + this.limits.deadlineMs;
      const deadline = new AbortController();
      const timer = setTimeout(() => { deadline.abort(new DOMException('Session usage deadline', 'TimeoutError')); }, this.limits.deadlineMs);
      timer.unref();
      const readSignal = AbortSignal.any([this.modelController.signal, deadline.signal]);
      const pricing = this.core.accessor.get(IModelPricingService);
      const preparation = pricing.ready.then(() => { state.pricingReady = true; });
      void preparation.catch(() => undefined);
      try {
        const scope = sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId);
        state.agents ??= await waitForSource(this.core.accessor.get(IFileSystemStorageService).list(`${scope}/agents`), readSignal);
        const pending = state.agents.filter((agent) => !state.rows[agent]?.complete).slice(0, this.limits.sourceScanLimit);
        await waitForSource(this.readAgentUsageSources(workspaceId, sessionId, pending, { signal: readSignal, factSignal: readSignal, summaryOnly: true, deadlineAt, factBudget: { remainingRecords: this.limits.usageFactBudget }, recoveryBudget: { remainingRecords: Math.min(100_000, this.limits.wireRecordBudget), remainingBytes: 128 * 1024 * 1024 } }, state.rows, state.revisions), readSignal);
        await waitForSource(preparation, readSignal);
      } catch (error) {
        this.modelController.signal.throwIfAborted();
        if (!deadline.signal.aborted) throw error;
      } finally { clearTimeout(timer); }
      const agents = state.agents ?? [];
      state.snapshot = { version: 2, subject: { session_id: sessionId, scope: 'session' }, source_revision: agents.map((agent) => state.revisions.get(agent) ?? `${agent}:unread`).join('|'), covered_at: this.now(), complete: state.agents !== undefined && agents.every((agent) => state.rows[agent]?.complete) && state.version === this.sessionVersion(key), ...this.sessionAccountingTotals(Object.values(state.rows), state.pricingReady) };
      state.snapshotVersion = state.version;
      return this.readSessionAccountingSnapshot(workspaceId, sessionId);
    })().finally(() => { state.flight = undefined; });
    state.flight = flight;
    void flight.catch(() => undefined);
    return waitForSource(flight, signal);
  }

  private sessionAccountingTotals(rows: readonly AgentUsageProjection[], pricingReady: boolean): Pick<UsageAccountingSnapshot, 'tokens' | 'tokens_unknown' | 'cost_usd_estimated' | 'cost_unknown'> {
    const totals = summarizeUsageFacts([]);
    const pricing = this.core.accessor.get(IModelPricingService);
    let partial = false;
    let cost = 0;
    let costUnknown = !pricingReady;
    for (const row of rows) {
      const summary = row.totals ?? summarizeUsageFacts(row.records);
      for (const key of ['inputOther', 'output', 'inputCacheRead', 'inputCacheCreation'] as const) totals.usage[key] += summary.usage[key];
      partial ||= summary.partial;
      if (pricingReady) for (const [model, masks] of Object.entries(summary.byModelMask ?? {})) for (const value of Object.values(masks)) {
        const quoted = pricing.calculate(model, value);
        if (quoted === undefined || !Number.isFinite(cost + quoted)) costUnknown = true; else cost += quoted;
      }
      if (summary.byModelMask === undefined && summary.knownUsageRecords > 0) costUnknown = true;
    }
    return { tokens: { input_other: totals.usage.inputOther, output: totals.usage.output, input_cache_read: totals.usage.inputCacheRead, input_cache_creation: totals.usage.inputCacheCreation }, tokens_unknown: partial, cost_usd_estimated: cost, cost_unknown: costUnknown || partial };
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
    const factBudget = { remainingRecords: options.maxFacts ?? (bounded ? this.limits.usageFactBudget : Infinity) };
    const recoveryBudget = { remainingRecords: options.maxRecords ?? Infinity, remainingBytes: options.maxBytes ?? Infinity };
    const rows: Record<string, AgentUsageProjection> = {};
    try {
      await waitForSource(this.readAgentUsageSources(workspaceId, sessionId, agentIds, { ...options, factSignal, factBudget, recoveryBudget }, rows), factSignal);
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
    options: SourceReadOptions & { factSignal?: AbortSignal },
    rows: Record<string, AgentUsageProjection>,
    revisions?: Map<string, string>,
  ): Promise<Readonly<Record<string, AgentUsageProjection>>> {
    const facts = this.core.accessor.get(IUsageFactStore);
    const storage = this.core.accessor.get(IFileSystemStorageService);
    const logs = this.core.accessor.get(IAppendLogStore);
    const model = this.core.accessor.get(IUsageReadModel);
    const sessionScope = sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId);
    const signal = options.factSignal ?? this.modelController.signal;
    for (const id of new Set(agentIds)) {
      signal.throwIfAborted();
      if (this.now() >= (options.deadlineAt ?? Infinity)) break;
      const source = agentScopeOf(sessionScope, id);
      const [generation, size, mtimeMs] = await Promise.all([logs.generation(source, AGENT_WIRE_RECORD_KEY), storage.size(source, AGENT_WIRE_RECORD_KEY), storage.mtime(source, AGENT_WIRE_RECORD_KEY)]);
      const covered = await this.synchronizeSource({ source, agentId: id, generation, size: size ?? 0, mtimeMs: mtimeMs ?? 0 }, signal, options);
      const snapshot = await model.summary(source, signal);
      const checkpoint = snapshot.head?.checkpoint;
      revisions?.set(id, `${id}:${snapshot.head?.revision ?? 0}:${checkpoint?.generation ?? ''}:${checkpoint?.offset ?? 0}`);
      if (options.summaryOnly) rows[id] = { records: [], totals: snapshot.totals, complete: false };
      const complete = covered && checkpoint?.valid === true && snapshot.head?.pendingCheckpoint === undefined && checkpoint.generation === generation && checkpoint.size === (size ?? 0) && checkpoint.offset === (size ?? 0) && checkpoint.mtimeMs === (mtimeMs ?? 0) && await waitForSource(logs.generation(source, AGENT_WIRE_RECORD_KEY), signal) === generation;
      if (options.summaryOnly) rows[id] = { records: [], totals: snapshot.totals, complete };
      else { const read = await facts.read(source, undefined, signal); rows[id] = { records: read.records, complete: complete && read.readComplete !== false }; }
    }
    return rows;
  }

  async resetExportRead(): Promise<void> {
    await this.exportRetainedIterator?.return(undefined); this.exportRetainedIterator = undefined; this.exportEphemeralRecords.clear(); this.exportRetainedIncomplete = false;
    this.exportCursor = undefined; this.exportAtRetained = false; this.exportActiveKeys.clear(); this.exportVerifyBoundary = false;
  }

  async invalidateExportCheckpoints(): Promise<void> {
    await this.resetExportRead();
    this.exportVerifyBoundary = true;
    this.modelReady = false;
    this.modelVerifiedAt = 0;
  }

  private async readExportSession(summary: SessionSummary, budget: ScanBudget): Promise<SessionRecords | undefined> {
    const storage = this.core.accessor.get(IFileSystemStorageService);
    const logs = this.core.accessor.get(IAppendLogStore);
    const facts = this.core.accessor.get(IUsageFactStore);
    const scope = sessionScopeOf(workspacePersistenceScope('sessions', summary.workspaceId), summary.id);
    const agents = await storage.list(`${scope}/agents`);
    const records: NormalizedUsageRecord[] = [];
    let complete = true;
    for (const agentId of agents) {
      const source = agentScopeOf(scope, agentId);
      const [generation, size, mtimeMs] = await Promise.all([logs.generation(source, AGENT_WIRE_RECORD_KEY), storage.size(source, AGENT_WIRE_RECORD_KEY), storage.mtime(source, AGENT_WIRE_RECORD_KEY)]);
      if (!await this.synchronizeSource({ source, agentId, generation, size: size ?? 0, mtimeMs: mtimeMs ?? 0 }, this.modelController.signal, { verifyBoundary: this.exportVerifyBoundary, maxFacts: Infinity, maxRecords: budget.remainingRecords, deadlineAt: budget.deadlineAt, onScannedRecord: () => { budget.remainingRecords--; } })) {
        budget.incompleteReason = this.now() >= budget.deadlineAt ? 'deadline' : 'record_budget';
        return undefined;
      }
      const snapshot = await facts.read(source, undefined, this.modelController.signal);
      records.push(...snapshot.records);
      complete &&= snapshot.readComplete !== false && snapshot.checkpoint?.offset === (size ?? 0) && snapshot.checkpoint?.generation === generation && await logs.generation(source, AGENT_WIRE_RECORD_KEY) === generation;
      await yieldToEventLoop(undefined, { signal: this.modelController.signal });
    }
    return { summary, records, complete, deleted: false };
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
        const session = await this.readExportSession(summary, budget);
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
          this.exportCursor = undefined; this.exportAtRetained = false; this.exportActiveKeys.clear(); this.exportVerifyBoundary = false;
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
    this.exportCursor = undefined; this.exportAtRetained = false; this.exportActiveKeys.clear(); this.exportVerifyBoundary = false;
    return { complete, reason: complete ? null : 'retained-incomplete', sources };
  }

  async query(raw: UsageQuery, signal?: AbortSignal): Promise<UsageResponse> {
    signal?.throwIfAborted();
    const key = JSON.stringify(Object.entries(raw).toSorted(([left], [right]) => left.localeCompare(right)));
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

  private modelPreparing?: Promise<void>;
  private modelVerifiedAt = 0;
  private modelReady = false;
  private modelFailure?: unknown;
  private readonly modelController = new AbortController();

  private readonly sourceSynchronizations = new Map<string, Promise<boolean>>();

  private synchronizeSource(source: { source: string; agentId: string; generation: string; size: number; mtimeMs: number }, signal: AbortSignal, options: SourceReadOptions = {}): Promise<boolean> {
    const prior = this.sourceSynchronizations.get(source.source) ?? Promise.resolve(false);
    const work = prior.catch(() => false).then(async () => {
      signal.throwIfAborted();
      const storage = this.core.accessor.get(IFileSystemStorageService);
      const logs = this.core.accessor.get(IAppendLogStore);
      const facts = this.core.accessor.get(IUsageFactStore);
      const model = this.core.accessor.get(IUsageReadModel);
      const budget = options.factBudget ?? { remainingRecords: options.maxFacts ?? this.limits.usageFactBudget };
      const imported = await facts.summary(source.source, signal, { budget });
      if (imported.readComplete === false) return false;
      const head = await model.source(source.source, signal);
      let checkpoint = head?.pendingCheckpoint ?? head?.checkpoint;
      if (!options.verifyBoundary && checkpoint?.generation === source.generation && checkpoint.offset === source.size && checkpoint.size === source.size && checkpoint.mtimeMs === source.mtimeMs) return true;
      if (checkpoint !== undefined && (checkpoint.generation !== source.generation || checkpoint.offset > source.size || checkpoint.offset === source.size && checkpoint.mtimeMs !== source.mtimeMs || checkpoint.offset > 0 && await this.boundaryHash(storage, source.source, checkpoint.offset, signal) !== checkpoint.boundaryHash)) checkpoint = undefined;
      let committedOffset = checkpoint?.offset ?? 0;
      let committedFacts = 0;
      const allowance = new UsageReadAllowance(options.recoveryBudget?.remainingRecords ?? options.maxRecords ?? this.limits.wireRecordBudget, budget.remainingRecords, options.recoveryBudget?.remainingBytes ?? options.maxBytes ?? Infinity);
      const deadlineAt = options.deadlineAt ?? this.now() + this.limits.deadlineMs;
      const cancellation = new AbortController();
      const onAbort = (): void => { if (!(signal.reason instanceof Error && signal.reason.name === 'TimeoutError')) cancellation.abort(signal.reason); };
      signal.addEventListener('abort', onAbort, { once: true });
      const publicationSignal = AbortSignal.any([this.modelController.signal, cancellation.signal]);
      const publish = async (end: number, records: readonly UsageFact[], valid: boolean): Promise<void> => {
        publicationSignal.throwIfAborted();
        if (await logs.generation(source.source, AGENT_WIRE_RECORD_KEY) !== source.generation) throw new Error('Usage source changed during recovery; retry');
        await facts.commit(source.source, committedOffset, { generation: source.generation, offset: end, size: source.size, mtimeMs: source.mtimeMs, boundaryHash: await this.boundaryHash(storage, source.source, end, publicationSignal), valid: (checkpoint?.valid ?? true) && valid }, records.slice(committedFacts));
        committedOffset = end;
        committedFacts = records.length;
      };
      try {
        if (source.size === 0) { await publish(0, [], true); return true; }
        let complete = false;
        await this.recovery.run([source], async (_job, worker, laneSignal) => {
          const tail = await readUsageWireTail(storage, source.source, checkpoint?.offset ?? 0, source.size, allowance, deadlineAt, this.now, source.agentId, laneSignal, publish, this.pendingWireLines, JSON.stringify([source.generation, source.size, source.mtimeMs]), worker, options.onScannedRecord, publicationSignal);
          if (options.recoveryBudget !== undefined) {
            options.recoveryBudget.remainingRecords -= tail.scannedRecordCount;
            options.recoveryBudget.remainingBytes -= tail.readBytes;
          }
          if (tail.offset !== committedOffset || checkpoint === undefined) await publish(tail.offset, tail.records, tail.valid);
          complete = tail.complete && tail.offset === source.size;
        }, signal, false);
        budget.remainingRecords -= allowance.counts().facts;
        return complete;
      } finally { signal.removeEventListener('abort', onAbort); }
    });
    this.sourceSynchronizations.set(source.source, work);
    void work.finally(() => { if (this.sourceSynchronizations.get(source.source) === work) this.sourceSynchronizations.delete(source.source); }).catch(() => undefined);
    return work;
  }

  private preparationController?: AbortController;
  private preparationWaiters = 0;
  private modelIncompleteReason: UsageResponse['reliability']['incomplete_reason'] = null;

  private modelRangeStart = -Infinity;
  private readonly modelExcludedSources = new Set<string>();

  private async prepareReadModel(requestSignal: AbortSignal, startAt?: number): Promise<void> {
    if (this.rescan.state === 'running') return;
    if (this.modelReady && (startAt ?? -Infinity) >= this.modelRangeStart && this.sourceChanges?.ready && this.now() - this.modelVerifiedAt < SOURCE_RECHECK_MS) return;
    if (this.preparationController?.signal.aborted) await this.modelPreparing?.catch(() => undefined);
    if (this.modelPreparing === undefined) this.preparationController = new AbortController();
    this.preparationWaiters++;
    try {
      await waitForSource(this.startReadModelPreparation(false, startAt), requestSignal);
      if (this.modelReady && (startAt ?? -Infinity) < this.modelRangeStart) await waitForSource(this.startReadModelPreparation(false, startAt), requestSignal);
    } finally { if (--this.preparationWaiters === 0 && this.modelPreparing !== undefined) this.preparationController?.abort(requestSignal.reason); }
  }

  private inventory?: UsageInventory;
  private inventoryRevision = 0;
  private verifiedInventoryRevision = -1;
  private readonly dirtySessions = new Map<string, number>();
  private knownSessions = new Map<string, SessionSummary>();
  private knownSources = new Map<string, { source: string; workspaceId: string; sessionId: string }>();

  private startReadModelPreparation(full = false, startAt?: number): Promise<void> {
    if (this.modelPreparing !== undefined) return this.modelPreparing;
    const epoch = this.replayEpoch;
    const signal = AbortSignal.any([this.modelController.signal, this.preparationController!.signal]);
    const factBudget = { remainingRecords: full ? Infinity : this.limits.usageFactBudget };
    const recoveryBudget = { remainingRecords: full ? Infinity : this.limits.wireRecordBudget, remainingBytes: Infinity };
    const deadlineAt = full ? Infinity : this.now() + this.limits.deadlineMs;
    this.modelIncompleteReason = null;
    this.modelReady = false;
    const rangeStart = full ? -Infinity : startAt ?? -Infinity;
    if (full || this.inventory !== undefined && rangeStart < this.inventory.startAt) this.inventory = undefined;
    const work = (async () => {
      const index = this.core.accessor.get(ISessionIndex);
      const storage = this.core.accessor.get(IFileSystemStorageService);
      const logs = this.core.accessor.get(IAppendLogStore);
      const model = this.core.accessor.get(IUsageReadModel);
      if (this.inventory === undefined) {
        const verifyAll = full || this.verifiedInventoryRevision !== this.inventoryRevision || !this.sourceChanges?.ready || this.now() - this.modelVerifiedAt >= SOURCE_RECHECK_MS || rangeStart < this.modelRangeStart;
        const heads = new Map(verifyAll ? (await waitForSource(model.sources(signal), signal)).map((row) => [row.source, row.head]) : []);
        if (verifyAll) {
          this.modelExcludedSources.clear();
          this.modelRangeStart = rangeStart;
        }
        this.inventory = { full: verifyAll, revision: this.inventoryRevision, startAt: this.modelRangeStart, summaries: verifyAll ? new Map() : new Map(this.knownSessions), sources: verifyAll ? new Map() : new Map(this.knownSources), dirtyKeys: [...this.dirtySessions.keys()], prepared: new Map(), heads, page: [], nextSession: 0, exhausted: false };
      }
      const inventory = this.inventory;
      if (inventory.current !== undefined && inventory.current.version !== this.dirtySessions.get(sessionKey(inventory.current.summary))) {
        inventory.prepared.delete(sessionKey(inventory.current.summary));
        inventory.current = undefined;
      }
      let scannedSessions = 0;
      let scannedSources = 0;
      const fullScannedSessions = new Set<string>();
      const stop = (): boolean => {
        signal.throwIfAborted();
        if (this.now() >= deadlineAt) { this.modelIncompleteReason = 'deadline'; return true; }
        if (factBudget.remainingRecords <= 0 || recoveryBudget.remainingRecords <= 0 || !full && scannedSources >= this.limits.sourceScanLimit) { this.modelIncompleteReason = 'record_budget'; return true; }
        return false;
      };
      while (true) {
        if (inventory.current === undefined) {
          const done = inventory.full ? inventory.nextSession >= inventory.page.length && inventory.exhausted : inventory.nextSession >= inventory.dirtyKeys.length;
          if (done) break;
          if (stop()) return;
          if (!full && scannedSessions >= this.limits.sessionScanLimit) { this.modelIncompleteReason = 'session_cap'; return; }
          if (inventory.full && inventory.nextSession >= inventory.page.length) {
            const page = await waitForSource(index.listRecent({ includeArchived: true, limit: Math.min(INDEX_PAGE_SIZE, full ? INDEX_PAGE_SIZE : this.limits.sessionScanLimit), before: inventory.before }), signal);
            const prepared = await waitForSource(Promise.all(page.items.map(async (summary) => {
              const key = sessionKey(summary);
              const version = this.dirtySessions.get(key);
              const session = sessionScopeOf(workspacePersistenceScope('sessions', summary.workspaceId), summary.id);
              const agents = await storage.list(`${session}/agents`);
              return { key, summary, agents, version, sources: agents.map((agentId) => ({ source: agentScopeOf(session, agentId), workspaceId: summary.workspaceId, sessionId: summary.id })) };
            })), signal);
            await model.catalog(page.items.map((summary) => ({ ...summary, deleted: false })), prepared.flatMap((item) => item.sources));
            for (const item of prepared) {
              inventory.prepared.set(item.key, { agents: item.agents, version: item.version });
              inventory.summaries.set(item.key, item.summary);
              for (const source of item.sources) inventory.sources.set(source.source, source);
            }
            inventory.page = page.items;
            inventory.nextSession = 0;
            inventory.before = page.nextCursor;
            inventory.exhausted = page.nextCursor === undefined;
            if (full) this.rescan = { ...this.rescan, total_sessions: inventory.summaries.size };
            continue;
          }
          const dirtyKey = inventory.full ? undefined : inventory.dirtyKeys[inventory.nextSession];
          const version = dirtyKey === undefined ? undefined : this.dirtySessions.get(dirtyKey);
          const summary = inventory.full ? inventory.page[inventory.nextSession] : await waitForSource(index.get(dirtyKey!.split('\0')[1]!), signal);
          if (summary === undefined) {
            inventory.summaries.delete(dirtyKey!);
            for (const [key, value] of inventory.sources) if (`${value.workspaceId}\0${value.sessionId}` === dirtyKey) inventory.sources.delete(key);
            if (this.dirtySessions.get(dirtyKey!) === version) this.dirtySessions.delete(dirtyKey!);
            inventory.nextSession++;
            scannedSessions++;
            continue;
          }
          const key = sessionKey(summary);
          const prepared = inventory.prepared.get(key);
          const observedVersion = inventory.full ? prepared === undefined ? this.dirtySessions.get(key) : prepared.version : version;
          const session = sessionScopeOf(workspacePersistenceScope('sessions', summary.workspaceId), summary.id);
          const agents = prepared?.agents ?? await waitForSource(storage.list(`${session}/agents`), signal);
          const accountedAgents = this.sessionAccounting.get(key)?.agents;
          if (accountedAgents !== undefined && (accountedAgents.length !== agents.length || accountedAgents.some((agent) => !agents.includes(agent)))) this.sessionVersions.set(key, (this.sessionVersions.get(key) ?? 0) + 1);
          const sources = agents.map((agentId) => ({ source: agentScopeOf(session, agentId), workspaceId: summary.workspaceId, sessionId: summary.id }));
          inventory.current = { summary, version: observedVersion, agents, sources, nextAgent: 0 };
          inventory.summaries.set(key, summary);
          for (const [source, value] of inventory.sources) if (value.workspaceId === summary.workspaceId && value.sessionId === summary.id) inventory.sources.delete(source);
          for (const source of sources) inventory.sources.set(source.source, source);
          if (prepared === undefined) await model.catalog([{ ...summary, deleted: false }], sources);
        }
        const current = inventory.current;
        while (current.nextAgent < current.agents.length) {
          if (stop()) return;
          if (current.pending === undefined || current.pending.length === 0) {
            const count = full ? 32 : Math.min(32, this.limits.sourceScanLimit - scannedSources);
            current.pending = await waitForSource(Promise.all(current.sources.slice(current.nextAgent, current.nextAgent + count).map(async ({ source }, offset) => {
              const [generation, size, mtime, head] = await Promise.all([logs.generation(source, AGENT_WIRE_RECORD_KEY), storage.size(source, AGENT_WIRE_RECORD_KEY), storage.mtime(source, AGENT_WIRE_RECORD_KEY), inventory.full ? inventory.heads.get(source) : model.source(source, signal)]);
              const checkpoint = head?.checkpoint;
              return { source, agentId: current.agents[current.nextAgent + offset]!, generation, size: size ?? 0, mtimeMs: mtime ?? 0, aligned: !full && checkpoint?.generation === generation && checkpoint.offset === (size ?? 0) && checkpoint.size === (size ?? 0) && checkpoint.mtimeMs === (mtime ?? 0) };
            })), signal);
          }
          const source = current.pending[0]!;
          const excluded = !full && source.mtimeMs >= 1_000_000_000_000 && source.mtimeMs < inventory.startAt;
          if (!source.aligned && excluded) this.modelExcludedSources.add(source.source);
          else {
            const key = sessionKey(current.summary);
            if (!source.aligned && this.sessionAccounting.has(key)) this.sessionVersions.set(key, (this.sessionVersions.get(key) ?? 0) + 1);
            this.modelExcludedSources.delete(source.source);
            if (!source.aligned && !await this.synchronizeSource(source, signal, { factBudget, recoveryBudget, deadlineAt, onScannedRecord: full ? () => { this.rescan = { ...this.rescan, scanned_records: this.rescan.scanned_records + 1 }; } : undefined })) { this.modelIncompleteReason = this.now() >= deadlineAt ? 'deadline' : 'record_budget'; return; }
            if (full && (await model.source(source.source, signal))?.checkpoint?.valid !== true) {
              fullScannedSessions.add(sessionKey(current.summary));
              this.rescan = { ...this.rescan, scanned_sessions: fullScannedSessions.size };
              throw new Error(`Usage checkpoint is incomplete for session ${current.summary.id}`);
            }
          }
          current.pending.shift();
          current.nextAgent++;
          scannedSources++;
        }
        const key = sessionKey(current.summary);
        if (this.dirtySessions.get(key) === current.version) this.dirtySessions.delete(key);
        inventory.current = undefined;
        inventory.nextSession++;
        scannedSessions++;
        if (full) { fullScannedSessions.add(key); this.rescan = { ...this.rescan, scanned_sessions: fullScannedSessions.size }; }
        await yieldToEventLoop(undefined, { signal });
      }
      await model.catalog([...inventory.summaries.values()].map((summary) => ({ ...summary, deleted: false })), [...inventory.sources.values()], true);
      this.knownSessions = inventory.summaries;
      this.knownSources = inventory.sources;
      const retained = this.core.accessor.get(IRetainedUsageService);
      if (retained.prepareReadModel !== undefined) {
        const progress = await retained.prepareReadModel({ deadlineAt, recordLimit: factBudget.remainingRecords, signal });
        if (!progress.complete) { this.modelIncompleteReason = progress.incompleteReason ?? null; return; }
      }
      signal.throwIfAborted();
      if (inventory.full) { this.modelVerifiedAt = this.now(); this.verifiedInventoryRevision = inventory.revision; }
      this.inventory = undefined;
      this.modelReady = epoch === this.replayEpoch && this.dirtySessions.size === 0 && this.verifiedInventoryRevision === this.inventoryRevision;
      this.modelFailure = undefined;
    })();
    this.modelPreparing = work;
    void work.finally(() => { if (this.modelPreparing === work) this.modelPreparing = undefined; }).catch((error: unknown) => { this.modelFailure = error; this.modelReady = false; });
    return work;
  }

  private async querySources(raw: UsageQuery, signal: AbortSignal): Promise<UsageResponse> {
    const started = this.now();
    const query = normalizeQuery(raw, started);
    void this.sourceChanges?.ready;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException('Usage query deadline', 'TimeoutError')), this.limits.deadlineMs);
    timer.unref();
    const readSignal = AbortSignal.any([signal, deadline.signal]);
    let incompleteReason: UsageResponse['reliability']['incomplete_reason'] = null;
    try {
      try { await this.prepareReadModel(readSignal, query.range.startAt); incompleteReason = this.modelIncompleteReason; }
      catch (error) { signal.throwIfAborted(); if (!deadline.signal.aborted) throw error; incompleteReason = 'deadline'; }
      signal.throwIfAborted();
      if (deadline.signal.aborted) return incompleteUsageResponse(query, 'deadline');
      const fingerprint = queryFingerprint(query);
      const model = this.core.accessor.get(IUsageReadModel);
      const pricing = this.core.accessor.get(IModelPricingService);
      await waitForSource(pricing.ready, readSignal);
      const models = await model.models(readSignal);
      const quotes: UsageReadModelQuote[] = models.map((model) => {
        const match = pricing.resolve(model);
        const prices = match?.currency === undefined || match.currency === 'USD' ? match?.prices : undefined;
        return { model, inputOther: prices?.inputCostPerToken, output: prices?.outputCostPerToken, inputCacheRead: prices?.cacheReadInputTokenCost, inputCacheCreation: prices?.cacheCreationInputTokenCost };
      });
      const pricingRevision = createHash('sha256').update(JSON.stringify(quotes.toSorted((left, right) => left.model.localeCompare(right.model)))).digest('base64url').slice(0, 16);
      let position: readonly [number, string] | undefined;
      let expectedRevision: string | undefined;
      if (raw.page_token !== undefined) {
        let token: { v?: number; f?: string; p?: string; r?: string; k?: readonly [number, string] };
        try { token = JSON.parse(Buffer.from(raw.page_token, 'base64url').toString('utf8')); }
        catch { throw new UsagePageTokenMismatchError('Invalid Usage page; restart from the first page'); }
        if (token === null || token.v !== 2 || token.f !== fingerprint || token.p !== pricingRevision || typeof token.r !== 'string' || !Array.isArray(token.k) || token.k.length !== 2 || !Number.isFinite(token.k[0]) || typeof token.k[1] !== 'string') throw new UsagePageTokenMismatchError('Usage statistics changed; restart from the first page');
        position = token.k; expectedRevision = token.r;
      }
      let result;
      try { result = await model.query({ ...query, startAt: query.range.startAt, endAt: query.range.endAt, quotes, position, expectedRevision, excludedSources: [...this.modelExcludedSources], drilldownSessionLimit: this.limits.drilldownSessionLimit, drilldownTurnLimit: this.limits.drilldownTurnLimit }, readSignal); }
      catch (error) { if ((error as { code?: string }).code === 'usage.revision_changed') throw new UsagePageTokenMismatchError('Usage statistics changed; restart from the first page'); throw error; }
      if (this.now() - started >= this.limits.deadlineMs) incompleteReason = 'deadline';
      const last = result.sessions.at(-1);
      const wire = (value: UsageReadModelAggregate): UsageAggregateWire => ({ tokens: { input_other: value.usage.inputOther, output: value.usage.output, input_cache_read: value.usage.inputCacheRead, input_cache_creation: value.usage.inputCacheCreation }, tokens_unknown: value.missingRecords > 0 || value.legacyZeroRecords > 0, cost_usd_estimated: value.cost, cost_unknown: value.costUnknown });
      return {
        query: { granularity: query.granularity, range: { preset: query.range.preset, start_at: query.range.startAt ?? null, end_at: query.range.endAt ?? null, defaulted_to_all_history: query.range.defaultedToAllHistory }, dimension: query.dimension, models: [...query.models], providers: [...query.providers], profiles: [...query.profiles], agent_ids: [...query.agentIds], workspace_ids: [...query.workspaceIds], include_archived: query.includeArchived, timezone_offset_minutes: query.timezoneOffsetMinutes },
        summary: { ...wire(result.total), session_count: result.sessionCount },
        trend: result.trend.map((bucket) => ({ key: bucket.key, start_at: bucket.startAt, end_at: bucket.endAt, request_count: bucket.requests, turn_count: bucket.turns, groups: bucket.groups.map((group) => ({ key: group.key, ...wire(group), provider: group.provider, model_alias: group.modelAlias, agent_id: group.agentId, parent_agent_id: group.parentAgentId, profile_name: group.profileName })), drilldown: { sessions: bucket.sessions.map((session) => ({ session_id: session.id, turn_ids: [...session.turnIds], turn_count: session.turns, unknown_turn_records: session.unknownTurnRecords, turn_ids_truncated: session.turns > session.turnIds.length })), sessions_truncated: bucket.sessionsTruncated } })),
        sessions: { items: result.sessions.map((row) => ({ id: row.session.id, workspace_id: row.session.workspaceId, title: row.session.title ?? null, created_at: row.session.createdAt, updated_at: row.session.updatedAt, archived: row.session.archived, deleted: row.session.deleted, usage: wire(row), primary_model: row.primaryModel ?? null, profile_names: [...row.profileNames], unknown_price_models: [...row.unknownPriceModels] })), total: result.sessionCount, has_more: result.hasMore, next_page_token: result.hasMore && last !== undefined ? Buffer.from(JSON.stringify({ v: 2, f: fingerprint, r: result.revision, p: pricingRevision, k: [last.cost, last.session.id] })).toString('base64url') : null },
        reliability: { complete: this.modelReady && incompleteReason === null && result.incompleteSessions === 0, coverage: { earliest_at: result.earliestAt ?? null, latest_at: result.latestAt ?? null }, usage_coverage: { known_records: result.total.knownRecords, missing_records: result.total.missingRecords, legacy_zero_records: result.total.legacyZeroRecords }, scanned_sessions: result.scannedSessions, incomplete_sessions: result.incompleteSessions, unknown_price_models: [...result.unknownPriceModels], includes_deleted_sessions: result.includesDeletedSessions, incomplete_reason: incompleteReason },
      };
    } catch (error) {
      signal.throwIfAborted();
      if (deadline.signal.aborted) return incompleteUsageResponse(query, 'deadline');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async readLegacyProjection(raw: UsageQuery, signal?: AbortSignal): Promise<UsageRangeProjection | undefined> {
    const fingerprint = queryFingerprint(normalizeQuery(raw, this.now()));
    const bytes = await this.core.accessor.get(IFileSystemStorageService).read(PERSISTENCE_SCOPE, projectionFileName(fingerprint));
    signal?.throwIfAborted();
    if (bytes === undefined) return undefined;
    const projection = parseUsageRangeProjection(bytes);
    return projection?.fingerprint === fingerprint ? projection : undefined;
  }

  private async boundaryHash(
    storage: IFileSystemStorageService,
    scope: string,
    offset: number,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (offset === 0) return '';
    const start = Math.max(0, offset - BOUNDARY_BYTES);
    const bytes = await readRange(storage, scope, start, offset - 1, signal);
    return createHash('sha256').update(bytes).digest('base64url');
  }
}

async function waitForSource<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) { void promise.catch(() => undefined); signal.throwIfAborted(); }
  if (signal === undefined) return promise;
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(signal.reason ?? new DOMException('The request was aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function readRange(
  storage: IFileSystemStorageService,
  scope: string,
  start: number,
  end: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (end < start) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of readLogicalBytes(
    storage,
    scope,
    AGENT_WIRE_RECORD_KEY,
    { start, end },
    { signal },
  )) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
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

function sessionKey(summary: Pick<SessionSummary, 'id' | 'workspaceId'>): string {
  return `${summary.workspaceId}\0${summary.id}`;
}

function emptyUsage(): TokenUsage {
  return { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
}

function emptyAggregate(): AggregateAccumulator {
  return { usage: emptyUsage(), cost: 0, costUnknown: false, knownRecords: 0, missingRecords: 0, legacyZeroRecords: 0 };
}

function incompleteUsageResponse(query: NormalizedQuery, reason: UsageResponse['reliability']['incomplete_reason']): UsageResponse {
  return {
    query: { granularity: query.granularity, range: { preset: query.range.preset, start_at: query.range.startAt ?? null, end_at: query.range.endAt ?? null, defaulted_to_all_history: query.range.defaultedToAllHistory }, dimension: query.dimension, models: [...query.models], providers: [...query.providers], profiles: [...query.profiles], agent_ids: [...query.agentIds], workspace_ids: [...query.workspaceIds], include_archived: query.includeArchived, timezone_offset_minutes: query.timezoneOffsetMinutes },
    summary: { ...aggregateWire(emptyAggregate()), session_count: 0 },
    trend: [],
    sessions: { items: [], total: 0, has_more: false, next_page_token: null },
    reliability: { complete: false, coverage: { earliest_at: null, latest_at: null }, usage_coverage: { known_records: 0, missing_records: 0, legacy_zero_records: 0 }, scanned_sessions: 0, incomplete_sessions: 0, unknown_price_models: [], includes_deleted_sessions: false, incomplete_reason: reason },
  };
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
