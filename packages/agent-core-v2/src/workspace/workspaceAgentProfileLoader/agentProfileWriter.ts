import type {
  AgentProfile,
  AgentProfileRouteDefinition,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { ServiceTier } from '#/kosong/contract/provider';
import type { ExecutorPrompt } from '@kiki/agent-profiles/executorPrompt';

export type AgentProfileWriteScope = 'user' | 'project' | 'extra';

export interface AgentProfileRouteUpdate {
  readonly id: string;
  readonly description?: string;
  readonly modelAlias?: string | null;
}

/**
 * One `subagents` entry. A bare name keeps that entry's existing lease mapping
 * untouched; a mapping merges the given keys onto it (`null` deletes a key).
 */
export type AgentProfileSubagentUpdate =
  | string
  | {
      readonly name: string;
      readonly modelAlias?: string | null;
      readonly thinkingEffort?: string | null;
      readonly allowedModels?: readonly string[] | null;
    };

/** One `model_profiles` entry keyed by alias; unlisted per-model keys are preserved. */
export interface AgentProfileModelProfileUpdate {
  readonly alias: string;
  readonly when?: string | null;
  readonly thinkingEffort?: string | null;
}

export interface AgentProfileCreateRequest {
  readonly name: string;
  readonly scope: 'user' | 'project';
  readonly template?: string;
  readonly main?: boolean;
  readonly description?: string;
  readonly whenToUse?: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly tools?: readonly string[];
  readonly prompt?: string;
}

export interface AgentProfileWriteRequest {
  readonly name: string;
  readonly scope: AgentProfileWriteScope;
  readonly sourcePath?: string;
  readonly description?: string;
  readonly whenToUse?: string | null;
  readonly main?: boolean | null;
  readonly executor?: string | null;
  readonly executorPrompt?: ExecutorPrompt | null;
  readonly modelAlias?: string | null;
  readonly thinkingEffort?: string | null;
  readonly allowedModels?: readonly string[] | null;
  readonly denyModels?: readonly string[] | null;
  readonly allowedEfforts?: readonly string[] | null;
  readonly subagents?: readonly AgentProfileSubagentUpdate[] | null;
  readonly subagentPolicy?: 'advisory' | 'strict' | null;
  readonly spawnConstraints?: {
    readonly allowedModels?: readonly string[];
    readonly denyModels?: readonly string[];
    readonly allowedEfforts?: readonly string[];
    readonly disallowedTools?: readonly string[];
  } | null;
  readonly modelProfiles?: readonly AgentProfileModelProfileUpdate[] | null;
  readonly serviceTier?: ServiceTier | null;
  readonly autoCompact?: number | null;
  readonly tools?: readonly string[] | null;
  readonly disallowedTools?: readonly string[] | null;
  readonly routes?: readonly AgentProfileRouteUpdate[];
  readonly prompt?: string;
  readonly rawText?: string;
}

export interface AgentProfileWriteResult {
  readonly sourceId: 'user' | 'workspace' | 'extra';
  readonly workspaceKey: string;
  readonly profile: AgentProfile;
  readonly routes: readonly AgentProfileRouteDefinition[];
}

/** `workspaceAgentProfileLoader` domain — validated named-profile write-back contract. A
 *  Workspace-scoped writer applies validated common-field or whole-file updates to user, project,
 *  and extra profiles, reloads the owning source, and returns the authoritative registry projection
 *  after reload. */
export interface IAgentProfileWriter {
  readonly _serviceBrand: undefined;
  create(request: AgentProfileCreateRequest): Promise<AgentProfileWriteResult>;
  update(request: AgentProfileWriteRequest): Promise<AgentProfileWriteResult>;
}
