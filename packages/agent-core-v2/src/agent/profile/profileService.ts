import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/kosong/contract/capability';
import {
  type RequestParams,
  type SamplingOptions,
  type ServiceTier,
  type ThinkingEffort,
} from '#/kosong/contract/provider';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { type ModelOverrides } from '#/kosong/model/model.types';
import { type ModelRequestParams } from '#/kosong/model/modelRequester';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import {
  drivesThinkingThroughTraits,
  modelSupportsThinkingEffort,
  normalizeRequestedThinkingEffort,
  resolveForcedThinkingEffort,
  resolveThinkingEffortForModel,
  resolveThinkingKeep,
  requiresStrictThinkingValidation,
  type ThinkingConfig,
} from '#/kosong/model/thinking';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { DEFAULT_AGENT_PROFILE_NAME, type EnvironmentDisclosureSnapshot } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { ErrorCodes, Error2 } from "#/errors";
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { AGENTS_SECTION, type AgentsConfig } from '#/session/agentCollaboration/configSection';
import {
  DelegationFileError,
  injectDelegationContext,
  resolveDelegationSnippet,
  type DelegationPosition,
} from '#/agent/profile/delegationContext';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import type { LoopControl } from '#/agent/loop/configSection';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { IHostClock } from '#/os/interface/hostClock';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ToolSource } from '#/tool/toolContract';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import { BUILTIN_SKILL_SOURCE_ID } from '#/app/skillCatalog/skillSource';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { IPluginService } from '#/app/plugin/plugin';
import type { ResolvedAgentProfile, SystemPromptContext } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentAgentsMdReminderService } from '#/agent/agentsMdReminder/agentsMdReminder';
import {
  applyOverlay,
  CognitionFileError,
  cognitionPathRefs,
  loadCognitionSlots,
} from '#/agent/cognition/cognitionFiles';

import {
  applyMatchedModelProfilePrompt,
  declaresModelProfilePrompt,
  resolveModelProfileEntry,
} from '#/app/agentProfileCatalog/modelProfileOverlay';
import {
  aliasIdentity,
  applyLease,
  applySpawnPolicy,
  intersectSpawnPolicy,
  spawnConstraintOrigin,
} from '#/app/agentProfileCatalog/applySubagentLease';
import {
  resolveMainModelCandidate,
  resolveMainThinkingCandidate,
} from '#/agent/profile/mainModelCandidate';
import {
  humanProfileDeviations,
  roleConstraintsFromProfile,
  routeModelOverrideMessage,
  routeThinkingOverrideMessage,
} from '#/session/subagent/modelConstraints';
import { assertBoundModelAllowed } from '#/session/subagent/configSection';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import {
  extractAgentsMdPathsFromSystemPrompt,
  prepareSystemPromptContext,
  type LoadedAgentsMd,
} from './context';
import type {
  ApplyProfileOptions,
  BindAgentInput,
  ProfileBindingSnapshot,
  ProfileData,
  ProfileModelContext,
  ProfileServiceOptions,
  ProfileSetModelResult,
  ProfileUpdateData,
} from './profile';
import { IAgentProfileService, ProfileError, ProfileErrors } from './profile';
import { TOOLS_SECTION, type ToolsConfig } from '#/agent/toolPolicy/configSection';
import { isToolActiveComposed, findInactiveToolPatterns, literalToolNames, type InactiveToolPattern } from '#/agent/toolPolicy/evaluate';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import {
  profileActiveToolsKey,
  ConfigUpdate,
  ProfileBind,
  profileKey,
  ToolsResetActiveTools,
  ToolsSetActiveTools,
  WarningIssued,
  type ActiveToolsState,
  type ConfigUpdatePayload,
  type ProfileModelState,
} from './profileOps';

import { AgentStatusUpdated } from '#/agent/usage/usageEvents';

export interface WarningEvent {
  readonly type: 'warning';
  readonly message: string;
  readonly code?: string;
}

function describeInactiveToolPattern(
  context: string,
  field: string,
  issue: InactiveToolPattern,
): string {
  switch (issue.kind) {
    case 'unknown-tool':
      return `Tool pattern "${issue.pattern}" in ${context} ${field} does not match any registered or built-in tool; it will never activate anything.`;
    case 'wildcard-not-mcp':
      return `Tool pattern "${issue.pattern}" in ${context} ${field} uses wildcards, which only match MCP tools (names starting with "mcp__"); it will never activate anything.`;
    case 'incomplete-mcp-name':
      return `Tool pattern "${issue.pattern}" in ${context} ${field} matches no tool; use "${issue.pattern}__*" to match the whole MCP server.`;
  }
}

export const PLUGIN_SECTIONS_MAX_BYTES = 64 * 1024;

export const profileActiveToolNamesOverlayKey = defineState<readonly string[] | undefined>(
  'profile.activeToolNamesOverlay',
  () => undefined as readonly string[] | undefined,
);
export const profileAgentsMdWarningKey = defineState<string | undefined>(
  'profile.agentsMdWarning',
  () => undefined as string | undefined,
);
export const profileEmittedThinkingEffortWarningsKey = defineState<Set<string>>(
  'profile.emittedThinkingEffortWarnings',
  () => new Set(),
);
export const profileEmittedToolPatternWarningsKey = defineState<Set<string>>(
  'profile.emittedToolPatternWarnings',
  () => new Set(),
);
export const profileEmittedPluginBudgetWarningsKey = defineState<Set<string>>(
  'profile.emittedPluginBudgetWarnings',
  () => new Set(),
);

export class AgentProfileService extends Disposable implements IAgentProfileService {
  declare readonly _serviceBrand: undefined;

  private optionsValue: ProfileServiceOptions = {};

  private get activeToolNames(): ActiveToolsState {
    return (
      this.activeToolNamesOverlay ??
      (this.states.get(profileActiveToolsKey) as ActiveToolsState)
    );
  }

  private activeProfile: ResolvedAgentProfile | undefined;
  private readonly emittedDeviationWarnings = new Set<string>();
  private delegationPosition: DelegationPosition = 'main';

  private frozenSkillListing: string | undefined;
  private frozenPluginSections: string | undefined;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentTelemetryContextService private readonly telemetryContext: IAgentTelemetryContextService,
    @IConfigService private readonly config: IConfigService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IModelService private readonly models: IModelService,
    @IProtocolAdapterRegistry private readonly protocolAdapters: IProtocolAdapterRegistry,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @IHostClock private readonly clock: IHostClock,
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IHostEnvironment private readonly hostEnv: IHostEnvironment,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @ISessionInstructionsProvider private readonly instructions: ISessionInstructionsProvider,
    @ISessionToolPolicy private readonly sessionToolPolicy: ISessionToolPolicy,
    @ISessionToolPolicyGate private readonly toolPolicyGate: ISessionToolPolicyGate,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IBuiltinAgentProfileLoader private readonly builtinProfiles: IBuiltinAgentProfileLoader,
    @IAgentStateService private readonly states: IAgentStateService,
    @IPluginService private readonly plugins: IPluginService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
    @IAgentAgentsMdReminderService private readonly agentsMdReminder: IAgentAgentsMdReminderService,
    @IAgentScopeContext private readonly agentScope: IAgentScopeContext,
  ) {
    super();
    this.states.contributeState(profileKey);
    this.states.contributeState(profileActiveToolsKey);
    this.states.contributeState(profileActiveToolNamesOverlayKey);
    this.states.contributeState(profileAgentsMdWarningKey);
    this.states.contributeState(profileEmittedThinkingEffortWarningsKey);
    this.states.contributeState(profileEmittedToolPatternWarningsKey);
    this.states.contributeState(profileEmittedPluginBudgetWarningsKey);
    this.configure({});
    this._register(
      this.sessionToolPolicy.onDidChange((event) => {
        event.waitUntil(this.refreshSystemPrompt());
      }),
    );
    this._register(
      this.instructions.onDidChange(() => {
        void this.refreshSystemPrompt();
      }),
    );
    this._register(
      this.config.onDidSectionChange(({ domain }) => {
        if (domain === TOOLS_SECTION) {
          this.publishToolPatternWarnings();
          void this.refreshSystemPrompt();
        }
      }),
    );
    this._register(
      this.skillCatalog.onDidChange((sourceId) => {
        if (sourceId === BUILTIN_SKILL_SOURCE_ID) {
          void this.refreshSystemPrompt();
        }
      }),
    );
  }

  private get activeToolNamesOverlay(): readonly string[] | undefined {
    return this.states.get(profileActiveToolNamesOverlayKey);
  }

  private set activeToolNamesOverlay(value: readonly string[] | undefined) {
    this.states.set(profileActiveToolNamesOverlayKey, value);
  }

  private get agentsMdWarning(): string | undefined {
    return this.states.get(profileAgentsMdWarningKey);
  }

  private set agentsMdWarning(value: string | undefined) {
    this.states.set(profileAgentsMdWarningKey, value);
  }

  private get emittedThinkingEffortWarnings(): Set<string> {
    return this.states.get(profileEmittedThinkingEffortWarningsKey);
  }

  private get emittedToolPatternWarnings(): Set<string> {
    return this.states.get(profileEmittedToolPatternWarningsKey);
  }

  private get emittedPluginBudgetWarnings(): Set<string> {
    return this.states.get(profileEmittedPluginBudgetWarningsKey);
  }

  configure(options: ProfileServiceOptions): void {
    this.optionsValue = {
      emitStatusUpdated: options.emitStatusUpdated ?? this.optionsValue.emitStatusUpdated,
    };
  }

  update(changed: ProfileUpdateData): void {
    const { activeToolNames, ...configChanged } = changed;
    if (
      changed.profileName !== undefined &&
      this.activeProfile?.name !== changed.profileName
    ) {
      this.activeProfile = undefined;
    }
    if (Object.keys(configChanged).length > 0) {
      void this.dispatcher.dispatch(new ConfigUpdate(this.resolveConfigPayload(configChanged)));
      this.afterConfigDispatch(configChanged);
    }
    if (activeToolNames !== undefined) {
      this.setActiveTools(activeToolNames);
    }
  }

  applyBindingSnapshot(snapshot: ProfileBindingSnapshot): void {
    this.activeProfile = undefined;
    this.activeToolNamesOverlay = undefined;
    const agentsMdPaths =
      snapshot.agentsMdPaths ?? extractAgentsMdPathsFromSystemPrompt(snapshot.systemPrompt);
    void this.dispatcher.dispatch(
      new ProfileBind({
        modelAlias: snapshot.modelAlias,
        profileName: snapshot.profileName,
        routeId: snapshot.routeId,
        lockedModelAlias: snapshot.lockedModelAlias,
        lockedThinkingEffort: snapshot.lockedThinkingEffort,
        thinkingEffort: snapshot.thinkingLevel,
        serviceTier: snapshot.serviceTier,
        requestParams:
          snapshot.requestParams === undefined ? undefined : { ...snapshot.requestParams },
        systemPrompt: snapshot.systemPrompt,
        environmentDisclosure: snapshot.environmentDisclosure,
        renderGeneration: snapshot.renderGeneration,
        agentsMdPaths,
        activeToolNames: snapshot.activeToolNames,
        toolAllowPolicies: snapshot.toolAllowPolicies,
        disallowedTools: snapshot.disallowedTools ?? [],
        subagents: snapshot.subagents,
        subagentLeases: snapshot.subagentLeases,
        spawnPolicy: snapshot.spawnPolicy,
        appliedLease: snapshot.appliedLease,
      }),
    );
    this.afterConfigDispatch({
      modelAlias: snapshot.modelAlias,
      profileName: snapshot.profileName,
      thinkingLevel: snapshot.thinkingLevel,
      systemPrompt: snapshot.systemPrompt,
      environmentDisclosure: snapshot.environmentDisclosure,
      agentsMdPaths,
      disallowedTools: snapshot.disallowedTools ?? [],
    });
    this.agentsMdReminder.seedInjected(agentsMdPaths, this.sessionContext.cwd);
  }

  async bind(input: BindAgentInput): Promise<void> {
    await this.catalog.ready;
    await this.identity.resolved();
    const boundProfileName = this.profileName;
    if (
      boundProfileName !== undefined &&
      (input.profile !== undefined || input.route !== undefined)
    ) {
      this.assertBindable(input.profile ?? boundProfileName, input.route);
    }
    const selection =
      input.route === undefined
        ? (() => {
            const base =
              input.profile === DEFAULT_AGENT_PROFILE_NAME
                ? this.catalog.getDefault()
                : input.profile === undefined
                  ? undefined
                  : this.catalog.get(input.profile);
            if (base === undefined) {
              const available = this.catalog.list().map((item) => item.name).join(', ');
              throw new ProfileError(
                ProfileErrors.codes.PROFILE_UNKNOWN,
                `Unknown agent profile: "${input.profile ?? ''}". Available profiles: ${available}`,
                { profile: input.profile, available },
              );
            }
            return { profile: base, baseProfile: base, route: undefined };
          })()
        : this.catalog.resolveSelection({ profile: input.profile, route: input.route });
    const resolveId = aliasIdentity(this.models);
    const leased = applyLease(selection.profile, input.lease, resolveId);
    const profile = applySpawnPolicy(leased, input.spawnPolicy, resolveId);
    const spawnPolicy = intersectSpawnPolicy(
      input.spawnPolicy,
      selection.profile.spawnConstraints,
      resolveId,
    );
    const subagentLeases = selection.profile.subagentLeases;
    this.assertBindable(selection.baseProfile.name, selection.route?.id);
    const routeModelAlias = selection.route?.lockedModelAlias;
    const canonicalRouteModelAlias =
      routeModelAlias === undefined ? undefined : this.resolveModelId(routeModelAlias);
    if (
      routeModelAlias !== undefined &&
      input.model !== undefined &&
      this.resolveModelId(input.model) !== canonicalRouteModelAlias
    ) {
      throw new Error2(
        ErrorCodes.ROUTE_BINDING_CONFLICT,
        `Agent profile route "${selection.route!.id}" locks model_alias to "${routeModelAlias}"`,
      );
    }
    if (
      selection.route?.lockedThinkingEffort !== undefined &&
      input.thinking !== undefined &&
      input.thinking !== selection.route.lockedThinkingEffort
    ) {
      throw new Error2(
        ErrorCodes.ROUTE_BINDING_CONFLICT,
        `Agent profile route "${selection.route.id}" locks thinking_effort to "${selection.route.lockedThinkingEffort}"`,
      );
    }
    const requested = resolveMainModelCandidate({
      inputModel: input.model,
      routeLockedAlias: routeModelAlias,
      profileModelAlias: profile.modelAlias,
      defaultModel: this.config.get<string>('defaultModel'),
    });
    const requestedAlias = requested.alias;
    if (requestedAlias === undefined || requestedAlias === '') {
      throw new ProfileError(
        ProfileErrors.codes.MODEL_NOT_CONFIGURED,
        `model is required to bind profile "${selection.baseProfile.name}" (no default model configured)`,
      );
    }
    const alias = this.resolveModelId(requestedAlias);
    let model: Model;
    try {
      model = this.modelCatalog.get(alias);
    } catch (error) {
      if (routeModelAlias !== requestedAlias) throw error;
      throw new Error2(
        ErrorCodes.ROUTE_MODEL_ALIAS_MISSING,
        `Agent profile route "${selection.route!.id}" requires unavailable model alias "${routeModelAlias}"`,
        { details: { route: selection.route!.id, modelAlias: routeModelAlias }, cause: error },
      );
    }

    if (input.strictThinking === true && input.thinking !== undefined) {
      this.assertThinkingEffortSupported(input.thinking, model, alias);
    }

    await this.sessionToolPolicy.ready;
    const context = await this.buildSystemPromptContext(profile);
    this.assertBindable(selection.baseProfile.name, selection.route?.id);
    const currentProfileName = this.profileName;
    this.delegationPosition =
      input.delegationPosition ??
      (this.agentScope.agentId === MAIN_AGENT_ID ? 'main' : 'sub');
    const assembled = await this.assembleBoundSystemPrompt(profile, context, alias);
    const systemPrompt = assembled.text;
    this.cacheAgentsMdWarning(context);

    const matchedModelProfile = resolveModelProfileEntry(
      profile.modelProfiles,
      alias,
      (id) => this.models.resolveId(id),
    );
    const thinkingLevel = this.resolveThinkingEffort(
      resolveMainThinkingCandidate({
        inputThinking: input.thinking,
        routeLockedThinking: selection.route?.lockedThinkingEffort,
        modelProfileThinking: matchedModelProfile?.thinkingEffort,
        profileThinking: profile.thinkingEffort,
        sessionThinking: currentProfileName !== undefined ? this.thinkingLevel : undefined,
      }),
      model,
    );
    const resolvedRoute = selection.route;
    const lockedThinkingEffort = resolvedRoute?.lockedThinkingEffort;
    const normalizedLockedThinkingEffort = normalizeRequestedThinkingEffort(lockedThinkingEffort);
    if (
      lockedThinkingEffort !== undefined &&
      resolvedRoute !== undefined &&
      normalizedLockedThinkingEffort !== undefined &&
      thinkingLevel !== normalizedLockedThinkingEffort
    ) {
      throw new Error2(
        ErrorCodes.ROUTE_BINDING_CONFLICT,
        `Agent profile route "${resolvedRoute.id}" requires thinking_effort "${lockedThinkingEffort}", which model "${alias}" cannot honor`,
        {
          details: {
            route: resolvedRoute.id,
            modelAlias: alias,
            lockedThinkingEffort,
            resolvedThinkingEffort: thinkingLevel,
          },
        },
      );
    }

    if (requested.source === 'input' || input.thinking !== undefined) {
      for (const message of humanProfileDeviations({
        model: alias,
        thinking: thinkingLevel,
        constraints: roleConstraintsFromProfile(
          profile,
          spawnConstraintOrigin(input.lease, input.spawnPolicy),
        ),
        models: this.models,
        profileName: selection.baseProfile.name,
        checkModel: requested.source === 'input',
        checkThinking: input.thinking !== undefined,
      })) {
        this.emitDeviationWarning(message);
      }
    }

    if (this.delegationPosition !== 'main') {
      assertBoundModelAllowed(
        this.config,
        alias,
        roleConstraintsFromProfile(
          profile,
          spawnConstraintOrigin(input.lease, input.spawnPolicy),
        ),
        this.models,
        thinkingLevel,
      );
    }

    this.activeProfile = profile;
    this.activeToolNamesOverlay = undefined;
    await this.dispatcher.dispatch(new ProfileBind({
      modelAlias: alias,
      profileName: selection.baseProfile.name,
      routeId: selection.route?.id,
      lockedModelAlias: canonicalRouteModelAlias,
      lockedThinkingEffort: selection.route?.lockedThinkingEffort,
      thinkingEffort: thinkingLevel,
      serviceTier: profile.serviceTier,
      requestParams:
        profile.requestParams === undefined ? undefined : { ...profile.requestParams },
      systemPrompt,
      environmentDisclosure: assembled.environment,
      agentsMdPaths: context.agentsMdPaths ?? [],
      activeToolNames: profile.tools,
      toolAllowPolicies: profile.toolAllowPolicies,
      disallowedTools: profile.disallowedTools ?? [],
      subagents: profile.subagents,
      subagentLeases,
      spawnPolicy,
      appliedLease: input.lease,
    }));
    this.afterConfigDispatch({
      modelAlias: alias,
      profileName: profile.name,
      thinkingLevel,
      systemPrompt,
      disallowedTools: profile.disallowedTools ?? [],
    });
    this.seedAgentsMdReminder(context);

    this.publishAgentsMdWarning();
    this.publishToolPatternWarnings(profile);
  }

  async setModel(alias: string): Promise<ProfileSetModelResult> {
    const canonicalAlias = this.resolveModelId(alias);
    if (
      this.profileState.lockedModelAlias !== undefined &&
      canonicalAlias !== this.profileState.lockedModelAlias
    ) {
      this.emitDeviationWarning(
        routeModelOverrideMessage(
          this.routeId,
          this.profileState.lockedModelAlias,
          canonicalAlias,
        ),
      );
    }
    const model = this.modelCatalog.get(canonicalAlias);
    if (this.profileName === undefined) {
      await this.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: canonicalAlias });
      this.telemetry.track2('model_switch', { model: canonicalAlias });
    } else if (this.modelAlias !== canonicalAlias) {
      const previousAlias = this.modelAlias;
      this.update({ modelAlias: canonicalAlias });
      this.telemetry.track2('model_switch', { model: canonicalAlias });
      if (
        this.declaresCognitionOverlay(previousAlias) ||
        this.declaresCognitionOverlay(canonicalAlias) ||
        this.declaresModelProfilePrompt(previousAlias) ||
        this.declaresModelProfilePrompt(canonicalAlias)
      ) {
        await this.refreshSystemPrompt();
      }
    }
    if (this.activeProfile !== undefined) {
      for (const message of humanProfileDeviations({
        model: canonicalAlias,
        thinking: this.thinkingLevel,
        constraints: roleConstraintsFromProfile(this.activeProfile),
        models: this.models,
        profileName: this.activeProfile.name,
        checkThinking: false,
      })) {
        this.emitDeviationWarning(message);
      }
    }
    return {
      model: canonicalAlias,
      providerName: model.providerName,
    };
  }

  setThinking(level: string): void {
    if (
      this.profileState.lockedThinkingEffort !== undefined &&
      level !== this.profileState.lockedThinkingEffort
    ) {
      this.emitDeviationWarning(
        routeThinkingOverrideMessage(
          this.routeId,
          this.profileState.lockedThinkingEffort,
          level,
        ),
      );
    }
    const previousEffort = this.thinkingLevel;
    this.assertThinkingEffortSupported(level, this.tryResolveRawModel(), this.modelAlias ?? '');
    const normalized = normalizeRequestedThinkingEffort(level);
    this.update({ thinkingLevel: normalized ?? level });
    const effort = this.thinkingLevel;
    if (this.activeProfile !== undefined && this.modelAlias !== undefined) {
      for (const message of humanProfileDeviations({
        model: this.modelAlias,
        thinking: effort,
        constraints: roleConstraintsFromProfile(this.activeProfile),
        models: this.models,
        profileName: this.activeProfile.name,
        checkModel: false,
      })) {
        this.emitDeviationWarning(message);
      }
    }
    if (effort !== previousEffort) {
      this.telemetry.track2('thinking_toggle', {
        enabled: effort !== 'off',
        effort,
        from: previousEffort,
      });
    }
  }

  private assertThinkingEffortSupported(
    requested: string,
    model: Model | undefined,
    modelAlias: string,
  ): void {
    const normalized = normalizeRequestedThinkingEffort(requested);
    if (normalized === undefined || this.supportsThinkingEffort(normalized, model)) return;
    const efforts = model?.supportEfforts ?? [];
    const supported = efforts.length === 0 ? 'off' : ['off', ...efforts].join(', ');
    throw new ProfileError(
      ProfileErrors.codes.MODEL_CONFIG_INVALID,
      `Thinking effort "${requested}" is not supported by model "${modelAlias}". Supported efforts: ${supported}.`,
    );
  }

  getModel(): string {
    return this.modelAlias ?? '';
  }

  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void {
    this.activeProfile = profile;
    const rendered = profile.renderSystemPrompt(context);
    this.update({
      profileName: profile.name,
      systemPrompt: injectDelegationContext(rendered.text, undefined),
      environmentDisclosure: rendered.environment,
      agentsMdPaths: context.agentsMdPaths ?? [],
      disallowedTools: profile.disallowedTools ?? [],
    });
    this.setActiveTools(profile.tools);
  }

  async applyProfile(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<void> {
    const context = await this.buildSystemPromptContext(profile, options);
    this.activeProfile = profile;
    const assembled = await this.assembleBoundSystemPrompt(
      profile,
      context,
      this.modelAlias ?? '',
    );
    this.update({
      profileName: profile.name,
      systemPrompt: assembled.text,
      environmentDisclosure: assembled.environment,
      agentsMdPaths: context.agentsMdPaths ?? [],
      disallowedTools: profile.disallowedTools ?? [],
    });
    this.setActiveTools(profile.tools);
    this.seedAgentsMdReminder(context);
    this.cacheAgentsMdWarning(context);
    this.publishAgentsMdWarning();
    this.publishToolPatternWarnings(profile);
  }

  async refreshSystemPrompt(): Promise<void> {
    const profile = this.resolveActiveProfile();
    if (profile === undefined) return;

    try {
      const context = await this.buildSystemPromptContext(profile);
      this.activeProfile = profile;
      const assembled = await this.assembleBoundSystemPrompt(
        profile,
        context,
        this.modelAlias ?? '',
      );
      this.update({
        profileName: profile.name,
        systemPrompt: assembled.text,
        environmentDisclosure: assembled.environment,
        agentsMdPaths: context.agentsMdPaths ?? [],
      });
      this.seedAgentsMdReminder(context);
      this.cacheAgentsMdWarning(context);
      this.publishAgentsMdWarning();
    } catch (error) {
      void this.dispatcher.dispatch(
        new WarningIssued({
          message: `System prompt refresh skipped: ${error instanceof Error ? error.message : String(error)}`,
          code: 'system-prompt-refresh-failed',
        }),
      );
      return;
    }
  }

  private declaresCognitionOverlay(modelAlias: string | undefined): boolean {
    if (modelAlias === undefined || modelAlias.length === 0) return false;
    return cognitionPathRefs(this.models.get(modelAlias)?.cognition?.overlay).length > 0;
  }

  private declaresModelProfilePrompt(modelAlias: string | undefined): boolean {
    return declaresModelProfilePrompt(
      this.activeProfile?.modelProfiles,
      modelAlias,
      (id) => this.models.resolveId(id),
    );
  }

  private emitDeviationWarning(message: string): void {
    if (this.emittedDeviationWarnings.has(message)) return;
    this.emittedDeviationWarnings.add(message);
    void this.dispatcher.dispatch(
      new WarningIssued({
        code: 'profile-constraint-override',
        message,
      }),
    );
  }

  private async assembleBoundSystemPrompt(
    profile: ResolvedAgentProfile,
    context: SystemPromptContext,
    alias: string,
  ): Promise<{ readonly text: string; readonly environment: EnvironmentDisclosureSnapshot }> {
    const rendered = profile.renderSystemPrompt(context);
    const withModel = applyMatchedModelProfilePrompt(
      rendered.text,
      profile.modelProfiles,
      alias,
      (id) => this.models.resolveId(id),
    );
    let snippet: string | undefined;
    try {
      snippet = await resolveDelegationSnippet({
        position: this.delegationPosition,
        notice: profile.delegationNotice,
        config: this.config.get<AgentsConfig | undefined>(AGENTS_SECTION)?.delegation,
        fs: this.hostFs,
        homeDir: this.bootstrap.homeDir,
        pathClass: this.hostEnv.pathClass,
      });
    } catch (error) {
      if (error instanceof DelegationFileError) {
        throw new ProfileError(
          error.reason === 'missing' || error.reason === 'empty'
            ? ProfileErrors.codes.DELEGATION_FILE_MISSING
            : ProfileErrors.codes.DELEGATION_PATH_INVALID,
          error.message,
          { slot: error.slot, path: error.ref, reason: error.reason },
        );
      }
      throw error;
    }
    const withDelegation = injectDelegationContext(withModel, snippet);
    return {
      text: await this.applyCognitionOverlay(withDelegation, alias),
      environment: rendered.environment,
    };
  }

  private async applyCognitionOverlay(base: string, modelAlias: string): Promise<string> {
    if (modelAlias.length === 0) return base;
    const record = this.models.get(modelAlias);
    try {
      const slots = await loadCognitionSlots(
        this.hostFs,
        this.bootstrap.homeDir,
        record?.cognition,
        this.hostEnv.pathClass,
      );
      return applyOverlay(base, slots.overlay, record?.cognition?.overlayMode ?? 'append');
    } catch (error) {
      if (error instanceof CognitionFileError) {
        throw new ProfileError(
          error.reason === 'missing'
            ? ProfileErrors.codes.COGNITION_FILE_MISSING
            : ProfileErrors.codes.COGNITION_PATH_INVALID,
          error.message,
          { slot: error.slot, path: error.ref, reason: error.reason },
        );
      }
      throw error;
    }
  }

  private seedAgentsMdReminder(context: SystemPromptContext): void {
    this.agentsMdReminder.seedInjected(
      context.agentsMdPaths ?? [],
      context.cwd ?? this.sessionContext.cwd,
    );
  }

  getAgentsMdWarning(): string | undefined {
    return this.agentsMdWarning;
  }

  data(): ProfileData {
    const model = this.tryResolveRawModel();
    return {
      modelAlias: this.modelAlias,
      modelCapabilities: model?.capabilities ?? UNKNOWN_CAPABILITY,
      profileName: this.profileName,
      routeId: this.routeId,
      lockedModelAlias: this.profileState.lockedModelAlias,
      lockedThinkingEffort: this.profileState.lockedThinkingEffort,
      thinkingLevel: this.thinkingLevel,
      systemPrompt: this.systemPrompt,
      agentsMdPaths: this.profileState.agentsMdPaths,
      activeToolNames: this.activeToolNames === undefined ? undefined : [...this.activeToolNames],
      toolAllowPolicies: this.profileState.toolAllowPolicies?.map((policy) => [...policy]),
      disallowedTools: [...(this.profileState.disallowedTools ?? [])],
      subagents:
        this.profileState.subagents === undefined ? undefined : [...this.profileState.subagents],
      subagentLeases: this.profileState.subagentLeases,
      spawnPolicy: this.profileState.spawnPolicy,
      appliedLease: this.profileState.appliedLease,
      serviceTier: this.serviceTier,
      requestParams:
        this.requestParams === undefined ? undefined : { ...this.requestParams },
      environmentDisclosure: this.profileState.environmentDisclosure,
      renderGeneration: this.profileState.renderGeneration,
    };
  }

  getEffectiveThinkingLevel(): ThinkingEffort {
    return this.resolveThinkingState(this.tryResolveRawModel()).effective;
  }

  resolveModelContext(): ProfileModelContext {
    const modelAlias = this.model;
    const model = this.modelCatalog.get(modelAlias);
    const loopControl = this.config.get<LoopControl>('loopControl');
    return {
      modelAlias,
      modelCapabilities: model.capabilities,
      maxOutputSize: model.maxOutputSize,
      alwaysThinking: model.alwaysThinking || undefined,
      thinkingLevel: this.resolveThinkingState(model).effective,
      reservedContextSize: loopControl?.reservedContextSize,
      compactionTriggerRatio: loopControl?.compactionTriggerRatio,
    };
  }

  resolveRequestParams(): ModelRequestParams {
    const model = this.tryResolveRawModel();
    const thinking = this.resolveThinkingState(model);
    const thinkingConfig = this.config.get<ThinkingConfig>(THINKING_SECTION);
    const overrides = this.config.get<ModelOverrides>('modelOverrides');
    const sampling: SamplingOptions = {
      temperature: overrides?.temperature,
      topP: overrides?.topP,
    };
    let params: ModelRequestParams = {
      cacheKey: this.sessionContext.sessionId,
      sampling:
        sampling.temperature === undefined && sampling.topP === undefined ? undefined : sampling,
      thinkingEffort: thinking.effective,
      thinkingKeep: resolveThinkingKeep(
        overrides?.thinkingKeep,
        thinkingConfig?.keep,
        thinking.effective,
      ),
    };
    const serviceTier = this.serviceTier;
    if (serviceTier !== undefined) params = { ...params, serviceTier };
    const requestParams = this.requestParams;
    if (requestParams !== undefined) {
      params = { ...params, requestParams: { ...requestParams } };
    }
    return params;
  }

  getModelCapabilities(): ModelCapability {
    return this.tryResolveRawModel()?.capabilities ?? UNKNOWN_CAPABILITY;
  }

  getMaxOutputSize(): number | undefined {
    return this.tryResolveRawModel()?.maxOutputSize;
  }

  hasModel(): boolean {
    return this.modelAlias !== undefined;
  }

  isRunnable(): boolean {
    return this.profileName !== undefined && this.hasModel();
  }

  hasProvider(): boolean {
    return this.tryResolveRawModel() !== undefined;
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  getActiveToolNames(): readonly string[] | undefined {
    return this.activeToolNames;
  }

  addActiveTool(name: string): void {
    const activeToolNames = this.activeToolNames;
    if (activeToolNames === undefined || activeToolNames.includes(name)) return;
    this.activeToolNamesOverlay = [...activeToolNames, name];
  }

  removeActiveTool(name: string): void {
    const activeToolNames = this.activeToolNames;
    if (activeToolNames === undefined || !activeToolNames.includes(name)) return;
    this.activeToolNamesOverlay = activeToolNames.filter((candidate) => candidate !== name);
  }

  private resolveConfigPayload(
    changed: Omit<ProfileUpdateData, 'activeToolNames'>,
  ): ConfigUpdatePayload {
    const payload: ConfigUpdatePayload = {};
    if (changed.modelAlias !== undefined) payload.modelAlias = changed.modelAlias;
    if (changed.profileName !== undefined) payload.profileName = changed.profileName;
    if (changed.thinkingLevel !== undefined || changed.modelAlias !== undefined) {
      const model = this.resolveModelForThinking(changed.modelAlias ?? this.modelAlias);
      const requested =
        changed.thinkingLevel ?? (this.modelAlias === undefined ? undefined : this.thinkingLevel);
      payload.thinkingEffort = this.resolveThinkingEffort(requested, model);
    }
    if (changed.systemPrompt !== undefined) {
      payload.systemPrompt = changed.systemPrompt;
      if (changed.environmentDisclosure !== undefined) {
        payload.environmentDisclosure = changed.environmentDisclosure;
      }
    }
    if (changed.agentsMdPaths !== undefined) {
      payload.agentsMdPaths = [...changed.agentsMdPaths];
    }
    if (changed.disallowedTools !== undefined) {
      payload.disallowedTools = [...changed.disallowedTools];
    }
    return payload;
  }

  private afterConfigDispatch(changed: Omit<ProfileUpdateData, 'activeToolNames'>): void {
    if (changed.modelAlias !== undefined) {
      const model = this.tryResolveRawModel();
      this.telemetryContext.set({
        provider_type: model?.providerType ?? model?.protocol,
        protocol: model?.protocol,
      });
    }
    if (changed.modelAlias !== undefined || changed.thinkingLevel !== undefined) {
      this.warnAboutAnthropicThinkingEffort();
    }
    this.emitStatusUpdated(
      changed.modelAlias !== undefined || changed.thinkingLevel !== undefined,
    );
  }

  private warnAboutAnthropicThinkingEffort(): void {
    try {
      const model = this.tryResolveRawModel();
      if (model?.protocol !== 'anthropic') return;
      const effort = this.getEffectiveThinkingLevel();
      if (effort === 'on' || effort === 'off') return;

      let code: string;
      let message: string;
      let knownEfforts = '';
      const efforts = model.supportEfforts?.filter((value) => value.length > 0);
      if (efforts === undefined || efforts.length === 0 || efforts.includes(effort)) return;
      knownEfforts = efforts.join(',');
      code = 'anthropic-thinking-effort-not-listed';
      message = `Thinking effort "${effort}" is not listed for model "${model.name}" (known: ${efforts.join(', ')}). The configured value will be sent unchanged to the Anthropic-compatible backend.`;

      const key = [code, model.id, model.name, effort, knownEfforts].join('\u0000');
      if (this.emittedThinkingEffortWarnings.has(key)) return;
      this.emittedThinkingEffortWarnings.add(key);
      void this.dispatcher.dispatch(new WarningIssued({ code, message }));
    } catch {
    }
  }

  private setActiveTools(names: readonly string[] | undefined): void {
    this.activeToolNamesOverlay = undefined;
    if (names === undefined) {
      void this.dispatcher.dispatch(new ToolsResetActiveTools({}));
      return;
    }
    void this.dispatcher.dispatch(new ToolsSetActiveTools({ names: [...names] }));
  }

  private emitStatusUpdated(includeThinkingEffort = false): void {
    const custom = this.optionsValue.emitStatusUpdated;
    if (custom !== undefined) {
      custom();
      return;
    }
    const modelAlias = this.modelAlias;
    if (modelAlias === undefined) return;
    const capabilities = this.tryResolveRawModel()?.capabilities;
    const maxContextTokens = capabilities?.max_input_tokens ?? capabilities?.max_context_tokens;
    void this.dispatcher.dispatch(
      new AgentStatusUpdated({
        model: modelAlias,
        thinkingEffort: includeThinkingEffort
          ? this.getEffectiveThinkingLevel()
          : undefined,
        maxContextTokens:
          maxContextTokens !== undefined && maxContextTokens > 0 ? maxContextTokens : undefined,
      }),
    );
  }

  republishStatus(): void {
    this.emitStatusUpdated(true);
  }

  private get profileState(): ProfileModelState {
    return this.states.get(profileKey);
  }

  private get model(): string {
    const modelAlias = this.modelAlias;
    if (modelAlias === undefined) {
      throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Model not set');
    }
    return modelAlias;
  }

  private get modelAlias(): string | undefined {
    return this.profileState.modelAlias;
  }

  private get profileName(): string | undefined {
    return this.profileState.profileName;
  }

  private get routeId(): string | undefined {
    return this.profileState.routeId;
  }

  private get serviceTier(): ServiceTier | undefined {
    return this.activeProfile === undefined
      ? this.profileState.serviceTier
      : this.activeProfile.serviceTier;
  }

  private get requestParams(): RequestParams | undefined {
    return this.activeProfile === undefined
      ? this.profileState.requestParams
      : this.activeProfile.requestParams;
  }

  private get systemPrompt(): string {
    return this.profileState.systemPrompt;
  }

  private get thinkingLevel(): ThinkingEffort {
    const stored = this.profileState.thinkingLevel;
    if (stored === 'off' && this.alwaysThinkingModel) {
      return this.resolveThinkingEffort(stored, this.tryResolveRawModel());
    }
    return stored;
  }

  private resolveThinkingState(model: Model | undefined): {
    readonly effective: ThinkingEffort;
    readonly forced: ThinkingEffort | undefined;
  } {
    const base = this.thinkingLevel;
    const forced = resolveForcedThinkingEffort(
      this.config.get<ThinkingConfig>(THINKING_SECTION)?.forcedEffort,
      base,
      drivesThinkingThroughTraits(model?.providerType),
    );
    return { effective: forced ?? base, forced };
  }

  private strictThinkingValidation(model: Model | undefined): boolean {
    if (model === undefined) return false;
    return requiresStrictThinkingValidation(
      this.protocolAdapters,
      model.protocol,
      model.providerType,
    );
  }

  private resolveThinkingEffort(
    requested: string | undefined,
    model: Model | undefined,
  ): ThinkingEffort {
    return resolveThinkingEffortForModel(
      requested,
      this.config.get<ThinkingConfig>(THINKING_SECTION),
      model,
      this.strictThinkingValidation(model),
    );
  }

  private supportsThinkingEffort(effort: ThinkingEffort, model: Model | undefined): boolean {
    return modelSupportsThinkingEffort(effort, model, this.strictThinkingValidation(model));
  }

  private get alwaysThinkingModel(): boolean {
    return this.tryResolveRawModel()?.alwaysThinking === true;
  }

  private resolveModelId(alias: string): string {
    return this.models.resolveId(alias) ?? alias;
  }

  private tryResolveRawModel(): Model | undefined {
    const alias = this.modelAlias;
    return this.resolveModelForThinking(alias);
  }

  private resolveModelForThinking(alias: string | undefined): Model | undefined {
    if (alias === undefined) return undefined;
    try {
      return this.modelCatalog.get(alias);
    } catch {
      return undefined;
    }
  }

  private assertBindable(requested: string, requestedRoute?: string): void {
    const current = this.profileName;
    if (current !== undefined && current !== requested) {
      throw new ProfileError(
        ProfileErrors.codes.PROFILE_ALREADY_BOUND,
        `agent is already bound to profile "${current}"; cannot switch to "${requested}" in this session`,
        { current, requested },
      );
    }
    const currentRoute = this.routeId;
    if (current !== undefined && currentRoute !== requestedRoute) {
      throw new Error2(
        ErrorCodes.ROUTE_SWITCH_FORBIDDEN,
        `agent route is already bound to "${currentRoute ?? 'base'}"; cannot switch to "${requestedRoute ?? 'base'}" in this session`,
        { details: { currentRoute, requestedRoute } },
      );
    }
  }

  private resolveActiveProfile(): ResolvedAgentProfile | undefined {
    if (this.activeProfile !== undefined) return this.activeProfile;
    const profileName = this.profileName;
    if (profileName === undefined) return undefined;
    if (this.routeId !== undefined) return undefined;
    const catalogProfile =
      profileName === DEFAULT_AGENT_PROFILE_NAME
        ? this.catalog.getDefault()
        : this.catalog.get(profileName);
    if (catalogProfile === undefined) return undefined;
    return applyLease(
      catalogProfile,
      this.profileState.appliedLease,
      aliasIdentity(this.models),
    );
  }

  private cacheAgentsMdWarning(context: Pick<SystemPromptContext, 'agentsMdWarning'>): void {
    this.agentsMdWarning = context.agentsMdWarning;
  }

  private publishAgentsMdWarning(): void {
    const warning = this.agentsMdWarning;
    if (warning === undefined) return;
    void this.dispatcher.dispatch(
      new WarningIssued({
        message: warning,
        code: 'agents-md-oversized',
      }),
    );
  }

  private publishToolPatternWarnings(profile?: ResolvedAgentProfile): void {
    const known = new Set<string>();
    for (const contribution of getAgentToolContributions()) known.add(contribution.options.name);
    for (const ref of this.toolRegistry.listReferences()) known.add(ref.name);
    for (const builtin of this.builtinProfiles.list()) {
      for (const name of literalToolNames([
        ...(builtin.tools ?? []),
        ...(builtin.disallowedTools ?? []),
      ])) {
        known.add(name);
      }
    }
    const checks: {
      context: string;
      field: string;
      patterns: readonly string[] | undefined;
    }[] = [];
    if (profile !== undefined) {
      checks.push(
        { context: `profile "${profile.name}"`, field: 'tools', patterns: profile.tools },
        {
          context: `profile "${profile.name}"`,
          field: 'disallowedTools',
          patterns: profile.disallowedTools,
        },
      );
      for (const [index, patterns] of (profile.toolAllowPolicies ?? []).entries()) {
        checks.push({
          context:
            profile.routeId === undefined
              ? `profile "${profile.name}"`
              : `profile route "${profile.routeId}"`,
          field: `tools policy layer ${String(index + 1)}`,
          patterns,
        });
      }
    }
    const global = this.config.get<ToolsConfig>(TOOLS_SECTION);
    checks.push(
      { context: 'the global [tools] config', field: 'enabled', patterns: global?.enabled },
      { context: 'the global [tools] config', field: 'disabled', patterns: global?.disabled },
    );
    for (const { context, field, patterns } of checks) {
      if (patterns === undefined) continue;
      for (const issue of findInactiveToolPatterns(patterns, (name) => known.has(name))) {
        const key = `${context}|${field}|${issue.pattern}`;
        if (this.emittedToolPatternWarnings.has(key)) continue;
        this.emittedToolPatternWarnings.add(key);
        void this.dispatcher.dispatch(
          new WarningIssued({
            code: 'tool-pattern-no-match',
            message: describeInactiveToolPattern(context, field, issue),
          }),
        );
      }
    }
  }

  private async buildSystemPromptContext(
    profile: ResolvedAgentProfile,
    options?: ApplyProfileOptions,
  ): Promise<SystemPromptContext> {
    const preloadedAgentsMd = await this.workspaceInstructionsSnapshot();
    const fsAvailable = this.runtime.isAvailable(['fs']);
    const lease = this.runtime.acquire(fsAvailable ? ['fs'] : []);
    const env = lease.runtime.environment;
    const view = new RuntimeWorkspaceView(lease.runtime, {
      workDir: this.sessionContext.cwd,
      additionalDirs: options?.additionalDirs ?? this.workspace.additionalDirs,
    });
    let base: SystemPromptContext;
    try {
      base = !fsAvailable
        ? {}
        : await prepareSystemPromptContext(
            { fs: lease.runtime.fs!, homeDir: env.homeDir },
            view.workDir,
            this.bootstrap.homeDir,
            {
              additionalDirs: view.additionalDirs,
              preloadedAgentsMd,
            },
          );
    } finally {
      lease.dispose();
    }
    const skills = await this.resolveSkillListing();
    const pluginSections = await this.resolvePluginSections();
    const now = this.clock.now();
    const timeZone = this.clock.timeZone();
    return {
      ...base,
      cwd: view.workDir,
      osKind: env.osKind,
      shellName: env.shellName,
      shellPath: env.shellPath,
      now: now.toISOString(),
      timeZone,
      skills,
      pluginSections,
      skillActive: this.isToolActiveForProfile(profile, 'Skill'),
      productName: (await this.identity.resolved()).displayName,
      replyStyleGuide: this.bootstrap.args.replyStyleGuide,
    };
  }

  private async workspaceInstructionsSnapshot(): Promise<LoadedAgentsMd> {
    await this.instructions.ready;
    return {
      content: this.instructions.agentsMd ?? '',
      warning: this.instructions.agentsMdWarning,
      paths: this.instructions.agentsMdPaths ?? [],
    };
  }

  private isToolActiveForProfile(
    profile: ResolvedAgentProfile,
    name: string,
    source: ToolSource = 'builtin',
  ): boolean {
    return isToolActiveComposed(
      {
        workspaceDisabledTools: this.toolPolicyGate.disabledTools,
        profile,
        global: this.config.get<ToolsConfig>(TOOLS_SECTION),
        sessionDisabledTools: this.sessionToolPolicy.disabledTools(),
      },
      name,
      source,
    );
  }

  private async resolveSkillListing(): Promise<string> {
    if (this.frozenSkillListing !== undefined) return this.frozenSkillListing;
    try {
      await this.skillCatalog.ready;
      const listing = this.skillCatalog.catalog.getModelSkillListing();
      this.frozenSkillListing = listing;
      return listing;
    } catch {
      return '';
    }
  }

  private async resolvePluginSections(): Promise<string> {
    if (this.frozenPluginSections !== undefined) return this.frozenPluginSections;
    const sections = await this.plugins.enabledSystemPrompts();
    const parts: string[] = [];
    const skipped: string[] = [];
    let totalBytes = 0;
    for (const section of sections) {
      const block = `<!-- From: plugin ${section.pluginId} -->\n${section.content}`;
      const bytes = Buffer.byteLength(block, 'utf8');
      if (totalBytes + bytes > PLUGIN_SECTIONS_MAX_BYTES) {
        skipped.push(section.pluginId);
        continue;
      }
      totalBytes += bytes;
      parts.push(block);
    }
    if (skipped.length > 0) {
      const newlySkipped = skipped.filter((id) => !this.emittedPluginBudgetWarnings.has(id));
      if (newlySkipped.length > 0) {
        for (const id of newlySkipped) this.emittedPluginBudgetWarnings.add(id);
        void this.dispatcher.dispatch(
          new WarningIssued({
            message:
              `Plugin system-prompt contributions from ${newlySkipped.map((id) => `"${id}"`).join(', ')} ` +
              `were skipped: the aggregate ${PLUGIN_SECTIONS_MAX_BYTES / 1024} KB budget is exhausted.`,
            code: 'plugin-sections-oversized',
          }),
        );
      }
    }
    const resolved = parts.join('\n\n');
    if (this.plugins.hasLoadedSnapshot()) this.frozenPluginSections = resolved;
    return resolved;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentProfileService,
  AgentProfileService,
  ScopeActivation.OnScopeCreated,
  'profile',
);
