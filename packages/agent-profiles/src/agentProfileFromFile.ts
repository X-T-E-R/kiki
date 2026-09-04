import {
  normalizeAgentProfile,
  type AgentProfile,
  type AgentProfileContext,
  type SystemPromptRenderResult,
} from './agentProfile';
import type { AgentProfileContribution } from './agentProfileContribution';
import type { AgentFileDefinition, AgentFileDiscoveryResult } from './agentFileTypes';
import type { ExecutorValidator } from './ports';
import { renderPromptTemplateResult } from './profileShared';

export function agentProfileFromFile(
  definition: AgentFileDefinition,
  basePrompt: (context: AgentProfileContext) => SystemPromptRenderResult,
  builtinPrompt?: (context: AgentProfileContext) => SystemPromptRenderResult,
): AgentProfile {
  const skillActive =
    (definition.tools === undefined || definition.tools.includes('Skill')) &&
    !(definition.disallowedTools ?? []).includes('Skill');
  return normalizeAgentProfile({
    name: definition.name,
    definitionId: definition.definitionId,
    description: definition.description,
    sourcePath: definition.path,
    whenToUse: definition.whenToUse,
    override: definition.override || definition.source === 'explicit',
    main: definition.main,
    tools: definition.tools,
    disallowedTools: definition.disallowedTools,
    subagents: definition.subagents,
    subagentLeases: definition.subagentLeases,
    spawnConstraints: definition.spawnConstraints,
    executor: definition.executor,
    executorOptions: definition.executorOptions,
    modelAlias: definition.modelAlias,
    thinkingEffort: definition.thinkingEffort,
    allowedModels: definition.allowedModels,
    denyModels: definition.denyModels,
    allowedEfforts: definition.allowedEfforts,
    modelProfiles: definition.modelProfiles,
    serviceTier: definition.serviceTier,
    requestParams: definition.requestParams,
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
  for (const [definitionId, definition] of result.sourceDefinitions) {
    const validated = validateExecutorProfile(
      agentProfileFromFile(definition, basePrompt, builtinPrompt),
      validation,
    );
    if (validated.error === undefined) {
      sourceDefinitions.set(definitionId, validated.profile);
    } else {
      diagnostics.push({
        code: 'agent_executor.invalid_profile',
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
                code: 'agent_executor.invalid_profile',
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
      profiles.push(validated.profile);
    } else {
      skipped.push({
        path: definition.path,
        reason: validated.error,
        code: 'agent_executor.invalid_profile',
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
): { readonly profile: AgentProfile; readonly error?: string } {
  if (validation === undefined || profile.executor === 'native') return { profile };
  if (!validation.allowExternal) {
    return {
      profile,
      error:
        validation.reason ??
        `External executor "${profile.executor}" is not allowed for this profile source`,
    };
  }
  const result = validation.validateExecutor(profile.executor!, profile.executorOptions, {
    modelAlias: profile.modelAlias,
    thinkingEffort: profile.thinkingEffort,
  });
  if (typeof result === 'string') return { profile, error: result };
  if (result?.diagnostic !== undefined) return { profile, error: result.diagnostic };
  if (result?.binding === undefined) return { profile };
  return {
    profile: normalizeAgentProfile({
      ...profile,
      modelAlias: result.binding.modelAlias ?? profile.modelAlias,
      thinkingEffort: result.binding.thinkingEffort ?? profile.thinkingEffort,
    }),
  };
}
