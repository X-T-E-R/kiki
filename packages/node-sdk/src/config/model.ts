import {
  BUDGET_THINKING_EFFORTS,
  matchKnownAnthropicModelProfile,
  matchUnknownClaudeProfile,
} from '@kiki/agent-core-v2/kosong/provider/bases/anthropic/anthropic-profile';

import { ErrorCodes, KimiError } from '../errors';

import type { ModelAlias, ProviderType } from './schema';

export interface ResolvedModelAlias {
  readonly id: string;
  readonly alias: ModelAlias;
}

export function resolveModelAlias(
  models: Readonly<Record<string, ModelAlias>> | undefined,
  id: string,
): ResolvedModelAlias | undefined {
  const exact = models?.[id];
  if (exact !== undefined) return { id, alias: exact };
  if (models === undefined || id.includes('/')) return undefined;

  const candidates = Object.entries(models)
    .filter(([candidateId, alias]) =>
      matchesBareModelId(candidateId, id) || matchesBareModelId(alias.model, id),
    )
    .toSorted(([left], [right]) => left.localeCompare(right));
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) {
    const [candidateId, alias] = candidates[0]!;
    return { id: candidateId, alias };
  }

  const candidateIds = candidates.map(([candidateId]) => candidateId);
  const quotedCandidates = candidateIds.map((candidate) => `"${candidate}"`).join(', ');
  throw new KimiError(
    ErrorCodes.CONFIG_INVALID,
    `Model "${id}" matches multiple configured models: ${quotedCandidates}. Use a full model id to disambiguate.`,
    { details: { model: id, candidates: candidateIds } },
  );
}

function matchesBareModelId(value: string | undefined, id: string): boolean {
  return value === id || value?.endsWith(`/${id}`) === true;
}

export function effectiveModelAlias(
  alias: ModelAlias,
  providerType?: ProviderType,
): ModelAlias {
  const { overrides, ...base } = alias;
  const effective: ModelAlias = overrides === undefined ? alias : {
    ...base,
    ...overrides,
    requestParams: base.requestParams === undefined && overrides.requestParams === undefined
      ? undefined : { ...base.requestParams, ...overrides.requestParams },
  };

  if (
    overrides?.supportEfforts !== undefined &&
    overrides.defaultEffort === undefined &&
    effective.defaultEffort !== undefined &&
    !overrides.supportEfforts.includes(effective.defaultEffort)
  ) {
    delete effective.defaultEffort;
  }

  // The input cap can never exceed the effective total window (an override
  // lowering max_context_size must not leave a stale, larger cap behind).
  // Build a copy for the clamp — never rewrite the caller's config record.
  const clamped =
    effective.maxInputSize !== undefined && effective.maxInputSize > effective.maxContextSize
      ? { ...effective, maxInputSize: effective.maxContextSize }
      : effective;

  return withAnthropicProfile(clamped, providerType);
}

function withAnthropicProfile(model: ModelAlias, providerType?: ProviderType): ModelAlias {
  const protocol = model.protocol ?? providerType;
  // The inferred fallback profile exists for third-party Anthropic-compatible
  // endpoints whose model name encodes no known Claude version. It only
  // applies to names that still carry a Claude marker (e.g. a proxied
  // `claude-latest`): clearly non-Claude models served over the Anthropic
  // protocol (catalog-imported Kimi `k3`, GLM, …) must not advertise Claude
  // effort levels. Kimi providers — including managed models routed through
  // protocol = "anthropic" — declare thinking efforts via the catalog, so
  // they never receive the fallback. Callers without provider context fall
  // back to name matching only.
  const profile =
    providerType !== undefined && providerType !== 'kimi' && protocol === 'anthropic'
      ? (matchKnownAnthropicModelProfile(model.model) ?? matchUnknownClaudeProfile(model.model))
      : matchKnownAnthropicModelProfile(model.model);
  if (profile === undefined) return model;

  const capability = profile.canDisableThinking ? 'thinking' : 'always_thinking';
  const capabilities = model.capabilities ?? [];
  const hasCapability = capabilities.some(
    (candidate) => candidate.trim().toLowerCase() === capability,
  );
  // `adaptive_thinking = false` opts the endpoint out of the adaptive API, so
  // the catalog must not advertise adaptive-only efforts (xhigh/max) — this
  // mirrors the budget branch of kosong's resolveThinkingProfile.
  const supportEfforts =
    model.supportEfforts ??
    (model.adaptiveThinking === false ? [...BUDGET_THINKING_EFFORTS] : [...profile.efforts]);

  return {
    ...model,
    capabilities: hasCapability ? capabilities : [...capabilities, capability],
    supportEfforts,
    defaultEffort:
      model.defaultEffort ?? (supportEfforts.includes('high') ? 'high' : undefined),
  };
}

export function effectiveModelAliases(
  models: Record<string, ModelAlias>,
): Record<string, ModelAlias> {
  return Object.fromEntries(
    Object.entries(models).map(([alias, model]) => [alias, effectiveModelAlias(model)]),
  );
}
