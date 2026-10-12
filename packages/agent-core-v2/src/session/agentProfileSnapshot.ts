import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
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
  type ProfileModelState,
} from '#/agent/profile/profileOps';
import { AgentModelSwitch } from '#/agent/modelSwitch/modelSwitchEvent';
import { effectiveToolBinding } from '#/agent/profile/toolBinding';
import { subagentProfileName } from '#/session/agentLifecycle/subagentMetadata';
import { LlmRequest, promptRequestEvidence } from '#/agent/llmRequester/llmRequestOps';

type PersistedProfileFields = Pick<ProfileModelState,
  'personaId' | 'personaRevision' | 'personaOverrides' | 'persona' | 'roomPrompt' |
  'execution' | 'modelAlias' | 'profileName' | 'profileDefinitionId' | 'routeId' |
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
}

export interface PersistedAgentProfileReadOptions {
  readonly inlineByteBudget?: number;
}

export const PERSISTED_AGENT_PROFILE_INLINE_BYTE_BUDGET = 8 << 20;

export type AgentProfileSnapshotHost = { readonly accessor: ServicesAccessor } | {
  readonly storage: IFileSystemStorageService;
  readonly appendLog: IAppendLogStore;
};

interface PersistedAgentProfileCacheEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly metadataKey: string;
  readonly snapshot: PersistedAgentProfileSnapshot | undefined;
}

const PERSISTED_AGENT_PROFILE_CACHE_MAX_ENTRIES = 1024;
const PERSISTED_AGENT_PROFILE_REQUEST_PARSE_MAX_BYTES = 1 << 20;
const persistedAgentProfileCaches = new WeakMap<AgentProfileSnapshotHost, Map<string, PersistedAgentProfileCacheEntry>>();

interface PersistedAgentProfileFlight {
  readonly size: number;
  readonly mtimeMs: number;
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
  `"type":"${LlmRequest.type}"`,
];

const PROFILE_EVENT_CLASSES: ReadonlyMap<string, Event2Class> = new Map<string, Event2Class>([
  [ProfileBind.type, ProfileBind],
  [ConfigUpdate.type, ConfigUpdate],
  [AgentModelSwitch.type, AgentModelSwitch],
  [ToolsSetActiveTools.type, ToolsSetActiveTools],
  [ToolsResetActiveTools.type, ToolsResetActiveTools],
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
  try {
    [size, mtimeMs] = await Promise.all([
      storage.size(scope, AGENT_WIRE_RECORD_KEY).then((value) => value ?? 0),
      storage.mtime(scope, AGENT_WIRE_RECORD_KEY).then((value) => value ?? 0),
    ]);
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason ?? error;
    return metadataSnapshot(metadata);
  }
  signal?.throwIfAborted();
  const metadataKey = persistedMetadataKey(metadata);
  const cache = persistedAgentProfileCache(core);
  const cached = cache.get(scope);
  if (cached !== undefined && cached.size === size && cached.mtimeMs === mtimeMs && cached.metadataKey === metadataKey) {
    cache.delete(scope);
    cache.set(scope, cached);
    return cached.snapshot;
  }
  const inlineByteBudget = options?.inlineByteBudget;
  if (inlineByteBudget !== undefined && size > inlineByteBudget) {
    const fallback = metadataSnapshot(metadata);
    return fallback === undefined ? undefined : { ...fallback, wireCoverage: 'unscanned' };
  }
  const flights = persistedAgentProfileFlightMap(core);
  let flight = flights.get(scope);
  if (flight === undefined || flight.size !== size || flight.mtimeMs !== mtimeMs || flight.metadataKey !== metadataKey) {
    const promise = scanPersistedAgentProfileSnapshot(appendLog, storage, scope)
      .then((snapshot) => snapshot ?? metadataSnapshot(metadata))
      .catch(() => metadataSnapshot(metadata))
      .then((snapshot) => {
        cachePersistedAgentProfile(cache, scope, { size, mtimeMs, metadataKey, snapshot });
        return snapshot;
      })
      .finally(() => {
        if (flights.get(scope)?.promise === promise) flights.delete(scope);
      });
    flight = { size, mtimeMs, metadataKey, promise };
    flights.set(scope, flight);
  }
  return await waitForPersistedAgentProfile(flight.promise, signal);
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
): Promise<PersistedAgentProfileSnapshot | undefined> {
  const records = typeof storage.readStream === 'function'
    ? filteredProfileRecords(storage, appendLog, scope)
    : appendLog.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY);
  let state = structuredClone(profileKey.initial()) as ProfileModelState;
  let activeToolNames: readonly string[] | undefined;
  let activeToolsKnown = false;
  let profileStateSeen = false;
  let promptRequest: import('@kiki/protocol').AgentPromptRequest | undefined;
  for await (const record of records) {
    if (record.type === LlmRequest.type) {
      const request = event2FromRecord(LlmRequest, record);
      if (request instanceof LlmRequest) promptRequest = promptRequestEvidence(request);
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
    } else if (event instanceof ToolsSetActiveTools) {
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
    execution: state.execution,
    toolOverride: state.toolOverride,
    memoryReadContext: state.memoryReadContext,
    personaId: state.personaId,
    personaRevision: state.personaRevision,
    personaOverrides: state.personaOverrides,
    persona: state.persona,
    roomPrompt: state.roomPrompt,
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
  };
}

async function* filteredProfileRecords(
  storage: IFileSystemStorageService,
  appendLog: IAppendLogStore,
  scope: string,
): AsyncIterable<WireRecord> {
  await appendLog.flush(scope, AGENT_WIRE_RECORD_KEY).catch(() => undefined);
  const decoder = new TextDecoder();
  let pending = '';
  let lastRequest: string | undefined;
  const emit = function* (line: string): Generator<WireRecord> {
    const head = line.slice(0, 96);
    if (!PROFILE_LINE_MARKERS.some((marker) => head.includes(marker))) return;
    if (head.includes(`"type":"${LlmRequest.type}"`)) {
      if (Buffer.byteLength(line) <= PERSISTED_AGENT_PROFILE_REQUEST_PARSE_MAX_BYTES) lastRequest = line;
      return;
    }
    const record = parseProfileLine(line);
    if (record !== undefined) yield record;
  };
  for await (const chunk of storage.readStream(scope, AGENT_WIRE_RECORD_KEY)) {
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (line.length > 0) yield* emit(line);
      newline = pending.indexOf('\n');
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
    subagentProfileName(metadata),
    metadata?.execution,
    metadata?.model,
    metadata?.thinkingEffort,
    metadata?.thinkingEffortExplicit,
    metadata?.executor,
    metadata?.executorProtocol,
  ]);
}

function metadataSnapshot(metadata: AgentMeta | undefined): PersistedAgentProfileSnapshot | undefined {
  if (metadata === undefined) return undefined;
  return {
    source: 'metadata',
    execution: metadata.execution,
    profileName: subagentProfileName(metadata),
    modelAlias: metadata.model,
    thinkingLevel: metadata.thinkingEffort,
    thinkingEffortExplicit: metadata.thinkingEffortExplicit,
    executorId: metadata.executor,
    executorProtocol: metadata.executorProtocol,
    activeToolsKnown: false,
  };
}
