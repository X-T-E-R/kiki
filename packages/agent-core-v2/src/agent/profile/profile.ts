import type { BindingAdvisory, BindingValueSource } from '@kiki/agent-profiles/bindingAdvisory';
import type {
  ExecutorBinding,
  ExecutorValidationResult,
} from '@kiki/agent-profiles/ports';

import type {
  AgentProfile,
  AgentProfileContext,
  EnvironmentDisclosureSnapshot,
  ResolvedAgentProfileRoute,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { SpawnConstraints, SubagentLease } from '#/app/agentProfileCatalog/subagentLease';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { RequestParams, ServiceTier, ThinkingEffort } from '#/kosong/contract/provider';
import type { ModelRequestParams } from '#/kosong/model/modelRequester';
import type { ToolGroupId } from '@kiki/agent-profiles/toolGroups';

import { createDecorator } from "#/_base/di/instantiation";
import type { ErrorCode } from '#/errors';
import { Error2 } from '#/_base/errors/errors';

import { ProfileErrors } from './errors';

export { ProfileErrors } from './errors';

export type ProfileErrorCode = (typeof ProfileErrors.codes)[keyof typeof ProfileErrors.codes];

export class ProfileError extends Error2 {
  constructor(code: ProfileErrorCode, message: string, details?: Record<string, unknown>) {
    super(code as ErrorCode, message, { details });
    this.name = 'ProfileError';
  }
}

export interface AgentConfigData {
  driver?: 'external';
  modelAlias?: string;
  modelCapabilities: ModelCapability;
  profileName?: string;
  profileDefinitionId?: string;
  routeId?: string;
  readonly lockedModelAlias?: string;
  readonly lockedThinkingEffort?: string;
  thinkingLevel: string;
  systemPrompt: string;
}

export type AgentConfigUpdateData = Partial<{
  modelAlias: string;
  profileName: string;
  thinkingLevel: string;
  systemPrompt: string;
}>;

export interface SystemPromptContext extends AgentProfileContext {
  readonly pluginBlocks?: Readonly<Record<string, string>>;
  readonly agentsMdWarning?: string;
  readonly agentsMdPaths?: readonly string[];
  readonly agentsMdFiles?: readonly import('#/agent/agentsMdReminder/instructionCoverage').InstructionFile[];
}

export type ResolvedAgentProfile = AgentProfile;

export type ThinkingEffortSource = 'forced' | 'adjusted';
export type ProfileBindingSource = 'registered' | 'profile-file';

export interface ToolBindingOverride {
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
}

export interface ProfileToolPolicyBase {
  readonly tools?: readonly string[];
  readonly toolAllowPolicies?: readonly (readonly string[])[];
  readonly disallowedTools?: readonly string[];
}

export interface ProfileData extends AgentConfigData {
  readonly toolOverride?: ToolBindingOverride;
  readonly toolPolicyBase?: ProfileToolPolicyBase;
  readonly memoryReadContext?: import('#/app/memory/memorySnapshot').MemoryPersonaContext;
  readonly personaId?: string;
  readonly personaRevision?: string;
  readonly personaOverrides?: Readonly<{ profile?: string; model?: string; thinking?: string }>;
  readonly persona?: import('@kiki/agent-profiles/personaFile').PersonaSnapshot;
  readonly roomPrompt?: string;
  readonly effectiveThinkingLevel?: ThinkingEffort;
  readonly thinkingEffortSource?: ThinkingEffortSource;
  readonly routeDetached?: boolean;
  readonly profileSource?: ProfileBindingSource;
  readonly permissionMode?: import('@kiki/agent-profiles/agentProfile').AgentPermissionMode;
  readonly bindingAdvisories?: readonly BindingAdvisory[];
  readonly executionRestriction?: import('./executionRestriction').ExecutionRestriction;
  readonly allowParentNotify?: boolean;
  readonly execution?: import('@kiki/protocol').ExecutionBinding;
  readonly executorId?: string;
  readonly executorProtocol?: string;
  readonly executorOptions?: Readonly<Record<string, string | number | boolean>>;
  readonly executorPrompt?: import('@kiki/agent-profiles/executorPrompt').ExecutorPrompt;
  readonly allowKikiSubagents?: boolean;
  readonly kikiContext?: AgentProfile['kikiContext'];
  readonly executorDescriptorRevision?: string;
  readonly agentsMdPaths?: readonly string[];
  readonly activeToolNames?: readonly string[];
  readonly toolAllowPolicies?: readonly (readonly string[])[];
  readonly disallowedTools?: readonly string[];
  readonly disabledToolGroups?: readonly ToolGroupId[];
  readonly subagentPolicy?: AgentProfile['subagentPolicy'];
  readonly subagentDeclaration?: AgentProfile['subagentDeclaration'];
  readonly canSpawnSubagents?: boolean;
  readonly allowedSubagents?: readonly string[];
  readonly preferredSubagents?: readonly string[];
  readonly denySubagents?: readonly string[];
  readonly subagents?: readonly string[];
  readonly subagentLeases?: Readonly<Record<string, SubagentLease>>;
  readonly dispatchDecision?: import('#/app/agentProfileCatalog/subagentDispatch').SubagentDispatchDecision;
  readonly spawnPolicy?: SpawnConstraints;
  readonly appliedLease?: SubagentLease;
  readonly boundProfile?: import('./boundProfile').BoundProfile;
  readonly serviceTier?: ServiceTier;
  readonly requestParams?: RequestParams;
  readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
  readonly renderGeneration?: number;
}

export type ProfileUpdateData = Partial<{
  execution: import('@kiki/protocol').ExecutionBinding;
  personaOverrides: NonNullable<ProfileData['personaOverrides']>;
  promptBase: import('./boundProfile').BoundPromptBase;
  modelAlias: string;
  profileName: string;
  thinkingLevel: string;
  thinkingEffortAdjusted: boolean;
  bindingAdvisories: readonly BindingAdvisory[];
  allowParentNotify: boolean;
  systemPrompt: string;
  environmentDisclosure: EnvironmentDisclosureSnapshot;
  agentsMdPaths: readonly string[];
  disallowedTools: readonly string[];
  disabledToolGroups: readonly ToolGroupId[];
  activeToolNames: readonly string[];
}>;

export interface ProfileBindingSnapshot {
  readonly driver?: 'external';
  readonly toolOverride?: ToolBindingOverride;
  readonly toolPolicyBase?: ProfileToolPolicyBase;
  readonly memoryReadContext?: import('#/app/memory/memorySnapshot').MemoryPersonaContext;
  readonly personaId?: string;
  readonly personaRevision?: string;
  readonly personaOverrides?: Readonly<{ profile?: string; model?: string; thinking?: string }>;
  readonly persona?: import('@kiki/agent-profiles/personaFile').PersonaSnapshot;
  readonly roomPrompt?: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly profileDefinitionId?: string;
  readonly routeId?: string;
  readonly lockedModelAlias?: string;
  readonly lockedThinkingEffort?: string;
  readonly executionRestriction?: import('./executionRestriction').ExecutionRestriction;
  readonly allowParentNotify?: boolean;
  readonly execution?: import('@kiki/protocol').ExecutionBinding;
  readonly executorId?: string;
  readonly executorProtocol?: string;
  readonly executorOptions?: Readonly<Record<string, string | number | boolean>>;
  readonly executorPrompt?: import('@kiki/agent-profiles/executorPrompt').ExecutorPrompt;
  readonly allowKikiSubagents?: boolean;
  readonly kikiContext?: AgentProfile['kikiContext'];
  readonly executorDescriptorRevision?: string;
  readonly thinkingLevel: string;
  readonly thinkingEffortAdjusted?: boolean;
  readonly bindingAdvisories?: readonly BindingAdvisory[];
  readonly serviceTier?: ServiceTier;
  readonly requestParams?: RequestParams;
  readonly systemPrompt: string;
  readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
  readonly renderGeneration?: number;
  readonly agentsMdPaths?: readonly string[];
  readonly activeToolNames?: readonly string[];
  readonly toolAllowPolicies?: readonly (readonly string[])[];
  readonly disallowedTools?: readonly string[];
  readonly disabledToolGroups?: readonly ToolGroupId[];
  readonly subagentPolicy?: AgentProfile['subagentPolicy'];
  readonly subagentDeclaration?: AgentProfile['subagentDeclaration'];
  readonly canSpawnSubagents?: boolean;
  readonly allowedSubagents?: readonly string[];
  readonly preferredSubagents?: readonly string[];
  readonly denySubagents?: readonly string[];
  readonly subagents?: readonly string[];
  readonly subagentLeases?: Readonly<Record<string, SubagentLease>>;
  readonly dispatchDecision?: import('#/app/agentProfileCatalog/subagentDispatch').SubagentDispatchDecision;
  readonly spawnPolicy?: SpawnConstraints;
  readonly appliedLease?: SubagentLease;
  readonly boundProfile?: import('./boundProfile').BoundProfile;
}

export interface ProfileServiceOptions {
  readonly emitStatusUpdated?: () => void;
}

export interface ApplyProfileOptions {
  readonly additionalDirs?: readonly string[];
}

export interface ProfileModelContext {
  readonly modelAlias: string;
  readonly modelCapabilities: ModelCapability;
  readonly maxOutputSize: number | undefined;
  readonly alwaysThinking: boolean | undefined;
  readonly thinkingLevel: ThinkingEffort;
  readonly reservedContextSize: number | undefined;
  readonly globalAutoCompact?: string;
  readonly modelAutoCompact?: number;
  readonly profileAutoCompact?: number;
  readonly sessionAutoCompact?: number;
  readonly compactionTriggerRatio: number | undefined;
  readonly compactionMaxAttempts: number | undefined;
  readonly compactionSoftContextSize: number | undefined;
}

export interface ProfileSetModelResult {
  readonly model: string;
  readonly providerName?: string | undefined;
}

export interface ProfileSetEffortResult {
  readonly effort: string;
}

export interface PreparedModelSwitchBinding {
  readonly model: string;
  readonly thinking: string;
  readonly config: import('./profileOps').ConfigUpdatePayload;
  readonly maxContextTokens: number | undefined;
  readonly reservedTokens: number | undefined;
  assertCurrent(): void;
  syncMetadata(): Promise<void>;
}

export interface BindingSelectionValue {
  readonly source: BindingValueSource;
  readonly requestedValue?: string;
}

export interface BindingSelectionInput {
  readonly model: BindingSelectionValue;
  readonly thinking?: BindingSelectionValue;
}

export interface BindingConstraintInput {
  readonly constraints: SpawnConstraints | SubagentLease;
  readonly ruleSource: string;
}

export interface BindAgentInput {
  readonly driver?: 'external' | 'local';
  readonly execution?: import('@kiki/protocol').ExecutionSelection;
  readonly toolOverride?: ToolBindingOverride;
  readonly memoryReadContext?: import('#/app/memory/memorySnapshot').MemoryPersonaContext;
  readonly persona?: string;
  readonly personaSnapshot?: import('@kiki/agent-profiles/personaFile').PersonaSnapshot;
  readonly personaOverrides?: NonNullable<ProfileData['personaOverrides']>;
  readonly roomPrompt?: string;
  readonly executionRestriction?: import('./executionRestriction').ExecutionRestriction;
  readonly allowParentNotify?: boolean;
  readonly profile?: string;
  readonly route?: string;
  readonly resolvedProfile?: AgentProfile;
  readonly resolvedRoute?: ResolvedAgentProfileRoute;
  readonly model?: string;
  readonly thinking?: string;
  readonly bindingSelection?: BindingSelectionInput;
  readonly strictThinking?: boolean;
  readonly inheritedUserToolNames?: readonly string[];
  readonly delegationPosition?: 'main' | 'sub' | 'independent';
  readonly lease?: SubagentLease;
  readonly spawnPolicy?: SpawnConstraints;
  readonly dispatchDecision?: import('#/app/agentProfileCatalog/subagentDispatch').SubagentDispatchDecision;
}

export interface IAgentProfileService {
  readonly _serviceBrand: undefined;

  configure(options: ProfileServiceOptions): void;
  update(changed: ProfileUpdateData): void;
  applyBindingSnapshot(snapshot: ProfileBindingSnapshot): void;
  /** Runs the optional guard synchronously before committing a prepared binding; throwing prevents the commit. */
  bind(input: BindAgentInput, assertCurrent?: () => void): Promise<void>;
  applyPersonaSettings(restoreDefaults?: boolean): Promise<void>;
  /** Runs the optional guard synchronously before committing a prepared model; throwing prevents the commit. */
  setModel(model: string, assertCurrent?: () => void): Promise<ProfileSetModelResult>;
  prepareModelSwitchBinding(model: string, thinking?: string): Promise<PreparedModelSwitchBinding>;
  setEffort(level: string): ProfileSetEffortResult;
  setThinking(level: string): void;
  validateBinding(binding: ExecutorBinding): ExecutorValidationResult;
  prepareResumeBinding(input: {
    readonly toolOverride?: ToolBindingOverride;
    readonly modelAlias?: string;
    readonly thinkingEffort?: string;
    readonly allowModelChange?: boolean;
    readonly newWindow?: boolean;
    readonly allowParentNotify?: boolean;
    readonly callerConstraints?: readonly (BindingConstraintInput | SpawnConstraints)[];
  }): Promise<PreparedModelSwitchBinding>;
  syncBindingMetadata(): Promise<void>;
  publishBindingAdvisories(): void;
  republishStatus(): void;
  getModel(): string;
  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void;
  applyProfile(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<void>;
  refreshSystemPrompt(): Promise<void>;
  refreshMemorySnapshot(): Promise<void>;
  reconcileMemorySnapshot(): Promise<void>;
  reconcilePluginUsage?(): Promise<void>;
  rebuildPromptContext(): Promise<void>;
  preparePromptConfiguration(): Promise<boolean>;
  getCognitionBinding(): Promise<import('#/agent/cognition/cognitionConfig').CognitionBinding>;
  getCognitionSnapshot(): import('#/agent/cognition/cognitionConfig').CognitionBinding | undefined;
  getRecipeModelSettings(alias?: string): Record<string, unknown> | undefined;
  getRecipeScriptHooks(): Promise<readonly import('#/features/externalHooks/internal/types').HookDef[]>;
  getPromptDiagnostics(options?: { readonly checkAllPromptFiles?: boolean }): Promise<import('@kiki/protocol').AgentPromptDiagnostics>;
  getAgentsMdWarning(): string | undefined;
  data(): ProfileData;
  getEffectiveThinkingLevel(): ThinkingEffort;
  resolveModelContext(): ProfileModelContext;
  resolveContextStrategy(): import('@kiki/agent-profiles/agentProfile').ContextStrategy | undefined;
  resolveRequestParams(): ModelRequestParams;
  getModelCapabilities(): ModelCapability;
  /**
   * The provider type (`providers.<name>.type`, e.g. `kimi`) of the alias in
   * effect: an explicit `alias`, else the bound model, else the configured
   * default model. `undefined` when none of them resolves.
   */
  getModelProviderType(alias?: string): string | undefined;
  getMaxOutputSize(): number | undefined;
  hasModel(): boolean;
  isRunnable(): boolean;
  hasProvider(): boolean;
  getSystemPrompt(options?: { readonly recipeAnchor?: string }): string;
  getPromptFieldSnapshot(options?: { readonly anchor?: boolean }): import('#/app/promptField/promptFieldRegistry').ResolvedPromptFieldOverrides;
  getActiveToolNames(): readonly string[] | undefined;
  addActiveTool(name: string): void;
  removeActiveTool(name: string): void;
}

export const IAgentProfileService = createDecorator<IAgentProfileService>('agentProfileService');
