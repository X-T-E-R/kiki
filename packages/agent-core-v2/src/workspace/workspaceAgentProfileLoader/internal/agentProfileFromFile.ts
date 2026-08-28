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
    modelAlias: definition.modelAlias,
    thinkingEffort: definition.thinkingEffort,
    allowedModels: definition.allowedModels,
    denyModels: definition.denyModels,
    allowedEfforts: definition.allowedEfforts,
    modelProfiles: definition.modelProfiles,
    serviceTier: definition.serviceTier,
    requestParams: definition.requestParams,
    delegationNotice: definition.delegationNotice,
    renderSystemPrompt: (context) =>
      renderPromptTemplateResult(
        definition.prompt,
        context,
        { skillActive },
        basePrompt,
        builtinPrompt,
      ),
  });
}

export function profilesFromDiscovery(
  result: AgentFileDiscoveryResult,
  basePrompt: (context: AgentProfileContext) => SystemPromptRenderResult,
  builtinPrompt?: (context: AgentProfileContext) => SystemPromptRenderResult,
): AgentProfileContribution {
  const sourceDefinitions = new Map(
    [...result.sourceDefinitions].map(([definitionId, definition]) => [
      definitionId,
      agentProfileFromFile(definition, basePrompt, builtinPrompt),
    ]),
  );
  const scopedBindings = new Map(
    [...result.scopedBindings].map(([parentDefinitionId, table]) => [
      parentDefinitionId,
      new Map(
        [...table].map(([alias, binding]) => {
          const sourceProfile =
            binding.sourceDefinitionId === undefined
              ? undefined
              : sourceDefinitions.get(binding.sourceDefinitionId);
          return [
            alias,
            {
              parentDefinitionId: binding.parentDefinitionId,
              alias: binding.alias,
              source: binding.source,
              lease: binding.lease,
              status: binding.status,
              sourceDefinitionId: binding.sourceDefinitionId,
              profile:
                sourceProfile === undefined
                  ? undefined
                  : normalizeAgentProfile({ ...sourceProfile, name: alias }),
              diagnostic: binding.diagnostic,
            },
          ];
        }),
      ),
    ]),
  );
  return {
    profiles: result.agents.map((definition) =>
      agentProfileFromFile(definition, basePrompt, builtinPrompt),
    ),
    routes: result.routes,
    skipped: result.skipped,
    scannedRoots: result.scannedRoots,
    scopedBindings,
    sourceDefinitions,
    dependencyIndex: result.dependencyIndex,
    diagnostics: result.diagnostics,
  };
}
