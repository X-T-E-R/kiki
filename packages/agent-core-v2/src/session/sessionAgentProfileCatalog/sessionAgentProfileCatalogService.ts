/**
 * `sessionAgentProfileCatalog` domain — `ISessionAgentProfileCatalog`
 * implementation.
 *
 * Projects the App-scope `IAgentProfileRegistry` into this session's merged
 * profile view. The relevant entries are the global ones (builtin) plus the
 * ones tagged with the seeded workspace key (user / plugin / extra /
 * workspace / explicit); they are re-merged on every registry change (the
 * projection is a cheap full recompute — merge, never incremental patching).
 * Merge rules, applied per profile name: candidates are collected from every
 * relevant entry (deduped within an entry, highest priority first); the first
 * candidate wins, except that replacing a same-name `builtin` profile
 * requires `override: true` in the frontmatter — a non-override collision is
 * warned about and skipped to the next candidate. Builtins named by the
 * `disabledBuiltinProfiles` config section and file-backed profiles named by
 * `disabledNamedProfiles` are omitted from discovery and dispatch. The builtin
 * default is retained separately as a binding fallback so the main agent can
 * still start when `agent` is disabled. `ready` waits for config loading so
 * downstream tool descriptions see the effective projection.
 * Bound at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { BugIndicatingError } from '#/errors';
import { Error2, ErrorCodes } from '#/errors';
import type {
  AgentProfile,
  AgentProfileRouteCatalogEntry,
  AgentProfileRouteDefinition,
  ResolvedAgentProfileRoute,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { resolveAgentProfileRoute } from '#/app/agentProfileCatalog/agentProfileRoute';
import { AGENT_PROFILE_ROUTES_FLAG_ID } from '#/app/agentProfileCatalog/flag';
import { IFlagService } from '#/app/flag/flag';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import {
  IAgentProfileRegistry,
  type AgentProfileRegistration,
} from '#/app/agentProfileCatalog/agentProfileRegistry';
import { BUILTIN_AGENT_PROFILE_SOURCE_ID } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
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
  type AgentProfileSuppressedCandidate,
  type AgentProfileRouteDiagnostic,
  type AgentProfileSelection,
} from './sessionAgentProfileCatalog';

interface ProfileCandidate {
  readonly profile: AgentProfile;
  readonly sourceId: string;
  readonly priority: number;
}

// NOTE: stays Disposable — its own 'get' collides with the Fiber
export class SessionAgentProfileCatalogService
  extends Disposable
  implements ISessionAgentProfileCatalog
{
  declare readonly _serviceBrand: undefined;

  private merged = new Map<string, AgentProfile>();
  private defaultBindingProfile: AgentProfile | undefined;
  private inspections = new Map<string, AgentProfileInspection>();
  private routes = new Map<string, ResolvedAgentProfileRoute>();
  private routeDiagnosticsValue: AgentProfileRouteDiagnostic[] = [];
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
    this.readyPromise = this.config.ready.then(() => this.reproject());
    this._register(
      this.registry.onDidChange((change) => {
        if (change.workspaceKey !== undefined && change.workspaceKey !== this.seed.workspaceKey) {
          return;
        }
        this.reproject();
        this.onDidChangeEmitter.fire(change.sourceId);
      }),
    );
    this._register(
      this.config.onDidSectionChange((change) => {
        if (
          change.domain !== DISABLED_BUILTIN_PROFILES_SECTION
          && change.domain !== DISABLED_NAMED_PROFILES_SECTION
        ) return;
        this.reproject();
        this.onDidChangeEmitter.fire('catalog');
      }),
    );
  }

  get ready(): Promise<void> {
    return this.readyPromise;
  }

  get(name: string): AgentProfile | undefined {
    return this.merged.get(name);
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
    return [...this.merged.values()];
  }

  listRoutes(): readonly AgentProfileRouteCatalogEntry[] {
    if (!this.flags.enabled(AGENT_PROFILE_ROUTES_FLAG_ID)) return [];
    return [...this.routes.values()].map(
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
          `Unknown agent type: "${input.profile ?? ''}". Available agent types: ${available}`,
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

  async load(): Promise<void> {
    await this.ready;
  }

  async reload(): Promise<void> {
    await this.ready;
    this.reproject();
    this.onDidChangeEmitter.fire('catalog');
  }

  private relevantEntries(): AgentProfileRegistration[] {
    const key = this.seed.workspaceKey;
    return this.registry
      .entries()
      .filter((e) => e.workspaceKey === undefined || e.workspaceKey === key);
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

  private reproject(): void {
    const merged = new Map<string, AgentProfile>();
    let defaultBindingProfile: AgentProfile | undefined;
    const inspections = new Map<string, AgentProfileInspection>();
    const entries = this.relevantEntries();
    const disabledBuiltinProfiles = this.disabledBuiltinProfileNames();
    const disabledNamedProfiles = this.disabledNamedProfileNames();

    const builtinEntry = entries.find((e) => e.sourceId === BUILTIN_AGENT_PROFILE_SOURCE_ID);
    if (builtinEntry !== undefined) {
      for (const profile of builtinEntry.contribution.profiles) {
        if (profile.name === DEFAULT_AGENT_PROFILE_NAME) defaultBindingProfile = profile;
        if (disabledBuiltinProfiles.has(profile.name)) continue;
        merged.set(profile.name, profile);
        inspections.set(profile.name, {
          name: profile.name,
          profile,
          sourceId: builtinEntry.sourceId,
          priority: builtinEntry.priority,
          suppressed: [],
        });
      }
    }

    const fileCandidates = new Map<string, ProfileCandidate[]>();
    const ordered = entries
      .filter((e) => e.sourceId !== BUILTIN_AGENT_PROFILE_SOURCE_ID)
      .toSorted((a, b) => b.priority - a.priority);
    for (const entry of ordered) {
      const entryProfiles = new Map<string, AgentProfile>();
      for (const profile of entry.contribution.profiles) {
        entryProfiles.set(profile.name, profile);
      }
      for (const profile of entryProfiles.values()) {
        if (disabledNamedProfiles.has(profile.name)) continue;
        const candidates = fileCandidates.get(profile.name) ?? [];
        candidates.push({
          profile,
          sourceId: entry.sourceId,
          priority: entry.priority,
        });
        fileCandidates.set(profile.name, candidates);
      }
    }

    for (const candidates of fileCandidates.values()) {
      const suppressed: AgentProfileSuppressedCandidate[] = [];
      let winner = false;
      for (const candidate of candidates) {
        if (merged.has(candidate.profile.name) && candidate.profile.override !== true) {
          this.log.warn(
            `agent file profile "${candidate.profile.name}" ignored: a same-name builtin profile exists; set "override: true" in the frontmatter to replace it`,
          );
          suppressed.push({
            sourceId: candidate.sourceId,
            priority: candidate.priority,
            reason: 'builtin-override-required',
          });
          continue;
        }
        merged.set(candidate.profile.name, candidate.profile);
        inspections.set(candidate.profile.name, {
          name: candidate.profile.name,
          profile: candidate.profile,
          sourceId: candidate.sourceId,
          priority: candidate.priority,
          suppressed: [
            ...suppressed,
            ...candidates.slice(candidates.indexOf(candidate) + 1).map((rest) => ({
              sourceId: rest.sourceId,
              priority: rest.priority,
              reason: 'priority' as const,
            })),
          ],
        });
        winner = true;
        break;
      }
      if (!winner && suppressed.length > 0) {
        const name = candidates[0]?.profile.name;
        const existing = name === undefined ? undefined : inspections.get(name);
        if (existing !== undefined) {
          inspections.set(existing.name, { ...existing, suppressed });
        }
      }
    }

    this.merged = merged;
    this.defaultBindingProfile = defaultBindingProfile;
    this.inspections = inspections;
    this.reprojectRoutes(entries, merged);
  }

  private reprojectRoutes(
    entries: readonly AgentProfileRegistration[],
    profiles: ReadonlyMap<string, AgentProfile>,
  ): void {
    const diagnostics: AgentProfileRouteDiagnostic[] = [];
    for (const entry of entries) {
      for (const skipped of entry.contribution.skipped ?? []) {
        if (skipped.code?.startsWith('agent_profile_route.') !== true) continue;
        diagnostics.push({ code: skipped.code, message: skipped.reason, path: skipped.path });
      }
    }
    const candidates = new Map<string, AgentProfileRouteDefinition>();
    const ordered = entries.toSorted((a, b) => b.priority - a.priority);
    for (const entry of ordered) {
      for (const route of entry.contribution.routes ?? []) {
        if (!candidates.has(route.id)) candidates.set(route.id, route);
      }
    }
    const routes = new Map<string, ResolvedAgentProfileRoute>();
    for (const route of candidates.values()) {
      const base = profiles.get(route.profile);
      if (base === undefined) {
        const message = `Agent profile route "${route.id}" ignored because base profile "${route.profile}" is unavailable`;
        diagnostics.push({
          code: ErrorCodes.ROUTE_BASE_MISSING,
          message,
          path: route.path,
          routeId: route.id,
        });
        this.log.warn(message);
        continue;
      }
      routes.set(route.id, resolveAgentProfileRoute(route, base));
    }
    this.routes = routes;
    this.routeDiagnosticsValue = diagnostics;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionAgentProfileCatalog,
  SessionAgentProfileCatalogService,
  ScopeActivation.OnScopeCreated,
  'sessionAgentProfileCatalog',
);
