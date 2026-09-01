/**
 * `workspaceAgentProfileLoader` domain — `AgentFileDefinition` → `AgentProfile` factory.
 *
 * The file body is a prompt template rendered against the shared variable
 * table: `${var}` placeholders substitute live context,
 * and `${base_prompt}` embeds the effective default profile's prompt so a file
 * can wrap the builtin behavior instead of replacing it. Explicit files are
 * marked as builtin overrides; directory files must opt in through frontmatter.
 * `tools` passes through as the allowlist (`undefined` = every tool active);
 * `disallowedTools` passes through as the tool denylist; `subagents` passes
 * through as the delegation allowlist; `model_alias` pins the exact model used
 * when the profile is delegated to; `service_tier`
 * becomes the profile's per-turn service-tier intent; `request_params` carries
 * additional scalar per-turn request fields; `allowed_models` and
 * `deny_models` pass through as role-level spawn constraints that can only
 * narrow machine permission; `model_profiles` passes
 * through as dispatcher metadata and optional per-alias prompt deltas, and
 * `when` is never rendered into the child prompt.
 * `profilesFromDiscovery` packs a whole discovery pass into an
 * `AgentProfileContribution`, binding each profile's `${base_prompt}`
 * placeholder lazily at render time so it always reflects the effective
 * default profile (builtin, or the `SYSTEM.md` override) rather than any
 * file-based definition. A structured base prompt also forwards its
 * environment disclosure (e.g. the disclosed date) through
 * `renderSystemPrompt`, so runtime reminders never parse rendered text.
 */

import {
  normalizeAgentProfile,
  type AgentProfile,
  type AgentProfileContext,
  type SystemPromptRenderResult,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { AgentProfileContribution } from '#/app/agentProfileCatalog/agentProfileContribution';
import type { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import { renderPromptTemplateResult } from '#/app/agentProfileCatalog/profile-shared';

import type { AgentFileDefinition, AgentFileDiscoveryResult } from './types';

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
  const diagnostics = [...result.diagnostics];
  const skipped = [...result.skipped];
  const sourceDefinitions = new Map<string, AgentProfile>();
  for (const [definitionId, definition] of result.sourceDefinitions) {
    const profile = agentProfileFromFile(definition, basePrompt, builtinPrompt);
    const error = executorValidationError(profile, validation);
    if (error === undefined) {
      sourceDefinitions.set(definitionId, profile);
    } else {
      diagnostics.push({
        code: 'agent_executor.invalid_profile',
        severity: 'error',
        message: error,
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
    const profile = agentProfileFromFile(definition, basePrompt, builtinPrompt);
    const error = executorValidationError(profile, validation);
    if (error === undefined) {
      profiles.push(profile);
    } else {
      skipped.push({
        path: definition.path,
        reason: error,
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

function executorValidationError(
  profile: AgentProfile,
  validation: ExecutorProfileValidation | undefined,
): string | undefined {
  if (validation === undefined || profile.executor === 'native') return undefined;
  if (!validation.allowExternal) {
    return validation.reason ?? `External executor "${profile.executor}" is not allowed for this profile source`;
  }
  try {
    validation.registry.resolve(profile.executor, profile.executorOptions);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
