import type { AgentModelProfile } from './agentProfile';
import type { NamedAgentModelProfile, UpdateNamedAgentModelProfileEntry } from '@kiki/protocol';

export interface AgentModelProfilePatch extends Omit<AgentModelProfile, 'when' | 'thinkingEffort' | 'promptMode' | 'prompt' | 'main' | 'independent' | 'promptOverrides'> {
  readonly when?: string | null;
  readonly thinkingEffort?: string | null;
  readonly promptMode?: AgentModelProfile['promptMode'] | null;
  readonly prompt?: string | null;
  readonly main?: AgentModelProfile['main'] | null;
  readonly independent?: AgentModelProfile['independent'] | null;
  readonly promptOverrides?: AgentModelProfile['promptOverrides'] | null;
}

export function modelPromptBranchToWire(branch: AgentModelProfile['main']): NamedAgentModelProfile['main'] {
  return typeof branch !== 'object' ? branch : { prompt_mode: branch.promptMode!, prompt: branch.prompt! };
}

export function modelPromptBranchFromWire(branch: NamedAgentModelProfile['main']): AgentModelProfile['main'] {
  return typeof branch !== 'object' ? branch : { promptMode: branch.prompt_mode, prompt: branch.prompt };
}

export function modelProfilePatchToWire(entry: AgentModelProfilePatch): UpdateNamedAgentModelProfileEntry {
  return {
    alias: entry.alias, when: entry.when, thinking_effort: entry.thinkingEffort,
    context_budget: entry.contextBudget, auto_compact: entry.autoCompact, max_completion_tokens: entry.maxCompletionTokens,
    service_tier: entry.serviceTier, request_params: entry.requestParams,
    allowed_models: entry.allowedModels === undefined ? undefined : [...entry.allowedModels],
    deny_models: entry.denyModels === undefined ? undefined : [...entry.denyModels],
    allowed_efforts: entry.allowedEfforts === undefined ? undefined : [...entry.allowedEfforts],
    preferred_models: entry.preferredModels === undefined ? undefined : [...entry.preferredModels],
    discouraged_models: entry.discouragedModels === undefined ? undefined : [...entry.discouragedModels],
    preferred_efforts: entry.preferredEfforts === undefined ? undefined : [...entry.preferredEfforts],
    prompt_mode: entry.promptMode, prompt: entry.prompt,
    main: entry.main === null ? null : modelPromptBranchToWire(entry.main),
    independent: entry.independent === null ? null : modelPromptBranchToWire(entry.independent),
    prompt_overrides: entry.promptOverrides as UpdateNamedAgentModelProfileEntry['prompt_overrides'],
  };
}

export function modelProfileToWire(entry: AgentModelProfile): NamedAgentModelProfile {
  return modelProfilePatchToWire(entry) as NamedAgentModelProfile;
}

export function modelProfileUpdateFromWire(entry: UpdateNamedAgentModelProfileEntry): AgentModelProfilePatch {
  return {
    alias: entry.alias, when: entry.when, thinkingEffort: entry.thinking_effort,
    contextBudget: entry.context_budget, autoCompact: entry.auto_compact, maxCompletionTokens: entry.max_completion_tokens,
    serviceTier: entry.service_tier, requestParams: entry.request_params,
    allowedModels: entry.allowed_models, denyModels: entry.deny_models, allowedEfforts: entry.allowed_efforts,
    preferredModels: entry.preferred_models, discouragedModels: entry.discouraged_models, preferredEfforts: entry.preferred_efforts,
    promptMode: entry.prompt_mode, prompt: entry.prompt,
    main: entry.main === null ? null : modelPromptBranchFromWire(entry.main),
    independent: entry.independent === null ? null : modelPromptBranchFromWire(entry.independent),
    promptOverrides: entry.prompt_overrides,
  };
}

export type SubagentLeasePatch = Omit<import('./subagentLease').SubagentLease, 'modelAlias' | 'thinkingEffort' | 'allowedModels' | 'modelProfiles' | 'canSpawnSubagents' | 'allowedSubagents' | 'preferredSubagents' | 'denySubagents'> & {
  readonly modelAlias?: string | null;
  readonly thinkingEffort?: string | null;
  readonly allowedModels?: readonly string[] | null;
  readonly canSpawnSubagents?: boolean | null;
  readonly allowedSubagents?: readonly string[] | null;
  readonly preferredSubagents?: readonly string[] | null;
  readonly denySubagents?: readonly string[] | null;
  readonly modelProfiles?: readonly AgentModelProfilePatch[];
};

export function subagentLeaseUpdateFromWire(entry: Exclude<import('@kiki/protocol').UpdateNamedAgentSubagentEntry, string>): SubagentLeasePatch {
  return {
    name: entry.name, source: entry.source, description: entry.description, whenToUse: entry.when_to_use,
    modelAlias: entry.model_alias, thinkingEffort: entry.thinking_effort,
    allowedModels: entry.allowed_models, denyModels: entry.deny_models, allowedEfforts: entry.allowed_efforts,
    preferredModels: entry.preferred_models, discouragedModels: entry.discouraged_models, preferredEfforts: entry.preferred_efforts,
    tools: entry.tools, disallowedTools: entry.disallowed_tools,
    canSpawnSubagents: entry.can_spawn_subagents, allowedSubagents: entry.allowed_subagents,
    preferredSubagents: entry.preferred_subagents, denySubagents: entry.deny_subagents,
    promptMode: entry.prompt_mode, prompt: entry.prompt, delegationNotice: entry.delegation_notice,
    serviceTier: entry.service_tier, requestParams: entry.request_params,
    modelPrompts: entry.model_prompts, modelProfiles: entry.model_profiles?.map(modelProfileUpdateFromWire),
  };
}

export function subagentLeasePatchToWire(entry: SubagentLeasePatch): Exclude<import('@kiki/protocol').UpdateNamedAgentSubagentEntry, string> {
  return {
    name: entry.name, source: entry.source, description: entry.description, when_to_use: entry.whenToUse,
    model_alias: entry.modelAlias, thinking_effort: entry.thinkingEffort,
    allowed_models: entry.allowedModels === null ? null : entry.allowedModels === undefined ? undefined : [...entry.allowedModels],
    deny_models: entry.denyModels === undefined ? undefined : [...entry.denyModels],
    allowed_efforts: entry.allowedEfforts === undefined ? undefined : [...entry.allowedEfforts],
    preferred_models: entry.preferredModels === undefined ? undefined : [...entry.preferredModels],
    discouraged_models: entry.discouragedModels === undefined ? undefined : [...entry.discouragedModels],
    preferred_efforts: entry.preferredEfforts === undefined ? undefined : [...entry.preferredEfforts],
    tools: entry.tools === null ? null : entry.tools === undefined ? undefined : [...entry.tools],
    disallowed_tools: entry.disallowedTools === undefined ? undefined : [...entry.disallowedTools],
    can_spawn_subagents: entry.canSpawnSubagents,
    allowed_subagents: entry.allowedSubagents === null ? null : entry.allowedSubagents === undefined ? undefined : [...entry.allowedSubagents],
    preferred_subagents: entry.preferredSubagents === null ? null : entry.preferredSubagents === undefined ? undefined : [...entry.preferredSubagents],
    deny_subagents: entry.denySubagents === null ? null : entry.denySubagents === undefined ? undefined : [...entry.denySubagents],
    prompt_mode: entry.promptMode, prompt: entry.prompt, delegation_notice: entry.delegationNotice,
    service_tier: entry.serviceTier, request_params: entry.requestParams,
    model_prompts: entry.modelPrompts, model_profiles: entry.modelProfiles?.map(modelProfilePatchToWire),
  };
}
