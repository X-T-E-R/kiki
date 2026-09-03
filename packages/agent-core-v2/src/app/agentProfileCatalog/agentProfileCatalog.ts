import type { ILogger } from '#/_base/log/log';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import {
  normalizeAgentProfile as normalizeProfile,
  type AgentProfile as PackageAgentProfile,
  type AgentProfileContext,
  type SystemPromptRenderResult,
} from '@kiki/agent-profiles/agentProfile';

export {
  AgentSystemPromptModeSchema,
  DEFAULT_AGENT_PROFILE_NAME,
  type AgentModelProfile,
  type AgentModelProfilePromptMode,
  type AgentProfileContext,
  type AgentProfileRouteCatalogEntry,
  type AgentProfileRouteDefinition,
  type AgentProfileRoutePromptMode,
  type AgentProfileSummaryPolicy,
  type AgentRecommendedModel,
  type AgentSystemPromptMode,
  type EnvironmentDisclosureSnapshot,
  type ResolvedAgentProfileRoute,
  type SystemPromptRenderResult,
} from '@kiki/agent-profiles/agentProfile';

export interface AgentProfilePromptPrefixContext {
  readonly cwd: string;
  readonly process: IHostProcessService;
  readonly log?: ILogger;
}

export interface AgentProfile extends PackageAgentProfile {
  readonly promptPrefix?: (ctx: AgentProfilePromptPrefixContext) => Promise<string>;
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
        readonly renderSystemPrompt: (
          context: AgentProfileContext,
        ) => SystemPromptRenderResult;
      }
  );

export function normalizeAgentProfile(input: AgentProfileInput): AgentProfile {
  return normalizeProfile(input) as AgentProfile;
}
