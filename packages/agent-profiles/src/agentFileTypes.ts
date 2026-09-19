import type {
  AgentModelProfile,
  AgentProfileRouteDefinition,
  AgentSystemPromptMode,
  RequestParams,
  ServiceTier,
} from './agentProfile';
import type { SkippedAgentFile } from './agentProfileContribution';
import type { PromptOverrides } from './promptOverrides';
import type { AgentProfileDiagnostic } from './scopedAgentProfile';
import type { SpawnConstraints, SubagentLease, SourceSubagentLease } from './subagentLease';
import type { ToolGroupId } from './toolGroups';

export type { SkippedAgentFile } from './agentProfileContribution';

export type AgentFileSource = 'plugin' | 'project' | 'user' | 'extra' | 'explicit';

export interface AgentFileRoot {
  readonly path: string;
  readonly source: AgentFileSource;
  readonly lowPrioritySubdirectories?: readonly string[];
}

export interface AgentFileDefinition {
  readonly contextBudget?: number;
  readonly maxCompletionTokens?: number;
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
  readonly disabledToolGroups?: readonly ToolGroupId[];
  readonly subagents?: readonly string[];
  readonly subagentLeases?: Readonly<Record<string, SubagentLease>>;
  readonly spawnConstraints?: SpawnConstraints;
  readonly executor?: string;
  readonly executorOptions?: Readonly<Record<string, string | number | boolean>>;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly allowedModels?: readonly string[];
  readonly denyModels?: readonly string[];
  readonly allowedEfforts?: readonly string[];
  readonly modelProfiles?: readonly AgentModelProfile[];
  readonly serviceTier?: ServiceTier;
  readonly requestParams?: RequestParams;
  readonly promptOverrides?: PromptOverrides;
  readonly systemPromptMode?: AgentSystemPromptMode;
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
