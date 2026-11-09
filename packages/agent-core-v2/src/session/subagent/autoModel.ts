import { randomInt } from 'node:crypto';
import type { AgentProfile } from '@kiki/agent-profiles/agentProfile';
import { modelAliasResolverForExecutor } from '@kiki/agent-profiles/ports';
import { resolveModelProfileEntry } from '@kiki/agent-profiles/modelProfileOverlay';

import type { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import type { IConfigService } from '#/app/config/config';
import type { IModelCatalog } from '#/kosong/model/catalog';
import type { IModelService } from '#/kosong/model/model';
import { resolveThinkingEffortForModel, resolveForcedThinkingEffort, drivesThinkingThroughTraits, type ThinkingConfig } from '#/kosong/model/thinking';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { AUTO_MODEL_ALIAS, resolveSubagentBinding, assertSubagentModelNotDenied } from './configSection';
import { assertRoleBindingConstraints, roleConstraintsFromProfile } from './modelConstraints';
import { projectProfileModelMenu } from './modelCatalogProjection';

export interface AutoModelCandidate {
  readonly alias: string;
  readonly when?: string;
  readonly thinking_effort: string;
}

export interface AutoModelInput {
  readonly description: string;
  readonly prompt: string;
  readonly candidates: readonly AutoModelCandidate[];
}

export interface AutoModelServices {
  readonly config: IConfigService;
  readonly models: IModelService;
  readonly modelCatalog: IModelCatalog;
  readonly executors: IAgentExecutorRegistry;
}

export function autoModelCandidates(
  profile: AgentProfile,
  thinkingEffort: string | undefined,
  services: AutoModelServices,
  current?: { readonly model?: string; readonly thinking: string },
): readonly AutoModelCandidate[] {
  const { config, models, modelCatalog, executors } = services;
  const native = (profile.executor ?? 'native') === 'native';
  const resolver = modelAliasResolverForExecutor(profile.executor, models);
  const constraints = roleConstraintsFromProfile(profile);
  const executor = native ? undefined : executors.resolve(profile.executor, profile.executorOptions);
  const aliases = projectProfileModelMenu(profile, models, config, 'sub', {
    frozen: true,
    executorCapabilityCatalog: executors.getExecutorCapabilityCatalog?.(profile.executor ?? 'native'),
  }).configuredModelAliases;
  const candidates = new Map<string, AutoModelCandidate>();
  for (const alias of aliases) {
    if (alias === AUTO_MODEL_ALIAS) continue;
    try {
      const candidateEffort = thinkingEffort ?? (current?.model !== undefined &&
        (resolver.resolveId(current.model) ?? current.model) === (resolver.resolveId(alias) ?? alias) ? current.thinking : undefined);
      const binding = resolveSubagentBinding(config, { modelAlias: alias, thinkingEffort: candidateEffort }, profile,
        native ? models : undefined, constraints, { profileName: profile.name });
      let model = resolver.resolveId(binding.model) ?? binding.model;
      let thinking: string;
      if (native) {
        const metadata = modelCatalog.get(model);
        thinking = resolveThinkingEffortForModel(binding.thinking, undefined, metadata, false, true);
        const forced = resolveForcedThinkingEffort(config.get<ThinkingConfig>(THINKING_SECTION)?.forcedEffort,
          thinking as import('#/kosong/contract/provider').ThinkingEffort, drivesThinkingThroughTraits(metadata?.providerType));
        if (forced !== undefined) {
          resolveThinkingEffortForModel(forced, undefined, metadata, false, true);
          assertRoleBindingConstraints({ model, thinking: forced, constraints, models, ruleSource: `profile:${profile.name}`, modelValueSource: 'environment-forced' });
        }
      } else {
        const validation = executors.validateBinding(executor!.descriptor.id, executor!.options, {
          modelAlias: model, thinkingEffort: binding.thinking,
          explicitFields: [
            ...(profile.tools === undefined ? [] : ['tools']),
            ...(profile.disallowedTools === undefined ? [] : ['disallowed_tools']),
            ...(binding.thinking === undefined ? [] : ['thinking_effort']),
            ...(profile.serviceTier === undefined ? [] : ['service_tier']),
            ...(profile.requestParams === undefined ? [] : ['request_params']),
            ...(profile.contextBudget === undefined ? [] : ['context_budget']),
            ...(profile.maxCompletionTokens === undefined ? [] : ['max_completion_tokens']),
          ],
        });
        if (!validation.ok || validation.binding.modelAlias === undefined || validation.binding.thinkingEffort === undefined) continue;
        model = validation.binding.modelAlias;
        thinking = validation.binding.thinkingEffort;
        if (thinkingEffort !== undefined && thinking !== thinkingEffort) continue;
      }
      assertSubagentModelNotDenied(config, model, native ? models : undefined);
      assertRoleBindingConstraints({ model, thinking, constraints, models: native ? models : undefined,
        ruleSource: `profile:${profile.name}`, modelValueSource: 'dispatch-explicit' });
      const entry = resolveModelProfileEntry(profile.modelProfiles, model, (id) => resolver.resolveId(id));
      candidates.set(model, { alias: model, when: entry?.when, thinking_effort: thinking });
    } catch (error) {
      if (!isError2(error) || error.code !== ErrorCodes.CONFIG_INVALID && error.code !== ErrorCodes.MODEL_NOT_CONFIGURED &&
        error.code !== ErrorCodes.PROFILE_CONSTRAINT_VIOLATION) throw error;
    }
  }
  return [...candidates.values()];
}

export function weightedAutoModel(candidates: readonly AutoModelCandidate[], weights: Readonly<Record<string, number>> = {}): AutoModelCandidate {
  const configuredWeights = candidates.map(({ alias }) => Object.hasOwn(weights, alias) ? weights[alias]! : 1);
  const maximum = configuredWeights.reduce((max, weight) => Math.max(max, weight), 0);
  if (maximum === 0) throw new Error2(ErrorCodes.CONFIG_INVALID, 'Automatic model selection has no positively weighted candidates.');
  const scaled = configuredWeights.map((weight) => weight / maximum);
  let remaining = randomInt(0x100000000) / 0x100000000 * scaled.reduce((sum, weight) => sum + weight, 0);
  for (const [index, candidate] of candidates.entries()) {
    remaining -= scaled[index]!;
    if (remaining < 0) return candidate;
  }
  throw new Error2(ErrorCodes.CONFIG_INVALID, 'Automatic model selection has no eligible candidates.');
}

export function requireAutoModelChoice(output: unknown, candidates: readonly AutoModelCandidate[]): AutoModelCandidate {
  if (typeof output !== 'object' || output === null || Array.isArray(output) || Object.keys(output).length !== 1 ||
    !('model_alias' in output) || typeof output.model_alias !== 'string') {
    throw new Error2(ErrorCodes.CONFIG_INVALID, 'Model selector must return exactly { "model_alias": "candidate-alias" }.');
  }
  const chosen = candidates.find((candidate) => candidate.alias === output.model_alias);
  if (chosen === undefined) throw new Error2(ErrorCodes.PROFILE_CONSTRAINT_VIOLATION, 'Model selector returned an alias outside the eligible candidates.');
  return chosen;
}
