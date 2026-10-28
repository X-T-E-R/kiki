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
    this.sourceSubscription = sourceChanges?.onDidChange(() => {
      this.replayEpoch++;
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

  async readSessionAccounting(workspaceId: string, sessionId: string, signal?: AbortSignal): Promise<UsageAccountingSnapshot> {
    signal?.throwIfAborted();
    const deadlineAt = this.now() + this.limits.deadlineMs;
    const deadline = new AbortController();
    const timer = setTimeout(() => { deadline.abort(new DOMException('Session usage deadline', 'TimeoutError')); }, this.limits.deadlineMs);
    timer.unref();
    const readSignal = AbortSignal.any([this.modelController.signal, deadline.signal, ...(signal === undefined ? [] : [signal])]);
    const rows: Record<string, AgentUsageProjection> = {};
    const revisions = new Map<string, string>();
    let agents: string[] = [];
    let inventoryComplete = false;
    let pricingReady = false;
    const pricing = this.core.accessor.get(IModelPricingService);
    const preparation = pricing.ready.then(() => { pricingReady = true; });
    void preparation.catch(() => undefined);
    try {
      const scope = sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId);
      agents = await waitForSource(this.core.accessor.get(IFileSystemStorageService).list(`${scope}/agents`), readSignal);
      inventoryComplete = true;
      await waitForSource(this.readAgentUsageSources(workspaceId, sessionId, agents, { signal: readSignal, factSignal: readSignal, summaryOnly: true, deadlineAt, factBudget: { remainingRecords: this.limits.usageFactBudget }, recoveryBudget: { remainingRecords: Infinity, remainingBytes: Infinity } }, rows, revisions), readSignal);
      await waitForSource(preparation, readSignal);
    } catch (error) {
      signal?.throwIfAborted();
      this.modelController.signal.throwIfAborted();
      if (!deadline.signal.aborted) throw error;
    } finally { clearTimeout(timer); }
    let totals = summarizeUsageFacts([]);
    let complete = inventoryComplete;
    let cost = 0;
    let costUnknown = !pricingReady;
    for (const agent of agents) {
      const row = rows[agent];
      complete &&= row?.complete === true;
      const summary = row?.totals ?? summarizeUsageFacts(row?.records ?? []);
      for (const key of ['inputOther', 'output', 'inputCacheRead', 'inputCacheCreation'] as const) totals.usage[key] += summary.usage[key];
      totals = { ...totals, records: totals.records + summary.records, knownUsageRecords: totals.knownUsageRecords + summary.knownUsageRecords, partial: totals.partial || summary.partial };
      if (pricingReady) for (const [model, masks] of Object.entries(summary.byModelMask ?? {})) for (const value of Object.values(masks)) {
        const quoted = pricing.calculate(model, value);
        if (quoted === undefined || !Number.isFinite(cost + quoted)) costUnknown = true; else cost += quoted;
      }
      if (summary.byModelMask === undefined && summary.knownUsageRecords > 0) costUnknown = true;
    }
    return { version: 2, subject: { session_id: sessionId, scope: 'session' }, source_revision: agents.map((agent) => revisions.get(agent) ?? `${agent}:unread`).join('|'), covered_at: this.now(), complete, tokens: { input_other: totals.usage.inputOther, output: totals.usage.output, input_cache_read: totals.usage.inputCacheRead, input_cache_creation: totals.usage.inputCacheCreation }, tokens_unknown: totals.partial, cost_usd_estimated: cost, cost_unknown: costUnknown || totals.partial };
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

  private startReadModelPreparation(full = false, startAt?: number): Promise<void> {
    if (this.modelPreparing !== undefined) return this.modelPreparing;
    const epoch = this.replayEpoch;
    const signal = AbortSignal.any([this.modelController.signal, this.preparationController!.signal]);
    const factBudget = { remainingRecords: full ? Infinity : this.limits.usageFactBudget };
    const recoveryBudget = { remainingRecords: full ? Infinity : this.limits.wireRecordBudget, remainingBytes: Infinity };
    const deadlineAt = full ? Infinity : this.now() + this.limits.deadlineMs;
    this.modelIncompleteReason = null;
    this.modelReady = false;
    this.modelRangeStart = full ? -Infinity : startAt ?? -Infinity;
    this.modelExcludedSources.clear();
    const work = (async () => {
      const index = this.core.accessor.get(ISessionIndex);
      const storage = this.core.accessor.get(IFileSystemStorageService);
      const logs = this.core.accessor.get(IAppendLogStore);
      const model = this.core.accessor.get(IUsageReadModel);
      const heads = new Map((await model.sources(signal)).map((row) => [row.source, row.head]));
      const summaries: SessionSummary[] = [];
      let before: string | undefined;
      do {
        signal.throwIfAborted();
        const page = await index.listRecent({ includeArchived: true, limit: INDEX_PAGE_SIZE, before });
        summaries.push(...page.items); before = page.nextCursor;
      } while (before !== undefined);
      const sources: { source: string; workspaceId: string; sessionId: string }[] = [];
      const changed: { summary: SessionSummary; agentId: string; source: string; generation: string; size: number; mtimeMs: number }[] = [];
      for (let start = 0; start < summaries.length; start += 32) {
        signal.throwIfAborted();
        const inventories = await Promise.all(summaries.slice(start, start + 32).map(async (summary) => {
          const session = sessionScopeOf(workspacePersistenceScope('sessions', summary.workspaceId), summary.id);
          const agents = await storage.list(`${session}/agents`);
          return agents.map((agentId) => ({ summary, agentId, source: agentScopeOf(session, agentId) }));
        }));
        const jobs = inventories.flat();
        for (let offset = 0; offset < jobs.length; offset += 32) await Promise.all(jobs.slice(offset, offset + 32).map(async ({ summary, agentId, source }) => {
          signal.throwIfAborted();
          sources.push({ source, workspaceId: summary.workspaceId, sessionId: summary.id });
          const [generation, size, mtime] = await Promise.all([logs.generation(source, AGENT_WIRE_RECORD_KEY), storage.size(source, AGENT_WIRE_RECORD_KEY), storage.mtime(source, AGENT_WIRE_RECORD_KEY)]);
          signal.throwIfAborted();
          const checkpoint = heads.get(source)?.checkpoint;
          if (!full && checkpoint?.generation === generation && checkpoint.offset === (size ?? 0) && checkpoint.size === (size ?? 0) && checkpoint.mtimeMs === (mtime ?? 0)) return;
          if (!full && startAt !== undefined && mtime !== undefined && mtime >= 1_000_000_000_000 && mtime < startAt) { this.modelExcludedSources.add(source); return; }
          changed.push({ summary, agentId, source, generation, size: size ?? 0, mtimeMs: mtime ?? 0 });
        }));
      }
      await model.catalog(summaries.map((summary) => ({ ...summary, deleted: false })), sources, true);
      if (full) this.rescan = { ...this.rescan, total_sessions: summaries.length };
      const scannedSessions = new Set<string>();
      for (const source of changed) {
        if (this.now() >= deadlineAt) { this.modelIncompleteReason = 'deadline'; return; }
        if (factBudget.remainingRecords <= 0 || recoveryBudget.remainingRecords <= 0) { this.modelIncompleteReason = 'record_budget'; return; }
        const key = sessionKey(source.summary);
        if (!full && !scannedSessions.has(key) && scannedSessions.size >= this.limits.sessionScanLimit) { this.modelIncompleteReason = 'session_cap'; return; }
        if (!await this.synchronizeSource(source, signal, { factBudget, recoveryBudget, deadlineAt, onScannedRecord: full ? () => { this.rescan = { ...this.rescan, scanned_records: this.rescan.scanned_records + 1 }; } : undefined })) { this.modelIncompleteReason = this.now() >= deadlineAt ? 'deadline' : 'record_budget'; return; }
        scannedSessions.add(key);
        if (full) {
          this.rescan = { ...this.rescan, scanned_sessions: scannedSessions.size };
          if ((await model.source(source.source, signal))?.checkpoint?.valid !== true) throw new Error(`Usage checkpoint is incomplete for session ${source.summary.id}`);
        }
      }
      if (full) this.rescan = { ...this.rescan, scanned_sessions: summaries.length };
      const retained = this.core.accessor.get(IRetainedUsageService);
      if (retained.prepareReadModel !== undefined) {
        const progress = await retained.prepareReadModel({ deadlineAt, recordLimit: factBudget.remainingRecords, signal });
        if (!progress.complete) { this.modelIncompleteReason = progress.incompleteReason ?? null; return; }
      }
      await model.catalog(summaries.map((summary) => ({ ...summary, deleted: false })), sources, true);
      signal.throwIfAborted();
      this.modelReady = epoch === this.replayEpoch;
      this.modelVerifiedAt = this.now();
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
