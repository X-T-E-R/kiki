import type { ServicesAccessor } from '#/_base/di/instantiation';
import { ICpuWorkerService } from '#/app/cpuWorker/cpuWorkerService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { logicalByteSize, readLogicalBytes } from '#/persistence/coldSegmentLog';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  readPersistedAgentCheckpoint,
  readPersistedCheckpointStatToken,
  type PersistedCheckpointStatToken,
} from './persistedAgentCheckpoint';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { agentScopeOf, sessionScopeOf, workspacePersistenceScope } from '#/workspace/sessionLifecycle/internal/addressing';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { event2FromRecord, type Event2, type Event2Class } from '#/app/event/event2';
import {
  ConfigUpdate,
  ProfileBind,
  ToolsResetActiveTools,
  ToolsSetActiveTools,
  profileKey,
  profileActiveToolsKey,
  ToolsPolicyRefreshed,
  type ProfileModelState,
} from '#/agent/profile/profileOps';
import { AgentModelSwitch } from '#/agent/modelSwitch/modelSwitchEvent';
import { effectiveToolBinding } from '#/agent/profile/toolBinding';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { CreateAgentOptions } from '#/session/agentLifecycle/agentLifecycle';
import { subagentProfileName } from '#/session/agentLifecycle/subagentMetadata';
import { LlmRequest, promptRequestEvidence } from '#/agent/llmRequester/llmRequestOps';
import { McpToolsDiscovered } from '#/agent/mcp/mcpDiscoveryOps';

type PersistedProfileFields = Pick<ProfileModelState,
  'driver' | 'personaId' | 'personaRevision' | 'personaOverrides' | 'persona' | 'roomPrompt' |
  'endpoint' | 'execution' | 'modelAlias' | 'profileName' | 'profileDefinitionId' | 'routeId' |
  'lockedModelAlias' | 'lockedThinkingEffort' | 'executionRestriction' |
  'allowParentNotify' | 'executorId' | 'executorProtocol' | 'thinkingLevel' | 'thinkingEffortExplicit' | 'thinkingEffortAdjusted' |
  'bindingAdvisories' | 'serviceTier' | 'toolAllowPolicies' | 'disallowedTools' | 'disabledToolGroups' |
  'canSpawnSubagents' | 'allowedSubagents' | 'preferredSubagents' | 'denySubagents' | 'subagentLeases' |
  'spawnPolicy' | 'appliedLease' | 'boundProfile' | 'toolOverride' | 'memoryReadContext'>;

export interface PersistedAgentProfileSnapshot extends Omit<PersistedProfileFields, 'thinkingLevel'> {
  readonly source: 'wire' | 'metadata';
  readonly wireCoverage?: 'unscanned';
  readonly thinkingLevel?: string;
  readonly activeToolNames?: readonly string[];
  readonly activeToolsKnown: boolean;
  readonly promptRequest?: import('@kiki/protocol').AgentPromptRequest;
  readonly mcpTools?: readonly Pick<McpToolsDiscovered, 'serverName' | 'tools' | 'enabledNames' | 'collisions'>[];
}

export interface PersistedAgentProfileReadOptions {
  readonly inlineByteBudget?: number;
  readonly skipRequestAndMcp?: boolean;
}

export const PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET = 8 << 20;

export type AgentProfileSnapshotHost = { readonly accessor: ServicesAccessor } | {
  readonly storage: IFileSystemStorageService;
  readonly appendLog: IAppendLogStore;
  readonly docs?: IAtomicDocumentStore;
  readonly workers?: ICpuWorkerService;
};

interface PersistedAgentProfileCacheEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly usedCheckpoint: boolean;
  readonly hasRequestAndMcp: boolean;
  readonly checkpointToken: string;
  readonly metadataKey: string;
  readonly snapshot: PersistedAgentProfileSnapshot | undefined;
}

const PERSISTED_AGENT_PROFILE_CACHE_MAX_ENTRIES = 1024;
const PERSISTED_AGENT_PROFILE_REQUEST_PARSE_MAX_BYTES = 1 << 20;
const persistedAgentProfileCaches = new WeakMap<AgentProfileSnapshotHost, Map<string, PersistedAgentProfileCacheEntry>>();

interface PersistedAgentProfileFlight {
  readonly size: number;
  readonly mtimeMs: number;
  readonly checkpointToken: string;
  readonly metadataKey: string;
  readonly promise: Promise<PersistedAgentProfileSnapshot | undefined>;
}

const persistedAgentProfileFlights = new WeakMap<AgentProfileSnapshotHost, Map<string, PersistedAgentProfileFlight>>();

const PROFILE_LINE_MARKERS = [
  `"type":"${ProfileBind.type}"`,
  `"type":"${ConfigUpdate.type}"`,
  `"type":"${AgentModelSwitch.type}"`,
  `"type":"${ToolsSetActiveTools.type}"`,
  `"type":"${ToolsResetActiveTools.type}"`,
  `"type":"${ToolsPolicyRefreshed.type}"`,
  `"type":"${LlmRequest.type}"`,
  `"type":"${McpToolsDiscovered.type}"`,
];

const PROFILE_EVENT_CLASSES: ReadonlyMap<string, Event2Class> = new Map<string, Event2Class>([
  [ProfileBind.type, ProfileBind],
  [ConfigUpdate.type, ConfigUpdate],
  [AgentModelSwitch.type, AgentModelSwitch],
  [ToolsSetActiveTools.type, ToolsSetActiveTools],
  [ToolsResetActiveTools.type, ToolsResetActiveTools],
  [ToolsPolicyRefreshed.type, ToolsPolicyRefreshed],
]);

const REPLAY_CONTEXT = {
  silent: true,
  checkpoint: () => {},
  clearCheckpoints: () => {},
  undoToCheckpoint: (_count: number) => {},
  emit: (_event: Event2) => {},
};

export async function readPersistedAgentProfileSnapshot(
  core: AgentProfileSnapshotHost,
  workspaceId: string,
  sessionId: string,
  agentId: string,
  metadata: AgentMeta | undefined,
  signal?: AbortSignal,
  options?: PersistedAgentProfileReadOptions,
): Promise<PersistedAgentProfileSnapshot | undefined> {
  signal?.throwIfAborted();
  const scope = agentScopeOf(
    sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId),
    agentId,
  );
  const storage = 'accessor' in core ? core.accessor.get(IFileSystemStorageService) : core.storage;
  const appendLog = 'accessor' in core ? core.accessor.get(IAppendLogStore) : core.appendLog;
  let size: number;
  let mtimeMs: number;
  let ckptStat: PersistedCheckpointStatToken;
  try {
    [size, mtimeMs, ckptStat] = await Promise.all([
      logicalByteSize(storage, scope, AGENT_WIRE_RECORD_KEY).then((value) => value ?? 0),
      storage.mtime(scope, AGENT_WIRE_RECORD_KEY).then((value) => value ?? 0),
      readPersistedCheckpointStatToken(storage, scope),
    ]);
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason ?? error;
    return metadataSnapshot(metadata);
  }
  signal?.throwIfAborted();
  const inlineByteBudget = options?.inlineByteBudget;
  const skipRequestAndMcp = options?.skipRequestAndMcp === true;
  const exceedsBudget = inlineByteBudget !== undefined && size > inlineByteBudget;
  const usesCheckpoint = exceedsBudget || (skipRequestAndMcp && ckptStat.distinguishable && ckptStat.token !== 'none');
  const checkpointToken = usesCheckpoint ? ckptStat.token : 'full';
  const metadataKey = persistedMetadataKey(metadata);
  const cache = persistedAgentProfileCache(core);
  const cached = cache.get(scope);
  if (cached !== undefined) {
    const checkpointValid = !cached.usedCheckpoint || (ckptStat.distinguishable && cached.checkpointToken === ckptStat.token);
    const requestCompatible = skipRequestAndMcp || cached.hasRequestAndMcp;
    if (cached.size === size && cached.mtimeMs === mtimeMs && cached.metadataKey === metadataKey && checkpointValid && requestCompatible) {
      cache.delete(scope);
      cache.set(scope, cached);
      return cached.snapshot;
    }
    if (!requestCompatible) {
      cache.delete(scope);
    } else if (cached.size !== size || cached.mtimeMs !== mtimeMs || cached.metadataKey !== metadataKey || !checkpointValid) {
      cache.delete(scope);
    }
  }
  const flightKey = usesCheckpoint
    ? `${scope}:budget:${inlineByteBudget ?? 'none'}:skip:${skipRequestAndMcp ? '1' : '0'}:ckpt:${checkpointToken}`
    : scope;
  const flights = persistedAgentProfileFlightMap(core);
  let flight = flights.get(flightKey);
  if (
    flight === undefined ||
    flight.size !== size ||
    flight.mtimeMs !== mtimeMs ||
    flight.checkpointToken !== checkpointToken ||
    flight.metadataKey !== metadataKey
  ) {
    const docs = 'accessor' in core ? core.accessor.get(IAtomicDocumentStore) : core.docs;
    let workers: ICpuWorkerService | undefined;
    if ('accessor' in core) {
      try { workers = core.accessor.get(ICpuWorkerService); } catch { workers = undefined; }
    } else {
      workers = core.workers;
    }
    const promise = (async (): Promise<PersistedAgentProfileSnapshot | undefined> => {
      const checkpoint = usesCheckpoint
        ? await readPersistedAgentCheckpoint(docs, storage, scope, size, mtimeMs, new Set([profileKey.name, profileActiveToolsKey.name]), workers)
        : undefined;
      const validCheckpoint =
        checkpoint !== undefined &&
        checkpoint.states.has(profileKey.name) &&
        checkpoint.states.has(profileActiveToolsKey.name) &&
        (inlineByteBudget === undefined || size - checkpoint.offset <= inlineByteBudget);
      if (exceedsBudget && !validCheckpoint) {
        const fallback = metadataSnapshot(metadata);
        return fallback === undefined ? undefined : { ...fallback, wireCoverage: 'unscanned' };
      }
      const effectiveCheckpoint = validCheckpoint ? checkpoint : undefined;
      const snapshot = await scanPersistedAgentProfileSnapshot(appendLog, storage, scope, effectiveCheckpoint, size, skipRequestAndMcp)
        .then((value) => value ?? metadataSnapshot(metadata))
        .catch(() => metadataSnapshot(metadata));
      if (effectiveCheckpoint === undefined) {
        cachePersistedAgentProfile(cache, scope, {
          size,
          mtimeMs,
          usedCheckpoint: false,
          hasRequestAndMcp: !skipRequestAndMcp,
          checkpointToken: 'full',
          metadataKey,
          snapshot,
        });
      } else if (ckptStat.distinguishable) {
        const afterCkpt = await readPersistedCheckpointStatToken(storage, scope);
        if (afterCkpt.distinguishable && afterCkpt.token === ckptStat.token) {
          cachePersistedAgentProfile(cache, scope, {
            size,
            mtimeMs,
            usedCheckpoint: true,
            hasRequestAndMcp: false,
            checkpointToken: ckptStat.token,
            metadataKey,
            snapshot,
          });
        }
      }
      return snapshot;
    })().finally(() => {
      if (flights.get(flightKey)?.promise === promise) flights.delete(flightKey);
    });
    flight = { size, mtimeMs, checkpointToken, metadataKey, promise };
    flights.set(flightKey, flight);
  }
  return waitForPersistedAgentProfile(flight.promise, signal);
}

async function waitForPersistedAgentProfile(
  flight: Promise<PersistedAgentProfileSnapshot | undefined>,
  signal?: AbortSignal,
): Promise<PersistedAgentProfileSnapshot | undefined> {
  signal?.throwIfAborted();
  if (signal === undefined) return flight;
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason ?? new DOMException('The request was aborted', 'AbortError'));
    }, { once: true });
  });
  return Promise.race([flight, aborted]);
}

function persistedAgentProfileFlightMap(core: AgentProfileSnapshotHost): Map<string, PersistedAgentProfileFlight> {
  let flights = persistedAgentProfileFlights.get(core);
  if (flights === undefined) {
    flights = new Map();
    persistedAgentProfileFlights.set(core, flights);
  }
  return flights;
}

async function scanPersistedAgentProfileSnapshot(
  appendLog: IAppendLogStore,
  storage: IFileSystemStorageService,
  scope: string,
  checkpoint: Awaited<ReturnType<typeof readPersistedAgentCheckpoint>>,
  size: number,
  skipRequestAndMcp = false,
): Promise<PersistedAgentProfileSnapshot | undefined> {
  const records = typeof storage.readStream === 'function'
    ? filteredProfileRecords(storage, appendLog, scope, checkpoint?.offset ?? 0, size, skipRequestAndMcp)
    : appendLog.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY);
  let state = structuredClone(checkpoint?.states.get(profileKey.name) ?? profileKey.initial()) as ProfileModelState;
  let activeToolNames = checkpoint?.states.get(profileActiveToolsKey.name) as readonly string[] | undefined;
  let activeToolsKnown = checkpoint !== undefined;
  let profileStateSeen = checkpoint !== undefined;
  let promptRequest: import('@kiki/protocol').AgentPromptRequest | undefined;
  const mcpTools = new Map<string, McpToolsDiscovered>();
  for await (const record of records) {
    if (record.type === LlmRequest.type) {
      const request = event2FromRecord(LlmRequest, record);
      if (request instanceof LlmRequest) promptRequest = promptRequestEvidence(request);
      continue;
    }
    if (record.type === McpToolsDiscovered.type) {
      const discovery = event2FromRecord(McpToolsDiscovered, record);
      if (discovery instanceof McpToolsDiscovered) mcpTools.set(discovery.serverName, discovery);
      continue;
    }
    const cls = PROFILE_EVENT_CLASSES.get(record.type);
    if (cls === undefined) continue;
    const event = event2FromRecord(cls, record);
    if (event === undefined) continue;
    if (event instanceof ProfileBind) {
      activeToolNames = event.activeToolNames;
      activeToolsKnown = true;
      profileStateSeen = true;
    } else if (event instanceof ConfigUpdate || event instanceof AgentModelSwitch) {
      profileStateSeen = true;
    } else if (event instanceof ToolsSetActiveTools || event instanceof ToolsPolicyRefreshed) {
      activeToolNames = event.names;
      activeToolsKnown = true;
    } else if (event instanceof ToolsResetActiveTools) {
      activeToolNames = undefined;
      activeToolsKnown = true;
    }
    const fold = profileKey.replayable.folds.get(cls);
    if (fold === undefined) continue;
    const next = fold(state as never, event as never, REPLAY_CONTEXT);
    if (next !== undefined) state = next;
  }
  if (!profileStateSeen) return undefined;
  const toolPolicy = effectiveToolBinding({ tools: activeToolNames, toolAllowPolicies: state.toolAllowPolicies, disallowedTools: state.disallowedTools }, state.toolOverride, state.boundProfile);
  return {
    source: 'wire',
    driver: state.driver,
    execution: state.execution,
    toolOverride: state.toolOverride,
    memoryReadContext: state.memoryReadContext,
    personaId: state.personaId,
    personaRevision: state.personaRevision,
    personaOverrides: state.personaOverrides,
    persona: state.persona,
    roomPrompt: state.roomPrompt,
    endpoint: state.endpoint,
    modelAlias: state.modelAlias,
    profileName: state.profileName,
    profileDefinitionId: state.profileDefinitionId,
    routeId: state.routeId,
    lockedModelAlias: state.lockedModelAlias,
    lockedThinkingEffort: state.lockedThinkingEffort,
    executionRestriction: state.executionRestriction,
    allowParentNotify: state.allowParentNotify,
    executorId: state.executorId,
    executorProtocol: state.executorProtocol,
    thinkingLevel: state.thinkingLevel,
    thinkingEffortExplicit: state.thinkingEffortExplicit,
    thinkingEffortAdjusted: state.thinkingEffortAdjusted,
    bindingAdvisories: state.bindingAdvisories,
    serviceTier: state.serviceTier,
    activeToolNames: toolPolicy.tools,
    activeToolsKnown,
    toolAllowPolicies: toolPolicy.toolAllowPolicies,
    disallowedTools: toolPolicy.disallowedTools,
    disabledToolGroups: state.disabledToolGroups,
    canSpawnSubagents: state.canSpawnSubagents,
    allowedSubagents: state.allowedSubagents,
    preferredSubagents: state.preferredSubagents,
    denySubagents: state.denySubagents,
    subagentLeases: state.subagentLeases,
    spawnPolicy: state.spawnPolicy,
    appliedLease: state.appliedLease,
    boundProfile: state.boundProfile,
    promptRequest,
    mcpTools: [...mcpTools.values()].map(({ serverName, tools, enabledNames, collisions }) => ({ serverName, tools, enabledNames, collisions })),
  };
}

async function* filteredProfileRecords(
  storage: IFileSystemStorageService,
  appendLog: IAppendLogStore,
  scope: string,
  start: number,
  size: number,
  skipRequestAndMcp = false,
): AsyncIterable<WireRecord> {
  if (start >= size) return;
  await appendLog.flush(scope, AGENT_WIRE_RECORD_KEY).catch(() => undefined);
  const decoder = new TextDecoder();
  let pending = '';
  let lastRequest: string | undefined;
  const emit = function* (line: string): Generator<WireRecord> {
    const head = line.slice(0, 96);
    if (!PROFILE_LINE_MARKERS.some((marker) => head.includes(marker))) return;
    if (head.includes(`"type":"${LlmRequest.type}"`)) {
      if (!skipRequestAndMcp && Buffer.byteLength(line) <= PERSISTED_AGENT_PROFILE_REQUEST_PARSE_MAX_BYTES) lastRequest = line;
      return;
    }
    if (skipRequestAndMcp && head.includes(`"type":"${McpToolsDiscovered.type}"`)) return;
    const record = parseProfileLine(line);
    if (record !== undefined) yield record;
  };
  let yieldedAt = performance.now();
  for await (const chunk of readLogicalBytes(storage, scope, AGENT_WIRE_RECORD_KEY, { start, end: size - 1 }, { chunkBytes: 1024 * 1024 })) {
    pending += decoder.decode(chunk, { stream: true });
    let lineStart = 0;
    let newline: number;
    while ((newline = pending.indexOf('\n', lineStart)) !== -1) {
      const rawLine = pending.slice(lineStart, newline);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      lineStart = newline + 1;
      if (line.length > 0) yield* emit(line);
    }
    pending = lineStart === 0 ? pending : pending.slice(lineStart);
    if (performance.now() - yieldedAt >= 4) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      yieldedAt = performance.now();
    }
  }
  pending += decoder.decode();
  if (pending.length > 0) yield* emit(pending);
  if (lastRequest !== undefined) {
    const record = parseProfileLine(lastRequest);
    if (record !== undefined) yield record;
  }
}

function parseProfileLine(line: string): WireRecord | undefined {
  try {
    const record = JSON.parse(line) as WireRecord;
    return record !== null && typeof record === 'object' && typeof record.type === 'string' ? record : undefined;
  } catch {
    return undefined;
  }
}

function persistedAgentProfileCache(core: AgentProfileSnapshotHost): Map<string, PersistedAgentProfileCacheEntry> {
  let cache = persistedAgentProfileCaches.get(core);
  if (cache === undefined) {
    cache = new Map();
    persistedAgentProfileCaches.set(core, cache);
  }
  return cache;
}

function cachePersistedAgentProfile(
  cache: Map<string, PersistedAgentProfileCacheEntry>,
  scope: string,
  entry: PersistedAgentProfileCacheEntry,
): void {
  if (!cache.has(scope) && cache.size >= PERSISTED_AGENT_PROFILE_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(scope);
  cache.set(scope, entry);
}

function persistedMetadataKey(metadata: AgentMeta | undefined): string {
  return JSON.stringify([
    metadataProfileName(metadata),
    metadata?.execution,
    metadata?.model,
    metadata?.endpoint,
    metadata?.thinkingEffort,
    metadata?.thinkingEffortExplicit,
    metadata?.executor,
    metadata?.executorProtocol,
  ]);
}

function metadataProfileName(metadata: AgentMeta | undefined): string | undefined {
  return subagentProfileName(metadata)
    ?? (metadata?.labels?.['branch'] !== 'true' && metadata?.type === 'main' && metadata.displayName !== '' ? metadata.displayName : undefined);
}

function metadataSnapshot(metadata: AgentMeta | undefined): PersistedAgentProfileSnapshot | undefined {
  if (metadata === undefined) return undefined;
  return {
    source: 'metadata',
    endpoint: metadata.endpoint,
    execution: metadata.execution,
    profileName: metadataProfileName(metadata),
    modelAlias: metadata.model,
    thinkingLevel: metadata.thinkingEffort,
    thinkingEffortExplicit: metadata.thinkingEffortExplicit,
    executorId: metadata.executor,
    executorProtocol: metadata.executorProtocol,
    activeToolsKnown: false,
  };
}

/** Builds `CreateAgentOptions` for restoring a persisted agent, binding unbound branches cleanly. */
export function resolvePersistedAgentCreateOptions(
  agentId: string,
  metadata: AgentMeta | undefined,
  snapshot: PersistedAgentProfileSnapshot | undefined,
): CreateAgentOptions | undefined {
  const isBranch = metadata?.labels?.['branch'] === 'true';
  const nativeExecutor = snapshot?.executorId === undefined || snapshot.executorId === 'native';
  const hasBoundProfileOrRoute =
    (snapshot?.profileName !== undefined && snapshot.profileName.length > 0) ||
    (snapshot?.routeId !== undefined && snapshot.routeId.length > 0);
  const unboundBranch =
    isBranch &&
    nativeExecutor &&
    (!hasBoundProfileOrRoute || snapshot?.modelAlias === undefined || snapshot.modelAlias.length === 0);
  if (unboundBranch) {
    return {
      agentId,
      delegator: metadata?.delegator,
      userLabel: metadata?.userLabel,
      labels: metadata?.labels,
      binding: {
        profile: snapshot?.profileName ?? metadata?.labels?.['profileName'] ?? DEFAULT_AGENT_PROFILE_NAME,
        route: snapshot?.routeId,
      },
    };
  }
  if (snapshot === undefined) return undefined;
  return {
    agentId,
    delegator: metadata?.delegator,
    userLabel: metadata?.userLabel,
    labels: metadata?.labels,
    restoreBinding: {
      profileName: snapshot.profileName,
      routeId: snapshot.routeId,
      modelAlias: snapshot.modelAlias,
      thinkingEffort: snapshot.thinkingLevel,
      thinkingEffortExplicit: snapshot.thinkingEffortExplicit,
      executorId: snapshot.executorId,
      executorProtocol: snapshot.executorProtocol,
    },
  };
}
