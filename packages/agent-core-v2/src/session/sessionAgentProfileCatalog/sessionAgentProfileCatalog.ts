import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type {
  AgentProfile,
  AgentProfileRouteCatalogEntry,
  ResolvedAgentProfileRoute,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type {
  AgentProfileCatalogSnapshot,
  AgentProfileDiagnostic,
  ScopedAgentProfileBinding,
} from '#/app/agentProfileCatalog/scopedAgentProfile';

export interface AgentProfileRouteDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly routeId?: string;
}

export interface AgentProfileSelection {
  readonly profile: AgentProfile;
  readonly baseProfile: AgentProfile;
  readonly route?: ResolvedAgentProfileRoute;
}

export interface AgentProfileSuppressedCandidate {
  readonly sourceId: string;
  readonly priority: number;
  readonly reason: 'priority';
}

export interface AgentProfileInspection {
  readonly name: string;
  readonly profile: AgentProfile;
  readonly sourceId: string;
  readonly priority: number;
  readonly suppressed: readonly AgentProfileSuppressedCandidate[];
}

/** Session-scoped merged agent-profile catalog: a read-only projection over the App-scope
 *  `IAgentProfileRegistry` scoped to THIS session, merging the global contributions (builtin /
 *  plugin / user) with the ones the workspace loaders tagged with this session's seeded workspace key
 *  (workspace / extra / explicit). Name-level dedup happens here — higher-priority sources win name
 *  collisions. Disabled builtins are absent from `get` / `list` / `resolveSelection` / `inspect`, while `getDefault`
 *  retains the default binding fallback the main agent needs. */
export interface ISessionAgentProfileCatalog {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly onDidChange: Event<string>;
  get(name: string): AgentProfile | undefined;
  getDefault(): AgentProfile;
  list(): readonly AgentProfile[];
  listRoutes(): readonly AgentProfileRouteCatalogEntry[];
  routeDiagnostics(): readonly AgentProfileRouteDiagnostic[];
  diagnostics?(): readonly AgentProfileDiagnostic[];
  snapshot?(): AgentProfileCatalogSnapshot;
  getScopedBinding?(parentDefinitionId: string | undefined, alias: string): ScopedAgentProfileBinding | undefined;
  resolveSelection(input: { readonly profile?: string; readonly route?: string }): AgentProfileSelection;
  inspect(name: string): AgentProfileInspection | undefined;
  load(): Promise<void>;
  reload(): Promise<void>;
}

export const ISessionAgentProfileCatalog =
  createDecorator<ISessionAgentProfileCatalog>('sessionAgentProfileCatalog');
