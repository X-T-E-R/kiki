import type {
  AgentProfile,
  AgentProfileContext,
  EnvironmentDisclosureSnapshot,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { SpawnConstraints, SubagentLease } from '#/app/agentProfileCatalog/subagentLease';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { RequestParams, ServiceTier, ThinkingEffort } from '#/kosong/contract/provider';
import type { ModelRequestParams } from '#/kosong/model/modelRequester';

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
  modelAlias?: string;
  modelCapabilities: ModelCapability;
  profileName?: string;
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
  readonly agentsMdWarning?: string;
  readonly agentsMdPaths?: readonly string[];
}

export type ResolvedAgentProfile = AgentProfile;

export interface ProfileData extends AgentConfigData {
  readonly agentsMdPaths?: readonly string[];
  readonly activeToolNames?: readonly string[];
  readonly toolAllowPolicies?: readonly (readonly string[])[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly subagentLeases?: Readonly<Record<string, SubagentLease>>;
  readonly spawnPolicy?: SpawnConstraints;
  readonly appliedLease?: SubagentLease;
  readonly serviceTier?: ServiceTier;
  readonly requestParams?: RequestParams;
  readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
  readonly renderGeneration?: number;
}

export type ProfileUpdateData = Partial<{
  modelAlias: string;
  profileName: string;
  thinkingLevel: string;
  systemPrompt: string;
  environmentDisclosure: EnvironmentDisclosureSnapshot;
  agentsMdPaths: readonly string[];
  disallowedTools: readonly string[];
  activeToolNames: readonly string[];
}>;

export interface ProfileBindingSnapshot {
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly routeId?: string;
  readonly lockedModelAlias?: string;
  readonly lockedThinkingEffort?: string;
  readonly thinkingLevel: string;
  readonly serviceTier?: ServiceTier;
  readonly requestParams?: RequestParams;
  readonly systemPrompt: string;
  readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
  readonly renderGeneration?: number;
  readonly agentsMdPaths?: readonly string[];
  readonly activeToolNames?: readonly string[];
  readonly toolAllowPolicies?: readonly (readonly string[])[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly subagentLeases?: Readonly<Record<string, SubagentLease>>;
  readonly spawnPolicy?: SpawnConstraints;
  readonly appliedLease?: SubagentLease;
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
  readonly compactionTriggerRatio: number | undefined;
}

export interface ProfileSetModelResult {
  readonly model: string;
  readonly providerName?: string | undefined;
}

export interface BindAgentInput {
  readonly profile?: string;
  readonly route?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly strictThinking?: boolean;
  readonly delegationPosition?: 'main' | 'sub' | 'independent';
  readonly lease?: SubagentLease;
  readonly spawnPolicy?: SpawnConstraints;
}

export interface IAgentProfileService {
  readonly _serviceBrand: undefined;

  configure(options: ProfileServiceOptions): void;
  update(changed: ProfileUpdateData): void;
  applyBindingSnapshot(snapshot: ProfileBindingSnapshot): void;
  bind(input: BindAgentInput): Promise<void>;
  setModel(model: string): Promise<ProfileSetModelResult>;
  setThinking(level: string): void;
  republishStatus(): void;
  getModel(): string;
  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void;
  applyProfile(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<void>;
  refreshSystemPrompt(): Promise<void>;
  getAgentsMdWarning(): string | undefined;
  data(): ProfileData;
  getEffectiveThinkingLevel(): ThinkingEffort;
  resolveModelContext(): ProfileModelContext;
  resolveRequestParams(): ModelRequestParams;
  getModelCapabilities(): ModelCapability;
  getMaxOutputSize(): number | undefined;
  hasModel(): boolean;
  isRunnable(): boolean;
  hasProvider(): boolean;
  getSystemPrompt(): string;
  getActiveToolNames(): readonly string[] | undefined;
  addActiveTool(name: string): void;
  removeActiveTool(name: string): void;
}

export const IAgentProfileService = createDecorator<IAgentProfileService>('agentProfileService');
