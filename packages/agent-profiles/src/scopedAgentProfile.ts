import type { AgentProfile, ResolvedAgentProfileRoute } from './agentProfile';
import type { SourceSubagentLease } from './subagentLease';

export type ScopedAgentProfileBindingStatus = 'ready' | 'unavailable';

export interface AgentProfileDiagnostic {
  readonly code: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
  readonly path?: string;
  readonly parentDefinitionId?: string;
  readonly alias?: string;
  readonly source?: string;
}

export interface ScopedAgentProfileBinding {
  readonly parentDefinitionId: string;
  readonly alias: string;
  readonly source: string;
  readonly lease: SourceSubagentLease;
  readonly status: ScopedAgentProfileBindingStatus;
  readonly sourceDefinitionId?: string;
  readonly profile?: AgentProfile;
  readonly diagnostic?: AgentProfileDiagnostic;
}

export interface AgentProfileCatalogSnapshot {
  readonly publicProfiles: ReadonlyMap<string, AgentProfile>;
  readonly defaultProfile?: AgentProfile;
  readonly routes: ReadonlyMap<string, ResolvedAgentProfileRoute>;
  readonly scopedBindings: ReadonlyMap<string, ReadonlyMap<string, ScopedAgentProfileBinding>>;
  readonly sourceDefinitions: ReadonlyMap<string, AgentProfile>;
  readonly dependencyIndex: ReadonlyMap<string, readonly string[]>;
  readonly diagnostics: readonly AgentProfileDiagnostic[];
}

export function scopedBinding(
  snapshot: AgentProfileCatalogSnapshot,
  parentDefinitionId: string | undefined,
  alias: string,
): ScopedAgentProfileBinding | undefined {
  if (parentDefinitionId === undefined) return undefined;
  return snapshot.scopedBindings.get(parentDefinitionId)?.get(alias);
}

export const AgentProfileSourceDiagnosticCodes = {
  INVALID_PATH: 'agent_profile_source.invalid_path',
  PATH_ESCAPE: 'agent_profile_source.path_escape',
  SYMLINK_ESCAPE: 'agent_profile_source.symlink_escape',
  NOT_PRIVATE: 'agent_profile_source.not_private',
  UNAVAILABLE: 'agent_profile_source.unavailable',
  INVALID_PROFILE: 'agent_profile_source.invalid_profile',
  CYCLE: 'agent_profile_source.cycle',
  DEPTH_EXCEEDED: 'agent_profile_source.depth_exceeded',
} as const;
