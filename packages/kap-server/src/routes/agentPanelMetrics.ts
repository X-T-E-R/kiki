import {
  AGENT_WIRE_RECORD_KEY,
  IAgentStateService,
  IAgentProfileService,
  IAgentUsageService,
  IAgentTokenCountingService,
  IAppendLogStore,
  IFileSystemStorageService,
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

const PERSISTED_METRICS_CACHE_TTL_MS = 30_000;
const PERSISTED_METRICS_CACHE_MAX_ENTRIES = 256;
const persistedMetricsCache = new WeakMap<Scope, Map<string, PersistedMetricsCacheEntry>>();

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
): Promise<Readonly<Record<string, AgentPanelMetrics>>> {
  const cacheKey = `${workspaceId}\0${sessionId}`;
  const now = Date.now();
  const cache = persistedMetricsCache.get(core) ?? new Map<string, PersistedMetricsCacheEntry>();
  persistedMetricsCache.set(core, cache);
  const cached = cache.get(cacheKey);
  if (cached !== undefined && cached.revision === cacheRevision && cached.expiresAt > now) return cached.metrics;
  const storage = core.accessor.get(IFileSystemStorageService);
  const appendLog = core.accessor.get(IAppendLogStore);
  const sessionScope = sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId);
  const result = new Map<string, AgentPanelMetrics>();
  const agentIds = await storage.list(`${sessionScope}/agents`);
  for (const agentId of agentIds) {
    const state: PersistedUsage = {
      usage: { ...EMPTY_USAGE }, byModel: {}, records: 0, knownUsageRecords: 0,
      partial: false, cost: 0, knownCostRecords: 0, costPartial: false, complete: true,
    };
    try {
      for await (const raw of appendLog.read<WireRecord>(agentScopeOf(sessionScope, agentId), AGENT_WIRE_RECORD_KEY)) {
        if (raw.type !== 'usage.record') continue;
        const record = persistedUsageRecord(raw);
        if (record === undefined) {
          state.partial = true;
          state.complete = false;
          state.costPartial = true;
          continue;
        }
        state.records += 1;
        const reported = record.usage.inputOther + record.usage.output +
          record.usage.inputCacheRead + record.usage.inputCacheCreation;
        const known = record.usageKnown !== false && !(record.usageKnown === undefined && reported === 0);
        if (!known) {
          state.partial = true;
          state.costPartial = true;
          continue;
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
    } catch {
      state.partial = true;
      state.complete = false;
      state.costPartial = true;
    }
    result.set(agentId, toPersistedMetrics(state));
  }
  const metrics = Object.freeze(Object.fromEntries(result));
  if (!cache.has(cacheKey) && cache.size >= PERSISTED_METRICS_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey, {
    expiresAt: now + PERSISTED_METRICS_CACHE_TTL_MS,
    revision: cacheRevision,
    metrics,
  });
  return metrics;
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
