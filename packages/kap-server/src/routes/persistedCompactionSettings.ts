import {
  agentScopeOf,
  IConfigService,
  IModelCatalog,
  IModelService,
  MAIN_AGENT_ID,
  sessionScopeOf,
  workspacePersistenceScope,
  type Scope,
} from '@kiki/agent-core-v2';
import { ICpuWorkerService } from '@kiki/agent-core-v2/app/cpuWorker/cpuWorkerService';
import { IAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '@kiki/agent-core-v2/persistence/interface/storage';
import { logicalByteSize, readLogicalBytes } from '@kiki/agent-core-v2/persistence/coldSegmentLog';
import { AGENT_WIRE_RECORD_KEY, isWireRecord } from '@kiki/agent-core-v2/wire/record';
import { readPersistedAgentCheckpoint, readPersistedCheckpointStatToken } from '@kiki/agent-core-v2/session/persistedAgentCheckpoint';
import { materializeAdhocModel } from '@kiki/agent-core-v2/session/adhocEndpoint/adhocEndpointRuntime';
import { modelWithUsage } from '@kiki/agent-core-v2/kosong/model/parameters';
import { mergeModelParameters, resolveModelProfileEntry } from '@kiki/agent-core-v2/app/agentProfileCatalog/modelProfileOverlay';
import { resolveAutoCompact, type ResolvedAutoCompact } from '@kiki/agent-core-v2/agent/fullCompaction/autoCompact';
import { AutoCompactOverrideChanged, autoCompactOverrideKey } from '@kiki/agent-core-v2/agent/fullCompaction/autoCompactOps';
import { ContextStrategyOverrideChanged, contextStrategyOverrideKey } from '@kiki/agent-core-v2/agent/fullCompaction/contextStrategyOps';
import type { LoopControl } from '@kiki/agent-core-v2/agent/loop/configSection';
import type { AgentMeta } from '@kiki/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { event2FromRecord } from '@kiki/agent-core-v2/app/event/event2';
import type { ContextStrategyStatus } from '@kiki/protocol';
type ContextStrategy = ContextStrategyStatus['strategy'];
import {
  PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET,
  readPersistedAgentProfileSnapshot,
  type PersistedAgentProfileSnapshot,
} from './agentProfileSnapshot';

interface PersistedCompactionOverrides {
  readonly autoCompactOverrides: Record<string, number>;
  readonly contextStrategyOverride: ContextStrategy | null;
}

const OVERRIDE_NAMES = new Set([autoCompactOverrideKey.name, contextStrategyOverrideKey.name]);
const OVERRIDE_MARKERS = [
  `"type":"${AutoCompactOverrideChanged.type}"`,
  `"type":"${ContextStrategyOverrideChanged.type}"`,
];
const COMPACTION_OVERRIDES_CACHE_MAX_ENTRIES = 512;

interface CompactionOverridesCacheEntry {
  readonly key: string;
  readonly value: PersistedCompactionOverrides;
}

interface CompactionOverridesState {
  readonly cache: Map<string, CompactionOverridesCacheEntry>;
  readonly flights: Map<string, Promise<PersistedCompactionOverrides>>;
}

const compactionOverridesStates = new WeakMap<Scope, CompactionOverridesState>();

function compactionOverridesState(core: Scope): CompactionOverridesState {
  let state = compactionOverridesStates.get(core);
  if (state === undefined) {
    state = { cache: new Map(), flights: new Map() };
    compactionOverridesStates.set(core, state);
  }
  return state;
}

function waitForCompactionOverrides(
  promise: Promise<PersistedCompactionOverrides>,
  signal?: AbortSignal,
): Promise<PersistedCompactionOverrides> {
  signal?.throwIfAborted();
  if (signal === undefined) return promise;
  return new Promise<PersistedCompactionOverrides>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('The request was aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function readPersistedCompactionOverrides(
  core: Scope,
  workspaceId: string,
  sessionId: string,
  agentId: string,
  signal?: AbortSignal,
): Promise<PersistedCompactionOverrides> {
  const empty: PersistedCompactionOverrides = { autoCompactOverrides: {}, contextStrategyOverride: null };
  signal?.throwIfAborted();
  const storage = core.accessor.get(IFileSystemStorageService);
  const docs = core.accessor.get(IAtomicDocumentStore);
  let workers: ICpuWorkerService | undefined;
  try { workers = core.accessor.get(ICpuWorkerService); } catch { workers = undefined; }
  const scope = agentScopeOf(sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId), agentId);
  let size: number | undefined;
  let mtime: number | undefined;
  let ckptStat: Awaited<ReturnType<typeof readPersistedCheckpointStatToken>>;
  try {
    [size, mtime, ckptStat] = await Promise.all([
      logicalByteSize(storage, scope, AGENT_WIRE_RECORD_KEY),
      storage.mtime(scope, AGENT_WIRE_RECORD_KEY),
      readPersistedCheckpointStatToken(storage, scope),
    ]);
  } catch {
    return empty;
  }
  signal?.throwIfAborted();
  if (size === undefined) return empty;
  const state = compactionOverridesState(core);
  const versionKey = `${size}:${mtime ?? 0}:${ckptStat.token}`;
  const cached = state.cache.get(scope);
  if (cached !== undefined && ckptStat.distinguishable && cached.key === versionKey) {
    state.cache.delete(scope);
    state.cache.set(scope, cached);
    return cached.value;
  }
  const flightKey = `${scope}\0${versionKey}`;
  let flight = state.flights.get(flightKey);
  if (flight === undefined) {
    flight = (async (): Promise<PersistedCompactionOverrides> => {
      const checkpoint = await readPersistedAgentCheckpoint(docs, storage, scope, size, mtime ?? 0, OVERRIDE_NAMES, workers);
      const autoCompactOverrides: Record<string, number> = {
        ...((checkpoint?.states.get(autoCompactOverrideKey.name) as Record<string, number> | undefined) ?? {}),
      };
      let contextStrategyOverride = (checkpoint?.states.get(contextStrategyOverrideKey.name) as ContextStrategy | null | undefined) ?? null;
      const start = checkpoint !== undefined ? checkpoint.offset : 0;
      if (size - start > PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET || typeof storage.readStream !== 'function' || start >= size) {
        const result = { autoCompactOverrides, contextStrategyOverride };
        if (ckptStat.distinguishable) {
          state.cache.delete(scope);
          state.cache.set(scope, { key: versionKey, value: result });
          while (state.cache.size > COMPACTION_OVERRIDES_CACHE_MAX_ENTRIES) {
            const oldest = state.cache.keys().next().value;
            if (oldest === undefined) break;
            state.cache.delete(oldest);
          }
        }
        return result;
      }
      const decoder = new TextDecoder();
      let pending = '';
      const foldLine = (line: string) => {
        const head = line.slice(0, 96);
        if (!OVERRIDE_MARKERS.some((marker) => head.includes(marker))) return;
        let record: unknown;
        try { record = JSON.parse(line); } catch { return; }
        if (!isWireRecord(record)) return;
        if (record.type === AutoCompactOverrideChanged.type) {
          const event = event2FromRecord(AutoCompactOverrideChanged, record);
          if (event instanceof AutoCompactOverrideChanged) {
            if (event.tokens === null) delete autoCompactOverrides[event.modelId];
            else autoCompactOverrides[event.modelId] = event.tokens;
          }
        } else if (record.type === ContextStrategyOverrideChanged.type) {
          const event = event2FromRecord(ContextStrategyOverrideChanged, record);
          if (event instanceof ContextStrategyOverrideChanged) {
            contextStrategyOverride = event.strategy;
          }
        }
      };
      try {
        for await (const chunk of readLogicalBytes(storage, scope, AGENT_WIRE_RECORD_KEY, { start, end: size - 1 })) {
          pending += decoder.decode(chunk, { stream: true });
          let newline = pending.indexOf('\n');
          while (newline !== -1) {
            const line = pending.slice(0, newline).replace(/\r$/, '');
            pending = pending.slice(newline + 1);
            if (line.length > 0) foldLine(line);
            newline = pending.indexOf('\n');
          }
        }
        pending += decoder.decode();
        if (pending.length > 0) foldLine(pending);
      } catch {
        return { autoCompactOverrides, contextStrategyOverride };
      }
      const result = { autoCompactOverrides, contextStrategyOverride };
      if (ckptStat.distinguishable) {
        const [afterSize, afterMtime, afterCkpt] = await Promise.all([
          logicalByteSize(storage, scope, AGENT_WIRE_RECORD_KEY).catch(() => undefined),
          storage.mtime(scope, AGENT_WIRE_RECORD_KEY).catch(() => undefined),
          readPersistedCheckpointStatToken(storage, scope).catch(() => ({ token: 'untracked', distinguishable: false })),
        ]);
        if (afterSize === size && afterMtime === mtime && afterCkpt.distinguishable && afterCkpt.token === ckptStat.token) {
          state.cache.delete(scope);
          state.cache.set(scope, { key: versionKey, value: result });
          while (state.cache.size > COMPACTION_OVERRIDES_CACHE_MAX_ENTRIES) {
            const oldest = state.cache.keys().next().value;
            if (oldest === undefined) break;
            state.cache.delete(oldest);
          }
        }
      }
      return result;
    })().finally(() => {
      if (state.flights.get(flightKey) === flight) state.flights.delete(flightKey);
    });
    state.flights.set(flightKey, flight);
  }
  return waitForCompactionOverrides(flight, signal);
}

function isExternalProfile(profile: PersistedAgentProfileSnapshot | undefined, metadata: AgentMeta | undefined): boolean {
  const executorId = profile?.executorId ?? metadata?.executor;
  return profile?.driver === 'external' || (executorId !== undefined && executorId !== 'native');
}

export async function readPersistedAutoCompact(
  core: Scope,
  workspaceId: string,
  sessionId: string,
  agentId: string,
  metadata: AgentMeta | undefined,
  signal?: AbortSignal,
): Promise<ResolvedAutoCompact | undefined> {
  const [profile, overrides] = await Promise.all([
    readPersistedAgentProfileSnapshot(core, workspaceId, sessionId, agentId, metadata, signal,
      { inlineByteBudget: PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET }),
    readPersistedCompactionOverrides(core, workspaceId, sessionId, agentId, signal),
  ]);
  if (isExternalProfile(profile, metadata)) return undefined;
  const bound = profile?.boundProfile;
  const endpointModel = profile?.endpoint === undefined ? undefined : materializeAdhocModel(profile.endpoint);
  const modelAlias = profile?.modelAlias ?? metadata?.model ?? endpointModel?.id;
  if (modelAlias === undefined || modelAlias === '') return undefined;
  const position = agentId === MAIN_AGENT_ID ? 'main' : 'sub';
  let model: ReturnType<typeof materializeAdhocModel>;
  try {
    const cognition = bound?.promptBase?.inputs?.cognition;
    const settings = cognition?.modelAlias === modelAlias ? cognition.modelSettings ?? cognition.recipe?.resolved.model : undefined;
    model = endpointModel
      ?? modelWithUsage(core.accessor.get(IModelCatalog).get(modelAlias, settings), cognition?.position ?? position);
  } catch {
    return undefined;
  }
  const models = core.accessor.get(IModelService);
  const entry = endpointModel === undefined
    ? resolveModelProfileEntry(bound?.modelProfiles, model.id, (id) => models.resolveId(id))
    : undefined;
  const budget = mergeModelParameters(model, mergeModelParameters(bound ?? {}, entry)).contextBudget;
  const rawMax = model.capabilities.max_input_tokens ?? model.capabilities.max_context_tokens ?? model.maxContextSize;
  const effectiveMax = budget === undefined ? rawMax : Math.min(rawMax, budget);
  const loopControl = core.accessor.get(IConfigService).get<LoopControl>('loopControl');
  const sessionTokens = overrides.autoCompactOverrides[modelAlias] ?? overrides.autoCompactOverrides[model.id];
  return resolveAutoCompact({
    modelAlias,
    modelCapabilities: {
      ...model.capabilities,
      max_context_tokens: effectiveMax,
      max_input_tokens: effectiveMax,
    },
    maxOutputSize: model.maxOutputSize,
    alwaysThinking: model.alwaysThinking || undefined,
    thinkingLevel: (profile?.thinkingLevel ?? metadata?.thinkingEffort ?? 'off') as import('@kiki/agent-core-v2').ThinkingEffort,
    reservedContextSize: loopControl?.reservedContextSize,
    globalAutoCompact: loopControl?.autoCompact,
    modelAutoCompact: model.autoCompact,
    modelContextStrategy: model.contextStrategy,
    profileAutoCompact: entry?.autoCompact ?? bound?.autoCompact,
    sessionAutoCompact: sessionTokens,
    compactionTriggerRatio: loopControl?.compactionTriggerRatio,
    compactionMaxAttempts: loopControl?.compactionMaxAttempts,
    compactionSoftContextSize: loopControl?.compactionSoftContextSize,
  }, sessionTokens);
}

export async function readPersistedContextStrategy(
  core: Scope,
  workspaceId: string,
  sessionId: string,
  agentId: string,
  metadata: AgentMeta | undefined,
  signal?: AbortSignal,
): Promise<ContextStrategyStatus> {
  const [profile, overrides] = await Promise.all([
    readPersistedAgentProfileSnapshot(core, workspaceId, sessionId, agentId, metadata, signal,
      { inlineByteBudget: PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET }),
    readPersistedCompactionOverrides(core, workspaceId, sessionId, agentId, signal),
  ]);
  if (isExternalProfile(profile, metadata)) {
    return { strategy: 'summarize', source: 'executor', shadow: false };
  }
  const config = core.accessor.get(IConfigService).get<LoopControl>('loopControl');
  const shadow = config?.relayShadow === true;
  const bound = profile?.boundProfile;
  const modelAlias = profile?.modelAlias ?? metadata?.model;
  const models = core.accessor.get(IModelService);
  let resolvedModelId: string | undefined;
  let modelStrategy: ContextStrategy | undefined;
  if (modelAlias !== undefined && modelAlias !== '') {
    try {
      const rawModel = core.accessor.get(IModelCatalog).get(modelAlias);
      resolvedModelId = rawModel.id;
      modelStrategy = rawModel.contextStrategy;
    } catch {
      resolvedModelId = undefined;
    }
    if (modelStrategy === undefined) {
      const resolvedId = models.resolveId(modelAlias) ?? modelAlias;
      const record = models.get(resolvedId);
      modelStrategy = record?.overrides?.contextStrategy ?? record?.contextStrategy;
    }
  }
  const entry = resolvedModelId === undefined
    ? undefined
    : resolveModelProfileEntry(bound?.modelProfiles, resolvedModelId, (id) => models.resolveId(id));
  const profileStrategy = entry?.contextStrategy ?? bound?.contextStrategy;
  if (agentId !== MAIN_AGENT_ID) {
    if (profileStrategy !== undefined) return { strategy: profileStrategy, source: 'profile', shadow };
    if (modelStrategy !== undefined) return { strategy: modelStrategy, source: 'model', shadow };
    return { strategy: config?.subagentContextStrategy ?? 'summarize', source: 'subagent', shadow };
  }
  if (overrides.contextStrategyOverride !== null) return { strategy: overrides.contextStrategyOverride, source: 'session', shadow };
  if (profileStrategy !== undefined) return { strategy: profileStrategy, source: 'profile', shadow };
  if (modelStrategy !== undefined) return { strategy: modelStrategy, source: 'model', shadow };
  if (config?.contextStrategy !== undefined) return { strategy: config.contextStrategy, source: 'global', shadow };
  return { strategy: 'summarize', source: 'default', shadow };
}
