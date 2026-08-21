/**
 * `workspaceAgentProfileLoader` domain — agent-file model types.
 *
 * Shared types for the agent-file primitives: the parsed single-file
 * definition (`AgentFileDefinition`), scan roots (`AgentFileRoot`) tagged with
 * their source, and the discovery result carrying per-file skip diagnostics.
 * Pure data; no scoped state.
 */

import type {
  AgentModelPreference,
  AgentProfileRouteDefinition,
  AgentModelProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { SpawnConstraints, SubagentLease, SourceSubagentLease } from '#/app/agentProfileCatalog/subagentLease';
import type { SkippedAgentFile } from '#/app/agentProfileCatalog/agentProfileContribution';
import type { AgentProfileDiagnostic } from '#/app/agentProfileCatalog/scopedAgentProfile';
import type { RequestParams, ServiceTier } from '#/kosong/contract/provider';

export type { SkippedAgentFile } from '#/app/agentProfileCatalog/agentProfileContribution';

export type AgentFileSource = 'plugin' | 'project' | 'user' | 'extra' | 'explicit';

export interface AgentFileRoot {
  readonly path: string;
  readonly source: AgentFileSource;
}

export interface AgentFileDefinition {
  readonly name: string;
  readonly definitionId: string;
  readonly contributionRoot: string;
  readonly private: boolean;
  readonly description: string;
  readonly whenToUse?: string;
  readonly override: boolean;
  readonly main?: boolean;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly subagentLeases?: Readonly<Record<string, SubagentLease>>;
  readonly spawnConstraints?: SpawnConstraints;
  readonly modelPreference?: AgentModelPreference;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly allowedModels?: readonly string[];
  readonly denyModels?: readonly string[];
  readonly allowedEfforts?: readonly string[];
  readonly modelProfiles?: readonly AgentModelProfile[];
  readonly serviceTier?: ServiceTier;
  readonly requestParams?: RequestParams;
  readonly prompt: string;
  readonly path: string;
  readonly source: AgentFileSource;
  readonly delegationNotice?: 'auto' | 'off';
}

export interface AgentFileScopedBinding {
  readonly parentDefinitionId: string;
  readonly alias: string;
  readonly source: string;
  readonly lease: SourceSubagentLease;
  readonly status: 'ready' | 'unavailable';
  readonly sourceDefinitionId?: string;
  readonly definition?: AgentFileDefinition;
  readonly diagnostic?: AgentProfileDiagnostic;
}

export interface AgentFileDiscoveryResult {
  readonly agents: readonly AgentFileDefinition[];
  readonly routes: readonly AgentProfileRouteDefinition[];
  readonly skipped: readonly SkippedAgentFile[];
  readonly scannedRoots: readonly string[];
  readonly scopedBindings: ReadonlyMap<string, ReadonlyMap<string, AgentFileScopedBinding>>;
  readonly sourceDefinitions: ReadonlyMap<string, AgentFileDefinition>;
  readonly dependencyIndex: ReadonlyMap<string, readonly string[]>;
  readonly diagnostics: readonly AgentProfileDiagnostic[];
}
