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
import { subagentProfileName } from '#/session/agentLifecycle/subagentMetadata';

type PersistedProfileFields = Pick<ProfileModelState,
  'modelAlias' | 'profileName' | 'profileDefinitionId' | 'routeId' |
  'lockedModelAlias' | 'lockedThinkingEffort' | 'executionRestriction' |
  'allowParentNotify' | 'executorId' | 'executorProtocol' | 'thinkingLevel' | 'thinkingEffortAdjusted' |
  'serviceTier' | 'toolAllowPolicies' | 'disallowedTools' | 'disabledToolGroups' |
  'subagentPolicy' | 'subagentDeclaration' | 'subagents' | 'subagentLeases' |
  'spawnPolicy' | 'appliedLease' | 'boundProfile'>;

export interface PersistedAgentProfileSnapshot extends Omit<PersistedProfileFields, 'thinkingLevel'> {
  readonly source: 'wire' | 'metadata';
  readonly thinkingLevel?: string;
  readonly activeToolNames?: readonly string[];
  readonly activeToolsKnown: boolean;
}

export interface AgentProfileSnapshotHost {
  readonly accessor: ServicesAccessor;
}

interface PersistedAgentProfileCacheEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly metadataKey: string;
  readonly snapshot: PersistedAgentProfileSnapshot | undefined;
}

const PERSISTED_AGENT_PROFILE_CACHE_MAX_ENTRIES = 1024;
const persistedAgentProfileCaches = new WeakMap<AgentProfileSnapshotHost, Map<string, PersistedAgentProfileCacheEntry>>();

const PROFILE_EVENT_CLASSES: ReadonlyMap<string, Event2Class> = new Map<string, Event2Class>([
  [ProfileBind.type, ProfileBind],
  [ConfigUpdate.type, ConfigUpdate],
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
): Promise<PersistedAgentProfileSnapshot | undefined> {
  signal?.throwIfAborted();
  const scope = agentScopeOf(
    sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId),
    agentId,
  );
  const storage = core.accessor.get(IFileSystemStorageService);
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
  let snapshot: PersistedAgentProfileSnapshot | undefined;
  try {
    snapshot = await scanPersistedAgentProfileSnapshot(
      core.accessor.get(IAppendLogStore),
      scope,
      signal,
    ) ?? metadataSnapshot(metadata);
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason ?? error;
    snapshot = metadataSnapshot(metadata);
  }
  cachePersistedAgentProfile(cache, scope, { size, mtimeMs, metadataKey, snapshot });
  return snapshot;
}

async function scanPersistedAgentProfileSnapshot(
  appendLog: IAppendLogStore,
  scope: string,
  signal?: AbortSignal,
): Promise<PersistedAgentProfileSnapshot | undefined> {
  let state = structuredClone(profileKey.initial()) as ProfileModelState;
  let activeToolNames: readonly string[] | undefined;
  let activeToolsKnown = false;
  let profileStateSeen = false;
  for await (const record of appendLog.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY, { signal })) {
    const cls = PROFILE_EVENT_CLASSES.get(record.type);
    if (cls === undefined) continue;
    const event = event2FromRecord(cls, record);
    if (event === undefined) continue;
    if (event instanceof ProfileBind) {
      activeToolNames = event.activeToolNames;
      activeToolsKnown = true;
      profileStateSeen = true;
    } else if (event instanceof ConfigUpdate) {
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
  return {
    source: 'wire',
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
    thinkingEffortAdjusted: state.thinkingEffortAdjusted,
    serviceTier: state.serviceTier,
    activeToolNames,
    activeToolsKnown,
    toolAllowPolicies: state.toolAllowPolicies,
    disallowedTools: state.disallowedTools,
    disabledToolGroups: state.disabledToolGroups,
    subagentPolicy: state.subagentPolicy,
    subagentDeclaration: state.subagentDeclaration,
    subagents: state.subagents,
    subagentLeases: state.subagentLeases,
    spawnPolicy: state.spawnPolicy,
    appliedLease: state.appliedLease,
    boundProfile: state.boundProfile,
  };
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
    metadata?.model,
    metadata?.thinkingEffort,
    metadata?.executor,
    metadata?.executorProtocol,
  ]);
}

function metadataSnapshot(metadata: AgentMeta | undefined): PersistedAgentProfileSnapshot | undefined {
  if (metadata === undefined) return undefined;
  return {
    source: 'metadata',
    profileName: subagentProfileName(metadata),
    modelAlias: metadata.model,
    thinkingLevel: metadata.thinkingEffort,
    executorId: metadata.executor,
    executorProtocol: metadata.executorProtocol,
    activeToolsKnown: false,
  };
}
