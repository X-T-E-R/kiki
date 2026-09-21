import {
  AGENT_WIRE_RECORD_KEY,
  IAppendLogStore,
  agentScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
  type AgentMeta,
  type Scope,
  type WireRecord,
} from '@kiki/agent-core-v2';
import { event2FromRecord, type Event2, type Event2Class } from '@kiki/agent-core-v2/app/event/event2';
import {
  ConfigUpdate,
  ProfileBind,
  ToolsResetActiveTools,
  ToolsSetActiveTools,
  profileKey,
  type ProfileModelState,
} from '@kiki/agent-core-v2/agent/profile/profileOps';
import { subagentProfileName } from '@kiki/agent-core-v2/session/agentLifecycle/subagentMetadata';

type PersistedProfileFields = Pick<ProfileModelState,
  'modelAlias' | 'profileName' | 'profileDefinitionId' | 'routeId' |
  'lockedModelAlias' | 'lockedThinkingEffort' | 'executionRestriction' |
  'executorId' | 'executorProtocol' | 'thinkingLevel' | 'thinkingEffortAdjusted' |
  'serviceTier' | 'toolAllowPolicies' | 'disallowedTools' | 'disabledToolGroups' |
  'subagentPolicy' | 'subagentDeclaration' | 'subagents' | 'subagentLeases' |
  'spawnPolicy' | 'appliedLease' | 'boundProfile'>;

export interface PersistedAgentProfileSnapshot extends Omit<PersistedProfileFields, 'thinkingLevel'> {
  readonly source: 'wire' | 'metadata';
  readonly thinkingLevel?: string;
  readonly activeToolNames?: readonly string[];
  readonly activeToolsKnown: boolean;
}

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
  core: Scope,
  workspaceId: string,
  sessionId: string,
  agentId: string,
  metadata: AgentMeta | undefined,
  signal?: AbortSignal,
): Promise<PersistedAgentProfileSnapshot | undefined> {
  signal?.throwIfAborted();
  const appendLog = core.accessor.get(IAppendLogStore);
  const scope = agentScopeOf(
    sessionScopeOf(workspacePersistenceScope('sessions', workspaceId), sessionId),
    agentId,
  );
  let state = structuredClone(profileKey.initial()) as ProfileModelState;
  let activeToolNames: readonly string[] | undefined;
  let activeToolsKnown = false;
  let profileStateSeen = false;
  try {
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
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason ?? error;
    return metadataSnapshot(metadata);
  }
  if (!profileStateSeen) return metadataSnapshot(metadata);
  return {
    source: 'wire',
    modelAlias: state.modelAlias,
    profileName: state.profileName,
    profileDefinitionId: state.profileDefinitionId,
    routeId: state.routeId,
    lockedModelAlias: state.lockedModelAlias,
    lockedThinkingEffort: state.lockedThinkingEffort,
    executionRestriction: state.executionRestriction,
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
