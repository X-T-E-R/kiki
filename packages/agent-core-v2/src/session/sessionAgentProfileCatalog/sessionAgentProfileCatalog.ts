/**
 * `sessionAgentProfileCatalog` domain — Session-scoped merged agent-profile
 * catalog contract.
 *
 * The Catalog of the agent-profile extension point: a read-only projection
 * over the App-scope `IAgentProfileRegistry`, scoped to THIS session — it
 * merges the global contributions (builtin / plugin / user) with the ones the
 * workspace loaders tagged with this session's seeded workspace key
 * (workspace / extra / explicit). Name-level dedup happens HERE, in the
 * projection: higher-priority sources win name collisions, while builtin
 * names require an explicit `override: true` opt-in to be replaced.
 * `inspect(name)` exposes the projection's adjudication (winning source,
 * suppressed candidates) for debugging surfaces. Bound at Session scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type {
  AgentProfile,
  AgentProfileRouteCatalogEntry,
  ResolvedAgentProfileRoute,
} from '#/app/agentProfileCatalog/agentProfileCatalog';

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
  readonly reason: 'priority' | 'builtin-override-required';
}

export interface AgentProfileInspection {
  readonly name: string;
  readonly profile: AgentProfile;
  readonly sourceId: string;
  readonly priority: number;
  readonly suppressed: readonly AgentProfileSuppressedCandidate[];
}

export interface ISessionAgentProfileCatalog {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly onDidChange: Event<string>;
  get(name: string): AgentProfile | undefined;
  getDefault(): AgentProfile;
  list(): readonly AgentProfile[];
  listRoutes(): readonly AgentProfileRouteCatalogEntry[];
  routeDiagnostics(): readonly AgentProfileRouteDiagnostic[];
  resolveSelection(input: { readonly profile?: string; readonly route?: string }): AgentProfileSelection;
  inspect(name: string): AgentProfileInspection | undefined;
  load(): Promise<void>;
  reload(): Promise<void>;
}

export const ISessionAgentProfileCatalog =
  createDecorator<ISessionAgentProfileCatalog>('sessionAgentProfileCatalog');
