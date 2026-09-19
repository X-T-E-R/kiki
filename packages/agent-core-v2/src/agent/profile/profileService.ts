import type {
  ExecutorBinding,
  ExecutorValidationResult,
} from '@kiki/agent-profiles/ports';

import { type CollectionView } from '#/_base/di/collection';
import { createHash } from 'node:crypto';
import { applyFileCallerCeiling, freezeBoundProfile } from './boundProfile';
import { assertResearchExecutor, RESEARCH_READONLY_TOOLS } from './executionRestriction';
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
import { MODELS_SECTION, THINKING_SECTION } from '#/app/kosongConfig/configSection';
import {
  DEFAULT_AGENT_PROFILE_NAME,
  type AgentProfileContext,
  type EnvironmentDisclosureSnapshot,
  type ResolvedAgentProfileRoute,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { ErrorCodes, Error2 } from "#/errors";
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import {
  IAgentExecutorRegistry,
  type ResolvedAgentExecutor,
} from '#/app/agentExecutor/agentExecutor';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { AGENTS_SECTION, type AgentsConfig } from '#/session/agentCollaboration/configSection';
import {
  injectDelegationContext,
  resolveDelegationSnippet,
  type DelegationPosition,
} from '#/agent/profile/delegationContext';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { PROMPT_SECTION, type PromptConfig } from '#/app/prompt/configSection';
import { appendSharedPromptField } from '#/app/promptField/builtinPromptFields';
import {
  IPromptFieldRegistry,
  type ResolvedPromptFieldOverrides,
} from '#/app/promptField/promptFieldRegistry';
import { customPromptVariables } from '@kiki/agent-profiles/promptConfig';
import { renderPrompt } from '@kiki/agent-profiles/renderPrompt';
import { agentProfileFromFile } from '@kiki/agent-profiles/agentProfileFromFile';
import { resolveAgentProfileRoute } from '@kiki/agent-profiles/agentProfileRoute';
import { restoreProfileFileSources } from '#/session/dispatch/profileFile';
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
  resolveProfileThinkingDefault,
  mergeModelParameters,
} from '#/app/agentProfileCatalog/modelProfileOverlay';
import {
  aliasIdentity,
  applyLease,
  applySpawnPolicy,
  intersectSpawnPolicy,
  spawnConstraintOrigin,
} from '#/app/agentProfileCatalog/applySubagentLease';
import { resolveSnapshotProfileDefinition } from '#/app/agentProfileCatalog/subagentDispatch';
import type {
  SpawnConstraints,
  SubagentLease,
} from '#/app/agentProfileCatalog/subagentLease';
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
import {
  AgentToolContribution,
  getAgentToolContributions,
} from '#/agent/toolRegistry/toolContribution';
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
  private activeProfileDefinitionId: string | undefined;
  private readonly emittedDeviationWarnings = new Set<string>();
  private delegationPosition: DelegationPosition = 'main';
  private promptFieldSnapshot: ResolvedPromptFieldOverrides = { values: {}, fields: [] };

  private frozenSkillListing: string | undefined;
  private frozenPluginSections: string | undefined;
  private systemPromptRefreshTail: Promise<void> = Promise.resolve();

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentTelemetryContextService private readonly telemetryContext: IAgentTelemetryContextService,
    @IConfigService private readonly config: IConfigService,
    @IPromptFieldRegistry private readonly promptFields: IPromptFieldRegistry,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IModelService private readonly models: IModelService,
    @IAgentExecutorRegistry private readonly executors: IAgentExecutorRegistry,
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
    @AgentToolContribution private readonly toolContributions: CollectionView<AgentToolContribution>,
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
        if (domain === PROMPT_SECTION || domain === MODELS_SECTION || domain === AGENTS_SECTION) {
          this.promptConfigurationSignature = 'invalidated';
        }
        if (domain === TOOLS_SECTION) {
          this.publishToolPatternWarnings();
          void this.refreshSystemPrompt();
        }
      }),
    );
    this._register(this.promptFields.onDidChange(() => {
      this.promptConfigurationSignature = 'invalidated';
    }));
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
    const { activeToolNames, ...requestedConfigChanged } = changed;
    let configChanged = requestedConfigChanged;
    if (
      this.isExternalExecutor &&
      (configChanged.modelAlias !== undefined || configChanged.thinkingLevel !== undefined)
    ) {
      const binding = this.requireValidBinding(
        this.validateBinding({
          modelAlias: configChanged.modelAlias,
          thinkingEffort: configChanged.thinkingLevel,
        }),
      );
      configChanged = {
        ...configChanged,
        modelAlias: binding.modelAlias,
        thinkingLevel: binding.thinkingEffort,
      };
    }
    if (
      changed.profileName !== undefined &&
      this.activeProfile?.name !== changed.profileName
    ) {
      this.activeProfile = undefined;
      this.activeProfileDefinitionId = undefined;
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
    const executionRestriction = this.profileState.executionRestriction ?? snapshot.executionRestriction;
    assertResearchExecutor(executionRestriction, snapshot.executorId);
    this.activeProfile = undefined;
    this.promptConfigurationSignature = undefined;
    this.activeProfileDefinitionId = snapshot.profileDefinitionId;
    this.activeToolNamesOverlay = undefined;
    const agentsMdPaths = extractAgentsMdPathsFromSystemPrompt(snapshot.systemPrompt);
    void this.dispatcher.dispatch(
      new ProfileBind({
        executionRestriction,
        modelAlias: snapshot.modelAlias,
        profileName: snapshot.profileName,
        profileDefinitionId: snapshot.profileDefinitionId,
        routeId: snapshot.routeId,
        lockedModelAlias: snapshot.lockedModelAlias,
        lockedThinkingEffort: snapshot.lockedThinkingEffort,
        executorId: snapshot.executorId,
        executorProtocol: snapshot.executorProtocol,
        executorOptions: snapshot.executorOptions,
        executorDescriptorRevision: snapshot.executorDescriptorRevision,
        thinkingEffort: snapshot.thinkingLevel,
        thinkingEffortAdjusted: snapshot.thinkingEffortAdjusted,
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
        disabledToolGroups: snapshot.disabledToolGroups,
        subagents: snapshot.subagents,
        subagentLeases: snapshot.subagentLeases,
        spawnPolicy: snapshot.spawnPolicy,
        appliedLease: snapshot.appliedLease,
        boundProfile: snapshot.boundProfile,
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
      this.assertRouteBindable(input.route);
    }
    const selection =
      input.resolvedProfile !== undefined
        ? {
            profile: input.resolvedRoute?.effectiveProfile ?? input.resolvedProfile,
            baseProfile: input.resolvedProfile,
            route: input.resolvedRoute,
          }
        : input.route === undefined
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
    const executionRestriction = this.profileState.executionRestriction ?? input.executionRestriction;
    assertResearchExecutor(executionRestriction, selection.profile.executor);
    const executor = await this.executors.resolveExecutable(
      selection.profile.executor,
      selection.profile.executorOptions,
    );
    assertResearchExecutor(executionRestriction, executor.descriptor.id);
    const external = executor.descriptor.id !== 'native';
    const resolveId = external
      ? (id: string): string => id
      : aliasIdentity(this.models);
    const routedProfile = selection.route === undefined ? selection.profile : {
      ...selection.profile,
      thinkingEffort: selection.route.lockedThinkingEffort ?? resolveProfileThinkingDefault(
        selection.baseProfile, selection.profile.modelAlias ?? '', resolveId ?? ((id) => id),
      ),
    };
    const leased = applyLease(routedProfile, input.lease, resolveId);
    const effectiveProfile = applyFileCallerCeiling(applySpawnPolicy(leased, input.spawnPolicy, resolveId));
    const profile = executionRestriction === 'research-readonly'
      ? { ...effectiveProfile, toolAllowPolicies: [...(effectiveProfile.toolAllowPolicies ?? []), RESEARCH_READONLY_TOOLS] }
      : effectiveProfile;
    const spawnPolicy = intersectSpawnPolicy(
      input.spawnPolicy,
      selection.profile.spawnConstraints,
      resolveId,
    );
    const subagentLeases = selection.profile.subagentLeases;
    this.assertRouteBindable(selection.route?.id);
    if (external) {
      await this.bindExternal(
        input,
        selection,
        profile,
        spawnPolicy,
        subagentLeases,
        executor,
      );
      return;
    }
    const routeModelAlias = selection.route?.lockedModelAlias;
    const canonicalRouteModelAlias =
      routeModelAlias === undefined ? undefined : this.resolveModelId(routeModelAlias);
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

    if (input.thinking !== undefined) {
      this.assertThinkingEffortSupported(input.thinking, model, alias);
    }

    await this.sessionToolPolicy.ready;
    const context = await this.buildSystemPromptContext(profile);
    this.assertRouteBindable(selection.route?.id);
    this.delegationPosition =
      input.delegationPosition ??
      (this.agentScope.agentId === MAIN_AGENT_ID ? 'main' : 'sub');
    const assembled = await this.assembleBoundSystemPrompt(profile, context, alias);
    const systemPrompt = assembled.text;
    this.cacheAgentsMdWarning(context);

    const requestedThinking = resolveMainThinkingCandidate({
      inputThinking: input.thinking,
      routeLockedThinking: selection.route?.lockedThinkingEffort,
      profileThinking: resolveProfileThinkingDefault(profile, alias, (id) => this.models.resolveId(id)),
    });
    const thinkingLevel = this.resolveThinkingEffort(requestedThinking, model);
    const normalizedRequestedThinking = requestedThinking === undefined
      ? undefined
      : normalizeRequestedThinkingEffort(requestedThinking) ?? requestedThinking.trim().toLowerCase();
    const thinkingEffortAdjusted =
      normalizedRequestedThinking !== undefined && normalizedRequestedThinking !== thinkingLevel;

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
    this.validatedForcedThinkingEffort(
      thinkingLevel,
      model,
      alias,
      roleConstraintsFromProfile(profile, spawnConstraintOrigin(input.lease, input.spawnPolicy)),
    );

    this.assertProfileToolPatterns(profile, input.inheritedUserToolNames);
    this.activeProfile = profile;
    this.activeProfileDefinitionId = selection.baseProfile.definitionId;
    this.activeToolNamesOverlay = undefined;
    this.promptFieldSnapshot = assembled.promptFields;
    this.promptConfigurationSignature = this.promptFieldSignature(profile, alias, assembled.promptFields);
    await this.dispatcher.dispatch(new ProfileBind({
      modelAlias: alias,
      profileName: selection.baseProfile.name,
      profileDefinitionId: selection.baseProfile.definitionId,
      routeId: selection.route?.id,
      lockedModelAlias: canonicalRouteModelAlias,
      lockedThinkingEffort: selection.route?.lockedThinkingEffort,
      executionRestriction,
      executorId: 'native',
      executorProtocol: 'native',
      executorOptions: undefined,
      executorDescriptorRevision: 'native',
      thinkingEffort: thinkingLevel,
      thinkingEffortAdjusted: thinkingEffortAdjusted ? true : undefined,
      serviceTier: profile.serviceTier,
      requestParams:
        profile.requestParams === undefined ? undefined : { ...profile.requestParams },
      systemPrompt,
      environmentDisclosure: assembled.environment,
      agentsMdPaths: extractAgentsMdPathsFromSystemPrompt(systemPrompt),
      activeToolNames: profile.tools,
      toolAllowPolicies: profile.toolAllowPolicies,
      disallowedTools: profile.disallowedTools ?? [],
      disabledToolGroups: profile.disabledToolGroups,
      subagents: profile.subagents,
      subagentLeases,
      spawnPolicy,
      appliedLease: input.lease,
      boundProfile: freezeBoundProfile(profile, assembled.promptBase),
    }));
    this.afterConfigDispatch({
      modelAlias: alias,
      profileName: profile.name,
      thinkingLevel,
      systemPrompt,
      disallowedTools: profile.disallowedTools ?? [],
    });
    this.seedAgentsMdReminder(systemPrompt, context);

    this.publishAgentsMdWarning();
    this.publishToolPatternWarnings();
  }

  private async bindExternal(
    input: BindAgentInput,
    selection: {
      readonly baseProfile: ResolvedAgentProfile;
      readonly route?: ResolvedAgentProfileRoute;
    },
    profile: ResolvedAgentProfile,
    spawnPolicy: SpawnConstraints | undefined,
    subagentLeases: Readonly<Record<string, SubagentLease>> | undefined,
    executor: ResolvedAgentExecutor,
  ): Promise<void> {
    this.delegationPosition =
      input.delegationPosition ??
      (this.agentScope.agentId === MAIN_AGENT_ID ? 'main' : 'sub');
    if (this.delegationPosition === 'main') {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `External executor "${executor.descriptor.id}" is unsupported for the main agent`,
      );
    }
    if ([profile, ...(profile.modelProfiles ?? [])].some((entry) =>
      entry.serviceTier !== undefined || entry.requestParams !== undefined || entry.contextBudget !== undefined || entry.maxCompletionTokens !== undefined,
    )) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `External executor profile "${selection.baseProfile.name}" cannot declare service_tier, request_params, context_budget, or max_completion_tokens; these parameters require native execution`,
      );
    }
    const routeModelAlias = selection.route?.lockedModelAlias;
    const requested = resolveMainModelCandidate({
      inputModel: input.model,
      routeLockedAlias: routeModelAlias,
      profileModelAlias: profile.modelAlias,
    });
    const requestedAlias = requested.alias;
    if (requestedAlias === undefined || requestedAlias === '') {
      throw new ProfileError(
        ProfileErrors.codes.MODEL_NOT_CONFIGURED,
        `model is required to bind external executor profile "${selection.baseProfile.name}"`,
      );
    }
    const requestedThinking = resolveMainThinkingCandidate({
      inputThinking: input.thinking,
      routeLockedThinking: selection.route?.lockedThinkingEffort,
      profileThinking: resolveProfileThinkingDefault(profile, requestedAlias, (id) => id),
    }) ?? 'off';
    const validated = this.requireValidBinding(
      this.executors.validateBinding(executor.descriptor.id, executor.options, {
        modelAlias: requestedAlias,
        thinkingEffort: requestedThinking,
      }),
    );
    const alias = validated.modelAlias!;
    const thinkingLevel = validated.thinkingEffort as ThinkingEffort;
    const normalizedRequestedThinking =
      normalizeRequestedThinkingEffort(requestedThinking) ?? requestedThinking.trim().toLowerCase();
    const thinkingEffortAdjusted = normalizedRequestedThinking !== thinkingLevel;
    const routeBinding = selection.route === undefined
      ? undefined
      : this.executors.validateBinding(executor.descriptor.id, executor.options, {
          modelAlias: selection.route.lockedModelAlias ?? alias,
          thinkingEffort: selection.route.lockedThinkingEffort ?? thinkingLevel,
        });
    const normalizedRouteBinding = routeBinding?.ok === true ? routeBinding.binding : undefined;
    await this.sessionToolPolicy.ready;
    const context = await this.buildSystemPromptContext(profile);
    this.assertRouteBindable(selection.route?.id);
    const assembled = await this.assembleBoundSystemPrompt(profile, context, alias);
    assertBoundModelAllowed(
      this.config,
      alias,
      roleConstraintsFromProfile(
        profile,
        spawnConstraintOrigin(input.lease, input.spawnPolicy),
      ),
      undefined,
      thinkingLevel,
    );
    this.activeProfile = profile;
    this.activeProfileDefinitionId = selection.baseProfile.definitionId;
    this.activeToolNamesOverlay = undefined;
    this.promptFieldSnapshot = assembled.promptFields;
    this.promptConfigurationSignature = this.promptFieldSignature(profile, alias, assembled.promptFields);
    await this.dispatcher.dispatch(new ProfileBind({
      modelAlias: alias,
      profileName: selection.baseProfile.name,
      profileDefinitionId: selection.baseProfile.definitionId,
      routeId: selection.route?.id,
      lockedModelAlias: routeModelAlias === undefined
        ? undefined
        : normalizedRouteBinding?.modelAlias ?? routeModelAlias,
      lockedThinkingEffort: selection.route?.lockedThinkingEffort === undefined
        ? undefined
        : normalizedRouteBinding?.thinkingEffort ?? selection.route.lockedThinkingEffort,
      executorId: executor.descriptor.id,
      executorProtocol: executor.descriptor.protocol,
      executorOptions: { ...executor.options },
      executorDescriptorRevision: executor.descriptor.revision,
      thinkingEffort: thinkingLevel,
      thinkingEffortAdjusted: thinkingEffortAdjusted ? true : undefined,
      systemPrompt: assembled.text,
      environmentDisclosure: assembled.environment,
      agentsMdPaths: extractAgentsMdPathsFromSystemPrompt(assembled.text),
      activeToolNames: [],
      toolAllowPolicies: undefined,
      disallowedTools: [],
      subagents: profile.subagents,
      subagentLeases,
      spawnPolicy,
      appliedLease: input.lease,
      boundProfile: freezeBoundProfile(profile, assembled.promptBase),
    }));
    this.afterConfigDispatch({
      modelAlias: alias,
      profileName: profile.name,
      thinkingLevel,
      systemPrompt: assembled.text,
      disallowedTools: [],
    });
    this.seedAgentsMdReminder(assembled.text, context);
    this.cacheAgentsMdWarning(context);
    this.publishAgentsMdWarning();
    this.publishToolPatternWarnings();
  }

  validateBinding(binding: ExecutorBinding): ExecutorValidationResult {
    const complete = {
      modelAlias: binding.modelAlias ?? this.modelAlias,
      thinkingEffort: binding.thinkingEffort ?? this.profileState.thinkingLevel,
    };
    if (this.isExternalExecutor) {
      return this.executors.validateBinding(
        this.profileState.executorId!,
        this.profileState.executorOptions,
        complete,
      );
    }
    const modelAlias = complete.modelAlias === undefined ? undefined : this.resolveModelId(complete.modelAlias);
    const changedModel = modelAlias !== undefined && modelAlias !== this.modelAlias;
    const thinkingEffort = binding.thinkingEffort ?? (changedModel
      ? this.resolveThinkingEffort(
          resolveProfileThinkingDefault(this.profileState.boundProfile ?? this.resolveActiveProfile(), modelAlias, (id) => this.models.resolveId(id)),
          this.modelCatalog.get(modelAlias),
        )
      : complete.thinkingEffort);
    return { ok: true, binding: { modelAlias, thinkingEffort } };
  }

  async prepareResumeBinding(input: Parameters<IAgentProfileService['prepareResumeBinding']>[0]): Promise<() => void> {
    const previous = this.data();
    const validated = this.requireValidBinding(this.validateBinding({
      modelAlias: input.modelAlias,
      thinkingEffort: input.thinkingEffort,
    }));
    const model = validated.modelAlias;
    if (model === undefined) throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'The resumed agent has no bound model.');
    const thinking = (this.isExternalExecutor ? validated.thinkingEffort : normalizeRequestedThinkingEffort(validated.thinkingEffort)) ?? previous.thinkingLevel;
    const requestedThinking = input.thinkingEffort?.trim().toLowerCase();
    const thinkingEffortAdjusted = requestedThinking !== undefined &&
      (normalizeRequestedThinkingEffort(requestedThinking) ?? requestedThinking) !== thinking;
    const identity = (alias: string | undefined): string | undefined => alias === undefined || this.isExternalExecutor ? alias : this.models.resolveId(alias) ?? alias;
    const changedModel = model !== identity(previous.modelAlias);
    if (changedModel && (input.allowModelChange !== true || input.modelAlias === undefined)) {
      throw new Error2(ErrorCodes.REQUEST_INVALID,
        `Changing the resumed agent model from "${previous.modelAlias ?? '(unbound)'}" to "${model}" requires model_alias plus allow_model_change: true.`,
        { details: { previousModel: previous.modelAlias, requestedModel: model, requiredParameter: 'allow_model_change' } });
    }
    const constraints = previous.boundProfile ?? this.resolveActiveProfile();
    if (constraints === undefined && (changedModel || thinking !== previous.thinkingLevel)) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'The saved role constraints cannot be resolved; resume without changing the binding.');
    }
    const resolver = this.isExternalExecutor ? undefined : this.models;
    assertBoundModelAllowed(this.config, model, constraints, resolver, thinking);
    for (const ceiling of input.callerConstraints ?? []) {
      assertBoundModelAllowed(this.config, model, ceiling, resolver, thinking);
    }
    if (this.isExternalExecutor) {
      if (changedModel || thinking !== previous.thinkingLevel) {
        throw new Error2(ErrorCodes.REQUEST_INVALID,
          `Executor "${previous.executorId}" does not support changing a resumed thread binding; no thread or executor was replaced.`,
          { details: { executor: previous.executorId, previousModel: previous.modelAlias, requestedModel: model, previousEffort: previous.thinkingLevel, requestedEffort: thinking } });
      }
    } else {
      this.assertThinkingEffortSupported(thinking, this.modelCatalog.get(model), model);
    }
    let systemPrompt: string | undefined;
    let environmentDisclosure: EnvironmentDisclosureSnapshot | undefined;
    if (changedModel) {
      const base = previous.boundProfile?.promptBase;
      if (base !== undefined) {
        const withModel = applyMatchedModelProfilePrompt(base.text, constraints?.modelProfiles, model, (id) => this.models.resolveId(id));
        systemPrompt = injectDelegationContext(await this.applyCognitionOverlay(withModel, model), base.delegationSnippet);
        environmentDisclosure = base.environment;
      } else if (this.declaresCognitionOverlay(previous.modelAlias) || this.declaresCognitionOverlay(model)
        || declaresModelProfilePrompt(constraints?.modelProfiles, previous.modelAlias, (id) => this.models.resolveId(id))
        || declaresModelProfilePrompt(constraints?.modelProfiles, model, (id) => this.models.resolveId(id))) {
        throw new Error2(ErrorCodes.CONFIG_INVALID, 'The saved prompt base is unavailable; resume without changing the model.');
      }
    }
    return () => {
      const current = this.data();
      if (current.modelAlias !== previous.modelAlias || current.thinkingLevel !== previous.thinkingLevel
        || current.profileDefinitionId !== previous.profileDefinitionId || current.routeId !== previous.routeId) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'The agent binding changed during resume admission. Retry against its current binding.');
      }
      assertBoundModelAllowed(this.config, model, constraints, resolver, thinking);
      if (changedModel || thinking !== previous.thinkingLevel) {
        this.update({
          modelAlias: model,
          thinkingLevel: thinking,
          thinkingEffortAdjusted,
          systemPrompt,
          environmentDisclosure,
        });
      }
    };
  }

  async setModel(alias: string): Promise<ProfileSetModelResult> {
    if (this.isExternalExecutor) {
      const validated = this.requireValidBinding(this.validateBinding({ modelAlias: alias }));
      const externalAlias = validated.modelAlias!;
      if (
        this.profileState.lockedModelAlias !== undefined &&
        externalAlias !== this.profileState.lockedModelAlias
      ) {
        this.emitDeviationWarning(
          routeModelOverrideMessage(
            this.routeId,
            this.profileState.lockedModelAlias,
            externalAlias,
          ),
        );
      }
      if (this.modelAlias !== externalAlias) {
        this.update({ modelAlias: externalAlias });
        this.telemetry.track2('model_switch', { model: externalAlias });
      }
      if (this.activeProfile !== undefined) {
        for (const message of humanProfileDeviations({
          model: externalAlias,
          thinking: this.thinkingLevel,
          constraints: roleConstraintsFromProfile(this.activeProfile),
          profileName: this.activeProfile.name,
          checkThinking: false,
        })) {
          this.emitDeviationWarning(message);
        }
      }
      return { model: externalAlias };
    }
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
    const external = this.isExternalExecutor;
    let effort: string;
    if (external) {
      const validated = this.requireValidBinding(this.validateBinding({ thinkingEffort: level }));
      effort = validated.thinkingEffort!;
    } else {
      this.assertThinkingEffortSupported(level, this.tryResolveRawModel(), this.modelAlias ?? '');
      effort = normalizeRequestedThinkingEffort(level) ?? level;
    }
    if (
      this.profileState.lockedThinkingEffort !== undefined &&
      effort !== this.profileState.lockedThinkingEffort
    ) {
      this.emitDeviationWarning(
        routeThinkingOverrideMessage(
          this.routeId,
          this.profileState.lockedThinkingEffort,
          effort,
        ),
      );
    }
    const previousEffort = this.thinkingLevel;
    const requestedEffort = normalizeRequestedThinkingEffort(level) ?? level.trim().toLowerCase();
    this.update({ thinkingLevel: effort, thinkingEffortAdjusted: requestedEffort !== effort });
    if (this.activeProfile !== undefined && this.modelAlias !== undefined) {
      for (const message of humanProfileDeviations({
        model: this.modelAlias,
        thinking: effort,
        constraints: roleConstraintsFromProfile(this.activeProfile),
        models: external ? undefined : this.models,
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
    const efforts = model?.supportEfforts ?? [];
    const declared = normalized === 'on' || normalized === 'off' ||
      (efforts.length === 0 ? !this.strictThinkingValidation(model) : efforts.includes(normalized ?? ''));
    if (normalized !== undefined && declared && this.supportsThinkingEffort(normalized, model)) return;
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
    this.activeProfileDefinitionId = profile.definitionId;
    const rendered = profile.renderSystemPrompt({
      ...context,
      promptVariables: this.config.get<PromptConfig>(PROMPT_SECTION)?.variables,
    });
    const systemPrompt = injectDelegationContext(rendered.text, undefined);
    this.update({
      profileName: profile.name,
      systemPrompt,
      environmentDisclosure: rendered.environment,
      agentsMdPaths: extractAgentsMdPathsFromSystemPrompt(systemPrompt),
      disallowedTools: profile.disallowedTools ?? [],
      disabledToolGroups: profile.disabledToolGroups,
    });
    this.setActiveTools(profile.tools);
  }

  async applyProfile(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<void> {
    this.assertProfileToolPatterns(profile);
    const context = await this.buildSystemPromptContext(profile, options);
    this.activeProfile = profile;
    this.activeProfileDefinitionId = profile.definitionId;
    const assembled = await this.assembleBoundSystemPrompt(
      profile,
      context,
      this.modelAlias ?? '',
    );
    this.promptFieldSnapshot = assembled.promptFields;
    this.promptConfigurationSignature = this.promptFieldSignature(profile, this.modelAlias ?? '', assembled.promptFields);
    this.update({
      profileName: profile.name,
      systemPrompt: assembled.text,
      environmentDisclosure: assembled.environment,
      agentsMdPaths: extractAgentsMdPathsFromSystemPrompt(assembled.text),
      disallowedTools: profile.disallowedTools ?? [],
      disabledToolGroups: profile.disabledToolGroups,
    });
    this.setActiveTools(profile.tools);
    this.seedAgentsMdReminder(assembled.text, context);
    this.cacheAgentsMdWarning(context);
    this.publishAgentsMdWarning();
    this.publishToolPatternWarnings();
  }

  async rebuildPromptContext(): Promise<void> {
    await this.systemPromptRefreshTail.catch(() => undefined);
    const current = this.profileState;
    if (current.profileName === undefined) return;
    this.activeProfile = undefined;
    this.frozenSkillListing = undefined;
    this.frozenPluginSections = undefined;
    this.promptConfigurationSignature = 'invalidated';
    await this.bind({
      profile: current.profileName,
      route: current.routeId,
      model: current.modelAlias,
      thinking: current.thinkingLevel,
      lease: current.appliedLease,
      spawnPolicy: current.spawnPolicy,
      delegationPosition: this.delegationPosition,
    });
  }

  refreshSystemPrompt(): Promise<void> {
    const refresh = this.systemPromptRefreshTail.catch(() => undefined).then(() => this.refreshSystemPromptNow());
    this.systemPromptRefreshTail = refresh;
    return refresh;
  }

  private async refreshSystemPromptNow(): Promise<void> {
    const profile = this.resolveActiveProfile();
    if (profile === undefined) return;

    try {
      const context = await this.buildSystemPromptContext(profile);
      this.activeProfile = profile;
      const assembled = await this.assembleBoundSystemPrompt(
        profile,
        context,
        this.modelAlias ?? '',
        this.profileState.boundProfile?.promptBase,
      );
      this.promptFieldSnapshot = assembled.promptFields;
      this.promptConfigurationSignature = this.promptFieldSignature(profile, this.modelAlias ?? '', assembled.promptFields);
      this.update({
        profileName: profile.name,
        systemPrompt: assembled.text,
        promptBase: assembled.promptBase,
        environmentDisclosure: assembled.environment,
        agentsMdPaths: extractAgentsMdPathsFromSystemPrompt(assembled.text),
      });
      this.seedAgentsMdReminder(assembled.text, context);
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

  private promptFieldSignature(
    profile: ResolvedAgentProfile,
    alias: string,
    snapshot: ResolvedPromptFieldOverrides,
  ): string {
    const config = this.config.get<PromptConfig>(PROMPT_SECTION);
    return JSON.stringify({
      fields: snapshot.fields,
      variables: config?.variables ?? {},
      delegation: this.config.get<AgentsConfig | undefined>(AGENTS_SECTION)?.delegation,
      profile: profile.definitionId ?? profile.name,
      model: alias,
    });
  }

  private async resolvePromptFieldSnapshot(
    profile: ResolvedAgentProfile,
    alias: string,
  ): Promise<ResolvedPromptFieldOverrides> {
    const promptConfig = this.config.get<PromptConfig>(PROMPT_SECTION);
    const model = alias.length === 0 ? undefined : this.models.get(alias);
    const resolveId = (profile.executor ?? 'native') === 'native'
      ? (id: string) => this.models.resolveId(id)
      : (id: string) => id;
    const modelProfile = resolveModelProfileEntry(profile.modelProfiles, alias, resolveId);
    const sourcePath = profile.sourcePath?.replaceAll('\\', '/');
    const resolved = await this.promptFields.resolve({
      global: { surface: 'global', overrides: promptConfig?.overrides },
      model: { surface: 'model', overrides: model?.promptOverrides },
      profile: {
        surface: sourcePath?.endsWith('/SYSTEM.md') === true ? 'system' : 'profile',
        overrides: profile.promptOverrideLayers ?? profile.promptOverrides,
        sourcePath: profile.sourcePath,
      },
      profileModel: { surface: 'profile-model', overrides: modelProfile?.promptOverrides },
      context: {
        profileName: profile.name,
        modelAlias: alias,
        executor: profile.executor ?? 'native',
        delegationPosition: this.delegationPosition,
      },
      customVariables: promptConfig?.variables,
    });
    const customBody = profile.fileDefinition !== undefined || sourcePath?.endsWith('/SYSTEM.md') === true;
    const profileShadowsSystem = customBody
      && profile.systemPromptMode !== 'prepend'
      && profile.systemPromptMode !== 'append'
      && profile.systemPromptMode !== 'inherit';
    const cognitionShadowsSystem = (profile.executor ?? 'native') === 'native'
      && model?.cognition?.overlayMode === 'replace'
      && cognitionPathRefs(model.cognition.overlay).length > 0;
    const intentOverride = resolved.values['system.intent_tool_use'];
    const intentShadowsReplyStyle = intentOverride !== undefined && !intentOverride.includes('${reply_style_guide}');
    if (!profileShadowsSystem && !cognitionShadowsSystem && !intentShadowsReplyStyle) return resolved;
    const fields = resolved.fields.map((field) =>
      (field.id.startsWith('system.') && field.id !== 'system.shared' && (profileShadowsSystem || cognitionShadowsSystem))
        || (field.id === 'system.reply_style' && intentShadowsReplyStyle)
        ? { ...field, status: 'shadowed' as const }
        : field,
    );
    return {
      values: Object.fromEntries(fields.filter((field) => field.status === 'effective').map((field) => [field.id, field.value])),
      fields,
    };
  }

  private async assembleBoundSystemPrompt(
    profile: ResolvedAgentProfile,
    context: SystemPromptContext,
    alias: string,
    savedBase?: import('./boundProfile').BoundPromptBase,
  ): Promise<{ readonly text: string; readonly environment: EnvironmentDisclosureSnapshot; readonly promptBase: import('./boundProfile').BoundPromptBase; readonly promptFields: ResolvedPromptFieldOverrides }> {
    const promptVariables = this.config.get<PromptConfig>(PROMPT_SECTION)?.variables;
    const promptFields = await this.resolvePromptFieldSnapshot(profile, alias);
    const rendered = profile.renderSystemPrompt({
      ...context,
      promptVariables,
      promptFields: promptFields.values,
    });
    const withModel = applyMatchedModelProfilePrompt(
      rendered.text,
      profile.modelProfiles,
      alias,
      (profile.executor ?? 'native') === 'native'
        ? (id) => this.models.resolveId(id)
        : (id) => id,
    );
    const snippetTemplate = this.delegationPosition === 'main' && savedBase?.delegationSnippet !== undefined
      ? savedBase.delegationSnippet
      : resolveDelegationSnippet({
          position: this.delegationPosition,
          notice: profile.delegationNotice,
          config: this.config.get<AgentsConfig | undefined>(AGENTS_SECTION)?.delegation,
          fields: promptFields.values,
        });
    const snippet = snippetTemplate === undefined
      ? undefined
      : renderPrompt(snippetTemplate, customPromptVariables(promptVariables));
    const body = (profile.executor ?? 'native') === 'native'
      ? await this.applyCognitionOverlay(withModel, alias)
      : withModel;
    return {
      text: injectDelegationContext(body, snippet),
      environment: rendered.environment,
      promptBase: { text: rendered.text, environment: rendered.environment, delegationSnippet: snippet, promptVariablesRevision: createHash('sha256').update(JSON.stringify(promptVariables ?? {})).digest('hex') },
      promptFields,
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

  private seedAgentsMdReminder(
    systemPrompt: string,
    context: Pick<SystemPromptContext, 'cwd'>,
  ): void {
    this.agentsMdReminder.seedInjected(
      extractAgentsMdPathsFromSystemPrompt(systemPrompt),
      context.cwd ?? this.sessionContext.cwd,
    );
  }

  getAgentsMdWarning(): string | undefined {
    return this.agentsMdWarning;
  }

  data(): ProfileData {
    const model = this.tryResolveRawModel();
    const thinking = this.isExternalExecutor
      ? { effective: this.profileState.thinkingLevel as ThinkingEffort, forced: undefined }
      : this.resolveThinkingState(model);
    const lockedModelAlias = this.profileState.lockedModelAlias;
    const lockedThinkingEffort = this.profileState.lockedThinkingEffort;
    const routeModelDetached = lockedModelAlias !== undefined &&
      (this.isExternalExecutor ? lockedModelAlias : this.resolveModelId(lockedModelAlias)) !== this.modelAlias;
    const routeEffortDetached = lockedThinkingEffort !== undefined &&
      (normalizeRequestedThinkingEffort(lockedThinkingEffort) ?? lockedThinkingEffort.trim().toLowerCase()) !== thinking.effective;
    const routeDetached = this.routeId !== undefined && (routeModelDetached || routeEffortDetached);
    return {
      modelAlias: this.modelAlias,
      modelCapabilities: model?.capabilities ?? UNKNOWN_CAPABILITY,
      profileName: this.profileName,
      profileDefinitionId: this.activeProfileDefinitionId ?? this.profileState.profileDefinitionId,
      routeId: this.routeId,
      lockedModelAlias: this.profileState.lockedModelAlias,
      lockedThinkingEffort: this.profileState.lockedThinkingEffort,
      executorId: this.profileState.executorId ?? 'native',
      executorProtocol: this.profileState.executorProtocol ?? 'native',
      executorOptions:
        this.profileState.executorOptions === undefined
          ? undefined
          : { ...this.profileState.executorOptions },
      executorDescriptorRevision: this.profileState.executorDescriptorRevision,
      thinkingLevel: this.thinkingLevel,
      effectiveThinkingLevel: thinking.effective,
      thinkingEffortSource: thinking.forced !== undefined
        ? 'forced'
        : this.profileState.thinkingEffortAdjusted ? 'adjusted' : undefined,
      routeDetached,
      profileSource: this.profileState.boundProfile?.fileSources === undefined ? 'registered' : 'profile-file',
      systemPrompt: this.systemPrompt,
      agentsMdPaths: this.profileState.agentsMdPaths,
      activeToolNames: this.activeToolNames === undefined ? undefined : [...this.activeToolNames],
      executionRestriction: this.profileState.executionRestriction,
      toolAllowPolicies: this.profileState.executionRestriction === 'research-readonly'
        ? [...(this.profileState.toolAllowPolicies ?? []), RESEARCH_READONLY_TOOLS]
        : this.profileState.toolAllowPolicies?.map((policy) => [...policy]),
      disallowedTools: [...(this.profileState.disallowedTools ?? [])],
      disabledToolGroups:
        this.profileState.disabledToolGroups === undefined
          ? undefined
          : [...this.profileState.disabledToolGroups],
      subagents:
        this.profileState.subagents === undefined ? undefined : [...this.profileState.subagents],
      subagentLeases: this.profileState.subagentLeases,
      spawnPolicy: this.profileState.spawnPolicy,
      appliedLease: this.profileState.appliedLease,
      boundProfile: this.profileState.boundProfile,
      serviceTier: this.serviceTier,
      requestParams:
        this.requestParams === undefined ? undefined : { ...this.requestParams },
      environmentDisclosure: this.profileState.environmentDisclosure,
      renderGeneration: this.profileState.renderGeneration,
    };
  }

  getEffectiveThinkingLevel(): ThinkingEffort {
    if (this.isExternalExecutor) return this.profileState.thinkingLevel as ThinkingEffort;
    return this.resolveThinkingState(this.tryResolveRawModel()).effective;
  }

  resolveModelContext(): ProfileModelContext {
    if ((this.profileState.executorId ?? 'native') !== 'native') {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `resolveModelContext is unsupported for external executor "${this.profileState.executorId}"`,
      );
    }
    const modelAlias = this.model;
    const model = this.modelCatalog.get(modelAlias);
    const loopControl = this.config.get<LoopControl>('loopControl');
    return {
      modelAlias,
      modelCapabilities: this.getModelCapabilities(),
      maxOutputSize: this.getMaxOutputSize(),
      alwaysThinking: model.alwaysThinking || undefined,
      thinkingLevel: this.resolveThinkingState(model).effective,
      reservedContextSize: loopControl?.reservedContextSize,
      compactionTriggerRatio: loopControl?.compactionTriggerRatio,
      compactionMaxAttempts: loopControl?.compactionMaxAttempts,
      compactionSoftContextSize: loopControl?.compactionSoftContextSize,
    };
  }

  resolveRequestParams(): ModelRequestParams {
    if (this.isExternalExecutor) {
      return {
        cacheKey: this.sessionContext.sessionId,
        thinkingEffort: this.profileState.thinkingLevel as ThinkingEffort,
      };
    }
    const model = this.tryResolveRawModel();
    const thinking = this.resolveThinkingState(model);
    const thinkingConfig = this.config.get<ThinkingConfig>(THINKING_SECTION);
    const overrides = this.config.get<ModelOverrides>('modelOverrides');
    const parameters = this.resolveModelParameters(model);
    const requestParams = parameters.requestParams;
    const sampling: SamplingOptions = {
      temperature: typeof requestParams?.['temperature'] === 'number' ? requestParams['temperature'] : overrides?.temperature,
      topP: typeof requestParams?.['top_p'] === 'number' ? requestParams['top_p'] : overrides?.topP,
    };
    return {
      cacheKey: this.sessionContext.sessionId,
      sampling:
        sampling.temperature === undefined && sampling.topP === undefined ? undefined : sampling,
      thinkingEffort: thinking.effective,
      thinkingKeep: resolveThinkingKeep(overrides?.thinkingKeep, thinkingConfig?.keep, thinking.effective),
      serviceTier: parameters.serviceTier,
      requestParams,
      maxCompletionTokens: parameters.maxCompletionTokens,
      maxContextTokens: parameters.contextBudget === undefined ? undefined : this.getModelCapabilities().max_context_tokens,
    };
  }

  private resolveModelParameters(model: Model | undefined) {
    const profile = this.profileState.boundProfile ?? this.activeProfile;
    const entry = resolveModelProfileEntry(profile?.modelProfiles, model?.id ?? '', (id) => this.models.resolveId(id));
    return mergeModelParameters(model, profile ?? { serviceTier: this.serviceTier, requestParams: this.requestParams }, entry);
  }

  getModelCapabilities(): ModelCapability {
    if (this.isExternalExecutor) return UNKNOWN_CAPABILITY;
    const model = this.tryResolveRawModel();
    if (model === undefined) return UNKNOWN_CAPABILITY;
    const budget = this.resolveModelParameters(model).contextBudget;
    if (budget === undefined) return model.capabilities;
    const total = Math.min(model.capabilities.max_context_tokens, budget);
    return {
      ...model.capabilities,
      max_context_tokens: total,
      max_input_tokens: Math.min(model.capabilities.max_input_tokens ?? total, total),
    };
  }

  getModelProviderType(alias?: string): string | undefined {
    const effective = alias ?? this.modelAlias ?? this.config.get<string>('defaultModel');
    return this.resolveModelForThinking(effective)?.providerType;
  }

  getMaxOutputSize(): number | undefined {
    if (this.isExternalExecutor) return undefined;
    const model = this.tryResolveRawModel();
    const budget = this.resolveModelParameters(model).maxCompletionTokens;
    if (budget === undefined) return model?.maxOutputSize;
    return Math.min(model?.maxOutputSize ?? budget, budget);
  }

  hasModel(): boolean {
    return this.modelAlias !== undefined;
  }

  isRunnable(): boolean {
    return this.profileName !== undefined && this.hasModel();
  }

  hasProvider(): boolean {
    if (this.isExternalExecutor) {
      return this.executors.provider(this.profileState.executorProtocol!) !== undefined;
    }
    return this.tryResolveRawModel() !== undefined;
  }

  getSystemPrompt(): string {
    const variables = customPromptVariables(this.config.get<PromptConfig>(PROMPT_SECTION)?.variables);
    return appendSharedPromptField(this.systemPrompt, this.promptFieldSnapshot, variables);
  }

  getPromptFieldSnapshot(options?: { readonly anchor?: boolean }): ResolvedPromptFieldOverrides {
    if (options?.anchor !== true) return this.promptFieldSnapshot;
    const fields = this.promptFieldSnapshot.fields.map((field) =>
      field.id.startsWith('system.') || field.id.startsWith('delegation.')
        ? { ...field, status: 'inactive' as const }
        : field,
    );
    return {
      values: Object.fromEntries(fields.filter((field) => field.status === 'effective').map((field) => [field.id, field.value])),
      fields,
    };
  }

  private promptConfigurationSignature: string | undefined;

  async preparePromptConfiguration(): Promise<boolean> {
    const profile = this.resolveActiveProfile();
    if (profile === undefined) {
      if (this.profileName === undefined) return false;
      void this.dispatcher.dispatch(new WarningIssued({
        code: 'prompt-fields-refresh-failed',
        message: 'Prompt field refresh skipped; keeping the last valid snapshot because the saved profile source is unavailable.',
      }));
      return false;
    }
    try {
      const candidate = await this.resolvePromptFieldSnapshot(profile, this.modelAlias ?? '');
      const signature = this.promptFieldSignature(profile, this.modelAlias ?? '', candidate);
      if (this.promptConfigurationSignature === signature) return false;
      const promptConfig = this.config.get<PromptConfig>(PROMPT_SECTION);
      const delegation = this.config.get<AgentsConfig | undefined>(AGENTS_SECTION)?.delegation;
      if (
        this.promptConfigurationSignature === undefined
        && candidate.fields.length === 0
        && this.promptFieldSnapshot.fields.length === 0
        && Object.keys(promptConfig?.variables ?? {}).length === 0
        && delegation === undefined
      ) {
        this.promptConfigurationSignature = signature;
        return false;
      }
      const generation = this.profileState.renderGeneration;
      await this.refreshSystemPrompt();
      if (this.profileState.renderGeneration === generation) return false;
      this.promptConfigurationSignature = signature;
      return true;
    } catch (error) {
      void this.dispatcher.dispatch(new WarningIssued({
        code: 'prompt-fields-refresh-failed',
        message: `Prompt field refresh skipped; keeping the last valid snapshot: ${error instanceof Error ? error.message : String(error)}`,
      }));
      return false;
    }
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
    if (changed.promptBase !== undefined) payload.promptBase = changed.promptBase;
    if (changed.modelAlias !== undefined) payload.modelAlias = changed.modelAlias;
    if (changed.profileName !== undefined) payload.profileName = changed.profileName;
    if (
      changed.thinkingEffortAdjusted !== undefined &&
      (changed.thinkingEffortAdjusted || this.profileState.thinkingEffortAdjusted === true)
    ) {
      payload.thinkingEffortAdjusted = changed.thinkingEffortAdjusted;
    }
    if (changed.thinkingLevel !== undefined || changed.modelAlias !== undefined) {
      const requested = changed.thinkingLevel;
      if (this.isExternalExecutor) {
        payload.thinkingEffort =
          (requested ?? this.profileState.thinkingLevel) as ThinkingEffort;
      } else {
        const alias = changed.modelAlias ?? this.modelAlias;
        const model = this.resolveModelForThinking(alias);
        const changedModel = alias !== undefined && this.resolveModelId(alias) !== this.modelAlias;
        const candidate = requested ?? (changedModel
          ? resolveProfileThinkingDefault(this.profileState.boundProfile ?? this.resolveActiveProfile(), alias, (id) => this.models.resolveId(id))
          : this.modelAlias === undefined ? undefined : this.thinkingLevel);
        payload.thinkingEffort = this.resolveThinkingEffort(candidate, model);
        if (changed.thinkingEffortAdjusted === undefined && candidate !== undefined) {
          const normalized = normalizeRequestedThinkingEffort(candidate) ?? candidate.trim().toLowerCase();
          const adjusted = normalized !== payload.thinkingEffort;
          if (adjusted || this.profileState.thinkingEffortAdjusted === true) {
            payload.thinkingEffortAdjusted = adjusted;
          }
        }
      }
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
    if (changed.disabledToolGroups !== undefined) {
      payload.disabledToolGroups = [...changed.disabledToolGroups];
    }
    return payload;
  }

  private afterConfigDispatch(changed: Omit<ProfileUpdateData, 'activeToolNames'>): void {
    if (changed.modelAlias !== undefined) {
      if (this.isExternalExecutor) {
        this.telemetryContext.set({});
      } else {
        const model = this.tryResolveRawModel();
        this.telemetryContext.set({
          provider_type: model?.providerType ?? model?.protocol,
          protocol: model?.protocol,
        });
      }
    }
    if (changed.modelAlias !== undefined || changed.thinkingLevel !== undefined) {
      this.warnAboutAnthropicThinkingEffort();
    }
    this.emitStatusUpdated(
      changed.modelAlias !== undefined || changed.thinkingLevel !== undefined,
    );
  }

  private warnAboutAnthropicThinkingEffort(): void {
    if (this.isExternalExecutor) return;
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
    const capabilities = this.isExternalExecutor
      ? undefined
      : this.getModelCapabilities();
    const maxContextTokens = capabilities?.max_input_tokens ?? capabilities?.max_context_tokens;
    void this.dispatcher.dispatch(
      new AgentStatusUpdated({
        model: modelAlias,
        thinkingEffort: includeThinkingEffort
          ? this.isExternalExecutor
            ? this.profileState.thinkingLevel as ThinkingEffort
            : this.getEffectiveThinkingLevel()
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
    const stored = this.profileState.thinkingLevel as ThinkingEffort;
    if (this.isExternalExecutor) return stored;
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
    if (this.isExternalExecutor) return { effective: base, forced: undefined };
    const forced = this.validatedForcedThinkingEffort(
      base,
      model,
      this.modelAlias,
      this.profileState.boundProfile ?? this.activeProfile,
    );
    return { effective: forced ?? base, forced };
  }

  private validatedForcedThinkingEffort(
    base: ThinkingEffort,
    model: Model | undefined,
    modelAlias: string | undefined,
    constraints: Parameters<typeof assertBoundModelAllowed>[2],
  ): ThinkingEffort | undefined {
    const forced = resolveForcedThinkingEffort(
      this.config.get<ThinkingConfig>(THINKING_SECTION)?.forcedEffort,
      base,
      drivesThinkingThroughTraits(model?.providerType),
    );
    if (forced === undefined || modelAlias === undefined) return forced;
    assertBoundModelAllowed(this.config, modelAlias, constraints, this.models, forced);
    return forced;
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

  private get isExternalExecutor(): boolean {
    return this.profileState.executorId !== undefined && this.profileState.executorId !== 'native';
  }

  private requireValidBinding(result: ExecutorValidationResult): ExecutorBinding {
    if (!result.ok) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, result.diagnostic);
    }
    return result.binding;
  }

  private get alwaysThinkingModel(): boolean {
    if (this.isExternalExecutor) return false;
    return this.tryResolveRawModel()?.alwaysThinking === true;
  }

  private resolveModelId(alias: string): string {
    return this.models.resolveId(alias) ?? alias;
  }

  private tryResolveRawModel(): Model | undefined {
    if (this.isExternalExecutor) return undefined;
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

  private assertRouteBindable(requestedRoute?: string): void {
    const current = this.profileName;
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
    const bound = this.profileState.boundProfile;
    if (bound !== undefined) {
      const basePrompt = (context: AgentProfileContext) =>
        this.catalog.getDefault().renderSystemPrompt(context);
      const restored = bound.fileSources !== undefined
        ? restoreProfileFileSources(bound.fileSources, basePrompt, bound.definitionId)
        : bound.fileDefinition !== undefined
          ? agentProfileFromFile(bound.fileDefinition, basePrompt)
          : bound.routeDefinition !== undefined ? this.catalog.get(bound.routeDefinition.profile) : undefined;
      if (restored !== undefined) {
        const rendered = bound.routeDefinition === undefined ? restored : resolveAgentProfileRoute(bound.routeDefinition, restored).effectiveProfile;
        return { ...bound, systemPrompt: rendered.systemPrompt, renderSystemPrompt: rendered.renderSystemPrompt };
      }
    }
    const profileName = this.profileName;
    if (profileName === undefined) return undefined;
    if (this.routeId !== undefined) {
      try {
        const restored = this.catalog.resolveSelection({ route: this.routeId }).profile;
        return bound === undefined ? restored : { ...bound, systemPrompt: restored.systemPrompt, renderSystemPrompt: restored.renderSystemPrompt };
      } catch { return undefined; }
    }
    const definitionId = this.profileState.profileDefinitionId;
    const catalogProfile =
      definitionId === undefined
        ? profileName === DEFAULT_AGENT_PROFILE_NAME
          ? this.catalog.getDefault()
          : this.catalog.get(profileName)
        : this.catalog.snapshot === undefined
          ? undefined
          : resolveSnapshotProfileDefinition(this.catalog.snapshot(), definitionId, profileName);
    if (catalogProfile === undefined) return undefined;
    const resolveId = aliasIdentity(this.models);
    return applySpawnPolicy(
      applyLease(catalogProfile, this.profileState.appliedLease, resolveId),
      this.profileState.spawnPolicy,
      resolveId,
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

  private knownToolNames(additionalNames?: readonly string[]): Set<string> {
    const known = new Set(additionalNames);
    for (const contribution of getAgentToolContributions()) known.add(contribution.options.name);
    for (const contribution of this.toolContributions.items) known.add(contribution.options.name);
    for (const ref of this.toolRegistry.listReferences()) known.add(ref.name);
    for (const builtin of this.builtinProfiles.list()) {
      for (const name of literalToolNames(builtin.tools ?? [])) {
        known.add(name);
      }
    }
    return known;
  }

  private profileToolPatternChecks(profile: ResolvedAgentProfile): {
    context: string;
    field: string;
    patterns: readonly string[] | undefined;
  }[] {
    const checks: {
      context: string;
      field: string;
      patterns: readonly string[] | undefined;
    }[] = [
      { context: `profile "${profile.name}"`, field: 'tools', patterns: profile.tools },
      {
        context: `profile "${profile.name}"`,
        field: 'disallowedTools',
        patterns: profile.disallowedTools,
      },
    ];
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
    return checks;
  }

  private assertProfileToolPatterns(
    profile: ResolvedAgentProfile,
    inheritedUserToolNames?: readonly string[],
  ): void {
    const known = this.knownToolNames(inheritedUserToolNames);
    const issues: string[] = [];
    for (const { context, field, patterns } of this.profileToolPatternChecks(profile)) {
      if (patterns === undefined) continue;
      for (const issue of findInactiveToolPatterns(patterns, (name) => known.has(name))) {
        issues.push(describeInactiveToolPattern(context, field, issue));
      }
    }
    if (issues.length === 0) return;
    throw new ProfileError(
      ProfileErrors.codes.TOOL_PATTERN_INACTIVE,
      issues.join(' '),
      { profile: profile.name, issues },
    );
  }

  private publishToolPatternWarnings(): void {
    const known = this.knownToolNames();
    const global = this.config.get<ToolsConfig>(TOOLS_SECTION);
    const checks: {
      context: string;
      field: string;
      patterns: readonly string[] | undefined;
    }[] = [
      { context: 'the global [tools] config', field: 'enabled', patterns: global?.enabled },
      { context: 'the global [tools] config', field: 'disabled', patterns: global?.disabled },
    ];
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
