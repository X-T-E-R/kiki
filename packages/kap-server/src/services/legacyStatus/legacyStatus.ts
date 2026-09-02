import {
  IAgentContextMemoryService,
  IAgentProfileService,
  IAgentTokenCountingService,
  IAgentToolRegistryService,
  IAgentUsageService,
  IModelCatalog,
  IModelService,
  type IAgentScopeHandle,
  type UsageStatus,
} from '@moonshot-ai/agent-core-v2';
import { IAgentToolSelectService } from '@moonshot-ai/agent-core-v2/agent/toolSelect/toolSelect';

import type { ContextBreakdown } from '../../protocol/context-usage';

export { toLegacyPhase, type AgentPhase } from '@kiki/transcript-live';

export interface LegacyStatusSnapshot {
  readonly usage?: UsageStatus;
  readonly contextTokens: number;
  /** Omitted when the context limit is unknown — 0 is never pushed (0 is the engine's "unknown" marker, not a real limit). */
  readonly maxContextTokens?: number;
  readonly contextBreakdown?: ContextBreakdown;
  readonly model: string;
}

export interface ReadLegacyStatusOptions {
  /**
   * Whether to compute `contextBreakdown`. The breakdown re-estimates the
   * system prompt, every tool schema, and the whole conversation history, so
   * callers that only need usage / context size should pass `false`.
   * Defaults to `true`.
   */
  readonly contextBreakdown?: boolean;
}

/** Read the current combined status when the handle exposes a complete agent. */
export function readLegacyStatus(
  agent: IAgentScopeHandle,
  options?: ReadLegacyStatusOptions,
): LegacyStatusSnapshot | undefined {
  const profile = agent.accessor.get(IAgentProfileService) as
    | IAgentProfileService
    | undefined;
  const usageService = agent.accessor.get(IAgentUsageService) as
    | IAgentUsageService
    | undefined;
  const tokenCounting = agent.accessor.get(IAgentTokenCountingService) as
    | IAgentTokenCountingService
    | undefined;
  if (profile === undefined || usageService === undefined || tokenCounting === undefined) {
    return undefined;
  }
  const usage = usageService.status();
  const contextTokens = tokenCounting.statusSize();
  const capabilities = profile.getModelCapabilities();
  let maxContextTokens = capabilities.max_input_tokens ?? capabilities.max_context_tokens;
  if (maxContextTokens === 0 && profile.getModel() === '') {
    maxContextTokens = defaultModelContextTokens(agent) ?? 0;
  }
  const model = profile.getModel();
  return {
    usage,
    contextTokens,
    maxContextTokens: maxContextTokens > 0 ? maxContextTokens : undefined,
    contextBreakdown:
      options?.contextBreakdown === false ? undefined : readContextBreakdown(agent, contextTokens),
    model,
  };
}

export function readContextBreakdown(
  agent: IAgentScopeHandle,
  contextTokens: number,
): ContextBreakdown | undefined {
  if (contextTokens === 0) return undefined;
  const profile = agent.accessor.get(IAgentProfileService) as IAgentProfileService | undefined;
  const tokenCounting = agent.accessor.get(IAgentTokenCountingService) as
    | IAgentTokenCountingService
    | undefined;
  const context = agent.accessor.get(IAgentContextMemoryService) as
    | IAgentContextMemoryService
    | undefined;
  const registry = agent.accessor.get(IAgentToolRegistryService) as
    | IAgentToolRegistryService
    | undefined;
  const toolSelect = agent.accessor.get(IAgentToolSelectService) as
    | IAgentToolSelectService
    | undefined;
  if (
    profile === undefined ||
    tokenCounting === undefined ||
    context === undefined ||
    registry === undefined ||
    toolSelect === undefined
  ) {
    return undefined;
  }
  try {
    const tools = toolSelect
      .shapeTools(registry.list())
      .filter((tool) => tool.deferred !== true)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? {},
      }));
    return normalizeContextBreakdown(contextTokens, {
      systemTokens: tokenCounting.estimateText(profile.getSystemPrompt()),
      toolsTokens: tokenCounting.estimateTools(tools),
      messagesTokens: tokenCounting.estimateMessages(toolSelect.shapeHistory(context.get())),
    });
  } catch {
    return undefined;
  }
}

export function normalizeContextBreakdown(
  total: number,
  estimate: Omit<ContextBreakdown, 'estimated'>,
): ContextBreakdown {
  const contextTotal = Math.max(0, Math.round(total));
  const systemWeight = Math.max(0, estimate.systemTokens);
  const toolsWeight = Math.max(0, estimate.toolsTokens);
  const messagesWeight = Math.max(0, estimate.messagesTokens);
  const estimatedTotal = systemWeight + toolsWeight + messagesWeight;
  if (estimatedTotal <= 0) {
    return { systemTokens: 0, toolsTokens: 0, messagesTokens: contextTotal, estimated: true };
  }
  const systemTokens = Math.floor((contextTotal * systemWeight) / estimatedTotal);
  const toolsTokens = Math.floor((contextTotal * toolsWeight) / estimatedTotal);
  return {
    systemTokens,
    toolsTokens,
    messagesTokens: contextTotal - systemTokens - toolsTokens,
    estimated: true,
  };
}


function defaultModelContextTokens(agent: IAgentScopeHandle): number | undefined {
  const models = agent.accessor.get(IModelService) as IModelService | undefined;
  const catalog = agent.accessor.get(IModelCatalog) as IModelCatalog | undefined;
  const defaultModel = models?.getDefaultModel();
  if (defaultModel === undefined || defaultModel.length === 0 || catalog === undefined) {
    return undefined;
  }
  try {
    const capabilities = catalog.get(defaultModel).capabilities;
    return capabilities.max_input_tokens ?? capabilities.max_context_tokens;
  } catch {
    return undefined;
  }
}
