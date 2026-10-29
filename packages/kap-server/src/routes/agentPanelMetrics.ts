import {
  IAgentStateService,
  IAgentProfileService,
  IAgentUsageService,
  IAgentTokenCountingService,
  IInstantiationService,
  IFileSystemStorageService,
  ILogService,
  sessionScopeOf,
  workspacePersistenceScope,
  type IAgentScopeHandle,
  type Scope,
  type TokenUsage,
} from '@kiki/agent-core-v2';
import { panelAccountingKey } from '@kiki/agent-core-v2/agent/usage/panelAccounting';
import { summarizeUsageFacts } from '@kiki/agent-core-v2/agent/usage/usageFact';
import type { AgentPanelMetrics } from '@kiki/protocol';
import type { IModelPricingService } from '../pricing/modelPricingService';
import { usageRuntime } from '../usage/usageRuntime';

const EMPTY_USAGE: TokenUsage = {
  inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0,
};

type PersistedUsage = {
  usage: TokenUsage;
  byModel: Record<string, TokenUsage>;
  byModelMask?: Readonly<Record<string, Readonly<Record<string, TokenUsage>>>>;
  records: number;
  knownUsageRecords: number;
  partial: boolean;
  complete: boolean;
};

interface PersistedMetricsCacheEntry {
  readonly expiresAt: number;
  readonly usage: PersistedUsage;
}

interface PersistedMetricsScanResult {
  readonly usages: Readonly<Record<string, PersistedUsage>>;
  readonly budgetCapped: boolean;
}

interface PersistedMetricsFlight {
  readonly controller: AbortController;
  readonly promise: Promise<PersistedMetricsScanResult>;
  waiters: number;
  sharedWaiters: number;
  settled: boolean;
  detach: boolean;
}

interface PersistedMetricsState {
  readonly cache: Map<string, PersistedMetricsCacheEntry>;
  readonly flights: Map<string, PersistedMetricsFlight>;
  readonly liveSeen: Map<string, Set<string>>;
  revision: number;
}

export interface PersistedAgentPanelMetricsLimits {
  readonly maxRecords: number;
  readonly maxBytes: number;
  readonly wallTimeMs: number;
}

export interface PersistedAgentPanelMetricsOptions {
  readonly signal?: AbortSignal;
  readonly agentIds?: readonly string[];
  readonly skipAgentIds?: readonly string[];
  readonly mutableAgentIds?: readonly string[];
  readonly mutableUsageRecords?: Readonly<Record<string, number>>;
  readonly limits?: Partial<PersistedAgentPanelMetricsLimits>;
  readonly settle?: boolean;
  readonly complete?: boolean;
}

const PERSISTED_METRICS_MUTABLE_CACHE_TTL_MS = 30_000;
const PERSISTED_METRICS_IMMUTABLE_CACHE_TTL_MS = 600_000;
const PERSISTED_METRICS_SCAN_MAX_RECORDS = 100_000;
const PERSISTED_METRICS_SCAN_MAX_BYTES = 128 * 1024 * 1024;
const PERSISTED_METRICS_SCAN_WALL_TIME_MS = 5_000;
const PERSISTED_METRICS_CACHE_MAX_ENTRIES = 1024;
const persistedMetricsStates = new WeakMap<Scope, PersistedMetricsState>();

export function readAgentPanelMetrics(agent: IAgentScopeHandle, pricing: IModelPricingService): AgentPanelMetrics {
  const usage = agent.accessor.get(IAgentUsageService).status();
  const accounting = agent.accessor.get(IAgentStateService).get(panelAccountingKey);
  const profile = agent.accessor.get(IAgentProfileService).data();
  const hasKnownProvenance = accounting.knownRecords !== undefined &&
    accounting.knownByModel !== undefined;
  const knownRecords = hasKnownProvenance
    ? accounting.knownRecords
    : accounting.incomplete ? 0 : accounting.records;
  const knownByModel = hasKnownProvenance
    ? accounting.knownByModel
    : accounting.incomplete ? {} : usage.byModel ?? {};
  const total = knownRecords > 0 ? sumUsage(Object.values(knownByModel)) : undefined;
  const hasKnownUsage = total !== undefined;
  const costSummary = summarizeCosts(
    Object.entries(accounting.knownByModelMask ?? Object.fromEntries(Object.entries(knownByModel).map(([model, value]) => [model, { legacy: value }]))).flatMap(([model, masks]) => Object.values(masks).map((value) => pricing.calculate(model, value))),
  );
  const cost = hasKnownUsage ? costSummary.total : null;
  const input = total === undefined ? null : total.inputOther + total.inputCacheRead + total.inputCacheCreation;
  return {
    inputTokens: input,
    outputTokens: total?.output ?? null,
    cacheReadTokens: total?.inputCacheRead ?? null,
    cacheWriteTokens: total?.inputCacheCreation ?? null,
    totalTokens: input === null || total === undefined ? null : input + total.output,
    totalCostUsd: cost,
    contextTokens: profile.executorId !== undefined && profile.executorId !== 'native'
      ? null : agent.accessor.get(IAgentTokenCountingService).statusSize(),
    contextLimit: (profile.modelCapabilities.max_input_tokens ?? profile.modelCapabilities.max_context_tokens) || null,
    compactionCount: profile.executorId !== undefined && profile.executorId !== 'native' ? null : accounting.successfulCompactions,
    usagePartial: accounting.incomplete,
    usageComplete: hasKnownProvenance || !accounting.incomplete,
    costPartial: accounting.incomplete || !hasKnownUsage || costSummary.partial,
    usageSource: 'live',
  };
}

export async function readPersistedAgentPanelMetrics(
  core: Scope,
  workspaceId: string,
  sessionId: string,
  pricing: IModelPricingService,
  options: PersistedAgentPanelMetricsOptions = {},
): Promise<Readonly<Record<string, AgentPanelMetrics>>> {
  options.signal?.throwIfAborted();
  const state = persistedMetricsState(core);
  const log = core.accessor.get(ILogService);
  const sessionScope = sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId);
  const skip = new Set(options.skipAgentIds ?? []);
  const requested = options.agentIds === undefined
    ? await core.accessor.get(IFileSystemStorageService).list(`${sessionScope}/agents`)
    : [...new Set(options.agentIds)];
  const wanted = requested.filter((agentId) => !skip.has(agentId));
  const mutable = new Set(options.mutableAgentIds ?? []);
  const keyFor = (agentId: string) => {
    const records = options.mutableUsageRecords?.[agentId];
    const key = agentMetricsCacheKey(workspaceId, sessionId, agentId);
    return records === undefined ? key : `${key}\0usage:${records}`;
  };
  const liveSeenKey = `${workspaceId}\0${sessionId}`;
  const liveSeen = state.liveSeen.get(liveSeenKey) ?? new Set<string>();
  const liveNow = new Set([...skip, ...mutable]);
  for (const agentId of liveNow) {
    if (!liveSeen.has(agentId)) {
      liveSeen.add(agentId);
      state.cache.delete(agentMetricsCacheKey(workspaceId, sessionId, agentId));
    }
  }
  for (const agentId of liveSeen) {
    if (!liveNow.has(agentId)) {
      liveSeen.delete(agentId);
      state.cache.delete(agentMetricsCacheKey(workspaceId, sessionId, agentId));
    }
  }
  if (liveSeen.size === 0) state.liveSeen.delete(liveSeenKey);
  else state.liveSeen.set(liveSeenKey, liveSeen);
  const result = new Map<string, AgentPanelMetrics>();
  const missing: string[] = [];
  const now = Date.now();
  for (const agentId of wanted) {
    const cached = state.cache.get(keyFor(agentId));
    if (cached !== undefined && cached.expiresAt > now) result.set(agentId, toPersistedMetrics(cached.usage, pricing));
    else missing.push(agentId);
  }
  if (missing.length === 0) return Object.freeze(Object.fromEntries(result));
  if (options.settle === false) {
    for (const agentId of missing) result.set(agentId, toPersistedMetrics(emptyPersistedUsage(true)));
    return Object.freeze(Object.fromEntries(result));
  }
  const limitsKey = [
    options.limits?.maxRecords ?? PERSISTED_METRICS_SCAN_MAX_RECORDS,
    options.limits?.maxBytes ?? PERSISTED_METRICS_SCAN_MAX_BYTES,
    options.limits?.wallTimeMs ?? PERSISTED_METRICS_SCAN_WALL_TIME_MS,
  ].join(':');
  const flightKey = `${missing.toSorted().map(keyFor).join('\0')}\0${limitsKey}`;
  let flight = state.flights.get(flightKey);
  if (flight !== undefined) {
    flight.detach ||= options.complete === true;
    flight.sharedWaiters += 1;
    log.info('agent panel persisted metrics scan shared', {
      workspace_id: workspaceId, session_id: sessionId, cache_state: 'shared',
      targeted: options.agentIds !== undefined,
    });
  } else {
    log.info('agent panel persisted metrics cache miss', {
      workspace_id: workspaceId, session_id: sessionId, cache_state: 'miss',
      targeted: options.agentIds !== undefined,
    });
    const controller = new AbortController();
    const revision = state.revision;
    let created!: PersistedMetricsFlight;
    const promise = Promise.resolve().then(() => scanPersistedAgentPanelMetrics(
      core, workspaceId, sessionId, missing, options.agentIds !== undefined,
      options.limits,
      controller.signal, () => created.sharedWaiters,
    )).then((scanResult) => {
      if (scanResult.budgetCapped || revision !== state.revision || controller.signal.aborted) return scanResult;
      for (const [agentId, usage] of Object.entries(scanResult.usages)) {
        const ttl = mutable.has(agentId)
          ? PERSISTED_METRICS_MUTABLE_CACHE_TTL_MS
          : PERSISTED_METRICS_IMMUTABLE_CACHE_TTL_MS;
        cachePersistedMetrics(state, keyFor(agentId), {
          expiresAt: Date.now() + ttl,
          usage,
        });
      }
      return scanResult;
    }).finally(() => {
      created.settled = true;
      if (state.flights.get(flightKey) === created) state.flights.delete(flightKey);
    });
    created = { controller, promise, waiters: 0, sharedWaiters: 0, settled: false, detach: options.complete === true };
    void promise.catch(() => undefined);
    flight = created;
    state.flights.set(flightKey, flight);
  }
  const scanned = await waitForPersistedMetricsFlight(flight, options.signal);
  for (const agentId of missing) {
    const usage = scanned.usages[agentId]
      ?? state.cache.get(keyFor(agentId))?.usage
      ?? emptyPersistedUsage(true);
    result.set(agentId, toPersistedMetrics(usage, pricing));
  }
  return Object.freeze(Object.fromEntries(result));
}

function agentMetricsCacheKey(workspaceId: string, sessionId: string, agentId: string): string {
  return `${workspaceId}\0${sessionId}\0${agentId}`;
}

function cachePersistedMetrics(
  state: PersistedMetricsState,
  key: string,
  entry: PersistedMetricsCacheEntry,
): void {
  if (!state.cache.has(key) && state.cache.size >= PERSISTED_METRICS_CACHE_MAX_ENTRIES) {
    const oldest = state.cache.keys().next().value;
    if (oldest !== undefined) state.cache.delete(oldest);
  }
  state.cache.set(key, entry);
}

function persistedMetricsState(core: Scope): PersistedMetricsState {
  let state = persistedMetricsStates.get(core);
  if (state === undefined) {
    state = { cache: new Map(), flights: new Map(), liveSeen: new Map(), revision: 0 };
    persistedMetricsStates.set(core, state);
    const captured = state;
    const { sources } = usageRuntime(core);
    const subscription = sources.onDidChange((key) => {
      captured.revision++;
      for (const cacheKey of captured.cache.keys()) {
        if (key === undefined || cacheKey.startsWith(`${key}\0`)) captured.cache.delete(cacheKey);
      }
    });
    void sources.ready;
    core.accessor.get(IInstantiationService).onWillDispose(() => {
      subscription.dispose();
      for (const flight of captured.flights.values()) flight.controller.abort();
      captured.cache.clear();
      persistedMetricsStates.delete(core);
    });
  }
  return state;
}

async function waitForPersistedMetricsFlight(
  flight: PersistedMetricsFlight,
  signal?: AbortSignal,
): Promise<PersistedMetricsScanResult> {
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
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    flight.waiters -= 1;
    if (flight.waiters === 0 && !flight.settled && !flight.detach) {
      flight.controller.abort(new DOMException('No agent panel metrics waiters remain', 'AbortError'));
    }
  }
}

async function scanPersistedAgentPanelMetrics(
  core: Scope,
  workspaceId: string,
  sessionId: string,
  agentIds: readonly string[],
  targeted: boolean,
  requestedLimits: Partial<PersistedAgentPanelMetricsLimits> | undefined,
  signal: AbortSignal,
  sharedWaiters: () => number,
): Promise<PersistedMetricsScanResult> {
  const startedAt = Date.now();
  const rows = await usageRuntime(core).service.readAgentUsage(workspaceId, sessionId, agentIds, {
    signal,
    summaryOnly: true,
    maxRecords: requestedLimits?.maxRecords ?? PERSISTED_METRICS_SCAN_MAX_RECORDS,
    maxBytes: requestedLimits?.maxBytes ?? PERSISTED_METRICS_SCAN_MAX_BYTES,
    deadlineAt: startedAt + (requestedLimits?.wallTimeMs ?? PERSISTED_METRICS_SCAN_WALL_TIME_MS),
  });
  const usages: Record<string, PersistedUsage> = {};
  let partial = false;
  for (const id of agentIds) {
    const row = rows[id];
    const state: PersistedUsage = row?.totals === undefined
      ? emptyPersistedUsage(row?.complete !== true)
      : { ...row.totals, usage: { ...row.totals.usage }, byModel: { ...row.totals.byModel }, partial: row.totals.partial || !row.complete, complete: row.complete };
    if (row?.totals === undefined) Object.assign(state, summarizeUsageFacts(row?.records ?? [], state));
    usages[id] = state;
    partial ||= row?.complete !== true;
  }
  core.accessor.get(ILogService).info('agent panel usage projection read', {
    workspace_id: workspaceId, session_id: sessionId, targeted,
    agents_count: agentIds.length, duration_ms: Date.now() - startedAt,
    shared_waiters_count: sharedWaiters(), partial,
  });
  return { usages, budgetCapped: partial };
}

function emptyPersistedUsage(partial = false): PersistedUsage {
  return {
    usage: { ...EMPTY_USAGE }, byModel: {}, records: 0, knownUsageRecords: 0,
    partial, complete: !partial,
  };
}

function toPersistedMetrics(state: PersistedUsage, pricing?: IModelPricingService): AgentPanelMetrics {
  if (state.records === 0) {
    return {
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      totalTokens: null, totalCostUsd: null, contextTokens: null, contextLimit: null,
      compactionCount: null, usagePartial: state.partial || !state.complete, usageComplete: state.complete, costPartial: true,
      usageSource: 'persisted',
    };
  }
  const hasKnownUsage = state.knownUsageRecords > 0;
  const input = hasKnownUsage
    ? state.usage.inputOther + state.usage.inputCacheRead + state.usage.inputCacheCreation
    : null;
  const output = hasKnownUsage ? state.usage.output : null;
  const usagePartial = state.partial || !state.complete || !hasKnownUsage || state.knownUsageRecords < state.records;
  const costs = summarizeCosts(Object.entries(state.byModelMask ?? Object.fromEntries(Object.entries(state.byModel).map(([model, usage]) => [model, { legacy: usage }]))).flatMap(([model, masks]) => Object.values(masks).map((usage) => pricing?.calculate(model, usage))));
  return {
    inputTokens: input, outputTokens: output,
    cacheReadTokens: hasKnownUsage ? state.usage.inputCacheRead : null,
    cacheWriteTokens: hasKnownUsage ? state.usage.inputCacheCreation : null,
    totalTokens: input === null || output === null ? null : input + output,
    totalCostUsd: costs.total,
    contextTokens: null, contextLimit: null, compactionCount: null,
    usagePartial, usageComplete: state.complete, costPartial: usagePartial || costs.partial,
    usageSource: 'persisted',
  };
}

function sumUsage(values: Iterable<TokenUsage>): TokenUsage | undefined {
  let total: TokenUsage | undefined;
  for (const value of values) {
    if (total === undefined) total = { ...value };
    else addUsage(total, value);
  }
  return total;
}

function summarizeCosts(costs: Iterable<number | undefined>): { total: number | null; partial: boolean } {
  let total = 0;
  let known = false;
  let unknown = false;
  for (const cost of costs) {
    if (cost === undefined || !Number.isFinite(total + cost)) {
      unknown = true;
      continue;
    }
    known = true;
    total += cost;
  }
  return { total: known ? total : null, partial: unknown || !known };
}

function addUsage(target: TokenUsage, value: TokenUsage): void {
  target.inputOther += value.inputOther;
  target.output += value.output;
  target.inputCacheRead += value.inputCacheRead;
  target.inputCacheCreation += value.inputCacheCreation;
}
