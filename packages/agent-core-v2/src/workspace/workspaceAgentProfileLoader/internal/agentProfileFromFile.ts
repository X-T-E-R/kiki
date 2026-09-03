import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { AgentProfileContribution } from '#/app/agentProfileCatalog/agentProfileContribution';
import type { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import {
  agentProfileFromFile,
  profilesFromDiscovery as projectProfilesFromDiscovery,
} from '@kiki/agent-profiles/agentProfileFromFile';
import type {
  AgentProfileContext,
  SystemPromptRenderResult,
} from '@kiki/agent-profiles/agentProfile';
import type { AgentFileDiscoveryResult } from '@kiki/agent-profiles/agentFileTypes';
import type { ExecutorValidator } from '@kiki/agent-profiles/ports';

export { agentProfileFromFile };

export interface ExecutorProfileValidation {
  readonly registry: IAgentExecutorRegistry;
  readonly allowExternal: boolean;
  readonly reason?: string;
}

export function profilesFromDiscovery(
  result: AgentFileDiscoveryResult,
  basePrompt: (context: AgentProfileContext) => SystemPromptRenderResult,
  builtinPrompt?: (context: AgentProfileContext) => SystemPromptRenderResult,
  validation?: ExecutorProfileValidation,
): AgentProfileContribution {
  return projectProfilesFromDiscovery(
    result,
    basePrompt,
    builtinPrompt,
    validation === undefined
      ? undefined
      : {
          ...executorValidator(validation.registry),
          allowExternal: validation.allowExternal,
          reason: validation.reason,
        },
  ) as AgentProfileContribution;
}

function executorValidator(registry: IAgentExecutorRegistry): ExecutorValidator {
  return {
    validateExecutor: (id, options) => {
      try {
        registry.resolve(id, options);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  };
}

export type { AgentProfile };
