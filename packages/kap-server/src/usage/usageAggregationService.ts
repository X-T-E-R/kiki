import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import {
  AGENT_WIRE_RECORD_KEY,
  ErrorCodes,
  isError2,
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
  ILogService,
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
const DEFAULT_CATALOG_BATCH_SOURCES = 2048;
const CATALOG_BATCH_SOURCES_ENV = 'KIKI_USAGE_CATALOG_BATCH_SOURCES';

function resolveCatalogBatchSources(): number {
  const raw = process.env[CATALOG_BATCH_SOURCES_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_CATALOG_BATCH_SOURCES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CATALOG_BATCH_SOURCES;
}
const DAY_MS = 24 * 60 * 60 * 1000;
const PERSISTENCE_SCOPE = 'cache/usage-aggregation-v1';
const BOUNDARY_BYTES = 4 * 1024;
const DEFAULT_LIMITS: UsageAggregationLimits = {
  sessionScanLimit: 500,
  sourceScanLimit: 2048,
  wireRecordBudget: Infinity,
  usageFactBudget: 200_000,
  deadlineMs: 10_000,
  preparationWaitMs: 250,
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
  readonly preparationWaitMs: number;
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
  readonly kind: 'session' | 'ephemeral' | 'operation';
  readonly records: readonly NormalizedUsageRecord[];
}

interface ExportSessionRead {
  readonly key: string;
  readonly agents: readonly string[];
  readonly records: NormalizedUsageRecord[];
  nextAgent: number;
  complete: boolean;
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
  readonly onCompleteSummary?: (agentId: string, row: AgentUsageProjection) => void;
}

interface SourceReadOptions extends AgentUsageReadOptions {
  readonly verifyBoundary?: boolean;
  readonly background?: boolean;
  readonly factBudget?: UsageFactReadBudget;
  readonly recoveryBudget?: { remainingRecords: number; remainingBytes: number };
  readonly onScannedRecord?: () => void;
}

interface UsageSourceMetadata {
  readonly source: string;
  readonly agentId: string;
  readonly generation: string;
  readonly size: number;
  readonly mtimeMs: number;
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
  readonly sourcesBySession: Map<string, Set<string>>;
  readonly dirtyKeys: readonly string[];
  readonly prepared: Map<string, { agents: readonly string[]; version?: number }>;
  readonly heads: Map<string, Awaited<ReturnType<IUsageReadModel['source']>>>;
  needsFullCatalogSync: boolean;
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
  readonly sortBy: UsageResponse['query']['sort_by'];
}

function emptyAgentUsage(agentIds: readonly string[]): Readonly<Record<string, AgentUsageProjection>> {
  return Object.fromEntries(agentIds.map((id) => [id, { records: [], totals: summarizeUsageFacts([]), complete: true }]));
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
  private exportRetainedIterator: ReturnType<NonNullable<IRetainedUsageService['readExportUsage']>> | undefined;
  private readonly exportEphemeralRecords = new Map<string, NormalizedUsageRecord[]>();
  private exportRetainedIncomplete = false;
  private exportVerifyBoundary = false;
  private exportCursor: string | undefined;
  private exportSession: ExportSessionRead | undefined;
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
    this.sourceSubscription = sourceChanges?.onDidChange((change) => {
      if (typeof change === 'object' && (change.kind === 'retained' || change.kind === 'operation')) {
        if (change.kind === 'operation') {
          if (change.sessionKey === undefined) {
            this.operationRevision++;
          } else {
            this.sessionVersions.set(change.sessionKey, (this.sessionVersions.get(change.sessionKey) ?? 0) + 1);
            const saved = this.sessionAccounting.get(change.sessionKey);
            if (saved !== undefined) saved.operationDirty = true;
          }
        }
        this.retainedRevision++;
        this.modelReady = false;
        return;
      }
      const key = typeof change === 'object' ? change.sessionKey : change;
      this.replayEpoch++;
      if (key === undefined) {
        this.inventoryRevision++;
        this.agentInventories.clear();
        this.sourceMetadata.clear();
        this.sourceKeysBySession.clear();
        this.dirtyAgents.clear();
        this.fullDirtySessions.clear();
        this.progressFullGeneration++;
        this.progressDirtySessions.clear();
        this.progressDirtyAgents.clear();
        this.progressFullDirtySessions.clear();
      } else if (typeof key === 'string') {
        this.dirtySessions.set(key, this.replayEpoch);
        if (typeof change === 'object' && change.kind === 'agent') {
          this.invalidateSessionAccountingAgent(key, change.agentId);
          this.ensureAgentInInventory(key, change.agentId);
          const sourceKey = `sessions/${key.replace('\0', '/')}/agents/${change.agentId}`;
          this.sourceMetadata.delete(sourceKey);
          this.sourceKeysBySession.get(key)?.delete(sourceKey);
          if (!this.fullDirtySessions.has(key)) {
            let bucket = this.dirtyAgents.get(key);
            if (bucket === undefined) {
              bucket = new Set();
              this.dirtyAgents.set(key, bucket);
            }
            bucket.add(change.agentId);
          }
          if (!this.progressFullDirtySessions.has(key)) {
            let bucket = this.progressDirtyAgents.get(key);
            if (bucket === undefined) {
              bucket = new Set();
              this.progressDirtyAgents.set(key, bucket);
            }
            bucket.add(change.agentId);
          }
        } else {
          this.sessionVersions.set(key, (this.sessionVersions.get(key) ?? 0) + 1);
          this.sessionResetEpochs.set(key, (this.sessionResetEpochs.get(key) ?? 0) + 1);
          this.agentInventories.delete(key);
          this.fullDirtySessions.add(key);
          this.dirtyAgents.delete(key);
          this.progressFullDirtySessions.add(key);
          this.progressDirtyAgents.delete(key);
          const tracked = this.sourceKeysBySession.get(key);
          if (tracked !== undefined) {
            for (const source of tracked) this.sourceMetadata.delete(source);
            this.sourceKeysBySession.delete(key);
          }
        }
        this.progressDirtySessions.add(key);
      }
      this.progressInventoryReady = false;
      this.modelReady = false;
    });
  }

  private replayEpoch = 0;
  private retainedRevision = 0;
  private operationRevision = 0;
  private readonly sourceSubscription?: { dispose(): void };

  dispose(): void {
    this.modelController.abort();
    this.sourceSubscription?.dispose();
    for (const flight of this.queryFlights.values()) flight.controller.abort();
    this.queryFlights.clear();
    this.pendingWireLines.clear();
    this.exportSession = undefined;
    this.recovery.dispose();
  }

  cacheStatus(): { readonly entries: number; readonly records: number } {
    return { entries: 0, records: 0 };
  }

  private readonly sessionVersions = new Map<string, number>();
  private readonly sessionResetEpochs = new Map<string, number>();
  private readonly sessionAccounting = new Map<string, {
    version: string;
    resetEpoch: string;
    agents?: readonly string[];
    rows: Record<string, AgentUsageProjection>;
    revisions: Map<string, string>;
    invalidatedDuringFlight: Set<string>;
    operation?: Awaited<ReturnType<IRetainedUsageService['readOperationSummary']>>;
    operationVersion?: number;
    operationDirty: boolean;
    snapshot?: UsageAccountingSnapshot;
    snapshotVersion?: string;
    pricingReady: boolean;
    flight?: Promise<UsageAccountingSnapshot>;
  }>();

  private sessionVersion(key: string): string { return `${this.inventoryRevision}:${this.sessionVersions.get(key) ?? 0}`; }

  private sessionResetEpoch(key: string): string { return `${this.inventoryRevision}:${this.sessionResetEpochs.get(key) ?? 0}`; }

  private invalidateSessionAccountingAgent(key: string, agentId: string): void {
    this.sessionVersions.set(key, (this.sessionVersions.get(key) ?? 0) + 1);
    const saved = this.sessionAccounting.get(key);
    if (saved === undefined) return;
    delete saved.rows[agentId];
    saved.revisions.delete(agentId);
    if (saved.flight !== undefined) saved.invalidatedDuringFlight.add(agentId);
    if (saved.agents !== undefined && !saved.agents.includes(agentId)) {
      saved.agents = [...saved.agents, agentId];
    }
  }

  private reconcileSessionAccountingAgents(key: string, agents: readonly string[]): void {
    const saved = this.sessionAccounting.get(key);
    if (saved?.agents === undefined || sameAgentList(saved.agents, agents)) return;
    const nextSet = new Set(agents);
    for (const existing of saved.agents) {
      if (!nextSet.has(existing)) {
        delete saved.rows[existing];
        saved.revisions.delete(existing);
        if (saved.flight !== undefined) saved.invalidatedDuringFlight.add(existing);
      }
    }
    saved.agents = agents;
    this.sessionVersions.set(key, (this.sessionVersions.get(key) ?? 0) + 1);
  }

  readSessionAccountingSnapshot(workspaceId: string, sessionId: string, fallback?: UsageAccountingSnapshot): UsageAccountingSnapshot {
    const key = `${workspaceId}\0${sessionId}`;
    const saved = this.sessionAccounting.get(key);
    const snapshot = saved?.snapshot;
    if (saved === undefined || snapshot === undefined) return { ...(fallback ?? { version: 2, subject: { session_id: sessionId, scope: 'session' }, covered_at: 0, complete: false, tokens: { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 }, tokens_unknown: false, cost_usd_estimated: 0, cost_unknown: true }), freshness: fallback === undefined ? 'unverified' : 'stale' };
    const freshness = saved.snapshotVersion === this.sessionVersion(key) && saved.operationVersion === this.operationRevision && !saved.operationDirty && !this.core.accessor.get(IRetainedUsageService).operationWritesPending && this.now() - snapshot.covered_at < SOURCE_RECHECK_MS ? 'current' : 'stale';
    return { ...snapshot, freshness };
  }

  async readSessionAccounting(workspaceId: string, sessionId: string, signal?: AbortSignal): Promise<UsageAccountingSnapshot> {
    signal?.throwIfAborted();
    if ((await this.core.accessor.get(ISessionIndex).get(sessionId, workspaceId, signal))?.private === true) {
      return { version: 2, subject: { session_id: sessionId, scope: 'session' }, covered_at: this.now(), complete: true, freshness: 'current', ...this.sessionAccountingTotals([], true) };
    }
    void this.sourceChanges?.ready;
    const key = `${workspaceId}\0${sessionId}`;
    let saved = this.sessionAccounting.get(key);
    if (saved?.flight !== undefined) return waitForSource(saved.flight, signal);
    const version = this.sessionVersion(key);
    const resetEpoch = this.sessionResetEpoch(key);
    const expired = saved?.snapshot !== undefined && this.now() - saved.snapshot.covered_at >= SOURCE_RECHECK_MS;
    if (saved === undefined || saved.resetEpoch !== resetEpoch) {
      saved = {
        version,
        resetEpoch,
        rows: {},
        revisions: new Map(),
        invalidatedDuringFlight: new Set(),
        operationDirty: true,
        pricingReady: false,
        snapshot: saved?.snapshot,
      };
      this.sessionAccounting.set(key, saved);
    } else if (expired) {
      saved.version = version;
      saved.agents = undefined;
      saved.rows = {};
      saved.revisions = new Map();
      saved.invalidatedDuringFlight.clear();
      saved.operationDirty = true;
    } else if (saved.version !== version) {
      saved.version = version;
    }
    if (saved.snapshot?.complete && saved.snapshotVersion === version && saved.operationVersion === this.operationRevision && !saved.operationDirty && !this.core.accessor.get(IRetainedUsageService).operationWritesPending) {
      saved.snapshot = { ...saved.snapshot, ...this.sessionAccountingTotals(Object.values(saved.rows), saved.pricingReady, saved.operation?.totals) };
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
      const preparation = state.pricingReady ? Promise.resolve() : pricing.ready.then(() => { state.pricingReady = true; });
      void preparation.catch(() => undefined);
      state.invalidatedDuringFlight.clear();
      try {
        const scope = sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId);
        state.agents ??= await waitForSource(this.core.accessor.get(IFileSystemStorageService).list(`${scope}/agents`), readSignal);
        const pending = state.agents.filter((agent) => !state.rows[agent]?.complete).slice(0, this.limits.sourceScanLimit);
        const factBudget = { remainingRecords: this.limits.usageFactBudget };
        if (pending.length > 1) {
          await waitForSource(this.readVerifiedAgentSummaries(workspaceId, sessionId, pending, readSignal, state.rows, undefined, state.revisions), readSignal);
        }
        const remaining = pending.length > 1 ? pending.filter((agent) => !state.rows[agent]?.complete) : pending;
        if (remaining.length > 0) {
          await waitForSource(this.readAgentUsageSources(workspaceId, sessionId, remaining, { signal: readSignal, factSignal: readSignal, summaryOnly: true, deadlineAt, factBudget, recoveryBudget: { remainingRecords: Math.min(100_000, this.limits.wireRecordBudget), remainingBytes: 128 * 1024 * 1024 } }, state.rows, state.revisions), readSignal);
        }
        const retained = this.core.accessor.get(IRetainedUsageService);
        if (state.operation === undefined || state.operationDirty || state.operationVersion !== this.operationRevision || state.operation.complete !== true || retained.operationWritesPending) {
          const operationVersion = this.operationRevision;
          state.operationDirty = false;
          try {
            state.operation = await waitForSource(retained.readOperationSummary(workspaceId, sessionId, { deadlineAt, recordLimit: factBudget.remainingRecords, signal: readSignal }), readSignal);
            state.operationVersion = operationVersion;
          } catch (error) {
            state.operationDirty = true;
            throw error;
          }
        }
        await waitForSource(preparation, readSignal);
      } catch (error) {
        this.modelController.signal.throwIfAborted();
        if (!deadline.signal.aborted) throw error;
      } finally { clearTimeout(timer); }
      if (state.invalidatedDuringFlight.size > 0) {
        for (const agentId of state.invalidatedDuringFlight) {
          delete state.rows[agentId];
          state.revisions.delete(agentId);
        }
        state.invalidatedDuringFlight.clear();
      }
      const agents = state.agents ?? [];
      const revisions = agents.map((agent) => state.revisions.get(agent) ?? `${agent}:unread`);
      if (state.operation?.revision !== undefined) revisions.push(`operation:${state.operation.revision}`);
      state.snapshot = { version: 2, subject: { session_id: sessionId, scope: 'session' }, source_revision: revisions.join('|'), covered_at: this.now(), complete: state.agents !== undefined && agents.every((agent) => state.rows[agent]?.complete) && state.operation?.complete === true && state.operationVersion === this.operationRevision && !state.operationDirty && state.version === this.sessionVersion(key), ...this.sessionAccountingTotals(Object.values(state.rows), state.pricingReady, state.operation?.totals) };
      state.snapshotVersion = state.version;
      return this.readSessionAccountingSnapshot(workspaceId, sessionId);
    })().finally(() => { state.flight = undefined; });
    state.flight = flight;
    void flight.catch(() => undefined);
    return waitForSource(flight, signal);
  }

  private sessionAccountingTotals(rows: readonly AgentUsageProjection[], pricingReady: boolean, operations?: UsageFactTotals): Pick<UsageAccountingSnapshot, 'tokens' | 'tokens_unknown' | 'cost_usd_estimated' | 'cost_unknown'> {
    const totals = summarizeUsageFacts([]);
    const pricing = this.core.accessor.get(IModelPricingService);
    let partial = false;
    let cost = 0;
    let costUnknown = !pricingReady;
    const summaries = rows.map((row) => row.totals ?? summarizeUsageFacts(row.records));
    if (operations !== undefined) summaries.push(operations);
    for (const summary of summaries) {
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

  async readPublishedAgentUsage(workspaceId: string, sessionId: string, agentIds: readonly string[], signal?: AbortSignal): Promise<Readonly<Record<string, AgentUsageProjection>>> {
    const session = sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId);
    if ((await this.core.accessor.get(ISessionIndex).get(sessionId, workspaceId, signal))?.private === true) return emptyAgentUsage(agentIds);
    const snapshots = await this.core.accessor.get(IUsageReadModel).summaries(agentIds.map((id) => agentScopeOf(session, id)), signal);
    return Object.fromEntries(agentIds.map((id) => [id, { records: [], totals: snapshots[agentScopeOf(session, id)]?.totals, complete: false }]));
  }

  async readAgentUsage(
    workspaceId: string,
    sessionId: string,
    agentIds: readonly string[],
    options: AgentUsageReadOptions = {},
  ): Promise<Readonly<Record<string, AgentUsageProjection>>> {
    options.signal?.throwIfAborted();
    if ((await this.core.accessor.get(ISessionIndex).get(sessionId, workspaceId, options.signal))?.private === true) return emptyAgentUsage(agentIds);
    const deadline = new AbortController();
    const duration = (options.deadlineAt ?? Infinity) - this.now();
    const timer = Number.isFinite(duration) ? setTimeout(() => { deadline.abort(new DOMException('Agent usage deadline', 'TimeoutError')); }, Math.max(0, duration)) : undefined;
    timer?.unref();
    const factSignal = options.signal === undefined ? deadline.signal : AbortSignal.any([options.signal, deadline.signal]);
    const bounded = Number.isFinite(duration) || options.maxFacts !== undefined || options.maxRecords !== undefined || options.maxBytes !== undefined;
    const factBudget = { remainingRecords: options.maxFacts ?? (bounded ? this.limits.usageFactBudget : Infinity) };
    const recoveryBudget = { remainingRecords: options.maxRecords ?? Infinity, remainingBytes: options.maxBytes ?? Infinity };
    const rows: Record<string, AgentUsageProjection> = {};
    const prepare = async (): Promise<void> => {
      if (options.summaryOnly) {
        await this.readVerifiedAgentSummaries(workspaceId, sessionId, agentIds, factSignal, rows, options.onCompleteSummary);
      }
      const pending = agentIds.filter((id) => !rows[id]?.complete);
      if (pending.length > 0) await this.readAgentUsageSources(workspaceId, sessionId, pending, { ...options, factSignal, factBudget, recoveryBudget }, rows);
    };
    try {
      await waitForSource(prepare(), factSignal);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!deadline.signal.aborted) throw error;
      if (options.summaryOnly) {
        const pending = [...new Set(agentIds)].filter((id) => !rows[id]?.complete);
        Object.assign(rows, await this.readPublishedAgentUsage(workspaceId, sessionId, pending, options.signal));
      }
    } finally { if (timer !== undefined) clearTimeout(timer); }
    for (const id of agentIds) rows[id] ??= { records: [], complete: false };
    return rows;
  }

  private async readVerifiedAgentSummaries(
    workspaceId: string,
    sessionId: string,
    agentIds: readonly string[],
    signal: AbortSignal,
    rows: Record<string, AgentUsageProjection>,
    onComplete?: AgentUsageReadOptions['onCompleteSummary'],
    revisions?: Map<string, string>,
  ): Promise<void> {
    const facts = this.core.accessor.get(IUsageFactStore);
    const storage = this.core.accessor.get(IFileSystemStorageService);
    const logs = this.core.accessor.get(IAppendLogStore);
    const model = this.core.accessor.get(IUsageReadModel);
    const session = sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId);
    const sources = [...new Set(agentIds)].map((agentId) => ({ agentId, source: agentScopeOf(session, agentId) }));
    const snapshots = await model.summaries(sources.map(({ source }) => source), signal);
    const candidates = sources.filter(({ source }) => {
      const head = snapshots[source]?.head;
      return head?.checkpoint?.valid === true && head.pendingCheckpoint === undefined;
    });
    for (let offset = 0; offset < candidates.length; offset += 32) {
      if (offset > 0) await yieldToEventLoop(undefined, { signal });
      signal.throwIfAborted();
      await Promise.all(candidates.slice(offset, offset + 32).map(async ({ agentId, source }) => {
        const snapshot = snapshots[source]!;
        const head = snapshot.head!;
        const checkpoint = head.checkpoint!;
        const [generation, size, mtimeMs, journalSize] = await Promise.all([
          logs.generation(source, AGENT_WIRE_RECORD_KEY), storage.size(source, AGENT_WIRE_RECORD_KEY),
          storage.mtime(source, AGENT_WIRE_RECORD_KEY), facts.journalSize(source, signal),
        ]);
        if (checkpoint.generation !== generation || checkpoint.offset !== (size ?? 0)
          || checkpoint.size !== (size ?? 0) || checkpoint.mtimeMs !== (mtimeMs ?? 0)
          || head.journalOffset !== journalSize
          || await logs.generation(source, AGENT_WIRE_RECORD_KEY) !== generation) return;
        signal.throwIfAborted();
        const row = { records: [], totals: snapshot.totals, complete: true };
        rows[agentId] = row;
        revisions?.set(agentId, `${agentId}:${head.revision}:${checkpoint.generation}:${checkpoint.offset}`);
        onComplete?.(agentId, row);
      }));
    }
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
    const ordered = prioritizeMainAgentIds(agentIds);
    for (let index = 0; index < ordered.length; index += 1) {
      if (index > 0 && index % 4 === 0) await yieldToEventLoop(undefined, { signal });
      const id = ordered[index]!;
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
      if (options.summaryOnly) {
        const row = { records: [], totals: snapshot.totals, complete };
        rows[id] = row;
        if (complete) options.onCompleteSummary?.(id, row);
      } else { const read = await facts.read(source, undefined, signal); rows[id] = { records: read.records, complete: complete && read.readComplete !== false }; }
    }
    return rows;
  }

  async resetExportRead(): Promise<void> {
    await this.exportRetainedIterator?.return(undefined); this.exportRetainedIterator = undefined; this.exportEphemeralRecords.clear(); this.exportRetainedIncomplete = false;
    this.exportCursor = undefined; this.exportSession = undefined; this.exportAtRetained = false; this.exportActiveKeys.clear(); this.exportVerifyBoundary = false;
  }

  async invalidateExportCheckpoints(): Promise<void> {
    await this.resetExportRead();
    this.exportVerifyBoundary = true;
    this.modelReady = false;
    this.modelVerifiedAt = 0;
  }

  private async readExportSession(summary: SessionSummary, budget: ScanBudget): Promise<ExportSessionRead | undefined> {
    const storage = this.core.accessor.get(IFileSystemStorageService);
    const logs = this.core.accessor.get(IAppendLogStore);
    const facts = this.core.accessor.get(IUsageFactStore);
    const scope = sessionScopeOf(workspacePersistenceScope('sessions', summary.workspaceId), summary.id);
    const key = sessionKey(summary);
    const session: ExportSessionRead = this.exportSession?.key === key ? this.exportSession : { key, agents: await storage.list(`${scope}/agents`), records: [], nextAgent: 0, complete: true };
    this.exportSession = session;
    while (session.nextAgent < session.agents.length) {
      if (this.now() >= budget.deadlineAt) { budget.incompleteReason = 'deadline'; return undefined; }
      const agentId = session.agents[session.nextAgent]!;
      const source = agentScopeOf(scope, agentId);
      const [generation, size, mtimeMs] = await Promise.all([logs.generation(source, AGENT_WIRE_RECORD_KEY), storage.size(source, AGENT_WIRE_RECORD_KEY), storage.mtime(source, AGENT_WIRE_RECORD_KEY)]);
      if (!await this.synchronizeSource({ source, agentId, generation, size: size ?? 0, mtimeMs: mtimeMs ?? 0 }, this.modelController.signal, { verifyBoundary: this.exportVerifyBoundary, maxFacts: Infinity, maxRecords: budget.remainingRecords, deadlineAt: budget.deadlineAt, onScannedRecord: () => { budget.remainingRecords--; } })) {
        budget.incompleteReason = this.now() >= budget.deadlineAt ? 'deadline' : 'record_budget';
        return undefined;
      }
      const snapshot = await facts.read(source, undefined, this.modelController.signal);
      for (const record of snapshot.records) session.records.push(record);
      session.complete &&= snapshot.readComplete !== false && snapshot.checkpoint?.offset === (size ?? 0) && snapshot.checkpoint?.generation === generation && await logs.generation(source, AGENT_WIRE_RECORD_KEY) === generation;
      session.nextAgent++;
      await yieldToEventLoop(undefined, { signal: this.modelController.signal });
    }
    this.exportSession = undefined;
    return session;
  }

  privateUsageSessions(): ReturnType<IUsageReadModel['privateSessions']> {
    return this.core.accessor.get(IRetainedUsageService).privateSessions(this.modelController.signal);
  }

  async readExportSources(
    consume: (source: UsageExportSource) => Promise<void>,
    includeEphemeral = false,
  ): Promise<{ complete: boolean; reason: string | null; sources: number; operationsComplete?: boolean }> {
    const budget: ScanBudget = { remainingRecords: this.limits.wireRecordBudget, deadlineAt: this.now() + this.limits.deadlineMs, sourcesComplete: true, incompleteReason: null };
    const index = this.core.accessor.get(ISessionIndex);
    const active = this.exportActiveKeys; let sources = 0;
    for (const session of await this.privateUsageSessions()) {
      const key = sessionKey(session);
      active.add(key);
      await consume({ key, workspaceId: session.workspaceId, kind: 'session', records: [] });
    }
    while (!this.exportAtRetained) {
      let page: Awaited<ReturnType<ISessionIndex['listRecent']>>;
      try {
        page = await index.listRecent({ includeArchived: true, limit: INDEX_PAGE_SIZE, before: this.exportCursor });
      } catch (error) {
        if (isError2(error) && error.code === ErrorCodes.SESSION_INDEX_BUILDING) {
          return { complete: false, reason: 'index_building', sources };
        }
        throw error;
      }
      for (const summary of page.items) {
        if (this.now() >= budget.deadlineAt) return { complete: false, reason: 'deadline', sources };
        const key = sessionKey(summary); active.add(key);
        if (summary.private === true) {
          await consume({ key, workspaceId: summary.workspaceId, kind: 'session', records: [] });
          this.exportCursor = summary.id;
          continue;
        }
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
          this.exportCursor = undefined; this.exportSession = undefined; this.exportAtRetained = false; this.exportActiveKeys.clear(); this.exportVerifyBoundary = false;
          return { complete, reason: complete ? null : 'retained-incomplete', sources, operationsComplete: event.value?.operationsComplete };
        }
        if (event.value.kind === 'progress') { budget.remainingRecords--; if (budget.remainingRecords % 1024 === 0) await yieldToEventLoop(); }
        else if (event.value.kind === 'session') {
          const snapshot = event.value.snapshot; const key = sessionKey(snapshot); if (active.has(key)) continue;
          if (!snapshot.complete) { this.exportRetainedIncomplete = true; continue; }
          await consume({ key, workspaceId: snapshot.workspaceId, kind: 'session', records: snapshot.records.map(normalizeRetainedRecord) }); sources++;
        } else if (event.value.kind === 'ephemeral') {
          const record = event.value.record; const records = this.exportEphemeralRecords.get(record.workspaceId) ?? []; records.push(normalizeRetainedRecord(record)); this.exportEphemeralRecords.set(record.workspaceId, records);
        } else if (event.value.kind === 'operation') {
          const { session, record, position } = event.value;
          await consume({ key: `operation\0${sessionKey(session)}\0${position}`, workspaceId: session.workspaceId, kind: 'operation', records: [normalizeRetainedRecord(record)] });
          sources++;
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
    this.exportCursor = undefined; this.exportSession = undefined; this.exportAtRetained = false; this.exportActiveKeys.clear(); this.exportVerifyBoundary = false;
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
      if (!options.verifyBoundary && checkpoint?.generation === source.generation && checkpoint.offset === source.size && checkpoint.size === source.size && checkpoint.mtimeMs === source.mtimeMs) {
        if (checkpoint.valid && head?.pendingCheckpoint === undefined) this.verifiedSources.set(source.source, sourceIdentity(source));
        return true;
      }
      if (checkpoint !== undefined && (checkpoint.generation !== source.generation || checkpoint.offset > source.size || checkpoint.offset === source.size && checkpoint.mtimeMs !== source.mtimeMs || checkpoint.offset > 0 && await this.boundaryHash(storage, source.source, checkpoint.offset, signal) !== checkpoint.boundaryHash)) checkpoint = undefined;
      let committedOffset = checkpoint?.offset ?? 0;
      const identity = sourceIdentity(source);
      const previousProgress = this.canonicalProgress.get(source.source);
      const canonical = previousProgress?.identity === identity ? previousProgress : { identity, startOffset: committedOffset, readBytes: 0, totalBytes: source.size - committedOffset };
      this.canonicalProgress.set(source.source, canonical);
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
        if (end === source.size && (checkpoint?.valid ?? true) && valid) this.verifiedSources.set(source.source, identity);
      };
      try {
        if (source.size === 0) { await publish(0, [], true); return true; }
        let complete = false;
        await this.recovery.run([source], async (_job, worker, laneSignal) => {
          const tail = await readUsageWireTail(storage, source.source, checkpoint?.offset ?? 0, source.size, allowance, deadlineAt, this.now, source.agentId, laneSignal, publish, this.pendingWireLines, JSON.stringify([source.generation, source.size, source.mtimeMs]), worker, options.onScannedRecord, publicationSignal, async (cursor, bytes) => {
            canonical.readBytes = Math.max(canonical.readBytes, Math.min(source.size, cursor) - canonical.startOffset);
            if (options.background) await this.recovery.pace(bytes, laneSignal);
          });
          if (options.recoveryBudget !== undefined) {
            options.recoveryBudget.remainingRecords -= tail.scannedRecordCount;
            options.recoveryBudget.remainingBytes -= tail.readBytes;
          }
          if (tail.offset !== committedOffset || checkpoint === undefined) await publish(tail.offset, tail.records, tail.valid);
          complete = tail.complete && tail.offset === source.size;
        }, signal, false, options.background === true);
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
  private preparationRecovering = false;
  private readonly preparationRecoveryWaiters = new Set<() => void>();
  private modelIncompleteReason: UsageResponse['reliability']['incomplete_reason'] = null;

  private modelRangeStart = -Infinity;
  private readonly modelExcludedSources = new Set<string>();

  private markPreparationRecovery(): void {
    this.preparationRecovering = true;
    for (const waiter of this.preparationRecoveryWaiters) waiter();
  }

  private async prepareReadModel(requestSignal: AbortSignal, startAt?: number): Promise<void> {
    if (this.rescan.state === 'running') return;
    if (this.core.accessor.get(IRetainedUsageService).operationWritesPending) this.modelReady = false;
    this.discoverImportProgress();
    if (this.modelReady && (startAt ?? -Infinity) >= this.modelRangeStart && this.sourceChanges?.ready && this.now() - this.modelVerifiedAt < SOURCE_RECHECK_MS) return;
    if (this.preparationController?.signal.aborted) await this.modelPreparing?.catch(() => undefined);
    if (this.modelPreparing === undefined) this.preparationController = new AbortController();
    const slice = new AbortController();
    const yieldPreparation = () => { slice.abort(new DOMException('Usage preparation continues in background', 'TimeoutError')); };
    let recoveryWaitElapsed = false;
    const yieldRecovery = () => { if (recoveryWaitElapsed && this.preparationRecovering) yieldPreparation(); };
    this.preparationRecoveryWaiters.add(yieldRecovery);
    const timer = setTimeout(() => { recoveryWaitElapsed = true; yieldRecovery(); }, Math.min(this.limits.preparationWaitMs, this.limits.deadlineMs / 2));
    const verificationTimer = setTimeout(yieldPreparation, Math.min(Math.max(2_000, this.limits.preparationWaitMs), this.limits.deadlineMs / 2));
    timer.unref();
    verificationTimer.unref();
    const signal = AbortSignal.any([requestSignal, slice.signal]);
    this.preparationWaiters++;
    try {
      await waitForSource(this.startReadModelPreparation(false, startAt), signal);
      if (this.modelReady && (startAt ?? -Infinity) < this.modelRangeStart) await waitForSource(this.startReadModelPreparation(false, startAt), signal);
    } catch (error) {
      requestSignal.throwIfAborted();
      if (!slice.signal.aborted) throw error;
      this.modelIncompleteReason = 'deadline';
    } finally {
      clearTimeout(timer);
      clearTimeout(verificationTimer);
      this.preparationRecoveryWaiters.delete(yieldRecovery);
      if (--this.preparationWaiters === 0 && requestSignal.aborted && this.modelPreparing !== undefined) this.preparationController?.abort(requestSignal.reason);
    }
  }

  private inventory?: UsageInventory;
  private inventoryRevision = 0;
  private verifiedInventoryRevision = -1;
  private readonly dirtySessions = new Map<string, number>();
  private readonly dirtyAgents = new Map<string, Set<string>>();
  private readonly fullDirtySessions = new Set<string>();
  private knownSessions = new Map<string, SessionSummary>();
  private knownSources = new Map<string, { source: string; workspaceId: string; sessionId: string }>();
  private knownSourcesBySession = new Map<string, Set<string>>();

  private readonly agentInventories = new Map<string, Promise<readonly string[]>>();
  private readonly sourceMetadata = new Map<string, Promise<UsageSourceMetadata>>();
  private readonly sourceKeysBySession = new Map<string, Set<string>>();
  private readonly verifiedSources = new Map<string, string>();
  private readonly canonicalProgress = new Map<string, { identity: string; startOffset: number; readBytes: number; totalBytes: number }>();
  private progressInventory?: Promise<void>;
  private progressInventoryReady = false;
  private progressFullGeneration = 1;
  private progressCompletedGeneration = 0;
  private readonly progressDirtySessions = new Set<string>();
  private readonly progressDirtyAgents = new Map<string, Set<string>>();
  private readonly progressFullDirtySessions = new Set<string>();
  private progressRowsBySession = new Map<string, readonly { summary: SessionSummary; metadata: UsageSourceMetadata; journalSize: number }[]>();
  private progressRows: readonly { summary: SessionSummary; metadata: UsageSourceMetadata; journalSize: number }[] = [];
  private retainedProgress: readonly { source: string; size: number; readBytes: number; complete: boolean }[] = [];

  private ensureAgentInInventory(key: string, agentId: string): void {
    const existing = this.agentInventories.get(key);
    if (existing === undefined) return;
    const updated = existing.then((agents) => (agents.includes(agentId) ? agents : [...agents, agentId]));
    this.agentInventories.set(key, updated);
    void updated.catch(() => { if (this.agentInventories.get(key) === updated) this.agentInventories.delete(key); });
  }

  private agentsOf(summary: SessionSummary): Promise<readonly string[]> {
    const key = sessionKey(summary);
    let read = this.agentInventories.get(key);
    if (read === undefined) {
      const session = sessionScopeOf(workspacePersistenceScope('sessions', summary.workspaceId), summary.id);
      read = this.core.accessor.get(IFileSystemStorageService).list(`${session}/agents`);
      this.agentInventories.set(key, read);
      void read.catch(() => { if (this.agentInventories.get(key) === read) this.agentInventories.delete(key); });
    }
    return read;
  }

  private metadataOf(source: string, agentId: string, ownerSessionKey?: string): Promise<UsageSourceMetadata> {
    let read = this.sourceMetadata.get(source);
    if (read === undefined) {
      const storage = this.core.accessor.get(IFileSystemStorageService), logs = this.core.accessor.get(IAppendLogStore);
      read = Promise.all([logs.generation(source, AGENT_WIRE_RECORD_KEY), storage.size(source, AGENT_WIRE_RECORD_KEY), storage.mtime(source, AGENT_WIRE_RECORD_KEY)]).then(([generation, size, mtimeMs]) => ({ source, agentId, generation, size: size ?? 0, mtimeMs: mtimeMs ?? 0 }));
      this.sourceMetadata.set(source, read);
      const sessionOwner = ownerSessionKey ?? sessionKeyFromAgentSource(source);
      if (sessionOwner !== undefined) {
        let bucket = this.sourceKeysBySession.get(sessionOwner);
        if (bucket === undefined) {
          bucket = new Set();
          this.sourceKeysBySession.set(sessionOwner, bucket);
        }
        bucket.add(source);
      }
      void read.catch(() => {
        if (this.sourceMetadata.get(source) === read) {
          this.sourceMetadata.delete(source);
          if (sessionOwner !== undefined) this.sourceKeysBySession.get(sessionOwner)?.delete(source);
        }
      });
    }
    return read;
  }

  private discoverImportProgress(): void {
    if (this.progressInventoryReady || this.progressInventory !== undefined) return;
    const generation = this.progressFullGeneration;
    const signal = this.modelController.signal;
    const fullScan = this.progressCompletedGeneration !== generation || !this.sourceChanges?.ready;
    const dirtySnapshot = [...this.progressDirtySessions];
    const progressFullSnapshot = new Set(this.progressFullDirtySessions);
    const progressDirtyAgentSnapshot = new Map<string, readonly string[]>();
    for (const key of dirtySnapshot) {
      const agents = this.progressDirtyAgents.get(key);
      if (agents !== undefined && agents.size > 0) progressDirtyAgentSnapshot.set(key, [...agents]);
    }
    const versions = new Map(this.sessionVersions);
    const unchanged = (key: string): boolean => versions.get(key) === this.sessionVersions.get(key);
    const work = (async () => {
      const index = this.core.accessor.get(ISessionIndex), model = this.core.accessor.get(IUsageReadModel), facts = this.core.accessor.get(IUsageFactStore);
      const collectAgentRows = async (summary: SessionSummary, agents: readonly string[]): Promise<{ summary: SessionSummary; metadata: UsageSourceMetadata; journalSize: number }[]> => {
        if (summary.private === true) return [];
        const key = sessionKey(summary);
        const session = sessionScopeOf(workspacePersistenceScope('sessions', summary.workspaceId), summary.id);
        const sessionRows: { summary: SessionSummary; metadata: UsageSourceMetadata; journalSize: number }[] = [];
        for (let offset = 0; offset < agents.length; offset += 32) {
          sessionRows.push(...await Promise.all(agents.slice(offset, offset + 32).map(async (agentId) => {
            const source = agentScopeOf(session, agentId);
            const [metadata, journalSize] = await Promise.all([this.metadataOf(source, agentId, key), facts.journalSize(source, signal)]);
            return { summary, metadata, journalSize };
          })));
          await yieldToEventLoop(undefined, { signal });
        }
        return sessionRows;
      };
      const collectSessionRows = async (summary: SessionSummary): Promise<{ summary: SessionSummary; metadata: UsageSourceMetadata; journalSize: number }[]> => {
        if (summary.private === true) return [];
        const agents = await waitForSource(this.agentsOf(summary), signal);
        return collectAgentRows(summary, agents);
      };
      if (fullScan) {
        const bySession = new Map<string, readonly { summary: SessionSummary; metadata: UsageSourceMetadata; journalSize: number }[]>();
        let before: string | undefined;
        let visitedSessions = 0;
        do {
          let page: Awaited<ReturnType<ISessionIndex['listRecent']>>;
          try {
            page = await waitForSource(index.listRecent({ includeArchived: true, limit: INDEX_PAGE_SIZE, before }), signal);
          } catch (error) {
            if (isError2(error) && error.code === ErrorCodes.SESSION_INDEX_BUILDING) return;
            throw error;
          }
          for (const summary of page.items) {
            const key = sessionKey(summary);
            bySession.set(key, unchanged(key) ? await collectSessionRows(summary) : []);
            visitedSessions += 1;
            if (visitedSessions % 32 === 0) await yieldToEventLoop(undefined, { signal });
          }
          before = page.nextCursor;
        } while (before !== undefined);
        this.retainedProgress = await this.core.accessor.get(IRetainedUsageService).readModelImportProgress?.(signal) ?? [];
        const heads = await model.sources(signal);
        for (let index = 0; index < heads.length; index += 1) {
          if (index > 0 && index % 256 === 0) await yieldToEventLoop(undefined, { signal });
          const { source, head } = heads[index]!;
          const metadata = await this.sourceMetadata.get(source);
          const checkpoint = head.checkpoint;
          if (metadata !== undefined && checkpoint?.valid && head.pendingCheckpoint === undefined && checkpoint.generation === metadata.generation && checkpoint.offset === metadata.size && checkpoint.size === metadata.size && checkpoint.mtimeMs === metadata.mtimeMs) this.verifiedSources.set(source, sourceIdentity(metadata));
        }
        if (generation === this.progressFullGeneration) {
          for (const key of this.progressDirtySessions) {
            if (unchanged(key)) {
              this.progressDirtySessions.delete(key);
              this.progressDirtyAgents.delete(key);
              this.progressFullDirtySessions.delete(key);
            } else {
              const prior = this.progressRowsBySession.get(key);
              if (prior === undefined) bySession.delete(key);
              else bySession.set(key, prior);
            }
          }
          this.progressRowsBySession = bySession;
          this.progressCompletedGeneration = generation;
          this.progressRows = flattenProgressRows(bySession);
          this.progressInventoryReady = this.progressDirtySessions.size === 0;
        }
        return;
      }
      const nextBySession = new Map(this.progressRowsBySession);
      const refreshedSources: UsageSourceMetadata[] = [];
      for (const key of dirtySnapshot) {
        const sep = key.indexOf('\0');
        const workspaceId = sep >= 0 ? key.slice(0, sep) : undefined;
        const sessionId = sep >= 0 ? key.slice(sep + 1) : key;
        const summary = await waitForSource(index.get(sessionId, workspaceId), signal);
        if (summary === undefined || summary.private === true) {
          nextBySession.delete(key);
          continue;
        }
        if (!unchanged(key)) {
          nextBySession.set(key, []);
          continue;
        }
        const priorRows = this.progressRowsBySession.get(key);
        const partialAgents = !progressFullSnapshot.has(key) && priorRows !== undefined ? progressDirtyAgentSnapshot.get(key) : undefined;
        if (partialAgents !== undefined && partialAgents.length > 0) {
          const updatedRows = await collectAgentRows(summary, partialAgents);
          const byAgent = new Map(updatedRows.map((row) => [row.metadata.agentId, row]));
          const merged: { summary: SessionSummary; metadata: UsageSourceMetadata; journalSize: number }[] = [];
          for (const row of priorRows!) {
            const replacement = byAgent.get(row.metadata.agentId);
            if (replacement !== undefined) {
              merged.push(replacement);
              byAgent.delete(row.metadata.agentId);
            } else {
              merged.push(row);
            }
          }
          for (const added of byAgent.values()) merged.push(added);
          nextBySession.set(key, merged);
          for (const row of updatedRows) refreshedSources.push(row.metadata);
        } else {
          const sessionRows = await collectSessionRows(summary);
          nextBySession.set(key, sessionRows);
          for (const row of sessionRows) refreshedSources.push(row.metadata);
        }
      }
      this.retainedProgress = await this.core.accessor.get(IRetainedUsageService).readModelImportProgress?.(signal) ?? [];
      if (refreshedSources.length > 0) {
        const snapshots = await model.summaries(refreshedSources.map((item) => item.source), signal);
        for (const metadata of refreshedSources) {
          const head = snapshots[metadata.source]?.head;
          const checkpoint = head?.checkpoint;
          if (checkpoint?.valid && head?.pendingCheckpoint === undefined && checkpoint.generation === metadata.generation && checkpoint.offset === metadata.size && checkpoint.size === metadata.size && checkpoint.mtimeMs === metadata.mtimeMs) {
            this.verifiedSources.set(metadata.source, sourceIdentity(metadata));
          }
        }
      }
      if (generation === this.progressFullGeneration) {
        for (const key of dirtySnapshot) {
          if (unchanged(key)) {
            this.progressDirtySessions.delete(key);
            this.progressDirtyAgents.delete(key);
            this.progressFullDirtySessions.delete(key);
          } else {
            const prior = this.progressRowsBySession.get(key);
            if (prior === undefined) nextBySession.delete(key);
            else nextBySession.set(key, prior);
          }
        }
        this.progressRowsBySession = nextBySession;
        this.progressRows = flattenProgressRows(nextBySession);
        this.progressInventoryReady = this.progressDirtySessions.size === 0;
      }
    })().finally(() => { if (this.progressInventory === work) this.progressInventory = undefined; });
    this.progressInventory = work;
    void work.catch((error: unknown) => { if (!signal.aborted) this.core.accessor.get(ILogService).warn('Usage import progress inventory pending', error); });
  }

  private importProgress(query: NormalizedQuery): UsageResponse['reliability']['import_progress'] {
    if (!this.progressInventoryReady && this.progressRows.length === 0) return undefined;
    const workspaceFilter = query.workspaceIds.length > 0 ? new Set(query.workspaceIds) : undefined;
    const startAt = query.range.startAt ?? -Infinity;
    let verified_sources = 0, total_sources = 0, read_bytes = 0, total_bytes = 0;
    for (const { summary, metadata, journalSize } of this.progressRows) {
      if (!query.includeArchived && summary.archived || workspaceFilter !== undefined && !workspaceFilter.has(summary.workspaceId) || metadata.mtimeMs >= 1_000_000_000_000 && metadata.mtimeMs < startAt) continue;
      total_sources++;
      const identity = sourceIdentity(metadata);
      const verified = this.verifiedSources.get(metadata.source) === identity;
      if (verified) verified_sources++;
      const canonical = this.canonicalProgress.get(metadata.source);
      if (canonical?.identity === identity) { total_bytes += canonical.totalBytes; read_bytes += canonical.readBytes; }
      else if (journalSize === 0 && !verified) total_bytes += metadata.size;
    }
    for (const retained of this.retainedProgress) { total_sources++; if (retained.complete) verified_sources++; total_bytes += retained.size; read_bytes += retained.readBytes; }
    return { verified_sources, total_sources, read_bytes, total_bytes };
  }

  private startReadModelPreparation(full = false, startAt?: number): Promise<void> {
    if (this.modelPreparing !== undefined) return this.modelPreparing;
    const epoch = this.replayEpoch;
    const deadline = new AbortController();
    const timer = full ? undefined : setTimeout(() => { deadline.abort(new DOMException('Usage preparation deadline', 'TimeoutError')); }, this.limits.deadlineMs);
    timer?.unref();
    const signal = AbortSignal.any([this.modelController.signal, this.preparationController!.signal, deadline.signal]);
    const factBudget = { remainingRecords: full ? Infinity : this.limits.usageFactBudget };
    const recoveryBudget = { remainingRecords: full ? Infinity : this.limits.wireRecordBudget, remainingBytes: Infinity };
    const deadlineAt = full ? Infinity : this.now() + this.limits.deadlineMs;
    this.modelIncompleteReason = null;
    this.modelReady = false;
    this.preparationRecovering = false;
    const rangeStart = full ? -Infinity : startAt ?? -Infinity;
    if (full || this.inventory !== undefined && rangeStart < this.inventory.startAt) this.inventory = undefined;
    const work = (async () => {
      const index = this.core.accessor.get(ISessionIndex);
      const model = this.core.accessor.get(IUsageReadModel);
      if (this.inventory === undefined) {
        const verifyAll = full || this.verifiedInventoryRevision !== this.inventoryRevision || !this.sourceChanges?.ready || this.now() - this.modelVerifiedAt >= SOURCE_RECHECK_MS || rangeStart < this.modelRangeStart;
        const heads = new Map(verifyAll ? (await waitForSource(model.sources(signal), signal)).map((row) => [row.source, row.head]) : []);
        if (verifyAll) {
          if (full || this.verifiedInventoryRevision >= 0 && (!this.sourceChanges?.ready || this.now() - this.modelVerifiedAt >= SOURCE_RECHECK_MS)) {
            this.agentInventories.clear();
            this.sourceMetadata.clear();
            this.sourceKeysBySession.clear();
            this.progressFullGeneration++;
            this.progressDirtySessions.clear();
            this.progressDirtyAgents.clear();
            this.progressFullDirtySessions.clear();
            this.progressInventoryReady = false;
          }
          this.modelExcludedSources.clear();
          this.modelRangeStart = rangeStart;
        }
        this.inventory = {
          full: verifyAll,
          revision: this.inventoryRevision,
          startAt: this.modelRangeStart,
          summaries: verifyAll ? new Map() : new Map(this.knownSessions),
          sources: verifyAll ? new Map() : new Map(this.knownSources),
          sourcesBySession: verifyAll ? new Map() : cloneSessionSourceIndex(this.knownSourcesBySession),
          dirtyKeys: [...this.dirtySessions.keys()],
          prepared: new Map(),
          heads,
          needsFullCatalogSync: verifyAll,
          page: [],
          nextSession: 0,
          exhausted: false,
        };
      }
      const inventory = this.inventory;
      if (inventory.current !== undefined && inventory.current.version !== this.dirtySessions.get(sessionKey(inventory.current.summary))) {
        inventory.prepared.delete(sessionKey(inventory.current.summary));
        inventory.current = undefined;
      }
      let scannedSessions = 0;
      let recoverySources = 0;
      const fullScannedSessions = new Set<string>();
      const stop = (): boolean => {
        signal.throwIfAborted();
        if (this.now() >= deadlineAt) { this.modelIncompleteReason = 'deadline'; return true; }
        if (factBudget.remainingRecords <= 0 || recoveryBudget.remainingRecords <= 0 || !full && recoverySources >= this.limits.sourceScanLimit) { this.modelIncompleteReason = 'record_budget'; return true; }
        return false;
      };
      while (true) {
        if (inventory.current === undefined) {
          const done = inventory.full ? inventory.nextSession >= inventory.page.length && inventory.exhausted : inventory.nextSession >= inventory.dirtyKeys.length;
          if (done) break;
          if (stop()) return;
          if (!full && scannedSessions >= this.limits.sessionScanLimit) { this.modelIncompleteReason = 'session_cap'; return; }
          if (inventory.full && inventory.nextSession >= inventory.page.length) {
            let page: Awaited<ReturnType<ISessionIndex['listRecent']>>;
            try {
              page = await waitForSource(index.listRecent({ includeArchived: true, limit: Math.min(INDEX_PAGE_SIZE, full ? INDEX_PAGE_SIZE : this.limits.sessionScanLimit), before: inventory.before }), signal);
            } catch (error) {
              if (isError2(error) && error.code === ErrorCodes.SESSION_INDEX_BUILDING) {
                this.modelIncompleteReason = 'deadline';
                return;
              }
              throw error;
            }
            const catalogBatchLimit = resolveCatalogBatchSources();
            const prepared: Array<{
              readonly key: string;
              readonly summary: SessionSummary;
              readonly agents: readonly string[];
              readonly version: number | undefined;
              readonly sources: { source: string; workspaceId: string; sessionId: string }[];
            }> = [];
            let batchSourceCount = 0;
            for (let offset = 0; offset < page.items.length; offset += 32) {
              const slice = page.items.slice(offset, offset + 32);
              const chunk = await waitForSource(Promise.all(slice.map(async (summary) => {
                const key = sessionKey(summary);
                const version = this.dirtySessions.get(key);
                const session = sessionScopeOf(workspacePersistenceScope('sessions', summary.workspaceId), summary.id);
                const agents = summary.private === true ? [] : await this.agentsOf(summary);
                return { key, summary, agents, version, sources: agents.map((agentId) => ({ source: agentScopeOf(session, agentId), workspaceId: summary.workspaceId, sessionId: summary.id })) };
              })), signal);
              for (const item of chunk) {
                prepared.push(item);
                batchSourceCount += item.sources.length;
                if (batchSourceCount >= catalogBatchLimit) break;
              }
              if (batchSourceCount >= catalogBatchLimit) break;
              if (batchSourceCount >= 512 && offset + 32 < page.items.length) await yieldToEventLoop(undefined, { signal });
            }
            const catalogSessions = prepared.map((item) => ({ ...item.summary, deleted: false }));
            const catalogSources = prepared.flatMap((item) => item.sources);
            if (catalogSources.length <= catalogBatchLimit) {
              await waitForSource(model.catalog(catalogSessions, catalogSources), signal);
            } else {
              for (let start = 0; start < catalogSources.length; start += catalogBatchLimit) {
                if (start > 0) await yieldToEventLoop(undefined, { signal });
                await waitForSource(
                  model.catalog(start === 0 ? catalogSessions : [], catalogSources.slice(start, start + catalogBatchLimit)),
                  signal,
                );
              }
            }
            for (const item of prepared) {
              inventory.prepared.set(item.key, { agents: item.agents, version: item.version });
              inventory.summaries.set(item.key, item.summary);
              replaceSessionInventorySources(inventory, item.key, item.sources);
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
            inventory.needsFullCatalogSync = true;
            inventory.summaries.delete(dirtyKey!);
            deleteSessionInventorySources(inventory, dirtyKey!);
            if (this.dirtySessions.get(dirtyKey!) === version) {
              this.dirtySessions.delete(dirtyKey!);
              this.dirtyAgents.delete(dirtyKey!);
              this.fullDirtySessions.delete(dirtyKey!);
            }
            inventory.nextSession++;
            scannedSessions++;
            continue;
          }
          const key = sessionKey(summary);
          const prepared = inventory.prepared.get(key);
          const observedVersion = inventory.full ? prepared === undefined ? this.dirtySessions.get(key) : prepared.version : version;
          const session = sessionScopeOf(workspacePersistenceScope('sessions', summary.workspaceId), summary.id);
          const partialDirtyAgents = !inventory.full && summary.private !== true && !this.fullDirtySessions.has(key) && inventory.summaries.has(key) && inventory.sourcesBySession.has(key)
            ? this.dirtyAgents.get(key)
            : undefined;
          if (partialDirtyAgents !== undefined && partialDirtyAgents.size > 0) {
            const agents = [...partialDirtyAgents];
            const sources = agents.map((agentId) => ({ source: agentScopeOf(session, agentId), workspaceId: summary.workspaceId, sessionId: summary.id }));
            const newSources: { source: string; workspaceId: string; sessionId: string }[] = [];
            let bucket = inventory.sourcesBySession.get(key);
            if (bucket === undefined) {
              bucket = new Set();
              inventory.sourcesBySession.set(key, bucket);
            }
            for (const entry of sources) {
              if (!inventory.sources.has(entry.source)) {
                inventory.sources.set(entry.source, entry);
                bucket.add(entry.source);
                newSources.push(entry);
              }
            }
            inventory.summaries.set(key, summary);
            if (newSources.length > 0) {
              await waitForSource(model.catalog([{ ...summary, deleted: false }], newSources), signal);
            }
            inventory.current = { summary, version: observedVersion, agents, sources, nextAgent: 0 };
          } else {
            if (!inventory.full) inventory.needsFullCatalogSync = true;
            const agents = summary.private === true ? [] : prepared?.agents ?? await waitForSource(this.agentsOf(summary), signal);
            this.reconcileSessionAccountingAgents(key, agents);
            const sources = agents.map((agentId) => ({ source: agentScopeOf(session, agentId), workspaceId: summary.workspaceId, sessionId: summary.id }));
            inventory.current = { summary, version: observedVersion, agents, sources, nextAgent: 0 };
            inventory.summaries.set(key, summary);
            replaceSessionInventorySources(inventory, key, sources);
            if (prepared === undefined) {
              const catalogBatchLimit = resolveCatalogBatchSources();
              if (sources.length <= catalogBatchLimit) {
                await waitForSource(model.catalog([{ ...summary, deleted: false }], sources), signal);
              } else {
                for (let start = 0; start < sources.length; start += catalogBatchLimit) {
                  if (start > 0) await yieldToEventLoop(undefined, { signal });
                  await waitForSource(
                    model.catalog(start === 0 ? [{ ...summary, deleted: false }] : [], sources.slice(start, start + catalogBatchLimit)),
                    signal,
                  );
                }
              }
            }
          }
        }
        const current = inventory.current;
        const currentKey = sessionKey(current.summary);
        let batchProcessed = 0;
        while (current.nextAgent < current.agents.length) {
          if (stop()) return;
          if (current.pending === undefined || current.pending.length === 0) {
            if (batchProcessed > 0) await yieldToEventLoop(undefined, { signal });
            const count = full ? 32 : Math.min(32, this.limits.sourceScanLimit - recoverySources);
            current.pending = await waitForSource(Promise.all(current.sources.slice(current.nextAgent, current.nextAgent + count).map(async ({ source }, offset) => {
              const [metadata, head] = await Promise.all([this.metadataOf(source, current.agents[current.nextAgent + offset]!, currentKey), inventory.full ? inventory.heads.get(source) : model.source(source, signal)]);
              const checkpoint = head?.checkpoint;
              return { ...metadata, aligned: !full && head?.pendingCheckpoint === undefined && checkpoint?.generation === metadata.generation && checkpoint.offset === metadata.size && checkpoint.size === metadata.size && checkpoint.mtimeMs === metadata.mtimeMs };
            })), signal);
          }
          const source = current.pending[0]!;
          const excluded = !full && source.mtimeMs >= 1_000_000_000_000 && source.mtimeMs < inventory.startAt;
          if (!source.aligned && excluded) this.modelExcludedSources.add(source.source);
          else {
            if (!source.aligned && this.sessionAccounting.has(currentKey)) this.invalidateSessionAccountingAgent(currentKey, source.agentId);
            this.modelExcludedSources.delete(source.source);
            if (!source.aligned) {
              this.markPreparationRecovery();
              recoverySources++;
              if (!await this.synchronizeSource(source, signal, { factBudget, recoveryBudget, deadlineAt, background: true, onScannedRecord: full ? () => { this.rescan = { ...this.rescan, scanned_records: this.rescan.scanned_records + 1 }; } : undefined })) { this.modelIncompleteReason = this.now() >= deadlineAt ? 'deadline' : 'record_budget'; return; }
            }
            if (full && (await model.source(source.source, signal))?.checkpoint?.valid !== true) {
              fullScannedSessions.add(currentKey);
              this.rescan = { ...this.rescan, scanned_sessions: fullScannedSessions.size };
              throw new Error(`Usage checkpoint is incomplete for session ${current.summary.id}`);
            }
          }
          current.pending.shift();
          current.nextAgent++;
          batchProcessed++;
        }
        const key = currentKey;
        if (this.dirtySessions.get(key) === current.version) {
          this.dirtySessions.delete(key);
          this.dirtyAgents.delete(key);
          this.fullDirtySessions.delete(key);
        }
        inventory.current = undefined;
        inventory.nextSession++;
        scannedSessions++;
        if (full) { fullScannedSessions.add(key); this.rescan = { ...this.rescan, scanned_sessions: fullScannedSessions.size }; }
        await yieldToEventLoop(undefined, { signal });
      }
      if (inventory.full || inventory.needsFullCatalogSync) {
        await model.catalog([...inventory.summaries.values()].map((summary) => ({ ...summary, deleted: false })), [...inventory.sources.values()], true);
      }
      this.knownSessions = inventory.summaries;
      this.knownSources = inventory.sources;
      this.knownSourcesBySession = inventory.sourcesBySession;
      const retained = this.core.accessor.get(IRetainedUsageService);
      let retainedRevision = this.retainedRevision;
      if (retained.prepareReadModel !== undefined) {
        this.retainedProgress = await retained.readModelImportProgress?.(signal) ?? [];
        if (this.retainedProgress.some((row) => !row.complete)) this.markPreparationRecovery();
        const progress = await retained.prepareReadModel({ deadlineAt, recordLimit: factBudget.remainingRecords, signal });
        retainedRevision = this.retainedRevision;
        this.retainedProgress = await retained.readModelImportProgress?.(signal) ?? [];
        if (!progress.complete || this.retainedProgress.some((row) => !row.complete)) {
          this.modelIncompleteReason = progress.incompleteReason ?? null;
          return;
        }
      }
      signal.throwIfAborted();
      if (inventory.full) { this.modelVerifiedAt = this.now(); this.verifiedInventoryRevision = inventory.revision; }
      this.inventory = undefined;
      this.modelReady = epoch === this.replayEpoch && retainedRevision === this.retainedRevision
        && this.dirtySessions.size === 0 && this.verifiedInventoryRevision === this.inventoryRevision;
      if (this.modelReady) this.modelIncompleteReason = null;
      this.modelFailure = undefined;
    })().catch((error: unknown) => {
      this.modelController.signal.throwIfAborted();
      this.preparationController!.signal.throwIfAborted();
      if (!deadline.signal.aborted) throw error;
      this.modelIncompleteReason = 'deadline';
    }).finally(() => { if (timer !== undefined) clearTimeout(timer); });
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
      const lastSortValue = last?.sortValue;
      const complete = this.modelReady && incompleteReason === null && result.incompleteSessions === 0;
      const wire = (value: UsageReadModelAggregate): UsageAggregateWire => ({ tokens: { input_other: value.usage.inputOther, output: value.usage.output, input_cache_read: value.usage.inputCacheRead, input_cache_creation: value.usage.inputCacheCreation }, tokens_unknown: value.missingRecords > 0 || value.legacyZeroRecords > 0, cost_usd_estimated: value.cost, cost_unknown: value.costUnknown });
      return {
        query: { granularity: query.granularity, range: { preset: query.range.preset, start_at: query.range.startAt ?? null, end_at: query.range.endAt ?? null, defaulted_to_all_history: query.range.defaultedToAllHistory }, dimension: query.dimension, models: [...query.models], providers: [...query.providers], profiles: [...query.profiles], agent_ids: [...query.agentIds], workspace_ids: [...query.workspaceIds], include_archived: query.includeArchived, timezone_offset_minutes: query.timezoneOffsetMinutes, sort_by: query.sortBy },
        summary: { ...wire(result.total), session_count: result.sessionCount, turn_count: result.turnCount, request_count: result.requestCount },
        trend: result.trend.map((bucket) => ({ key: bucket.key, start_at: bucket.startAt, end_at: bucket.endAt, request_count: bucket.requests, turn_count: bucket.turns, groups: bucket.groups.map((group) => ({ key: group.key, ...wire(group), provider: group.provider, model_alias: group.modelAlias, agent_id: group.agentId, parent_agent_id: group.parentAgentId, profile_name: group.profileName })), drilldown: { sessions: bucket.sessions.map((session) => ({ session_id: session.id, turn_ids: [...session.turnIds], turn_count: session.turns, unknown_turn_records: session.unknownTurnRecords, turn_ids_truncated: session.turns > session.turnIds.length })), sessions_truncated: bucket.sessionsTruncated } })),
        sessions: { items: result.sessions.map((row) => ({ id: row.session.id, workspace_id: row.session.workspaceId, title: row.session.title ?? null, created_at: row.session.createdAt, updated_at: row.session.updatedAt, archived: row.session.archived, deleted: row.session.deleted, usage: wire(row), primary_model: row.primaryModel ?? null, profile_names: [...row.profileNames], unknown_price_models: [...row.unknownPriceModels] })), total: result.sessionCount, has_more: result.hasMore, next_page_token: result.hasMore && last !== undefined && lastSortValue !== undefined ? Buffer.from(JSON.stringify({ v: 2, f: fingerprint, r: result.revision, p: pricingRevision, k: [lastSortValue, last.session.id] })).toString('base64url') : null },
        reliability: { complete, import_progress: complete ? undefined : this.importProgress(query), coverage: { earliest_at: result.earliestAt ?? null, latest_at: result.latestAt ?? null }, usage_coverage: { known_records: result.total.knownRecords, missing_records: result.total.missingRecords, legacy_zero_records: result.total.legacyZeroRecords }, scanned_sessions: result.scannedSessions, incomplete_sessions: result.incompleteSessions, unknown_price_models: [...result.unknownPriceModels], includes_deleted_sessions: result.includesDeletedSessions, incomplete_reason: incompleteReason },
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
    sortBy: raw.sort_by ?? 'tokens',
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

function sourceIdentity(source: UsageSourceMetadata): string {
  return JSON.stringify([source.generation, source.size, source.mtimeMs]);
}

function sessionKey(summary: Pick<SessionSummary, 'id' | 'workspaceId'>): string {
  return `${summary.workspaceId}\0${summary.id}`;
}

function sessionKeyFromAgentSource(source: string): string | undefined {
  if (!source.startsWith('sessions/')) return undefined;
  const agentsMarker = '/agents/';
  const agentsIndex = source.indexOf(agentsMarker, 'sessions/'.length);
  if (agentsIndex < 0) return undefined;
  const body = source.slice('sessions/'.length, agentsIndex);
  const slash = body.indexOf('/');
  if (slash <= 0 || slash >= body.length - 1) return undefined;
  return `${body.slice(0, slash)}\0${body.slice(slash + 1)}`;
}

function prioritizeMainAgentIds(agentIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const rest: string[] = [];
  let hasMain = false;
  for (const id of agentIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === 'main') hasMain = true;
    else rest.push(id);
  }
  return hasMain ? ['main', ...rest] : rest;
}

function sameAgentList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  if (left.length === 0) return true;
  const rightSet = new Set(right);
  for (const id of left) {
    if (!rightSet.has(id)) return false;
  }
  return true;
}

function cloneSessionSourceIndex(
  index: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
  const cloned = new Map<string, Set<string>>();
  for (const [key, value] of index) cloned.set(key, new Set(value));
  return cloned;
}

function deleteSessionInventorySources(inventory: UsageInventory, key: string): void {
  const existing = inventory.sourcesBySession.get(key);
  if (existing === undefined) return;
  for (const source of existing) inventory.sources.delete(source);
  inventory.sourcesBySession.delete(key);
}

function replaceSessionInventorySources(
  inventory: UsageInventory,
  key: string,
  sources: readonly { source: string; workspaceId: string; sessionId: string }[],
): void {
  deleteSessionInventorySources(inventory, key);
  if (sources.length === 0) return;
  const bucket = new Set<string>();
  for (const entry of sources) {
    inventory.sources.set(entry.source, entry);
    bucket.add(entry.source);
  }
  inventory.sourcesBySession.set(key, bucket);
}

function flattenProgressRows<T>(bySession: ReadonlyMap<string, readonly T[]>): T[] {
  const rows: T[] = [];
  for (const entries of bySession.values()) {
    for (const entry of entries) rows.push(entry);
  }
  return rows;
}

function emptyUsage(): TokenUsage {
  return { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
}

function emptyAggregate(): AggregateAccumulator {
  return { usage: emptyUsage(), cost: 0, costUnknown: false, knownRecords: 0, missingRecords: 0, legacyZeroRecords: 0 };
}

function incompleteUsageResponse(query: NormalizedQuery, reason: UsageResponse['reliability']['incomplete_reason']): UsageResponse {
  return {
    query: { granularity: query.granularity, range: { preset: query.range.preset, start_at: query.range.startAt ?? null, end_at: query.range.endAt ?? null, defaulted_to_all_history: query.range.defaultedToAllHistory }, dimension: query.dimension, models: [...query.models], providers: [...query.providers], profiles: [...query.profiles], agent_ids: [...query.agentIds], workspace_ids: [...query.workspaceIds], include_archived: query.includeArchived, timezone_offset_minutes: query.timezoneOffsetMinutes, sort_by: query.sortBy },
    summary: { ...aggregateWire(emptyAggregate()), session_count: 0, turn_count: 0, request_count: 0 },
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
      query.sortBy,
      ...(query.profiles.length > 0 ? [query.profiles] : []),
    ]))
    .digest('base64url')
    .slice(0, 16);
}
