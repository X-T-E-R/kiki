import { captureProfileModelMenu } from '@kiki/agent-profiles/agentProfile';
import type { AgentPromptDiagnostics } from '@kiki/protocol';
import { promptConfigurationChannels } from './promptDiagnostics';
import { llmRequestTraceKey } from '#/agent/llmRequester/llmRequestOps';
import {
  bindingAdvisoryKey,
  type BindingAdvisory,
} from '@kiki/agent-profiles/bindingAdvisory';
import type {
  ExecutorBinding,
  ExecutorValidationResult,
} from '@kiki/agent-profiles/ports';

import { type CollectionView } from '#/_base/di/collection';
import { createHash } from 'node:crypto';
import { applyFileCallerCeiling, freezeBoundProfile, type BoundProfile } from './boundProfile';
import { assertResearchExecutor, RESEARCH_READONLY_TOOLS } from './executionRestriction';
import { assertNativeToolOverride, effectiveToolBinding, mergeToolBindingOverride } from './toolBinding';
import { Disposable } from '#/_base/di/lifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ref, type LiveRef } from '#/_base/di/instantiation';
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
import { modelWithUsage } from '#/kosong/model/parameters';
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
  resolveDelegationPosition,
  type DelegationPosition,
} from '#/agent/profile/delegationContext';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IAgentMemorySnapshot } from '#/app/memory/memorySnapshot';
import { IPersonaStore } from '#/app/persona/personaStore';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import type { PersonaSnapshot } from '@kiki/agent-profiles/personaFile';
import {
  applyPersonaPrompt,
  hasDefaultIdentityParagraph,
  PERSONA_PROMPT_MARKER,
  personaExamplesWereTruncated,
  renderPersonaBlock,
} from './personaPrompt';
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
import { IEventBus } from '#/app/event/eventBus';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import { dynamicPromptKey, ProfileDynamicSnapshot, dynamicPromptContent, promptSectionHash, stablePromptContext, legacyEnvironmentContext } from './dynamicPrompt';
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
import { selectCognitionConfig, type CognitionBinding } from '#/agent/cognition/cognitionConfig';
import { checkPromptFiles } from './promptFileChecks';

import {
  applyMatchedModelProfilePrompt,
  declaresModelProfilePrompt,
  resolveModelProfileEntry,
  resolveProfileThinkingDefault,
  mergeModelParameters,
  modelPromptLayers,
} from '#/app/agentProfileCatalog/modelProfileOverlay';
import {
  aliasIdentity,
  applyLease,
  applySpawnPolicy,
  intersectSpawnPolicy,
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
  pinBindingAdvisory,
  roleBindingAdvisories,
  roleConstraintsFromProfile,
} from '#/session/subagent/modelConstraints';
import { assertSubagentModelNotDenied, INHERIT_MODEL_ALIAS } from '#/session/subagent/configSection';
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
  BindingConstraintInput,
  BindingSelectionValue,
  ProfileBindingSnapshot,
  ProfileData,
  ProfileModelContext,
  ProfileServiceOptions,
  ProfileSetEffortResult,
  ProfileSetModelResult,
  ProfileUpdateData,
} from './profile';
import { IAgentProfileService, ProfileError, ProfileErrors } from './profile';
import { renderExternalPrompt } from './externalPrompt';
import { resolveProfilePromptFields } from './promptFieldSnapshot';
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
  readonly advisory?: BindingAdvisory;
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

const NATIVE_SSH_SYSTEM_PROMPT =
  'SSH tools can target a configured remote host with the host argument or an ssh://host/path URI. ' +
  'Use host: "local" to explicitly target this machine. Remote hosts have independent filesystems and permission rules. ' +
  'Do not assume a remote path refers to a local file.';

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
      this.profileState.toolOverride?.tools ??
      this.activeToolNamesOverlay ??
      (this.states.get(profileActiveToolsKey) as ActiveToolsState)
    );
  }

  private activeProfile: ResolvedAgentProfile | undefined;
  private activeProfileDefinitionId: string | undefined;
  private readonly emittedBindingAdvisories = new Set<string>();
  private delegationPosition: DelegationPosition = 'main';
  private delegationPositionResolved = false;
  private cognitionBinding: CognitionBinding | undefined;
  private cognitionRevision = 0;
  private boundPromptDiagnostics: AgentPromptDiagnostics | undefined;
  private promptFieldSnapshot: ResolvedPromptFieldOverrides = { values: {}, fields: [] };

  private personaSnapshot: PersonaSnapshot | undefined;
  private readonly emittedPersonaWarnings = new Set<string>();
  private frozenSkillListing: string | undefined;
  private frozenPluginSections: string | undefined;
  private systemPromptRefreshTail: Promise<void> = Promise.resolve();
  private promptLayoutMigrationPending = false;

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
    @IAgentMemorySnapshot private readonly memorySnapshot: IAgentMemorySnapshot,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @ref(ISessionActivityView) private readonly sessionActivity: LiveRef<ISessionActivityView>,
    @IPersonaStore private readonly personas?: IPersonaStore,
    @IEventBus eventBus?: IEventBus,
  ) {
    super();
    this.delegationPosition = resolveDelegationPosition(this.agentScope.agentId, undefined);
    this.states.contributeState(profileKey);
    this.states.contributeState(dynamicPromptKey);
    if (eventBus !== undefined) this._register(eventBus.subscribe(ContextSpliced, (event) => {
      if (event.deleteCount > 0 && event.messages.some((message) => message.origin?.kind === 'compaction_summary')) {
        this.promptLayoutMigrationPending = true;
      }
    }));
    this.states.contributeState(profileActiveToolsKey);
    this.states.contributeState(profileActiveToolNamesOverlayKey);
    this.states.contributeState(profileAgentsMdWarningKey);
    this.states.contributeState(profileEmittedThinkingEffortWarningsKey);
    this.states.contributeState(profileEmittedToolPatternWarningsKey);
    this.states.contributeState(profileEmittedPluginBudgetWarningsKey);
    this.configure({});
    this._register(this.dispatcher.hooks.onDidRestore.register('profile-memory-view', async (_ctx, next) => {
      this.syncRestoredPersona();
      await next();
    }));
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
    const allowParentNotify = snapshot.allowParentNotify ?? this.profileState.allowParentNotify;
    assertResearchExecutor(executionRestriction, snapshot.executorId);
    const persona = freezePersonaSnapshot(snapshot.persona);
    this.personaSnapshot = persona;
    this.memorySnapshot.configurePersona(snapshot.memoryReadContext ?? memoryPersonaContext(persona));
    this.activeProfile = undefined;
    this.promptConfigurationSignature = undefined;
    this.cognitionBinding = undefined;
    this.boundPromptDiagnostics = undefined;
    this.activeProfileDefinitionId = snapshot.profileDefinitionId;
    this.activeToolNamesOverlay = undefined;
    const agentsMdPaths = extractAgentsMdPathsFromSystemPrompt(snapshot.systemPrompt);
    void this.dispatcher.dispatch(
      new ProfileBind({
        toolOverride: snapshot.toolOverride,
        memoryReadContext: snapshot.memoryReadContext,
        executionRestriction,
        allowParentNotify,
        personaId: snapshot.personaId,
        personaRevision: snapshot.personaRevision,
        personaOverrides: snapshot.personaOverrides,
        persona,
        roomPrompt: snapshot.roomPrompt,
        modelAlias: snapshot.modelAlias,
        profileName: snapshot.profileName,
        profileDefinitionId: snapshot.profileDefinitionId,
        routeId: snapshot.routeId,
        lockedModelAlias: snapshot.lockedModelAlias,
        lockedThinkingEffort: snapshot.lockedThinkingEffort,
        executorId: snapshot.executorId,
        executorProtocol: snapshot.executorProtocol,
        executorOptions: snapshot.executorOptions,
        executorPrompt: snapshot.executorPrompt,
        allowKikiSubagents: snapshot.allowKikiSubagents,
        kikiContext: snapshot.kikiContext,
        executorDescriptorRevision: snapshot.executorDescriptorRevision,
        thinkingEffort: snapshot.thinkingLevel,
        thinkingEffortAdjusted: snapshot.thinkingEffortAdjusted,
        bindingAdvisories: snapshot.bindingAdvisories,
        serviceTier: snapshot.serviceTier,
        requestParams:
          snapshot.requestParams === undefined ? undefined : { ...snapshot.requestParams },
        systemPrompt: snapshot.systemPrompt,
        environmentDisclosure: snapshot.environmentDisclosure,
        renderGeneration: snapshot.renderGeneration,
        agentsMdPaths,
        activeToolNames: snapshot.toolPolicyBase === undefined ? snapshot.activeToolNames : snapshot.toolPolicyBase.tools,
        toolAllowPolicies: snapshot.toolPolicyBase === undefined ? snapshot.toolAllowPolicies : snapshot.toolPolicyBase.toolAllowPolicies,
        disallowedTools: snapshot.toolPolicyBase?.disallowedTools ?? snapshot.disallowedTools ?? [],
        disabledToolGroups: snapshot.disabledToolGroups,
        canSpawnSubagents: snapshot.canSpawnSubagents,
        allowedSubagents: snapshot.allowedSubagents,
        preferredSubagents: snapshot.preferredSubagents,
        denySubagents: snapshot.denySubagents,
        subagentLeases: snapshot.subagentLeases,
        dispatchDecision: snapshot.dispatchDecision,
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

  async bind(input: BindAgentInput, assertCurrent?: () => void): Promise<void> {
    await this.catalog.ready;
    await this.identity.resolved();
    const persona = input.personaSnapshot ?? await this.loadPersonaSnapshot(input.persona);
    const selectedProfileName = input.profile ?? persona?.definition.profile;
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
        : input.route === undefined && (selectedProfileName === DEFAULT_AGENT_PROFILE_NAME ||
            (selectedProfileName === undefined && persona !== undefined))
          ? (() => {
              const base = this.catalog.getDefault();
              return { profile: base, baseProfile: base, route: undefined };
            })()
          : this.catalog.resolveSelection({ profile: selectedProfileName, route: input.route });
    const inheritedAlias = [
      selection.baseProfile.modelAlias,
      selection.profile.modelAlias,
      selection.route?.lockedModelAlias,
      input.lease?.modelAlias,
      input.model,
      persona?.definition.modelAlias,
    ].some((alias) => alias === INHERIT_MODEL_ALIAS);
    if (inheritedAlias) {
      if (this.agentScope.agentId === MAIN_AGENT_ID || input.delegationPosition === 'main') {
        throw new ProfileError(
          ProfileErrors.codes.MODEL_CONFIG_INVALID,
          `Main agent profile "${selection.baseProfile.name}" cannot use model_alias: inherit because it has no caller agent. Choose a configured model alias instead.`,
        );
      }
      throw new ProfileError(
        ProfileErrors.codes.MODEL_CONFIG_INVALID,
        `Subagent profile "${selection.baseProfile.name}" requires a caller binding to resolve model_alias: inherit; dispatch it through AgentRun.`,
      );
    }
    const executionRestriction = this.profileState.executionRestriction ?? input.executionRestriction;
    const allowParentNotify = input.allowParentNotify ?? this.profileState.allowParentNotify ??
      (this.profileState.profileName === undefined ? selection.profile.allowParentNotify : undefined);
    const toolOverride = mergeToolBindingOverride(this.profileState.toolOverride, input.toolOverride);
    assertNativeToolOverride(selection.profile.executor, toolOverride);
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
    const baseProfile = captureProfileModelMenu(selection.baseProfile, external ? (id) => id : (id) => this.models.resolveId(id));
    const routedProfile = {
      ...selection.profile,
      restrictModelsToMenu: baseProfile.restrictModelsToMenu,
      modelMenuConstraint: baseProfile.modelMenuConstraint,
      modelMenuDiagnostics: baseProfile.modelMenuDiagnostics,
      thinkingEffort: selection.route === undefined ? selection.profile.thinkingEffort : selection.route.lockedThinkingEffort ?? resolveProfileThinkingDefault(
        baseProfile, selection.profile.modelAlias ?? '', resolveId ?? ((id) => id),
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
        persona,
        { ...selection, baseProfile },
        profile,
        allowParentNotify,
        spawnPolicy,
        subagentLeases,
        executor,
        assertCurrent,
      );
      return;
    }
    const routeModelAlias = selection.route?.lockedModelAlias;
    const canonicalRouteModelAlias =
      routeModelAlias === undefined ? undefined : this.resolveModelId(routeModelAlias);
    const requested = resolveMainModelCandidate({
      inputModel: input.model,
      personaModelAlias: persona?.definition.modelAlias,
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
    this.delegationPosition = input.delegationPosition ?? await this.resolveCurrentDelegationPosition();
    this.delegationPositionResolved = true;
    let model: Model;
    try {
      model = this.resolveUsageModel(alias);
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
    const renderProfile = { ...profile, ...effectiveToolBinding(profile, toolOverride, profile as BoundProfile) };
    const context = await this.buildSystemPromptContext(renderProfile, undefined, persona ?? null);
    this.assertRouteBindable(selection.route?.id);
    const requestedThinking = resolveMainThinkingCandidate({
      inputThinking: input.thinking,
      personaThinking: persona?.definition.thinkingEffort,
      routeLockedThinking: selection.route?.lockedThinkingEffort,
      profileThinking: resolveProfileThinkingDefault(profile, alias, (id) => this.models.resolveId(id)),
    });
    const thinkingLevel = this.resolveThinkingEffort(requestedThinking, model);
    const normalizedRequestedThinking = requestedThinking === undefined
      ? undefined
      : normalizeRequestedThinkingEffort(requestedThinking) ?? requestedThinking.trim().toLowerCase();
    const thinkingEffortAdjusted =
      normalizedRequestedThinking !== undefined && normalizedRequestedThinking !== thinkingLevel;

    if (this.delegationPosition !== 'main') {
      assertSubagentModelNotDenied(this.config, alias, this.models);
    }
    const forcedThinking = this.validatedForcedThinkingEffort(thinkingLevel, model, alias);
    const modelSelection = input.bindingSelection?.model ?? {
      source: requested.source === 'input' ? 'dispatch-explicit'
        : requested.source === 'route' ? 'route-default'
          : requested.source === 'default' ? 'config-default' : 'profile-default',
      requestedValue: requestedAlias,
    };
    const profileModelThinking = resolveModelProfileEntry(
      profile.modelProfiles,
      alias,
      (id) => this.models.resolveId(id),
    )?.thinkingEffort;
    const baseThinkingSelection = input.bindingSelection?.thinking ?? {
      source: input.thinking !== undefined ? 'dispatch-explicit'
        : selection.route?.lockedThinkingEffort !== undefined ? 'route-default'
          : profileModelThinking !== undefined ? 'model-profile-default'
            : requestedThinking !== undefined ? 'profile-default' : 'model-default',
      requestedValue: requestedThinking,
    };
    const thinkingSelection = forcedThinking === undefined ? baseThinkingSelection : {
      source: 'environment-forced' as const,
      requestedValue: thinkingLevel,
    };
    const bindingAdvisories = this.collectBindingAdvisories({
      profile: baseProfile,
      profileName: selection.baseProfile.name,
      route: selection.route,
      lease: input.lease,
      spawnPolicy: input.spawnPolicy,
      model: alias,
      thinking: forcedThinking ?? thinkingLevel,
      modelSelection,
      thinkingSelection,
      models: this.models,
    });

    this.assertProfileToolPatterns(renderProfile, input.inheritedUserToolNames);
    const assembled = await this.assembleBoundSystemPrompt(renderProfile, context, alias, undefined, persona, input.roomPrompt ?? this.profileState.roomPrompt);
    const systemPrompt = assembled.text;
    this.cacheAgentsMdWarning(context);
    assertCurrent?.();
    this.activeProfile = profile;
    this.activeProfileDefinitionId = selection.baseProfile.definitionId;
    this.activeToolNamesOverlay = undefined;
    this.promptFieldSnapshot = assembled.promptFields;
    this.promptConfigurationSignature = this.promptFieldSignature(profile, alias, assembled.promptFields);
    await this.dispatcher.dispatch(new ProfileBind({
      toolOverride: mergeToolBindingOverride(this.profileState.toolOverride, input.toolOverride),
      memoryReadContext: input.memoryReadContext ?? this.profileState.memoryReadContext,
      personaId: persona?.definition.id,
      personaRevision: persona?.revision,
      personaOverrides: persona === undefined ? undefined : input.personaOverrides ?? {
        profile: input.profile ?? input.route, model: input.model, thinking: input.thinking,
      },
      persona,
      roomPrompt: input.roomPrompt ?? this.profileState.roomPrompt,
      modelAlias: alias,
      profileName: selection.baseProfile.name,
      profileDefinitionId: selection.baseProfile.definitionId,
      routeId: selection.route?.id,
      lockedModelAlias: canonicalRouteModelAlias,
      lockedThinkingEffort: selection.route?.lockedThinkingEffort,
      executionRestriction,
      allowParentNotify,
      executorId: 'native',
      executorProtocol: 'native',
      executorOptions: undefined,
      executorDescriptorRevision: 'native',
      thinkingEffort: thinkingLevel,
      thinkingEffortAdjusted: thinkingEffortAdjusted ? true : undefined,
      bindingAdvisories,
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
      canSpawnSubagents: profile.canSpawnSubagents,
      allowedSubagents: profile.allowedSubagents,
      preferredSubagents: profile.preferredSubagents,
      denySubagents: profile.denySubagents,
      subagentLeases,
      dispatchDecision: input.dispatchDecision,
      spawnPolicy,
      appliedLease: input.lease,
      boundProfile: freezeBoundProfile(profile, assembled.promptBase),
    }));
    this.personaSnapshot = persona;
    this.memorySnapshot.configurePersona(this.profileState.memoryReadContext ?? memoryPersonaContext(persona));
    this.afterConfigDispatch({
      modelAlias: alias,
      profileName: profile.name,
      thinkingLevel,
      systemPrompt,
      disallowedTools: profile.disallowedTools ?? [],
    });
    this.seedAgentsMdReminder(systemPrompt, context);
    this.publishPersonaWarnings(persona, assembled, selection.baseProfile.name);

    this.publishAgentsMdWarning();
    this.publishToolPatternWarnings();
    await this.syncBindingMetadata();
  }

  async syncBindingMetadata(): Promise<void> {
    await this.restoreCommittedPromptProjections();
    const binding = this.data();
    const executor = binding.executorId ?? 'native';
    await this.metadata.updateAgent(this.agentScope.agentId, (current) => ({
      ...current, model: binding.modelAlias, thinkingEffort: binding.thinkingLevel,
      executor, executorProtocol: binding.executorProtocol,
      negotiated: (current.executor ?? 'native') === executor ? current.negotiated : undefined,
      allowKikiSubagents: binding.allowKikiSubagents,
    }));
  }

  private async restoreCommittedPromptProjections(): Promise<void> {
    const current = this.profileState;
    const diagnostics = current.boundProfile?.promptBase?.promptDiagnostics;
    if (diagnostics === undefined) return;
    const modelAlias = this.isExternalExecutor ? diagnostics.identity.model_alias ?? '' : current.modelAlias;
    if (this.boundPromptDiagnostics?.binding_revision === diagnostics.binding_revision
      && this.cognitionBinding?.modelAlias === modelAlias) return;
    const profile = current.boundProfile ?? this.resolveActiveProfile();
    if (profile === undefined || modelAlias === undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'The committed prompt binding cannot be reconstructed from its saved profile.');
    }
    await this.ensureDelegationPosition();
    const fields = await this.resolvePromptFieldSnapshot(profile, modelAlias);
    const oldCognition = this.cognitionBinding;
    const oldRevision = this.cognitionRevision;
    let cognition: CognitionBinding | undefined;
    let revision = oldRevision;
    try {
      await this.applyCognitionOverlay('', modelAlias);
      cognition = this.cognitionBinding;
      revision = this.cognitionRevision;
      const reconstructed = this.buildPromptDiagnostics(profile, modelAlias, fields);
      if (reconstructed.binding_revision !== diagnostics.binding_revision) {
        throw new Error2(ErrorCodes.CONFIG_INVALID, 'The saved prompt binding differs from its current configuration or files. Restore its committed inputs before retrying recovery.');
      }
    } finally {
      this.cognitionBinding = oldCognition;
      this.cognitionRevision = oldRevision;
    }
    if (this.profileState !== current) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'The committed agent binding changed during prompt projection recovery.');
    }
    this.cognitionBinding = cognition === undefined ? undefined : { ...cognition, bindingRevision: diagnostics.binding_revision };
    this.cognitionRevision = revision;
    this.promptFieldSnapshot = fields;
    this.boundPromptDiagnostics = diagnostics;
  }

  private async bindExternal(
    input: BindAgentInput,
    persona: PersonaSnapshot | undefined,
    selection: {
      readonly baseProfile: ResolvedAgentProfile;
      readonly route?: ResolvedAgentProfileRoute;
    },
    profile: ResolvedAgentProfile,
    allowParentNotify: boolean | undefined,
    spawnPolicy: SpawnConstraints | undefined,
    subagentLeases: Readonly<Record<string, SubagentLease>> | undefined,
    executor: ResolvedAgentExecutor,
    assertCurrent?: () => void,
  ): Promise<void> {
    persona = persona ?? this.personaSnapshot ?? this.profileState.persona;
    this.delegationPosition = input.delegationPosition ?? await this.resolveCurrentDelegationPosition();
    this.delegationPositionResolved = true;
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
      personaModelAlias: persona?.definition.modelAlias,
      routeLockedAlias: routeModelAlias,
      profileModelAlias: profile.modelAlias,
    });
    const requestedAlias = requested.alias;
    if ((requestedAlias === undefined || requestedAlias === '') && this.delegationPosition !== 'main') {
      throw new ProfileError(ProfileErrors.codes.MODEL_NOT_CONFIGURED,
        `model is required to bind external executor profile "${selection.baseProfile.name}"`);
    }
    const configuredThinking = resolveMainThinkingCandidate({
      inputThinking: input.thinking,
      personaThinking: persona?.definition.thinkingEffort,
      routeLockedThinking: selection.route?.lockedThinkingEffort,
      profileThinking: resolveProfileThinkingDefault(profile, requestedAlias ?? '', (id) => id),
    });
    const requestedThinking = configuredThinking ?? 'off';
    const validation = this.executors.validateBinding(executor.descriptor.id, executor.options, {
      modelAlias: requestedAlias,
      thinkingEffort: requestedThinking,
      explicitFields: [
        ...(profile.tools === undefined ? [] : ['tools']),
        ...(profile.disallowedTools === undefined ? [] : ['disallowed_tools']),
        ...(profile.thinkingEffort === undefined && input.thinking === undefined ? [] : ['thinking_effort']),
        ...(profile.serviceTier === undefined ? [] : ['service_tier']),
        ...(profile.requestParams === undefined ? [] : ['request_params']),
        ...(profile.contextBudget === undefined ? [] : ['context_budget']),
        ...(profile.autoCompact === undefined ? [] : ['auto_compact']),
        ...(profile.maxCompletionTokens === undefined ? [] : ['max_completion_tokens']),
      ],
    });
    const validated = this.requireValidBinding(validation);
    const alias = validated.modelAlias;
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
    const context = await this.buildSystemPromptContext(profile, undefined, persona ?? null);
    this.assertRouteBindable(selection.route?.id);
    const assembled = await this.assembleBoundSystemPrompt(profile, context, alias ?? '', undefined, persona, input.roomPrompt ?? this.profileState.roomPrompt);
    if (alias !== undefined && this.delegationPosition !== 'main') assertSubagentModelNotDenied(this.config, alias);
    const profileModelThinking = resolveModelProfileEntry(profile.modelProfiles, alias ?? '', (id) => id)?.thinkingEffort;
    const baseModelSelection = input.bindingSelection?.model ?? {
      source: requested.source === 'input' ? 'dispatch-explicit'
        : requested.source === 'route' ? 'route-default' : 'profile-default',
      requestedValue: requestedAlias,
    };
    const modelSelection = alias === requestedAlias ? baseModelSelection : {
      source: 'executor-normalized' as const,
      requestedValue: requestedAlias,
    };
    const baseThinkingSelection = input.bindingSelection?.thinking ?? {
      source: input.thinking !== undefined ? 'dispatch-explicit'
        : selection.route?.lockedThinkingEffort !== undefined ? 'route-default'
          : profileModelThinking !== undefined ? 'model-profile-default'
            : configuredThinking !== undefined ? 'profile-default' : 'model-default',
      requestedValue: requestedThinking,
    };
    const thinkingSelection = thinkingLevel === requestedThinking ? baseThinkingSelection : {
      source: 'executor-normalized' as const,
      requestedValue: requestedThinking,
    };
    const bindingAdvisories = this.collectBindingAdvisories({
      profile: selection.baseProfile,
      profileName: selection.baseProfile.name,
      route: selection.route,
      lease: input.lease,
      spawnPolicy: input.spawnPolicy,
      model: alias ?? '',
      thinking: thinkingLevel,
      modelSelection,
      thinkingSelection,
    });
    assertCurrent?.();
    this.activeProfile = profile;
    this.activeProfileDefinitionId = selection.baseProfile.definitionId;
    this.activeToolNamesOverlay = undefined;
    this.promptFieldSnapshot = assembled.promptFields;
    this.promptConfigurationSignature = this.promptFieldSignature(profile, alias ?? '', assembled.promptFields);
    await this.dispatcher.dispatch(new ProfileBind({
      toolOverride: mergeToolBindingOverride(this.profileState.toolOverride, input.toolOverride),
      memoryReadContext: input.memoryReadContext ?? this.profileState.memoryReadContext,
      personaId: persona?.definition.id,
      personaRevision: persona?.revision,
      personaOverrides: persona === undefined ? undefined : input.personaOverrides ?? {
        profile: input.profile ?? input.route, model: input.model, thinking: input.thinking,
      },
      persona,
      roomPrompt: input.roomPrompt ?? this.profileState.roomPrompt,
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
      allowParentNotify,
      executorId: executor.descriptor.id,
      executorProtocol: executor.descriptor.protocol,
      executorOptions: { ...executor.options },
      executorPrompt: profile.executorPrompt,
      allowKikiSubagents: profile.allowKikiSubagents,
      kikiContext: profile.kikiContext,
      executorDescriptorRevision: executor.descriptor.revision,
      thinkingEffort: thinkingLevel,
      thinkingEffortAdjusted: thinkingEffortAdjusted ? true : undefined,
      bindingAdvisories,
      systemPrompt: assembled.text,
      environmentDisclosure: assembled.environment,
      agentsMdPaths: extractAgentsMdPathsFromSystemPrompt(assembled.text),
      activeToolNames: profile.tools,
      toolAllowPolicies: profile.toolAllowPolicies,
      disallowedTools: profile.disallowedTools ?? [],
      disabledToolGroups: profile.disabledToolGroups,
      canSpawnSubagents: profile.canSpawnSubagents,
      allowedSubagents: profile.allowedSubagents,
      preferredSubagents: profile.preferredSubagents,
      denySubagents: profile.denySubagents,
      subagentLeases,
      dispatchDecision: input.dispatchDecision,
      spawnPolicy,
      appliedLease: input.lease,
      boundProfile: freezeBoundProfile(profile, assembled.promptBase),
    }));
    this.personaSnapshot = persona;
    this.memorySnapshot.configurePersona(this.profileState.memoryReadContext ?? memoryPersonaContext(persona));
    this.afterConfigDispatch({
      modelAlias: alias,
      profileName: profile.name,
      thinkingLevel,
      systemPrompt: assembled.text,
      disallowedTools: profile.disallowedTools ?? [],
    });
    await this.syncBindingMetadata();
    if (validation.ok) for (const advisory of validation.advisories ?? []) {
      await this.dispatcher.dispatch(new WarningIssued({ code: advisory.code, message: advisory.message }));
    }
    this.seedAgentsMdReminder(assembled.text, context);
    this.cacheAgentsMdWarning(context);
    this.publishPersonaWarnings(persona, assembled, selection.baseProfile.name);
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
          this.resolveUsageModel(modelAlias),
        )
      : complete.thinkingEffort);
    return { ok: true, binding: { modelAlias, thinkingEffort } };
  }

  async prepareResumeBinding(input: Parameters<IAgentProfileService['prepareResumeBinding']>[0]): Promise<import('./profile').PreparedModelSwitchBinding> {
    await this.ensureDelegationPosition();
    const previousState = this.profileState;
    const previous = this.data();
    assertNativeToolOverride(previous.executorId, input.toolOverride);
    const toolOverride = mergeToolBindingOverride(previousState.toolOverride, input.toolOverride);
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
    const allowParentNotify = input.allowParentNotify ?? previous.allowParentNotify;
    if (changedModel && input.modelAlias === undefined) {
      throw new Error2(ErrorCodes.REQUEST_INVALID,
        `Changing the resumed agent model from "${previous.modelAlias ?? '(unbound)'}" to "${model}" requires an explicit model_alias.`,
        { details: { previousModel: previous.modelAlias, requestedModel: model, requiredParameter: 'model_alias' } });
    }
    if (changedModel && input.allowModelChange !== true && input.newWindow !== true) {
      throw new Error2(ErrorCodes.REQUEST_INVALID,
        `Changing the resumed agent model from "${previous.modelAlias ?? '(unbound)'}" to "${model}" requires either allow_model_change: true to keep the current context, or new_window: true to start a new context window.`,
        { details: { previousModel: previous.modelAlias, requestedModel: model, requiredParameter: 'allow_model_change',
          confirmationChoices: [{ parameter: 'allow_model_change', value: true, mode: 'direct' }, { parameter: 'new_window', value: true, mode: 'fresh' }] } });
    }
    const constraints = previous.boundProfile ?? this.resolveActiveProfile();
    if (constraints === undefined && changedModel) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'The saved role constraints cannot be resolved; resume without changing the model.');
    }
    if (constraints !== undefined && input.toolOverride !== undefined) {
      this.assertProfileToolPatterns({ ...constraints, ...effectiveToolBinding(previous.toolPolicyBase ?? constraints, toolOverride, previous.boundProfile) });
    }
    assertSubagentModelNotDenied(this.config, model, this.isExternalExecutor ? undefined : this.models);
    if (!this.isExternalExecutor) {
      this.assertThinkingEffortSupported(thinking, this.resolveUsageModel(model), model);
    }
    const forcedThinking = this.isExternalExecutor
      ? undefined
      : this.validatedForcedThinkingEffort(thinking as ThinkingEffort, this.resolveUsageModel(model), model);
    const modelSelection = {
      source: input.modelAlias === undefined ? 'resume-existing' as const : 'dispatch-explicit' as const,
      requestedValue: input.modelAlias ?? previous.modelAlias,
    };
    const baseThinkingSelection = {
      source: input.thinkingEffort === undefined ? 'resume-existing' as const : 'dispatch-explicit' as const,
      requestedValue: input.thinkingEffort ?? previous.thinkingLevel,
    };
    const thinkingSelection = forcedThinking === undefined ? baseThinkingSelection : {
      source: 'environment-forced' as const,
      requestedValue: thinking,
    };
    const route = previous.routeId === undefined ? undefined : {
      id: previous.routeId,
      lockedModelAlias: previous.lockedModelAlias,
      lockedThinkingEffort: previous.lockedThinkingEffort,
    };
    const bindingAdvisories = this.collectBindingAdvisories({
      profile: constraints,
      profileName: previous.profileName ?? 'saved',
      profileIncludesOverlays: true,
      route,
      lease: previous.appliedLease,
      spawnPolicy: previous.spawnPolicy,
      additionalConstraints: input.callerConstraints,
      model,
      thinking: forcedThinking ?? thinking,
      modelSelection,
      thinkingSelection,
      models: this.isExternalExecutor ? undefined : this.models,
    });
    let systemPrompt: string | undefined;
    let environmentDisclosure: EnvironmentDisclosureSnapshot | undefined;
    let nextPromptBase: import('./boundProfile').BoundPromptBase | undefined;
    let nextFields: ResolvedPromptFieldOverrides | undefined;
    let nextCognition: CognitionBinding | undefined;
    let nextDiagnostics: AgentPromptDiagnostics | undefined;
    const oldCognition = this.cognitionBinding;
    const oldCognitionRevision = this.cognitionRevision;
    let nextCognitionRevision = oldCognitionRevision;
    if (changedModel) {
      const base = previous.boundProfile?.promptBase;
      if (base !== undefined) {
        await this.ensureDelegationPosition();
        const withModel = modelPromptLayers(constraints!).reduce((text, layer) => applyMatchedModelProfilePrompt(text, layer.entries, model, this.isExternalExecutor ? (id) => id : (id) => this.models.resolveId(id), this.delegationPosition), base.text);
        const withPersona = applyPersonaPrompt(
          withModel,
          this.currentPersona === undefined ? undefined : renderPersonaBlock(this.currentPersona),
          this.profileState.roomPrompt,
        );
        try {
          if (this.isExternalExecutor) await this.applyCognitionOverlay('', model, true);
          systemPrompt = this.isExternalExecutor
            ? withPersona
            : injectDelegationContext(await this.applyCognitionOverlay(withPersona, model), base.delegationSnippet);
          environmentDisclosure = base.environment;
          nextCognition = this.cognitionBinding;
          nextCognitionRevision = this.cognitionRevision;
          const diagnosticsProfile = previous.boundProfile ?? this.resolveActiveProfile();
          if (diagnosticsProfile !== undefined) {
            nextFields = await this.resolvePromptFieldSnapshot(diagnosticsProfile, model);
            nextDiagnostics = this.buildPromptDiagnostics(diagnosticsProfile, model, nextFields);
            nextPromptBase = { ...base, promptDiagnostics: nextDiagnostics };
            nextCognition = nextCognition === undefined ? undefined : { ...nextCognition, bindingRevision: nextDiagnostics.binding_revision };
          }
        } finally {
          this.cognitionBinding = oldCognition;
          this.cognitionRevision = oldCognitionRevision;
        }
      } else if (this.declaresCognitionOverlay(previous.modelAlias) || this.declaresCognitionOverlay(model)
        || this.declaresModelProfilePrompt(previous.modelAlias, constraints)
        || this.declaresModelProfilePrompt(model, constraints)) {
        throw new Error2(ErrorCodes.CONFIG_INVALID, 'The saved prompt base is unavailable; resume without changing the model.');
      }
    }
    const config = this.resolveConfigPayload({
      modelAlias: model, thinkingLevel: thinking, thinkingEffortAdjusted, bindingAdvisories,
      allowParentNotify, systemPrompt, environmentDisclosure, promptBase: nextPromptBase,
    });
    if (toolOverride !== undefined) config.toolOverride = toolOverride;
    if (systemPrompt !== undefined) config.renderGeneration = previousState.renderGeneration + 1;
    const assertConstraints = () => {
      assertSubagentModelNotDenied(this.config, model, this.isExternalExecutor ? undefined : this.models);
      this.collectBindingAdvisories({ profile: constraints, profileName: previous.profileName ?? 'saved',
        profileIncludesOverlays: true, route, lease: previous.appliedLease, spawnPolicy: previous.spawnPolicy,
        additionalConstraints: input.callerConstraints, model, thinking: config.thinkingEffort ?? thinking,
        modelSelection, thinkingSelection, models: this.isExternalExecutor ? undefined : this.models });
    };
    return {
      model, thinking: config.thinkingEffort ?? thinking, config, ...this.modelSwitchCapacity(model),
      assertCurrent: () => {
        if (this.profileState !== previousState) {
          throw new Error2(ErrorCodes.REQUEST_INVALID, 'The agent binding changed during resume admission. Retry against its current binding.');
        }
        assertConstraints();
      },
      syncMetadata: async () => {
        this.assertPreparedBindingCommitted(config, previousState);
        assertConstraints();
        if (input.toolOverride?.tools !== undefined) this.activeToolNamesOverlay = undefined;
        if (nextCognition !== undefined) {
          this.cognitionBinding = nextCognition;
          this.cognitionRevision = nextCognitionRevision;
        }
        if (nextDiagnostics !== undefined) this.boundPromptDiagnostics = nextDiagnostics;
        if (nextFields !== undefined) this.promptFieldSnapshot = nextFields;
        if (JSON.stringify(previousState.toolOverride) !== JSON.stringify(toolOverride)) await this.refreshSystemPrompt();
        await this.syncBindingMetadata();
      },
    };
  }

  async prepareModelSwitchBinding(alias: string, requestedThinking?: string): Promise<import('./profile').PreparedModelSwitchBinding> {
    await this.ensureDelegationPosition();
    if (this.isExternalExecutor) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Model switching requires an executor-specific binding and context adapter.');
    }
    const previous = this.profileState;
    const model = this.resolveModelId(alias);
    const record = this.resolveUsageModel(model);
    if (this.delegationPosition !== 'main') assertSubagentModelNotDenied(this.config, model, this.models);
    const config = this.resolveConfigPayload({ modelAlias: model, thinkingLevel: requestedThinking,
      personaOverrides: previous.personaId === undefined ? undefined : {
        ...previous.personaOverrides, model: alias, thinking: requestedThinking ?? previous.personaOverrides?.thinking,
      },
    });
    const thinking = config.thinkingEffort ?? this.getEffectiveThinkingLevel();
    if (requestedThinking !== undefined) this.assertThinkingEffortSupported(requestedThinking, record, model);
    this.assertCurrentBindingConstraints(model, thinking);
    const base = previous.boundProfile?.promptBase;
    let nextFields: ResolvedPromptFieldOverrides | undefined;
    let nextCognition: CognitionBinding | undefined;
    let nextDiagnostics: AgentPromptDiagnostics | undefined;
    const oldCognition = this.cognitionBinding;
    const oldCognitionRevision = this.cognitionRevision;
    let nextCognitionRevision = oldCognitionRevision;
    if (base !== undefined) {
      await this.ensureDelegationPosition();
      const constraints = previous.boundProfile ?? this.resolveActiveProfile();
      const withModel = constraints === undefined ? base.text : modelPromptLayers(constraints).reduce((text, layer) => applyMatchedModelProfilePrompt(text, layer.entries, model, (id) => this.models.resolveId(id), this.delegationPosition), base.text);
      const withPersona = applyPersonaPrompt(withModel, this.currentPersona === undefined ? undefined : renderPersonaBlock(this.currentPersona), previous.roomPrompt);
      try {
        config.systemPrompt = injectDelegationContext(await this.applyCognitionOverlay(withPersona, model), base.delegationSnippet);
        config.environmentDisclosure = base.environment;
        config.renderGeneration = previous.renderGeneration + 1;
        nextCognition = this.cognitionBinding;
        nextCognitionRevision = this.cognitionRevision;
        const diagnosticsProfile = previous.boundProfile ?? this.resolveActiveProfile();
        if (diagnosticsProfile !== undefined) {
          nextFields = await this.resolvePromptFieldSnapshot(diagnosticsProfile, model);
          nextDiagnostics = this.buildPromptDiagnostics(diagnosticsProfile, model, nextFields);
          config.promptBase = { ...base, promptDiagnostics: nextDiagnostics };
          nextCognition = nextCognition === undefined ? undefined : { ...nextCognition, bindingRevision: nextDiagnostics.binding_revision };
        }
      } finally {
        this.cognitionBinding = oldCognition;
        this.cognitionRevision = oldCognitionRevision;
      }
    } else if (this.declaresCognitionOverlay(previous.modelAlias) || this.declaresCognitionOverlay(model)
      || this.declaresModelProfilePrompt(previous.modelAlias) || this.declaresModelProfilePrompt(model)) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'The saved prompt base is unavailable; model switching cannot reconstruct its prompt.');
    }
    const assertConstraints = () => {
      if (this.delegationPosition !== 'main') assertSubagentModelNotDenied(this.config, model, this.models);
      this.assertCurrentBindingConstraints(model, thinking);
    };
    return {
      model, thinking, config, ...this.modelSwitchCapacity(model),
      assertCurrent: () => {
        if (this.profileState !== previous) throw new Error2(ErrorCodes.REQUEST_INVALID, 'The agent binding changed during model switch preparation. Retry against its current binding.');
        assertConstraints();
      },
      syncMetadata: async () => {
        this.assertPreparedBindingCommitted(config, previous);
        assertConstraints();
        if (nextCognition !== undefined) {
          this.cognitionBinding = nextCognition;
          this.cognitionRevision = nextCognitionRevision;
        }
        if (nextDiagnostics !== undefined) this.boundPromptDiagnostics = nextDiagnostics;
        if (nextFields !== undefined) this.promptFieldSnapshot = nextFields;
        await this.syncBindingMetadata();
      },
    };
  }

  private assertPreparedBindingCommitted(config: ConfigUpdatePayload, previous: ProfileModelState): void {
    const current = this.profileState;
    if (current.modelAlias !== config.modelAlias || current.thinkingLevel !== (config.thinkingEffort ?? config.thinkingLevel ?? previous.thinkingLevel)
      || current.profileDefinitionId !== previous.profileDefinitionId || current.routeId !== previous.routeId
      || current.persona !== previous.persona || current.personaOverrides !== (config.personaOverrides ?? previous.personaOverrides)
      || current.allowParentNotify !== (config.allowParentNotify ?? previous.allowParentNotify)
      || JSON.stringify(current.toolOverride) !== JSON.stringify(config.toolOverride ?? previous.toolOverride)
      || (config.systemPrompt !== undefined && (current.systemPrompt !== config.systemPrompt || current.renderGeneration !== config.renderGeneration))) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'The prepared model switch no longer matches the committed agent binding. Retry recovery against its current binding.');
    }
  }

  private modelSwitchCapacity(model: string): Pick<import('./profile').PreparedModelSwitchBinding, 'maxContextTokens' | 'reservedTokens'> {
    if (this.isExternalExecutor) return { maxContextTokens: undefined, reservedTokens: undefined };
    const record = this.resolveUsageModel(model);
    const loop = this.config.get<LoopControl>('loopControl');
    const parameters = this.resolveModelParameters(record);
    const maxContextTokens = Math.min(record.capabilities.max_input_tokens ?? record.capabilities.max_context_tokens,
      parameters.contextBudget ?? record.capabilities.max_context_tokens);
    const reserve = loop?.reservedContextSize ?? 0;
    return { maxContextTokens, reservedTokens: Math.max(reserve < maxContextTokens ? reserve : 0,
      parameters.maxCompletionTokens ?? record.maxOutputSize ?? 0) };
  }

  async setModel(alias: string): Promise<ProfileSetModelResult> {
    await this.ensureDelegationPosition();
    if (this.isExternalExecutor) {
      const validated = this.requireValidBinding(this.validateBinding({ modelAlias: alias }));
      const externalAlias = validated.modelAlias!;
      if (this.delegationPosition !== 'main') assertSubagentModelNotDenied(this.config, externalAlias);
      this.assertCurrentBindingConstraints(externalAlias, this.thinkingLevel);
      const changed = this.modelAlias !== externalAlias;
      if (changed) {
        const profile = this.resolveActiveProfile();
        if (profile !== undefined) await this.resolvePromptFieldSnapshot(profile, externalAlias);
        this.update({ modelAlias: externalAlias });
        this.telemetry.track2('model_switch', { model: externalAlias });
        await this.refreshSystemPrompt();
      }
      this.refreshCurrentBindingAdvisories(
        { source: validated.modelAlias === alias ? 'runtime-explicit' : 'executor-normalized', requestedValue: alias },
        { source: 'resume-existing', requestedValue: this.thinkingLevel },
      );
      if (this.profileState.personaId !== undefined) this.update({ personaOverrides: { ...this.profileState.personaOverrides, model: alias } });
      await this.syncBindingMetadata();
      return { model: externalAlias };
    }
    const canonicalAlias = this.resolveModelId(alias);
    if (this.delegationPosition !== 'main') {
      assertSubagentModelNotDenied(this.config, canonicalAlias, this.models);
    }
    const model = this.resolveUsageModel(canonicalAlias);
    this.assertCurrentBindingConstraints(canonicalAlias, this.resolveConfigPayload({ modelAlias: canonicalAlias }).thinkingEffort ?? this.thinkingLevel);
    const changed = this.modelAlias !== canonicalAlias;
    if (this.profileName === undefined && this.routeId === undefined) {
      await this.bind({
        profile: DEFAULT_AGENT_PROFILE_NAME,
        model: canonicalAlias,
        bindingSelection: { model: { source: 'runtime-explicit', requestedValue: alias } },
      });
      this.telemetry.track2('model_switch', { model: canonicalAlias });
    } else if (changed) {
      const previousCognition = this.cognitionBinding;
      await this.applyCognitionOverlay('', canonicalAlias);
      this.cognitionBinding = previousCognition;
      const profile = this.resolveActiveProfile();
      if (profile !== undefined) await this.resolvePromptFieldSnapshot(profile, canonicalAlias);
      this.update({ modelAlias: canonicalAlias });
      this.telemetry.track2('model_switch', { model: canonicalAlias });
      await this.refreshSystemPrompt();
    }
    this.refreshCurrentBindingAdvisories(
      { source: 'runtime-explicit', requestedValue: alias },
      changed
        ? { source: 'model-default', requestedValue: this.thinkingLevel }
        : { source: 'resume-existing', requestedValue: this.thinkingLevel },
    );
    if (this.profileState.personaId !== undefined) this.update({ personaOverrides: { ...this.profileState.personaOverrides, model: alias } });
    await this.syncBindingMetadata();
    return {
      model: canonicalAlias,
      providerName: model.providerName,
    };
  }

  setEffort(level: string): ProfileSetEffortResult {
    this.setThinking(level);
    return { effort: this.getEffectiveThinkingLevel() };
  }

  setThinking(level: string): void {
    const external = this.isExternalExecutor;
    const modelAlias = this.modelAlias;
    if (modelAlias !== undefined && this.delegationPosition !== 'main') {
      assertSubagentModelNotDenied(this.config, modelAlias, external ? undefined : this.models);
    }
    let effort: string;
    if (external) {
      const validated = this.requireValidBinding(this.validateBinding({ thinkingEffort: level }));
      effort = validated.thinkingEffort!;
    } else {
      this.assertThinkingEffortSupported(level, this.tryResolveRawModel(), modelAlias ?? '');
      effort = normalizeRequestedThinkingEffort(level) ?? level;
    }
    this.assertCurrentBindingConstraints(modelAlias ?? '', effort);
    const previousEffort = this.thinkingLevel;
    const requestedEffort = normalizeRequestedThinkingEffort(level) ?? level.trim().toLowerCase();
    this.update({ thinkingLevel: effort, thinkingEffortAdjusted: requestedEffort !== effort,
      personaOverrides: this.profileState.personaId === undefined ? undefined : { ...this.profileState.personaOverrides, thinking: level },
    });
    this.refreshCurrentBindingAdvisories(
      { source: 'resume-existing', requestedValue: modelAlias },
      { source: external && effort !== requestedEffort ? 'executor-normalized' : 'runtime-explicit', requestedValue: level },
    );
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
      efforts.length === 0 || efforts.includes(normalized ?? '');
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
      undefined,
      this.currentPersona,
      this.profileState.roomPrompt,
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

  async applyPersonaSettings(restoreDefaults = false): Promise<void> {
    await this.systemPromptRefreshTail.catch(() => undefined);
    const previous = this.profileState;
    if (previous.personaId === undefined) throw new Error2(ErrorCodes.REQUEST_INVALID, 'This conversation has no persona binding.');
    const assertCurrent = () => {
      const activity = this.sessionActivity.current;
      if (activity === undefined) throw new Error2(ErrorCodes.CONFIG_INVALID, 'Session activity is unavailable; persona settings cannot be applied safely.');
      if (this.profileState !== previous || activity.state().busy) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'Wait for this conversation to become idle before applying persona settings.');
      }
    };
    assertCurrent();
    const persona = await this.loadPersonaSnapshot(previous.personaId);
    const overrides = restoreDefaults ? {} : previous.personaOverrides ?? {
      profile: previous.routeId ?? previous.profileName, model: previous.modelAlias, thinking: previous.thinkingLevel,
    };
    const sameProfile = overrides.profile !== undefined && (overrides.profile === previous.profileName || overrides.profile === previous.routeId);
    const saved = {
      activeProfile: this.activeProfile, activeProfileDefinitionId: this.activeProfileDefinitionId,
      cognition: this.cognitionBinding, cognitionRevision: this.cognitionRevision,
      diagnostics: this.boundPromptDiagnostics, promptFields: this.promptFieldSnapshot,
      signature: this.promptConfigurationSignature, persona: this.personaSnapshot,
      skills: this.frozenSkillListing, plugins: this.frozenPluginSections,
    };
    try {
      await this.bind({
        persona: previous.personaId, personaSnapshot: persona, personaOverrides: overrides,
        profile: previous.routeId !== undefined && sameProfile ? undefined : overrides.profile,
        route: previous.routeId !== undefined && sameProfile ? previous.routeId : undefined,
        resolvedProfile: sameProfile && previous.routeId === undefined ? this.resolveActiveProfile() : undefined,
        model: overrides.model, thinking: overrides.thinking, roomPrompt: previous.roomPrompt,
        lease: previous.appliedLease, spawnPolicy: previous.spawnPolicy,
        dispatchDecision: previous.dispatchDecision, executionRestriction: previous.executionRestriction,
        allowParentNotify: previous.allowParentNotify, delegationPosition: this.delegationPosition,
      }, assertCurrent);
    } catch (error) {
      if (this.profileState === previous) {
        this.activeProfile = saved.activeProfile;
        this.activeProfileDefinitionId = saved.activeProfileDefinitionId;
        this.cognitionBinding = saved.cognition;
        this.cognitionRevision = saved.cognitionRevision;
        this.boundPromptDiagnostics = saved.diagnostics;
        this.promptFieldSnapshot = saved.promptFields;
        this.promptConfigurationSignature = saved.signature;
        this.personaSnapshot = saved.persona;
        this.frozenSkillListing = saved.skills;
        this.frozenPluginSections = saved.plugins;
      }
      throw error;
    }
  }

  async rebuildPromptContext(): Promise<void> {
    await this.systemPromptRefreshTail.catch(() => undefined);
    this.memorySnapshot.invalidate();
    const current = this.profileState;
    if (current.profileName === undefined) return;
    const liveProfile = this.catalog.get(current.profileName);
    if (liveProfile === undefined || liveProfile.private === true ||
      (current.routeId !== undefined && !this.catalog.listRoutes().some((route) => route.id === current.routeId))) {
      await this.refreshSystemPrompt();
      return;
    }
    this.activeProfile = undefined;
    this.frozenSkillListing = undefined;
    this.frozenPluginSections = undefined;
    this.promptConfigurationSignature = 'invalidated';
    await this.bind({
      personaSnapshot: current.persona ?? this.currentPersona,
      personaOverrides: current.personaOverrides,
      profile: current.profileName,
      route: current.routeId,
      model: current.modelAlias,
      thinking: current.thinkingLevel,
      lease: current.appliedLease,
      spawnPolicy: current.spawnPolicy,
      delegationPosition: this.delegationPosition,
    });
  }

  async refreshMemorySnapshot(): Promise<void> {
    if (this.states.get(dynamicPromptKey)?.enabled !== true) return;
    this.syncRestoredPersona();
    this.memorySnapshot.invalidate();
    await this.publishMemoryProjection(await this.memorySnapshot.get(this.states.get(dynamicPromptKey)?.context.memory));
  }

  async reconcileMemorySnapshot(): Promise<void> {
    if (this.states.get(dynamicPromptKey)?.enabled !== true) return;
    const memory = await this.memorySnapshot.refreshIfDirty();
    if (memory !== undefined) await this.publishMemoryProjection(memory);
  }

  private async publishMemoryProjection(memory: string): Promise<void> {
    const previous = this.states.get(dynamicPromptKey);
    if (previous?.enabled !== true || previous.context.memory === memory) return;
    const context = { ...previous.context, memory };
    const content = dynamicPromptContent(context);
    const hash = promptSectionHash(content);
    if (hash === previous.hash) return;
    await this.dispatcher.dispatch(new ProfileDynamicSnapshot({ enabled: true, revision: previous.revision + 1, context, content, hash }));
  }

  refreshSystemPrompt(): Promise<void> {
    const refresh = this.systemPromptRefreshTail.catch(() => undefined).then(() => this.refreshSystemPromptNow());
    this.systemPromptRefreshTail = refresh;
    return refresh;
  }

  private async refreshSystemPromptNow(): Promise<void> {
    try {
      this.syncRestoredPersona();
      const profile = this.resolveActiveProfile();
      if (profile === undefined) return;
      const renderProfile = { ...profile, ...effectiveToolBinding(this.data().toolPolicyBase ?? profile, this.profileState.toolOverride, this.profileState.boundProfile) };
      const context = await this.buildSystemPromptContext(renderProfile);
      this.activeProfile = profile;
      const assembled = await this.assembleBoundSystemPrompt(
        renderProfile,
        context,
        this.modelAlias ?? '',
        this.profileState.boundProfile?.promptBase,
        this.currentPersona,
        this.profileState.roomPrompt,
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
    const cognition = selectCognitionConfig(this.models.get(modelAlias)?.cognition, this.delegationPosition);
    return [cognition?.overlay, cognition?.steering, cognition?.anchor].some((refs) => cognitionPathRefs(refs).length > 0);
  }

  private declaresModelProfilePrompt(modelAlias: string | undefined, profile: Pick<ResolvedAgentProfile, 'modelPromptLayers' | 'modelProfiles' | 'sourcePath'> | undefined = this.activeProfile): boolean {
    if (profile === undefined) return false;
    return modelPromptLayers(profile).some((layer) => declaresModelProfilePrompt(
      layer.entries,
      modelAlias,
      this.isExternalExecutor ? (id) => id : (id) => this.models.resolveId(id),
      this.delegationPosition,
    ));
  }

  publishBindingAdvisories(): void {
    for (const advisory of this.profileState.bindingAdvisories ?? []) {
      const key = bindingAdvisoryKey(advisory);
      if (this.emittedBindingAdvisories.has(key)) continue;
      this.emittedBindingAdvisories.add(key);
      void this.dispatcher.dispatch(
        new WarningIssued({
          code: 'profile-binding-advisory',
          message: advisory.message,
          advisory,
        }),
      );
    }
  }

  private collectBindingAdvisories(input: {
    readonly profile?: ResolvedAgentProfile | import('./boundProfile').BoundProfile;
    readonly profileName: string;
    readonly profileIncludesOverlays?: boolean;
    readonly route?: {
      readonly id: string;
      readonly lockedModelAlias?: string;
      readonly lockedThinkingEffort?: string;
    };
    readonly lease?: SubagentLease;
    readonly spawnPolicy?: SpawnConstraints;
    readonly additionalConstraints?: readonly (BindingConstraintInput | SpawnConstraints)[];
    readonly model: string;
    readonly thinking: string;
    readonly modelSelection: BindingSelectionValue;
    readonly thinkingSelection: BindingSelectionValue;
    readonly models?: IModelService;
  }): readonly BindingAdvisory[] {
    const layers: BindingConstraintInput[] = [];
    if (input.profile !== undefined) {
      const profileConstraints = input.profileIncludesOverlays === true
        ? roleConstraintsFromProfile(input.profile)
        : roleConstraintsFromProfile({
            ...input.profile,
            modelConstraintProfiles: input.lease?.modelProfiles === undefined
              ? input.profile.modelConstraintProfiles
              : [...(input.profile.modelConstraintProfiles ?? []), ...(input.profile.modelProfiles ?? [])],
            modelProfiles: input.lease?.modelProfiles === undefined ? input.profile.modelProfiles : undefined,
          });
      layers.push({
        constraints: profileConstraints,
        ruleSource: input.profile.fileDefinition === undefined
          ? `profile:${input.profileName}`
          : `profile-file:${input.profile.sourcePath ?? input.profileName}`,
      });
    }
    if (input.profileIncludesOverlays !== true && input.lease !== undefined) {
      layers.push({
        constraints: input.lease,
        ruleSource: `caller-lease:${input.profileName}`,
      });
    }
    if (input.profileIncludesOverlays !== true && input.spawnPolicy !== undefined) {
      layers.push({
        constraints: input.spawnPolicy,
        ruleSource: 'caller-spawn-constraints',
      });
    }
    for (const [index, entry] of (input.additionalConstraints ?? []).entries()) {
      layers.push('constraints' in entry
        ? entry
        : { constraints: entry, ruleSource: `caller-constraint:${String(index + 1)}` });
    }
    const userMain = this.delegationPosition === 'main' && this.agentScope.agentId === MAIN_AGENT_ID;
    const advisories: BindingAdvisory[] = layers.flatMap((layer) =>
      roleBindingAdvisories({
        model: input.model,
        requestedModel: input.modelSelection.requestedValue,
        thinking: input.thinking,
        requestedThinking: input.thinkingSelection.requestedValue,
        constraints: layer.constraints,
        models: input.models,
        ruleSource: layer.ruleSource,
        modelValueSource: input.modelSelection.source,
        thinkingValueSource: input.thinkingSelection.source,
        position: userMain ? 'main' : 'sub',
      }),
    );
    if (userMain) return advisories;
    if (input.route?.lockedModelAlias !== undefined) {
      const advisory = pinBindingAdvisory({
        dimension: 'model',
        ruleSource: `route:${input.route.id}`,
        pinnedValue: input.route.lockedModelAlias,
        requestedValue: input.modelSelection.requestedValue,
        effectiveValue: input.model,
        valueSource: input.modelSelection.source,
        model: input.model,
        models: input.models,
      });
      if (advisory !== undefined) advisories.push(advisory);
    }
    if (input.route?.lockedThinkingEffort !== undefined) {
      const advisory = pinBindingAdvisory({
        dimension: 'thinking_effort',
        ruleSource: `route:${input.route.id}`,
        pinnedValue: input.route.lockedThinkingEffort,
        requestedValue: input.thinkingSelection.requestedValue,
        effectiveValue: input.thinking,
        valueSource: input.thinkingSelection.source,
        model: input.model,
      });
      if (advisory !== undefined) advisories.push(advisory);
    }
    if (input.route?.lockedModelAlias === undefined && input.lease?.modelAlias !== undefined) {
      const advisory = pinBindingAdvisory({
        dimension: 'model',
        ruleSource: `caller-lease:${input.profileName}`,
        pinnedValue: input.lease.modelAlias,
        requestedValue: input.modelSelection.requestedValue,
        effectiveValue: input.model,
        valueSource: input.modelSelection.source,
        model: input.model,
        models: input.models,
      });
      if (advisory !== undefined) advisories.push(advisory);
    }
    if (input.route?.lockedThinkingEffort === undefined && input.lease?.thinkingEffort !== undefined) {
      const advisory = pinBindingAdvisory({
        dimension: 'thinking_effort',
        ruleSource: `caller-lease:${input.profileName}`,
        pinnedValue: input.lease.thinkingEffort,
        requestedValue: input.thinkingSelection.requestedValue,
        effectiveValue: input.thinking,
        valueSource: input.thinkingSelection.source,
        model: input.model,
      });
      if (advisory !== undefined) advisories.push(advisory);
    }
    return [...new Map(advisories.map((advisory) => [bindingAdvisoryKey(advisory), advisory])).values()];
  }

  private assertCurrentBindingConstraints(model: string, thinking: string): void {
    const data = this.data();
    const forced = this.isExternalExecutor ? undefined
      : this.validatedForcedThinkingEffort(thinking as ThinkingEffort, this.resolveModelForThinking(model), model);
    this.collectBindingAdvisories({
      profile: data.boundProfile ?? this.activeProfile,
      profileName: data.profileName ?? 'saved',
      profileIncludesOverlays: true,
      model,
      thinking: forced ?? thinking,
      modelSelection: { source: 'runtime-explicit', requestedValue: model },
      thinkingSelection: { source: forced === undefined ? 'runtime-explicit' : 'environment-forced', requestedValue: thinking },
      models: this.isExternalExecutor ? undefined : this.models,
    });
  }

  private refreshCurrentBindingAdvisories(
    modelSelection: BindingSelectionValue,
    thinkingSelection: BindingSelectionValue,
  ): void {
    const data = this.data();
    if (data.modelAlias === undefined) return;
    const effectiveThinkingSelection = data.thinkingEffortSource === 'forced'
      ? { source: 'environment-forced' as const, requestedValue: data.thinkingLevel }
      : thinkingSelection;
    const advisories = this.collectBindingAdvisories({
      profile: data.boundProfile ?? this.activeProfile,
      profileName: data.profileName ?? 'saved',
      profileIncludesOverlays: true,
      route: data.routeId === undefined ? undefined : {
        id: data.routeId,
        lockedModelAlias: data.lockedModelAlias,
        lockedThinkingEffort: data.lockedThinkingEffort,
      },
      lease: data.appliedLease,
      spawnPolicy: data.spawnPolicy,
      model: data.modelAlias,
      thinking: data.effectiveThinkingLevel ?? data.thinkingLevel,
      modelSelection,
      thinkingSelection: effectiveThinkingSelection,
      models: this.isExternalExecutor ? undefined : this.models,
    });
    if (!bindingAdvisoriesEqual(data.bindingAdvisories, advisories)) {
      this.update({ bindingAdvisories: advisories });
    }
    this.publishBindingAdvisories();
  }

  private promptFieldSignature(
    profile: BoundProfile,
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
      position: this.delegationPosition,
      cognition: selectCognitionConfig(this.models.get(alias)?.cognition, this.delegationPosition),
    });
  }

  private async resolvePromptFieldSnapshot(
    profile: BoundProfile,
    alias: string,
  ): Promise<ResolvedPromptFieldOverrides> {
    await this.ensureDelegationPosition();
    return resolveProfilePromptFields(profile, alias, this.delegationPosition,
      this.config, this.models, this.promptFields);
  }

  private async assembleBoundSystemPrompt(
    profile: ResolvedAgentProfile,
    context: SystemPromptContext,
    alias: string,
    savedBase?: import('./boundProfile').BoundPromptBase,
    persona?: PersonaSnapshot,
    roomPrompt?: string,
  ): Promise<{ readonly text: string; readonly environment: EnvironmentDisclosureSnapshot; readonly promptBase: import('./boundProfile').BoundPromptBase; readonly promptFields: ResolvedPromptFieldOverrides; readonly personaPositionExplicit: boolean; readonly personaBaseHasIdentity: boolean }> {
    const promptVariables = this.config.get<PromptConfig>(PROMPT_SECTION)?.variables;
    const promptFields = await this.resolvePromptFieldSnapshot(profile, alias);
    const rendered = profile.renderSystemPrompt({
      ...context,
      persona: persona === undefined ? '' : PERSONA_PROMPT_MARKER,
      promptVariables,
      promptFields: promptFields.values,
    });
    const dynamic = this.states.get(dynamicPromptKey);
    const environment = dynamic?.enabled === true
      ? profile.renderSystemPrompt({ ...dynamic.context, promptVariables, promptFields: promptFields.values }).environment
      : rendered.environment;
    const withModel = modelPromptLayers(profile).reduce((text, layer) => applyMatchedModelProfilePrompt(
      text,
      layer.entries,
      alias,
      (profile.executor ?? 'native') === 'native'
        ? (id) => this.models.resolveId(id)
        : (id) => id,
      this.delegationPosition,
    ), rendered.text);
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
    const external = (profile.executor ?? 'native') !== 'native';
    const body = external
      ? renderExternalPrompt(
          profile,
          { ...context, persona: persona === undefined ? '' : PERSONA_PROMPT_MARKER, promptVariables, promptFields: promptFields.values },
          promptFields,
          withModel,
        )
      : await this.applyCognitionOverlay(withModel, alias, false);
    if (external) await this.applyCognitionOverlay('', alias, true);
    const personaPositionExplicit = body.includes(PERSONA_PROMPT_MARKER);
    const finalBody = applyPersonaPrompt(
      body,
      persona === undefined ? undefined : renderPersonaBlock(persona),
      roomPrompt,
    );
    const promptDiagnostics = this.buildPromptDiagnostics(profile, alias, promptFields);
    this.boundPromptDiagnostics = promptDiagnostics;
    if (this.cognitionBinding !== undefined) this.cognitionBinding = { ...this.cognitionBinding, bindingRevision: promptDiagnostics.binding_revision };
    return {
      text: external ? finalBody : injectDelegationContext(finalBody, snippet),
      environment,
      promptBase: { text: rendered.text, environment, delegationSnippet: snippet, promptVariablesRevision: createHash('sha256').update(JSON.stringify(promptVariables ?? {})).digest('hex'), promptDiagnostics },
      promptFields,
      personaPositionExplicit,
      personaBaseHasIdentity: hasDefaultIdentityParagraph(body),
    };
  }

  private async loadPersonaSnapshot(id: string | undefined): Promise<PersonaSnapshot | undefined> {
    if (id === undefined) return this.currentPersona;
    if (this.personas === undefined) {
      throw new ProfileError(
        ProfileErrors.codes.PERSONA_UNKNOWN,
        `Persona "${id}" is unavailable because the persona store is not configured`,
        { persona: id },
      );
    }
    const snapshot = await this.personas.get(id);
    if (snapshot === undefined) {
      throw new ProfileError(
        ProfileErrors.codes.PERSONA_UNKNOWN,
        `Unknown persona: "${id}"`,
        { persona: id },
      );
    }
    return freezePersonaSnapshot(snapshot);
  }

  private publishPersonaWarnings(
    persona: PersonaSnapshot | undefined,
    assembled: { readonly personaPositionExplicit: boolean; readonly personaBaseHasIdentity: boolean },
    profileName: string,
  ): void {
    if (persona === undefined) return;
    if (personaExamplesWereTruncated(persona) && !this.emittedPersonaWarnings.has('examples')) {
      this.emittedPersonaWarnings.add('examples');
      void this.dispatcher.dispatch(new WarningIssued({
        code: 'persona-examples-oversized',
        message: `Persona "${persona.definition.id}" examples exceed the 1.5k-token budget and were truncated.`,
      }));
    }
    if (!assembled.personaPositionExplicit && !assembled.personaBaseHasIdentity) {
      const key = `position:${profileName}`;
      if (this.emittedPersonaWarnings.has(key)) return;
      this.emittedPersonaWarnings.add(key);
      void this.dispatcher.dispatch(new WarningIssued({
        code: 'persona-position-prepended',
        message: `Profile "${profileName}" does not declare \${persona}; the persona block was prepended.`,
      }));
    }
  }

  private async resolveCurrentDelegationPosition(): Promise<DelegationPosition> {
    const meta = await this.metadata.read();
    return resolveDelegationPosition(this.agentScope.agentId, meta.agents?.[this.agentScope.agentId]?.delegator);
  }

  private async ensureDelegationPosition(): Promise<void> {
    if (this.delegationPositionResolved) return;
    this.delegationPosition = await this.resolveCurrentDelegationPosition();
    this.delegationPositionResolved = true;
  }

  private promptBindingRevision(profile: BoundProfile, alias: string, fields: ResolvedPromptFieldOverrides, cognitionRevision: string | undefined): string {
    return createHash('sha256').update(JSON.stringify({
      signature: this.promptFieldSignature(profile, alias, fields),
      modelPrompts: modelPromptLayers(profile),
      baseBody: profile.fileDefinition?.prompt,
      baseMode: profile.systemPromptMode,
      cognitionRevision,
    })).digest('hex');
  }

  private buildPromptDiagnostics(profile: BoundProfile, alias: string, fields: ResolvedPromptFieldOverrides): AgentPromptDiagnostics {
    const model = this.models.get(alias);
    const layers = modelPromptLayers(profile);
    const leaseMode = profile.modelPromptBase === undefined ? undefined : layers.some((layer) => layer.source === 'profile') ? 'preserve' as const : 'replace' as const;
    const resolveId = (profile.executor ?? 'native') === 'native' ? (id: string) => this.models.resolveId(id) : (id: string) => id;
    return {
      identity: { delegation_position: this.delegationPosition, profile: profile.name, model_alias: alias, executor: profile.executor ?? 'native' },
      binding_revision: this.promptBindingRevision(profile, alias, fields, this.cognitionBinding?.contentRevision),
      apply_on: 'next-binding-or-context-rebuild',
      lease_model_prompts: leaseMode,
      channels: promptConfigurationChannels({
        profile, alias, position: this.delegationPosition, cognition: model?.cognition, fields, resolveId, leaseMode,
        overrideDeclarations: [
          { surface: 'global', overrides: this.config.get<PromptConfig>(PROMPT_SECTION)?.overrides },
          { surface: 'model', overrides: model?.promptOverrides },
          { surface: 'profile', overrides: profile.promptOverrideLayers ?? profile.promptOverrides, path: (profile.promptOverrideLayers?.length ?? 0) > 1 ? undefined : profile.sourcePath },
          ...layers.map((layer) => ({ surface: layer.source === 'lease' ? 'caller-lease-model' : 'profile-model', overrides: resolveModelProfileEntry(layer.entries, alias, resolveId)?.promptOverrides, path: layer.sourcePath })),
        ],
      }),
    };
  }

  async getPromptDiagnostics(options?: { readonly checkAllPromptFiles?: boolean }): Promise<AgentPromptDiagnostics> {
    await this.ensureDelegationPosition();
    const current = this.resolveActiveProfile();
    const alias = this.modelAlias ?? '';
    const binding = await this.getCognitionBinding();
    const bound = this.boundPromptDiagnostics ?? this.profileState.boundProfile?.promptBase?.promptDiagnostics;
    const snapshot = bound ?? (current === undefined ? {
      identity: { delegation_position: this.delegationPosition, profile: this.profileName, model_alias: this.modelAlias, executor: this.profileState.executorId ?? 'native' },
      apply_on: 'next-binding-or-context-rebuild' as const,
      channels: [],
    } : this.buildPromptDiagnostics(current, alias, this.promptFieldSnapshot));
    let diskRevision: string | undefined;
    let diskError: string | undefined;
    const live = this.catalog.get(this.profileName ?? '') ?? current;
    const diskProfile = live === undefined ? undefined : applyLease(live, this.profileState.appliedLease, (id) => this.models.resolveId(id));
    const fileChecks = options?.checkAllPromptFiles === true && diskProfile !== undefined ? await checkPromptFiles({
      fs: this.hostFs, homeDir: this.bootstrap.homeDir, pathClass: this.hostEnv.pathClass,
      profile: diskProfile, model: this.models.get(alias), modelAlias: alias,
      global: this.config.get<PromptConfig>(PROMPT_SECTION)?.overrides,
    }) : undefined;
    try {
      if (diskProfile !== undefined) {
        const fields = await this.resolvePromptFieldSnapshot(diskProfile, alias);
        const config = (diskProfile.executor ?? 'native') === 'native' ? selectCognitionConfig(this.models.get(alias)?.cognition, this.delegationPosition) : undefined;
        const slots = await loadCognitionSlots(this.hostFs, this.bootstrap.homeDir, config, this.hostEnv.pathClass);
        const contentRevision = createHash('sha256').update(JSON.stringify({ alias: this.models.resolveId(alias) ?? alias, position: this.delegationPosition, config, slots })).digest('hex');
        diskRevision = this.promptBindingRevision(diskProfile, alias, fields, contentRevision);
      }
    } catch (error) {
      diskError = error instanceof Error ? error.message : String(error);
    }
    return {
      ...snapshot,
      binding_revision: bound?.binding_revision ?? snapshot.binding_revision ?? binding.bindingRevision,
      disk_revision: diskRevision,
      disk_changed: diskRevision === undefined || snapshot.binding_revision === undefined ? undefined : diskRevision !== snapshot.binding_revision,
      disk_error: diskError,
      request: this.states.get(llmRequestTraceKey).lastRequest,
      file_checks: fileChecks,
    };
  }

  getCognitionSnapshot(): CognitionBinding | undefined {
    return this.cognitionBinding;
  }

  async getCognitionBinding(): Promise<CognitionBinding> {
    await this.ensureDelegationPosition();
    const alias = this.modelAlias ?? '';
    if (this.cognitionBinding?.modelAlias === alias && this.cognitionBinding.position === this.delegationPosition) return this.cognitionBinding;
    await this.applyCognitionOverlay('', alias);
    return this.cognitionBinding!;
  }

  private async applyCognitionOverlay(base: string, modelAlias: string, external = this.isExternalExecutor): Promise<string> {
    const config = external ? undefined : selectCognitionConfig(this.models.get(modelAlias)?.cognition, this.delegationPosition);
    try {
      const slots = await loadCognitionSlots(
        this.hostFs,
        this.bootstrap.homeDir,
        config,
        this.hostEnv.pathClass,
      );
      this.cognitionBinding = {
        position: this.delegationPosition,
        modelAlias,
        revision: ++this.cognitionRevision,
        contentRevision: createHash('sha256').update(JSON.stringify({ alias: this.models.resolveId(modelAlias) ?? modelAlias, position: this.delegationPosition, config, slots })).digest('hex'),
        config: config === undefined ? undefined : structuredClone(config),
        anchor: slots.anchor,
      };
      return applyOverlay(base, slots.overlay, config?.overlayMode ?? 'append');
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
    const toolPolicyBase = {
      tools: this.states.get(profileActiveToolsKey) as ActiveToolsState,
      toolAllowPolicies: this.profileState.toolAllowPolicies,
      disallowedTools: this.profileState.disallowedTools,
    };
    const toolPolicy = effectiveToolBinding(toolPolicyBase, this.profileState.toolOverride, this.profileState.boundProfile);
    return {
      toolOverride: this.profileState.toolOverride,
      toolPolicyBase,
      memoryReadContext: this.profileState.memoryReadContext,
      modelAlias: this.modelAlias,
      modelCapabilities: model?.capabilities ?? UNKNOWN_CAPABILITY,
      personaId: this.profileState.personaId,
      personaRevision: this.profileState.personaRevision,
      personaOverrides: this.profileState.personaOverrides,
      persona: this.currentPersona,
      roomPrompt: this.profileState.roomPrompt,
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
      executorPrompt: this.profileState.executorPrompt,
      allowKikiSubagents: this.profileState.allowKikiSubagents,
      kikiContext: this.profileState.kikiContext,
      executorDescriptorRevision: this.profileState.executorDescriptorRevision,
      thinkingLevel: this.thinkingLevel,
      effectiveThinkingLevel: thinking.effective,
      thinkingEffortSource: thinking.forced !== undefined
        ? 'forced'
        : this.profileState.thinkingEffortAdjusted ? 'adjusted' : undefined,
      routeDetached,
      profileSource: this.profileState.boundProfile?.fileSources === undefined ? 'registered' : 'profile-file',
      permissionMode: (this.profileState.boundProfile ?? this.activeProfile)?.permissionMode,
      bindingAdvisories: this.profileState.bindingAdvisories,
      systemPrompt: this.systemPrompt,
      agentsMdPaths: this.profileState.agentsMdPaths,
      activeToolNames: this.activeToolNames === undefined ? undefined : [...this.activeToolNames],
      executionRestriction: this.profileState.executionRestriction,
      allowParentNotify: this.profileState.allowParentNotify,
      toolAllowPolicies: this.profileState.executionRestriction === 'research-readonly'
        ? [...(toolPolicy.toolAllowPolicies ?? []), RESEARCH_READONLY_TOOLS]
        : toolPolicy.toolAllowPolicies?.map((policy) => [...policy]),
      disallowedTools: toolPolicy.disallowedTools,
      disabledToolGroups:
        this.profileState.disabledToolGroups === undefined
          ? undefined
          : [...this.profileState.disabledToolGroups],
      canSpawnSubagents: this.profileState.canSpawnSubagents,
      allowedSubagents: this.profileState.allowedSubagents,
      preferredSubagents: this.profileState.preferredSubagents,
      denySubagents: this.profileState.denySubagents,
      subagentLeases: this.profileState.subagentLeases,
      dispatchDecision: this.profileState.dispatchDecision,
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

  resolveContextStrategy(): import('@kiki/agent-profiles/agentProfile').ContextStrategy | undefined {
    const bound = this.profileState.boundProfile ?? this.activeProfile;
    const candidate = this.profileState.profileName === undefined ? undefined : this.catalog.get(this.profileState.profileName);
    const profile = candidate?.definitionId !== undefined && candidate.definitionId === bound?.definitionId
      ? candidate : bound;
    const model = this.tryResolveRawModel();
    const entry = model === undefined ? undefined : resolveModelProfileEntry(
      profile?.modelProfiles, model.id, (id) => this.models.resolveId(id),
    );
    return entry?.contextStrategy ?? profile?.contextStrategy;
  }

  resolveModelContext(): ProfileModelContext {
    if ((this.profileState.executorId ?? 'native') !== 'native') {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `resolveModelContext is unsupported for external executor "${this.profileState.executorId}"`,
      );
    }
    const modelAlias = this.model;
    const model = this.resolveUsageModel(modelAlias);
    const loopControl = this.config.get<LoopControl>('loopControl');
    const bound = this.profileState.boundProfile ?? this.activeProfile;
    const candidate = this.profileState.profileName === undefined ? undefined : this.catalog.get(this.profileState.profileName);
    const profile = candidate?.definitionId !== undefined && candidate.definitionId === bound?.definitionId
      ? candidate : bound;
    const entry = resolveModelProfileEntry(profile?.modelProfiles, model.id, (id) => this.models.resolveId(id));
    return {
      modelAlias,
      modelCapabilities: this.getModelCapabilities(),
      maxOutputSize: this.getMaxOutputSize(),
      alwaysThinking: model.alwaysThinking || undefined,
      thinkingLevel: this.resolveThinkingState(model).effective,
      reservedContextSize: loopControl?.reservedContextSize,
      globalAutoCompact: loopControl?.autoCompact,
      modelAutoCompact: model.autoCompact,
      profileAutoCompact: entry?.autoCompact ?? profile?.autoCompact,
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
    const profileParameters = this.resolveProfileParameters(model);
    const requestParams = profileParameters.requestParams;
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
      serviceTier: profileParameters.serviceTier ?? model?.generationParameters?.serviceTier ?? parameters.serviceTier,
      requestParams,
      maxCompletionTokens: parameters.maxCompletionTokens,
      maxContextTokens: parameters.contextBudget === undefined ? undefined : this.getModelCapabilities().max_context_tokens,
    };
  }

  private resolveModelParameters(model: Model | undefined) {
    return mergeModelParameters(model, this.resolveProfileParameters(model));
  }

  private resolveProfileParameters(model: Model | undefined) {
    const profile = this.profileState.boundProfile ?? this.activeProfile;
    const entry = resolveModelProfileEntry(profile?.modelProfiles, model?.id ?? '', (id) => this.models.resolveId(id));
    return mergeModelParameters(profile ?? { serviceTier: this.serviceTier, requestParams: this.requestParams }, entry);
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
    return this.profileName !== undefined && (this.isExternalExecutor || this.hasModel());
  }

  hasProvider(): boolean {
    if (this.isExternalExecutor) {
      return this.executors.provider(this.profileState.executorProtocol!) !== undefined;
    }
    return this.tryResolveRawModel() !== undefined;
  }

  getSystemPrompt(): string {
    const variables = customPromptVariables(this.config.get<PromptConfig>(PROMPT_SECTION)?.variables);
    const prompt = appendSharedPromptField(this.systemPrompt, this.promptFieldSnapshot, variables);
    return this.runtime.nativeSshEnabled?.() ? `${prompt}\n\n${NATIVE_SSH_SYSTEM_PROMPT}` : prompt;
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
        && selectCognitionConfig(this.models.get(this.modelAlias ?? '')?.cognition, this.delegationPosition) === undefined
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
    if (changed.personaOverrides !== undefined) payload.personaOverrides = changed.personaOverrides;
    if (changed.promptBase !== undefined) payload.promptBase = changed.promptBase;
    if (changed.modelAlias !== undefined) payload.modelAlias = changed.modelAlias;
    if (changed.profileName !== undefined) payload.profileName = changed.profileName;
    if (changed.bindingAdvisories !== undefined) payload.bindingAdvisories = [...changed.bindingAdvisories];
    if (changed.allowParentNotify !== undefined) payload.allowParentNotify = changed.allowParentNotify;
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

  private get currentPersona(): PersonaSnapshot | undefined {
    return this.personaSnapshot ?? this.profileState.persona;
  }

  private syncRestoredPersona(): void {
    const persona = this.profileState.persona ?? this.personaSnapshot;
    if (persona !== undefined) this.personaSnapshot = freezePersonaSnapshot(persona);
    this.memorySnapshot.configurePersona(this.profileState.memoryReadContext ?? memoryPersonaContext(this.personaSnapshot));
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
    const forced = this.validatedForcedThinkingEffort(base, model, this.modelAlias);
    return { effective: forced ?? base, forced };
  }

  private validatedForcedThinkingEffort(
    base: ThinkingEffort,
    model: Model | undefined,
    modelAlias: string | undefined,
  ): ThinkingEffort | undefined {
    const forced = resolveForcedThinkingEffort(
      this.config.get<ThinkingConfig>(THINKING_SECTION)?.forcedEffort,
      base,
      drivesThinkingThroughTraits(model?.providerType),
    );
    if (forced === undefined || modelAlias === undefined) return forced;
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
      return this.resolveUsageModel(alias);
    } catch {
      return undefined;
    }
  }

  private resolveUsageModel(alias: string): Model {
    return modelWithUsage(this.modelCatalog.get(alias), this.delegationPosition);
  }

  private assertRouteBindable(requestedRoute?: string): void {
    const currentRoute = this.routeId;
    const bound = this.profileName !== undefined || currentRoute !== undefined;
    if (bound && currentRoute !== requestedRoute) {
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
        return bound === undefined ? { ...restored, restrictModelsToMenu: false, modelMenuConstraint: undefined } : { ...bound, systemPrompt: restored.systemPrompt, renderSystemPrompt: restored.renderSystemPrompt };
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
    const restored = applySpawnPolicy(
      applyLease({ ...catalogProfile, restrictModelsToMenu: false, modelMenuConstraint: undefined }, this.profileState.appliedLease, resolveId),
      this.profileState.spawnPolicy,
      resolveId,
    );
    return bound === undefined ? restored : { ...bound, systemPrompt: restored.systemPrompt, renderSystemPrompt: restored.renderSystemPrompt };
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

  private profileToolPatternChecks(profile: Pick<ResolvedAgentProfile, 'name' | 'routeId' | 'tools' | 'toolAllowPolicies' | 'disallowedTools'>): {
    context: string;
    field: string;
    patterns: readonly string[] | undefined;
  }[] {
    const checks: {
      context: string;
      field: string;
      patterns: readonly string[] | undefined;
    }[] = [
      { context: `profile "${profile.name}"`, field: 'tools', patterns: profile.tools?.filter((name) => name !== '*') },
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
        patterns: patterns.filter((name) => name !== '*'),
      });
    }
    return checks;
  }

  private assertProfileToolPatterns(
    profile: Pick<ResolvedAgentProfile, 'name' | 'routeId' | 'tools' | 'toolAllowPolicies' | 'disallowedTools'>,
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
      { context: 'the global [tools] config', field: 'enabled', patterns: global?.enabled?.filter((name) => name !== '*') },
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
    personaOverride?: PersonaSnapshot | null,
  ): Promise<SystemPromptContext> {
    const preloadedAgentsMd = await this.workspaceInstructionsSnapshot();
    const fsAvailable = this.runtime.isAvailable(['fs']);
    const lease = this.runtime.acquire(fsAvailable ? ['fs'] : []);
    const env = lease.runtime.environment;
    const runtimeId = lease.runtime.identity.runtimeId;
    const view = new RuntimeWorkspaceView(lease.runtime, {
      workDir: this.sessionContext.cwd,
      additionalDirs: options?.additionalDirs ?? this.workspace.additionalDirs,
    });
    const previous = this.states.get(dynamicPromptKey);
    const sampled = previous?.context.cwd === view.workDir ? previous.context : undefined;
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
              cwdListing: sampled?.cwdListing,
              additionalDirsInfo: sampled?.additionalDirsInfo !== undefined &&
                JSON.stringify([...sampled.additionalDirsInfo.matchAll(/^### (.+)$/gm)].map((match) => match[1])) === JSON.stringify(view.additionalDirs)
                ? sampled.additionalDirsInfo : undefined,
            },
          );
    } finally {
      lease.dispose();
    }
    const skills = await this.resolveSkillListing();
    const pluginSections = await this.resolvePluginSections();
    const now = this.clock.now();
    const timeZone = this.clock.timeZone();
    const memory = await this.readMemoryForPersonaOverride(personaOverride);
    const context: SystemPromptContext = {
      ...base,
      agentsMdFiles: base.agentsMdFiles?.map((file) => ({ ...file, runtimeId })),
      cwd: view.workDir,
      osKind: env.osKind,
      shellName: env.shellName,
      shellPath: env.shellPath,
      now: now.toISOString(),
      timeZone,
      skills,
      pluginSections,
      memory,
      persona: this.currentPersona === undefined ? '' : PERSONA_PROMPT_MARKER,
      skillActive: this.isToolActiveForProfile(profile, 'Skill'),
      productName: (await this.identity.resolved()).displayName,
      replyStyleGuide: this.bootstrap.args.replyStyleGuide,
    };
    const enabled = previous?.enabled === true || this.profileState.renderGeneration === 0 || this.promptLayoutMigrationPending;
    this.promptLayoutMigrationPending = false;
    const effective = enabled ? context : legacyEnvironmentContext(context, this.profileState.systemPrompt, previous?.context);
    const content = dynamicPromptContent(effective);
    const hash = promptSectionHash(content);
    if (previous?.hash !== hash || previous.enabled !== enabled) {
      await this.dispatcher.dispatch(new ProfileDynamicSnapshot({ enabled, revision: (previous?.revision ?? 0) + 1, context: effective, content, hash }));
    }
    return enabled ? stablePromptContext(effective) : effective;
  }

  private async readMemoryForPersonaOverride(persona: PersonaSnapshot | null | undefined): Promise<string> {
    if (persona === undefined) return this.memorySnapshot.get();
    const previous = this.memorySnapshot.getPersona();
    this.memorySnapshot.configurePersona(memoryPersonaContext(persona));
    try {
      return await this.memorySnapshot.get();
    } finally {
      this.memorySnapshot.configurePersona(previous);
    }
  }

  private async workspaceInstructionsSnapshot(): Promise<LoadedAgentsMd> {
    await this.instructions.ready;
    return {
      content: this.instructions.agentsMd ?? '',
      warning: this.instructions.agentsMdWarning,
      paths: this.instructions.agentsMdPaths ?? [],
      files: this.instructions.agentsMdFiles,
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
    const live = this.states.get(dynamicPromptKey)?.enabled === true || this.profileState.renderGeneration === 0 || this.promptLayoutMigrationPending;
    if (!live && this.frozenSkillListing !== undefined) return this.frozenSkillListing;
    try {
      await this.skillCatalog.ready;
      const listing = this.skillCatalog.catalog.getModelSkillListing();
      if (!live) this.frozenSkillListing = listing;
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

function freezePersonaSnapshot(snapshot: PersonaSnapshot | undefined): PersonaSnapshot | undefined {
  if (snapshot === undefined) return undefined;
  return freezeValue(structuredClone(snapshot));
}

function freezeValue<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freezeValue(child);
    Object.freeze(value);
  }
  return value;
}

function memoryPersonaContext(snapshot: PersonaSnapshot | null | undefined): { readonly id: string; readonly shared: readonly ('global' | 'workspace')[] } | undefined {
  if (snapshot === null || snapshot === undefined) return undefined;
  return {
    id: snapshot.definition.id,
    shared: snapshot.definition.memory?.shared ?? ['global', 'workspace'],
  };
}

function bindingAdvisoriesEqual(
  left: readonly BindingAdvisory[] | undefined,
  right: readonly BindingAdvisory[],
): boolean {
  if ((left?.length ?? 0) !== right.length) return false;
  return right.every((advisory, index) =>
    left?.[index] !== undefined && bindingAdvisoryKey(left[index]) === bindingAdvisoryKey(advisory),
  );
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentProfileService,
  AgentProfileService,
  ScopeActivation.OnScopeCreated,
  'profile',
);
