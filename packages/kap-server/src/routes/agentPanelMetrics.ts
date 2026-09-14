import {
  AGENT_WIRE_RECORD_KEY,
  IAgentStateService,
  IAgentProfileService,
  IAgentUsageService,
  IAgentTokenCountingService,
  IAppendLogStore,
  IFileSystemStorageService,
  ILogService,
  agentScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
  type IAgentScopeHandle,
  type Scope,
  type TokenUsage,
  type WireRecord,
} from '@kiki/agent-core-v2';
import { panelAccountingKey } from '@kiki/agent-core-v2/agent/usage/panelAccounting';
import type { AgentPanelMetrics } from '@kiki/protocol';
import type { IModelPricingService } from '../pricing/modelPricingService';

const EMPTY_USAGE: TokenUsage = {
  inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0,
};

type PersistedUsage = {
  usage: TokenUsage;
  byModel: Record<string, TokenUsage>;
  records: number;
  knownUsageRecords: number;
  partial: boolean;
  cost: number;
  knownCostRecords: number;
  costPartial: boolean;
  complete: boolean;
};

interface PersistedMetricsCacheEntry {
  readonly expiresAt: number;
  readonly revision: string;
  readonly metrics: Readonly<Record<string, AgentPanelMetrics>>;
}

interface PersistedMetricsFlight {
  readonly controller: AbortController;
  readonly promise: Promise<Readonly<Record<string, AgentPanelMetrics>>>;
  waiters: number;
  sharedWaiters: number;
  settled: boolean;
}

interface PersistedMetricsState {
  readonly cache: Map<string, PersistedMetricsCacheEntry>;
  readonly flights: Map<string, PersistedMetricsFlight>;
}

export interface PersistedAgentPanelMetricsLimits {
  readonly maxRecords: number;
  readonly maxBytes: number;
  readonly wallTimeMs: number;
}

export interface PersistedAgentPanelMetricsOptions {
  readonly signal?: AbortSignal;
  readonly agentIds?: readonly string[];
  readonly limits?: Partial<PersistedAgentPanelMetricsLimits>;
}

const PERSISTED_METRICS_CACHE_TTL_MS = 30_000;
const PERSISTED_METRICS_SCAN_MAX_RECORDS = 100_000;
const PERSISTED_METRICS_SCAN_MAX_BYTES = 128 * 1024 * 1024;
const PERSISTED_METRICS_SCAN_WALL_TIME_MS = 5_000;
const PERSISTED_METRICS_CACHE_MAX_ENTRIES = 256;
const persistedMetricsStates = new WeakMap<Scope, PersistedMetricsState>();

export function readAgentPanelMetrics(agent: IAgentScopeHandle, pricing: IModelPricingService): AgentPanelMetrics {
  const usage = agent.accessor.get(IAgentUsageService).status();
  const accounting = agent.accessor.get(IAgentStateService).get(panelAccountingKey);
  const profile = agent.accessor.get(IAgentProfileService).data();
  const known = accounting.records > 0 && !accounting.incomplete && usage.total !== undefined;
  const total = known ? usage.total : undefined;
  const costSummary = summarizeCosts(
    Object.entries(usage.byModel ?? {}).map(([model, value]) => pricing.calculate(model, value)),
  );
  const cost = known ? costSummary.total : null;
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
    contextLimit: profile.modelCapabilities.max_context_tokens > 0 ? profile.modelCapabilities.max_context_tokens : null,
    compactionCount: profile.executorId !== undefined && profile.executorId !== 'native' ? null : accounting.successfulCompactions,
    usagePartial: accounting.incomplete,
    costPartial: !known || costSummary.partial,
    usageSource: 'live',
  };
}

export async function readPersistedAgentPanelMetrics(
  core: Scope,
  workspaceId: string,
  sessionId: string,
  pricing: IModelPricingService,
  cacheRevision = '',
  options: PersistedAgentPanelMetricsOptions = {},
): Promise<Readonly<Record<string, AgentPanelMetrics>>> {
  options.signal?.throwIfAborted();
  const selection = options.agentIds === undefined ? '*' : [...new Set(options.agentIds)].toSorted().join('\0');
  const cacheKey = `${workspaceId}\0${sessionId}\0${selection}`;
  const flightKey = `${cacheKey}\0${cacheRevision}`;
  const state = persistedMetricsState(core);
  const log = core.accessor.get(ILogService);
  const cached = state.cache.get(cacheKey);
  if (cached !== undefined && cached.revision === cacheRevision && cached.expiresAt > Date.now()) {
    log.info('agent panel persisted metrics cache hit', {
      workspace_id: workspaceId, session_id: sessionId, cache_state: 'hit', targeted: selection !== '*',
    });
    return cached.metrics;
  }
  let flight = state.flights.get(flightKey);
  if (flight !== undefined) {
    flight.sharedWaiters += 1;
    log.info('agent panel persisted metrics scan shared', {
      workspace_id: workspaceId, session_id: sessionId, cache_state: 'shared', targeted: selection !== '*',
    });
    return waitForPersistedMetricsFlight(flight, options.signal);
  }
  log.info('agent panel persisted metrics cache miss', {
    workspace_id: workspaceId, session_id: sessionId, cache_state: 'miss', targeted: selection !== '*',
  });
  const controller = new AbortController();
  let created!: PersistedMetricsFlight;
  const promise = Promise.resolve().then(() => scanPersistedAgentPanelMetrics(
    core, workspaceId, sessionId, pricing, options.agentIds, options.limits, controller.signal,
    () => created.sharedWaiters,
  )).then((metrics) => {
    if (!state.cache.has(cacheKey) && state.cache.size >= PERSISTED_METRICS_CACHE_MAX_ENTRIES) {
      const oldest = state.cache.keys().next().value;
      if (oldest !== undefined) state.cache.delete(oldest);
    }
    state.cache.set(cacheKey, {
      expiresAt: Date.now() + PERSISTED_METRICS_CACHE_TTL_MS,
      revision: cacheRevision,
      metrics,
    });
    return metrics;
  }).finally(() => {
    created.settled = true;
    if (state.flights.get(flightKey) === created) state.flights.delete(flightKey);
  });
  created = { controller, promise, waiters: 0, sharedWaiters: 0, settled: false };
  flight = created;
  state.flights.set(flightKey, flight);
  return waitForPersistedMetricsFlight(flight, options.signal);
}

function persistedMetricsState(core: Scope): PersistedMetricsState {
  let state = persistedMetricsStates.get(core);
  if (state === undefined) {
    state = { cache: new Map(), flights: new Map() };
    persistedMetricsStates.set(core, state);
  }
  return state;
}

async function waitForPersistedMetricsFlight(
  flight: PersistedMetricsFlight,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, AgentPanelMetrics>>> {
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
    if (flight.waiters === 0 && !flight.settled) {
      flight.controller.abort(new DOMException('No agent panel metrics waiters remain', 'AbortError'));
    }
  }
}

async function scanPersistedAgentPanelMetrics(
  core: Scope,
  workspaceId: string,
  sessionId: string,
  pricing: IModelPricingService,
  requestedAgentIds: readonly string[] | undefined,
  requestedLimits: Partial<PersistedAgentPanelMetricsLimits> | undefined,
  signal: AbortSignal,
  sharedWaiters: () => number,
): Promise<Readonly<Record<string, AgentPanelMetrics>>> {
  const limits: PersistedAgentPanelMetricsLimits = {
    maxRecords: requestedLimits?.maxRecords ?? PERSISTED_METRICS_SCAN_MAX_RECORDS,
    maxBytes: requestedLimits?.maxBytes ?? PERSISTED_METRICS_SCAN_MAX_BYTES,
    wallTimeMs: requestedLimits?.wallTimeMs ?? PERSISTED_METRICS_SCAN_WALL_TIME_MS,
  };
  const startedAt = Date.now();
  const deadline = new AbortController();
  const combinedSignal = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(() => { deadline.abort(); }, limits.wallTimeMs);
  const log = core.accessor.get(ILogService);
  let files = 0;
  let records = 0;
  let bytes = 0;
  let fileErrors = 0;
  let partialReason: 'record_budget' | 'byte_budget' | 'wall_time_budget' | undefined;
  try {
    const storage = core.accessor.get(IFileSystemStorageService);
    const appendLog = core.accessor.get(IAppendLogStore);
    const sessionScope = sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId);
    const agentIds = requestedAgentIds === undefined
      ? await storage.list(`${sessionScope}/agents`)
      : [...new Set(requestedAgentIds)];
    if (signal.aborted) throw signal.reason ?? new DOMException('The request was aborted', 'AbortError');
    const result = new Map<string, AgentPanelMetrics>();
    if (deadline.signal.aborted) partialReason = 'wall_time_budget';
    for (const agentId of partialReason === undefined ? agentIds : []) {
      const usageState = emptyPersistedUsage();
      files += 1;
      try {
        for await (const raw of appendLog.read<WireRecord>(
          agentScopeOf(sessionScope, agentId), AGENT_WIRE_RECORD_KEY, { signal: combinedSignal },
        )) {
          if (records >= limits.maxRecords) {
            markPersistedUsagePartial(usageState);
            partialReason = 'record_budget';
            break;
          }
          const recordBytes = Buffer.byteLength(JSON.stringify(raw), 'utf8') + 1;
          if (bytes + recordBytes > limits.maxBytes) {
            markPersistedUsagePartial(usageState);
            partialReason = 'byte_budget';
            break;
          }
          records += 1;
          bytes += recordBytes;
          if (raw.type === 'usage.record') applyPersistedUsageRecord(usageState, raw, pricing);
        }
      } catch {
        if (signal.aborted) throw signal.reason ?? new DOMException('The request was aborted', 'AbortError');
        if (deadline.signal.aborted) {
          markPersistedUsagePartial(usageState);
          partialReason = 'wall_time_budget';
        } else {
          fileErrors += 1;
          markPersistedUsagePartial(usageState);
        }
      }
      result.set(agentId, toPersistedMetrics(usageState));
      if (partialReason !== undefined) break;
    }
    if (partialReason !== undefined) {
      for (const agentId of agentIds) {
        if (!result.has(agentId)) result.set(agentId, toPersistedMetrics(emptyPersistedUsage(true)));
      }
    }
    const metrics = Object.freeze(Object.fromEntries(result));
    const payload = {
      workspace_id: workspaceId, session_id: sessionId, cache_state: 'miss',
      targeted: requestedAgentIds !== undefined,
      files_count: files, records_count: records, bytes_count: bytes,
      duration_ms: Date.now() - startedAt,
      shared_waiters_count: sharedWaiters(), file_errors_count: fileErrors,
      cancellation_reason: partialReason,
    };
    if (partialReason === undefined) log.info('agent panel persisted metrics scan completed', payload);
    else log.warn('agent panel persisted metrics scan budget reached', payload);
    return metrics;
  } catch (error) {
    log.warn('agent panel persisted metrics scan cancelled', {
      workspace_id: workspaceId, session_id: sessionId, cache_state: 'miss',
      targeted: requestedAgentIds !== undefined,
      files_count: files, records_count: records, bytes_count: bytes,
      duration_ms: Date.now() - startedAt,
      shared_waiters_count: sharedWaiters(), file_errors_count: fileErrors,
      cancellation_reason: signal.aborted ? 'no_waiters' : deadline.signal.aborted ? 'wall_time_budget' : 'error',
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function emptyPersistedUsage(partial = false): PersistedUsage {
  return {
    usage: { ...EMPTY_USAGE }, byModel: {}, records: 0, knownUsageRecords: 0,
    partial, cost: 0, knownCostRecords: 0, costPartial: partial, complete: !partial,
  };
}

function markPersistedUsagePartial(state: PersistedUsage): void {
  state.partial = true;
  state.complete = false;
  state.costPartial = true;
}

function applyPersistedUsageRecord(
  state: PersistedUsage,
  raw: WireRecord,
  pricing: IModelPricingService,
): void {
  const record = persistedUsageRecord(raw);
  if (record === undefined) {
    markPersistedUsagePartial(state);
    return;
  }
  state.records += 1;
  const reported = record.usage.inputOther + record.usage.output +
    record.usage.inputCacheRead + record.usage.inputCacheCreation;
  const known = record.usageKnown !== false && !(record.usageKnown === undefined && reported === 0);
  if (!known) {
    state.partial = true;
    state.costPartial = true;
    return;
  }
  state.knownUsageRecords += 1;
  addUsage(state.usage, record.usage);
  const byModel = state.byModel[record.model] ?? { ...EMPTY_USAGE };
  addUsage(byModel, record.usage);
  state.byModel[record.model] = byModel;
  const cost = pricing.calculate(record.model, record.usage);
  if (cost === undefined) state.costPartial = true;
  else {
    state.knownCostRecords += 1;
    state.cost += cost;
  }
}

function toPersistedMetrics(state: PersistedUsage): AgentPanelMetrics {
  if (state.records === 0) {
    return {
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null,
      totalTokens: null, totalCostUsd: null, contextTokens: null, contextLimit: null,
      compactionCount: null, usagePartial: state.partial || !state.complete, costPartial: true,
      usageSource: 'persisted',
    };
  }
  const hasKnownUsage = state.knownUsageRecords > 0;
  const input = hasKnownUsage
    ? state.usage.inputOther + state.usage.inputCacheRead + state.usage.inputCacheCreation
    : null;
  const output = hasKnownUsage ? state.usage.output : null;
  const usagePartial = state.partial || !state.complete || !hasKnownUsage || state.knownUsageRecords < state.records;
  const hasKnownCost = state.knownCostRecords > 0;
  return {
    inputTokens: input, outputTokens: output,
    cacheReadTokens: hasKnownUsage ? state.usage.inputCacheRead : null,
    cacheWriteTokens: hasKnownUsage ? state.usage.inputCacheCreation : null,
    totalTokens: input === null || output === null ? null : input + output,
    totalCostUsd: hasKnownCost ? state.cost : null,
    contextTokens: null, contextLimit: null, compactionCount: null,
    usagePartial, costPartial: state.costPartial || !hasKnownCost,
    usageSource: 'persisted',
  };
}

function summarizeCosts(costs: Iterable<number | undefined>): { total: number | null; partial: boolean } {
  let total = 0;
  let known = false;
  let unknown = false;
  for (const cost of costs) {
    if (cost === undefined) {
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

function persistedUsageRecord(raw: WireRecord): { model: string; usage: TokenUsage; usageKnown?: boolean } | undefined {
  const model = typeof raw['model'] === 'string' ? raw['model'] : undefined;
  const usage = raw['usage'] as Partial<TokenUsage> | undefined;
  const usageKnown = raw['usageKnown'];
  if (model === undefined || usage === undefined || (usageKnown !== undefined && typeof usageKnown !== 'boolean')) {
    return undefined;
  }
  const values = [usage.inputOther, usage.output, usage.inputCacheRead, usage.inputCacheCreation];
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return undefined;
  return { model, usage: {
    inputOther: usage.inputOther as number, output: usage.output as number,
    inputCacheRead: usage.inputCacheRead as number, inputCacheCreation: usage.inputCacheCreation as number,
  }, usageKnown: usageKnown as boolean | undefined };
}
