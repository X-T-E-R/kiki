import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { BugIndicatingError, Error2, ErrorCodes } from '#/errors';
import type {
  AgentProfile,
  AgentProfileRouteCatalogEntry,
  ResolvedAgentProfileRoute,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  scopedBinding,
  type AgentProfileCatalogSnapshot,
  type AgentProfileDiagnostic,
  type ScopedAgentProfileBinding,
} from '#/app/agentProfileCatalog/scopedAgentProfile';
import { AGENT_PROFILE_ROUTES_FLAG_ID } from '#/app/agentProfileCatalog/flag';
import { IFlagService } from '#/app/flag/flag';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  IAgentProfileRegistry,
  type AgentProfileRegistration,
} from '#/app/agentProfileCatalog/agentProfileRegistry';
import { projectAgentProfileCatalog } from '@kiki/agent-profiles/profileCatalog';
import { IConfigService } from '#/app/config/config';
import {
  DISABLED_BUILTIN_PROFILES_SECTION,
  DISABLED_NAMED_PROFILES_SECTION,
  type DisabledBuiltinProfilesConfig,
  type DisabledNamedProfilesConfig,
} from '#/workspace/workspaceAgentProfileLoader/configSection';

import { ISessionAgentProfileCatalogSeed } from './agentProfileCatalogSeed';
import {
  ISessionAgentProfileCatalog,
  type AgentProfileInspection,
  type AgentProfileRouteDiagnostic,
  type AgentProfileSelection,
} from './sessionAgentProfileCatalog';

export class SessionAgentProfileCatalogService
  extends Disposable
  implements ISessionAgentProfileCatalog
{
  declare readonly _serviceBrand: undefined;

  private resolvable = new Map<string, AgentProfile>();
  private publicProfiles = new Map<string, AgentProfile>();
  private defaultBindingProfile: AgentProfile | undefined;
  private inspections = new Map<string, AgentProfileInspection>();
  private routes = new Map<string, ResolvedAgentProfileRoute>();
  private publicRoutes = new Map<string, ResolvedAgentProfileRoute>();
  private routeDiagnosticsValue: AgentProfileRouteDiagnostic[] = [];
  private snapshotValue: AgentProfileCatalogSnapshot | undefined;
  private readonly contributions = new Map<string, AgentProfileRegistration>();
  private readonly readyPromise: Promise<void>;
  private readonly onDidChangeEmitter = this._register(new Emitter<string>());
  readonly onDidChange: Event<string> = this.onDidChangeEmitter.event;

  constructor(
    @IAgentProfileRegistry private readonly registry: IAgentProfileRegistry,
    @ISessionAgentProfileCatalogSeed private readonly seed: ISessionAgentProfileCatalogSeed,
    @IConfigService private readonly config: IConfigService,
    @ILogService private readonly log: ILogService,
    @IFlagService private readonly flags: IFlagService,
  ) {
    super();
    this.reproject();
    this.readyPromise = this.config.ready.then(() => {
      this.reproject();
    });
    this._register(
      this.registry.onDidChange((change) => {
        if (change.workspaceKey !== undefined && change.workspaceKey !== this.seed.workspaceKey) {
          return;
        }
        if (this.reproject()) this.onDidChangeEmitter.fire(change.sourceId);
      }),
    );
    this._register(
      this.config.onDidSectionChange((change) => {
        if (
          change.domain !== DISABLED_BUILTIN_PROFILES_SECTION
          && change.domain !== DISABLED_NAMED_PROFILES_SECTION
        ) return;
        if (this.reproject()) this.onDidChangeEmitter.fire('catalog');
      }),
    );
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  get(name: string): AgentProfile | undefined {
    return this.resolvable.get(name);
  }

  getDefault(): AgentProfile {
    const profile = this.get(DEFAULT_AGENT_PROFILE_NAME) ?? this.defaultBindingProfile;
    if (profile === undefined) {
      throw new BugIndicatingError(
        `Default agent profile "${DEFAULT_AGENT_PROFILE_NAME}" is not registered`,
      );
    }
    return profile;
  }

  list(): readonly AgentProfile[] {
    return [...this.publicProfiles.values()];
  }

  listRoutes(): readonly AgentProfileRouteCatalogEntry[] {
    if (!this.flags.enabled(AGENT_PROFILE_ROUTES_FLAG_ID)) return [];
    return [...this.publicRoutes.values()].map(
      ({
        effectiveProfile: _profile,
        lockedModelAlias: _alias,
        lockedThinkingEffort: _effort,
        ...entry
      }) => entry,
    );
  }

  routeDiagnostics(): readonly AgentProfileRouteDiagnostic[] {
    return this.flags.enabled(AGENT_PROFILE_ROUTES_FLAG_ID)
      ? this.routeDiagnosticsValue
      : [];
  }

  diagnostics(): readonly AgentProfileDiagnostic[] {
    return this.snapshot().diagnostics;
  }

  snapshot(): AgentProfileCatalogSnapshot {
    const snapshot = this.snapshotValue;
    if (snapshot === undefined) throw new BugIndicatingError('Agent profile catalog snapshot is unavailable');
    return snapshot;
  }

  getScopedBinding(
    parentDefinitionId: string | undefined,
    alias: string,
  ): ScopedAgentProfileBinding | undefined {
    return scopedBinding(this.snapshot(), parentDefinitionId, alias);
  }

  resolveSelection(input: {
    readonly profile?: string;
    readonly route?: string;
  }): AgentProfileSelection {
    if (input.route === undefined) {
      const profile = input.profile === undefined ? undefined : this.get(input.profile);
      if (profile === undefined) {
        const available = this.list().map((item) => item.name).join(', ');
        throw new Error2(
          ErrorCodes.PROFILE_UNKNOWN,
          `Unknown agent profile: "${input.profile ?? ''}". Available agent profiles: ${available}`,
          { details: { profileName: input.profile, available } },
        );
      }
      return { profile, baseProfile: profile };
    }
    if (!this.flags.enabled(AGENT_PROFILE_ROUTES_FLAG_ID)) {
      throw new Error2(
        ErrorCodes.ROUTE_FEATURE_DISABLED,
        `Agent profile route "${input.route}" cannot be used because agent-profile-routes is disabled`,
        { details: { route: input.route } },
      );
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(input.route)) {
      throw new Error2(ErrorCodes.ROUTE_INVALID_ID, `Invalid agent profile route id: "${input.route}"`, {
        details: { route: input.route },
      });
    }
    const route = this.routes.get(input.route);
    if (route === undefined) {
      const missingBase = this.routeDiagnosticsValue.find(
        (diagnostic) =>
          diagnostic.routeId === input.route && diagnostic.code === ErrorCodes.ROUTE_BASE_MISSING,
      );
      if (missingBase !== undefined) {
        throw new Error2(ErrorCodes.ROUTE_BASE_MISSING, missingBase.message, {
          details: { route: input.route },
        });
      }
      throw new Error2(ErrorCodes.ROUTE_UNKNOWN, `Unknown agent profile route: "${input.route}"`, {
        details: { route: input.route },
      });
    }
    if (input.profile !== undefined && input.profile !== route.profile) {
      throw new Error2(
        ErrorCodes.ROUTE_BASE_MISMATCH,
        `Agent profile route "${route.id}" belongs to "${route.profile}", not "${input.profile}"`,
        { details: { route: route.id, expectedProfile: route.profile, profile: input.profile } },
      );
    }
    return { profile: route.effectiveProfile, baseProfile: this.get(route.profile)!, route };
  }

  inspect(name: string): AgentProfileInspection | undefined {
    return this.inspections.get(name);
  }

  setContribution(id: string, contribution: AgentProfileRegistration['contribution'], priority: number): void {
    this.contributions.set(id, { sourceId: id, priority, contribution });
    if (this.reproject()) this.onDidChangeEmitter.fire(id);
  }

  removeContribution(id: string): void {
    if (!this.contributions.delete(id)) return;
    if (this.reproject()) this.onDidChangeEmitter.fire(id);
  }

  async load(): Promise<void> {
    await this.ready;
  }

  async reload(): Promise<void> {
    await this.ready;
    if (this.reproject()) this.onDidChangeEmitter.fire('catalog');
  }

  private relevantEntries(): AgentProfileRegistration[] {
    const key = this.seed.workspaceKey;
    return [
      ...this.registry
        .entries()
        .filter((e) => e.workspaceKey === undefined || e.workspaceKey === key),
      ...this.contributions.values(),
    ];
  }

  private disabledBuiltinProfileNames(): ReadonlySet<string> {
    return new Set(
      this.config.get<DisabledBuiltinProfilesConfig>(DISABLED_BUILTIN_PROFILES_SECTION) ?? [],
    );
  }

  private disabledNamedProfileNames(): ReadonlySet<string> {
    return new Set(
      this.config.get<DisabledNamedProfilesConfig>(DISABLED_NAMED_PROFILES_SECTION) ?? [],
    );
  }

  private reproject(): boolean {
    try {
      const projection = projectAgentProfileCatalog({
        entries: this.relevantEntries(),
        disabledBuiltinProfiles: this.disabledBuiltinProfileNames(),
        disabledNamedProfiles: this.disabledNamedProfileNames(),
        routeBaseMissingCode: ErrorCodes.ROUTE_BASE_MISSING,
        warn: (message) => this.log.warn(message),
      });
      this.resolvable = new Map(projection.resolvableProfiles);
      this.publicProfiles = new Map(projection.profiles);
      this.defaultBindingProfile = projection.defaultBindingProfile;
      this.inspections = new Map(projection.inspections);
      this.routes = new Map(projection.routes);
      this.publicRoutes = new Map(projection.publicRoutes);
      this.routeDiagnosticsValue = [...projection.routeDiagnostics];
      this.snapshotValue = projection.snapshot;
      return true;
    } catch (error) {
      this.log.warn('agent profile catalog reload failed; keeping the last good catalog', {
        error: String(error),
      });
      return false;
    }
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionAgentProfileCatalog,
  SessionAgentProfileCatalogService,
  ScopeActivation.OnScopeCreated,
  'sessionAgentProfileCatalog',
);
