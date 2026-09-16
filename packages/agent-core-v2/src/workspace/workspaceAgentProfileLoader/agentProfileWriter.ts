import type {
  AgentProfile,
  AgentProfileRouteDefinition,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { ServiceTier } from '#/kosong/contract/provider';

export type AgentProfileWriteScope = 'user' | 'project' | 'extra';

export interface AgentProfileRouteUpdate {
  readonly id: string;
  readonly description?: string;
  readonly modelAlias?: string | null;
}

export interface AgentProfileWriteRequest {
  readonly name: string;
  readonly scope: AgentProfileWriteScope;
  readonly sourcePath?: string;
  readonly description?: string;
  readonly whenToUse?: string | null;
  readonly modelAlias?: string | null;
  readonly thinkingEffort?: string | null;
  readonly serviceTier?: ServiceTier | null;
  readonly tools?: readonly string[] | null;
  readonly disallowedTools?: readonly string[] | null;
  readonly routes?: readonly AgentProfileRouteUpdate[];
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
  update(request: AgentProfileWriteRequest): Promise<AgentProfileWriteResult>;
}
