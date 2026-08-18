/**
 * `workspaceAgentProfileLoader` domain — validated named-profile write-back contract.
 *
 * A Workspace-scoped writer edits only the file-backed description and fixed
 * model aliases owned by the user, project, or extra source, reloads that
 * source, and returns the authoritative registry projection after reload.
 */

import type {
  AgentProfile,
  AgentProfileRouteDefinition,
} from '#/app/agentProfileCatalog/agentProfileCatalog';

export type AgentProfileWriteScope = 'user' | 'project' | 'extra';

export interface AgentProfileRouteUpdate {
  readonly id: string;
  readonly description?: string;
  readonly modelAlias?: string | null;
}

export interface AgentProfileWriteRequest {
  readonly name: string;
  readonly scope: AgentProfileWriteScope;
  readonly description?: string;
  readonly modelAlias?: string | null;
  readonly routes?: readonly AgentProfileRouteUpdate[];
}

export interface AgentProfileWriteResult {
  readonly sourceId: 'user' | 'workspace' | 'extra';
  readonly workspaceKey: string;
  readonly profile: AgentProfile;
  readonly routes: readonly AgentProfileRouteDefinition[];
}

export interface IAgentProfileWriter {
  readonly _serviceBrand: undefined;
  update(request: AgentProfileWriteRequest): Promise<AgentProfileWriteResult>;
}
