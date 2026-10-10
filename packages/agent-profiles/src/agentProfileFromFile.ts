import {
  normalizeAgentProfile,
  captureProfileModelMenu,
  type AgentProfile,
  type AgentProfileContext,
  type SystemPromptRenderResult,
} from './agentProfile';
import type { AgentProfileContribution } from './agentProfileContribution';
import type { AgentFileDefinition, AgentFileDiscoveryResult } from './agentFileTypes';
import type { ExecutorValidator } from './ports';
import { renderPromptTemplateResult } from './profileShared';
import { isToolActive } from './toolPolicy';

export function agentProfileFromFile(
  definition: AgentFileDefinition,
  basePrompt: (context: AgentProfileContext) => SystemPromptRenderResult,
  builtinPrompt?: (context: AgentProfileContext) => SystemPromptRenderResult,
): AgentProfile {
  const skillActive = isToolActive(definition, 'Skill');
  return normalizeAgentProfile({
    fileDefinition: structuredClone(definition),
    name: definition.name,
    definitionId: definition.definitionId,
    description: definition.description,
    sourcePath: definition.path,
    whenToUse: definition.whenToUse,
    override: definition.override || definition.source === 'explicit',
    private: definition.private,
    allowParentNotify: definition.allowParentNotify,
    permissionMode: definition.permissionMode,
    main: definition.main,
    tools: definition.tools,
    disallowedTools: definition.disallowedTools,
    disabledToolGroups: definition.disabledToolGroups,
    canSpawnSubagents: definition.canSpawnSubagents,
    allowedSubagents: definition.allowedSubagents,
    preferredSubagents: definition.preferredSubagents,
    denySubagents: definition.denySubagents,
    subagentLeases: definition.subagentLeases,
    spawnConstraints: definition.spawnConstraints,
    executor: definition.executor,
    executorOptions: definition.executorOptions,
    executorPrompt: definition.executorPrompt,
    allowKikiSubagents: definition.allowKikiSubagents,
    kikiContext: definition.kikiContext,
    recipe: definition.recipe,
    modelAlias: definition.modelAlias,
    restrictModelsToMenu: definition.restrictModelsToMenu ?? false,
    thinkingEffort: definition.thinkingEffort,
    preferredModels: definition.preferredModels,
    discouragedModels: definition.discouragedModels,
    preferredEfforts: definition.preferredEfforts,
    allowedModels: definition.allowedModels,
    denyModels: definition.denyModels,
    allowedEfforts: definition.allowedEfforts,
    modelProfiles: definition.modelProfiles,
    serviceTier: definition.serviceTier,
    requestParams: definition.requestParams,
    contextBudget: definition.contextBudget,
    autoCompact: definition.autoCompact,
    contextStrategy: definition.contextStrategy,
    maxCompletionTokens: definition.maxCompletionTokens,
    promptOverrides: definition.promptOverrides,
    systemPromptMode: definition.systemPromptMode,
    delegationNotice: definition.delegationNotice,
    renderSystemPrompt: (context) =>
      renderPromptTemplateResult(
        systemPromptTemplate(definition),
        context,
        { skillActive },
        basePrompt,
        builtinPrompt,
      ),
  });
}

function systemPromptTemplate(definition: AgentFileDefinition): string {
  switch (definition.systemPromptMode) {
    case 'prepend':
      return `${definition.prompt}\n\n\${base_prompt}`;
    case 'append':
      return `\${base_prompt}\n\n${definition.prompt}`;
    case 'inherit':
      return '${base_prompt}';
    case 'replace':
    case undefined:
      return definition.prompt;
  }
}

export interface ExecutorProfileValidation extends ExecutorValidator {
  readonly allowExternal: boolean;
  readonly reason?: string;
}

export function profilesFromDiscovery(
  result: AgentFileDiscoveryResult,
  basePrompt: (context: AgentProfileContext) => SystemPromptRenderResult,
  builtinPrompt?: (context: AgentProfileContext) => SystemPromptRenderResult,
  validation?: ExecutorProfileValidation,
): AgentProfileContribution {
  const diagnostics = [...result.diagnostics];
  const skipped = [...result.skipped];
  const sourceDefinitions = new Map<string, AgentProfile>();
  const sourceFailureCodes = new Map<string, string>();
  for (const [definitionId, definition] of result.sourceDefinitions) {
    const validated = validateExecutorProfile(
      agentProfileFromFile(definition, basePrompt, builtinPrompt),
      validation,
    );
    if (validated.error === undefined) {
      sourceDefinitions.set(definitionId, validated.profile);
    } else {
      sourceFailureCodes.set(definitionId, validated.code ?? 'agent_executor.invalid_profile');
      diagnostics.push({
        code: validated.code ?? 'agent_executor.invalid_profile',
        severity: 'error',
        message: validated.error,
        path: definition.path,
      });
    }
  }
  const scopedBindings = new Map(
    [...result.scopedBindings].map(([parentDefinitionId, table]) => [
      parentDefinitionId,
      new Map(
        [...table].map(([alias, binding]) => {
          const sourceProfile =
            binding.sourceDefinitionId === undefined
              ? undefined
              : sourceDefinitions.get(binding.sourceDefinitionId);
          const executorUnavailable =
            binding.sourceDefinitionId !== undefined && sourceProfile === undefined;
          const diagnostic = executorUnavailable
            ? {
                code: sourceFailureCodes.get(binding.sourceDefinitionId!) ?? 'agent_executor.invalid_profile',
                severity: 'error' as const,
                message: `Scoped profile "${alias}" has an unavailable executor binding`,
                path: binding.source,
                parentDefinitionId,
                alias,
                source: binding.source,
              }
            : binding.diagnostic;
          if (executorUnavailable && diagnostic !== undefined) diagnostics.push(diagnostic);
          return [
            alias,
            {
              parentDefinitionId: binding.parentDefinitionId,
              alias: binding.alias,
              source: binding.source,
              lease: binding.lease,
              status: executorUnavailable ? 'unavailable' as const : binding.status,
              sourceDefinitionId: binding.sourceDefinitionId,
              profile:
                sourceProfile === undefined
                  ? undefined
                  : normalizeAgentProfile({ ...sourceProfile, name: alias }),
              diagnostic,
            },
          ];
        }),
      ),
    ]),
  );
  const profiles: AgentProfile[] = [];
  for (const definition of result.agents) {
    const validated = validateExecutorProfile(
      agentProfileFromFile(definition, basePrompt, builtinPrompt),
      validation,
    );
    if (validated.error === undefined) {
      profiles.push(normalizeAgentProfile({
        ...validated.profile,
        shadowedFiles: result.shadowedFiles?.get(definition.definitionId),
      }));
    } else {
      skipped.push({
        path: definition.path,
        reason: validated.error,
        code: validated.code ?? 'agent_executor.invalid_profile',
      });
    }
  }
  return {
    profiles,
    routes: result.routes,
    skipped,
    scannedRoots: result.scannedRoots,
    scopedBindings,
    sourceDefinitions,
    dependencyIndex: result.dependencyIndex,
    diagnostics,
  };
}

function validateExecutorProfile(
  profile: AgentProfile,
  validation: ExecutorProfileValidation | undefined,
): { readonly profile: AgentProfile; readonly error?: string; readonly code?: string } {
  if (validation === undefined || profile.executor === 'native') return { profile };
  profile = captureProfileModelMenu(profile);
  if (!validation.allowExternal) {
    return {
      profile,
      code: 'agent_executor.source_not_allowed',
      error:
        validation.reason ??
        `External executor "${profile.executor}" is not allowed for this profile source`,
    };
  }
  const validationResult = validation.validateExecutor(
    profile.executor!,
    profile.executorOptions,
    {
      modelAlias: profile.modelAlias,
      thinkingEffort: profile.thinkingEffort,
    },
  );
  const result =
    typeof validationResult === 'string'
      ? { ok: false as const, diagnostic: validationResult }
      : validationResult;
  if (!result.ok) return { profile, error: result.diagnostic };
  return {
    profile: normalizeAgentProfile({
      ...profile,
      modelAlias: result.binding.modelAlias,
      thinkingEffort: result.binding.thinkingEffort,
    }),
  };
}
