import { z } from 'zod';

import type { SpawnConstraints, SubagentLease } from './subagentLease';

export type ServiceTier = 'auto' | 'default' | 'flex' | 'priority';
export type RequestParamValue = string | number | boolean;
export type RequestParams = Readonly<Record<string, RequestParamValue>>;

export const DEFAULT_AGENT_PROFILE_NAME = 'agent';

export const AgentSystemPromptModeSchema = z.enum(['replace', 'prepend', 'append']);
export type AgentSystemPromptMode = z.infer<typeof AgentSystemPromptModeSchema>;

export type AgentModelProfilePromptMode = 'prepend' | 'append' | 'wrap';

export interface AgentModelParameters {
  readonly contextBudget?: number;
  readonly maxCompletionTokens?: number;
  readonly serviceTier?: ServiceTier;
  readonly requestParams?: RequestParams;
}

export interface AgentModelProfile extends AgentModelParameters {
  readonly alias: string;
  readonly when?: string;
  readonly thinkingEffort?: string;
  readonly allowedEfforts?: readonly string[];
  readonly promptMode?: AgentModelProfilePromptMode;
  readonly prompt?: string;
}

export type AgentRecommendedModel = AgentModelProfile;

export interface AgentProfileSummaryPolicy {
  readonly minChars: number;
  readonly continuationPrompt: string;
  readonly retries: number;
}

export interface AgentProfileContext {
  readonly cwd?: string;
  readonly cwdListing?: string;
  readonly agentsMd?: string;
  readonly additionalDirsInfo?: string;
  readonly osKind?: string;
  readonly shellName?: string;
  readonly shellPath?: string;
  readonly now?: string;
  readonly timeZone?: string;
  readonly skills?: string;
  readonly skillActive?: boolean;
  readonly pluginSections?: string;
  readonly productName?: string;
  readonly replyStyleGuide?: string;
  readonly promptVariables?: Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

export interface EnvironmentDisclosureSnapshot {
  readonly cwd: string;
  readonly date:
    | { readonly disclosed: true; readonly value: { readonly localDate: string; readonly timeZone: string } }
    | { readonly disclosed: false };
}

export interface SystemPromptRenderResult {
  readonly text: string;
  readonly environment: EnvironmentDisclosureSnapshot;
}

export interface AgentProfile extends AgentModelParameters {
  readonly fileDefinition?: import('./agentFileTypes').AgentFileDefinition;
  readonly routeDefinition?: AgentProfileRouteDefinition;
  readonly name: string;
  readonly definitionId?: string;
  readonly routeId?: string;
  readonly description?: string;
  readonly sourcePath?: string;
  readonly whenToUse?: string;
  readonly override?: boolean;
  readonly main?: boolean;
  readonly tools?: readonly string[];
  readonly toolAllowPolicies?: readonly (readonly string[])[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly subagentLeases?: Readonly<Record<string, SubagentLease>>;
  readonly spawnConstraints?: SpawnConstraints;
  readonly executor?: string;
  readonly executorOptions?: Readonly<Record<string, string | number | boolean>>;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly allowedModels?: readonly string[];
  readonly denyModels?: readonly string[];
  readonly allowedEfforts?: readonly string[];
  readonly modelProfiles?: readonly AgentModelProfile[];
  readonly serviceTier?: ServiceTier;
  readonly requestParams?: RequestParams;
  readonly systemPromptMode?: AgentSystemPromptMode;
  readonly systemPrompt: (context: AgentProfileContext) => string;
  readonly renderSystemPrompt: (context: AgentProfileContext) => SystemPromptRenderResult;
  readonly summaryPolicy?: AgentProfileSummaryPolicy;
  readonly delegationNotice?: 'auto' | 'off';
}

export type AgentProfileRoutePromptMode = 'inherit' | 'prepend' | 'append' | 'wrap';

export interface AgentProfileRouteDefinition {
  readonly id: string;
  readonly profile: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly promptMode: AgentProfileRoutePromptMode;
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly serviceTier?: ServiceTier | null;
  readonly requestParams?: RequestParams | null;
  readonly overriddenFields: readonly string[];
  readonly path: string;
}

export interface AgentProfileRouteCatalogEntry {
  readonly id: string;
  readonly profile: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly overriddenFields: readonly string[];
}

export interface ResolvedAgentProfileRoute extends AgentProfileRouteCatalogEntry {
  readonly effectiveProfile: AgentProfile;
  readonly lockedModelAlias?: string;
  readonly lockedThinkingEffort?: string;
}

export type AgentProfileInput = Omit<AgentProfile, 'systemPrompt' | 'renderSystemPrompt'> &
  (
    | {
        readonly systemPrompt: (context: AgentProfileContext) => string;
        readonly renderSystemPrompt?: (
          context: AgentProfileContext,
        ) => SystemPromptRenderResult;
      }
    | {
        readonly systemPrompt?: (context: AgentProfileContext) => string;
        readonly renderSystemPrompt: (context: AgentProfileContext) => SystemPromptRenderResult;
      }
  );

export function normalizeAgentProfile(input: AgentProfileInput): AgentProfile {
  if (input.renderSystemPrompt !== undefined) {
    const render = input.renderSystemPrompt.bind(input);
    return {
      ...input,
      executor: input.executor ?? 'native',
      executorOptions:
        input.executorOptions === undefined
          ? undefined
          : { ...input.executorOptions },
      renderSystemPrompt: render,
      systemPrompt: (context) => render(context).text,
    };
  }
  if (input.systemPrompt !== undefined) {
    const systemPrompt = input.systemPrompt.bind(input);
    return {
      ...input,
      executor: input.executor ?? 'native',
      executorOptions:
        input.executorOptions === undefined
          ? undefined
          : { ...input.executorOptions },
      systemPrompt,
      renderSystemPrompt: (context) => ({
        text: systemPrompt(context),
        environment: { cwd: context.cwd ?? '', date: { disclosed: false } },
      }),
    };
  }
  throw new Error(
    `Agent profile "${input.name}" must define systemPrompt or renderSystemPrompt.`,
  );
}
