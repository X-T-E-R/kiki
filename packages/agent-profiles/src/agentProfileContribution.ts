import type { AgentProfile, AgentProfileRouteDefinition } from './agentProfile';
import type { AgentProfileDiagnostic, ScopedAgentProfileBinding } from './scopedAgentProfile';

export interface SkippedAgentFile {
  readonly path: string;
  readonly reason: string;
  readonly code?: string;
}

export interface AgentProfileContribution {
  readonly profiles: readonly AgentProfile[];
  readonly routes?: readonly AgentProfileRouteDefinition[];
  readonly skipped?: readonly SkippedAgentFile[];
  readonly scannedRoots?: readonly string[];
  readonly scopedBindings?: ReadonlyMap<string, ReadonlyMap<string, ScopedAgentProfileBinding>>;
  readonly sourceDefinitions?: ReadonlyMap<string, AgentProfile>;
  readonly dependencyIndex?: ReadonlyMap<string, readonly string[]>;
  readonly diagnostics?: readonly AgentProfileDiagnostic[];
}

export const AGENT_PROFILE_SOURCE_PRIORITY = {
  builtin: 0,
  plugin: 5,
  user: 10,
  extra: 20,
  workspace: 30,
  explicit: 40,
} as const;
