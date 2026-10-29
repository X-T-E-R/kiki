import { Error2 } from '#/_base/errors/errors';
import { CONFIG_INVALID_ERROR_CODE } from '#/kosong/contract/errors';
import type { ResolutionTrace } from '#/kosong/contract/inspection';

import {
  BUDGET_THINKING_EFFORTS,
  matchKnownAnthropicModelProfile,
  matchUnknownClaudeProfile,
} from '../provider/bases/anthropic/anthropic-profile';
import type { ProviderConfig } from '../provider/provider';
import { explainProviderEndpoint, resolveProviderApiKey } from '../provider/providerDefinition';

import type { ModelRecord } from './model';
import type { ResolvedModelAuthMaterial } from './model.types';
import { drivesThinkingThroughTraits } from './thinking';

export function resolveModelProviderId(
  model: Pick<ModelRecord, 'providerId' | 'provider'>,
  defaultProvider: string | undefined,
): string | undefined {
  return model.providerId ?? model.provider ?? defaultProvider;
}

export function resolveModelAuthMaterial(
  args: {
    readonly modelId: string;
    readonly model: ModelRecord;
    readonly provider: ProviderConfig | undefined;
    readonly providerName: string;
  },
  trace?: ResolutionTrace,
): ResolvedModelAuthMaterial {
  const modelApiKey = nonEmpty(args.model.apiKey);
  if (modelApiKey !== undefined && args.model.oauth !== undefined) {
    throw authConflictError('Model', args.modelId);
  }
  if (modelApiKey !== undefined) {
    trace?.record('resolved.auth', { kind: 'config', detail: 'model.apiKey' });
    return { apiKey: modelApiKey };
  }
  if (args.model.oauth !== undefined) {
    trace?.record('resolved.auth', { kind: 'config', detail: 'model.oauth' });
    return {
      oauth: args.model.oauth,
      oauthProviderKey: args.model.providerId ?? args.model.provider,
    };
  }

  const providerKey = resolveProviderApiKey({ ...args.provider, type: args.provider?.type ?? args.model.protocol });
  const providerApiKey = providerKey.apiKey;
  if (providerApiKey !== undefined && args.provider?.oauth !== undefined) {
    throw authConflictError('Provider', args.providerName);
  }
  if (providerApiKey !== undefined) {
    trace?.record(
      'resolved.auth',
      nonEmpty(args.provider?.apiKey) !== undefined
        ? { kind: 'config', detail: `provider '${args.providerName}' apiKey` }
        : {
            kind: 'env',
            detail: `${providerKey.envName ?? '?'} (provider '${args.providerName}' ${args.provider?.apiKeyEnv === undefined ? 'env bag' : 'api_key_env'})`,
          },
    );
    return { apiKey: providerApiKey };
  }
  if (args.provider?.oauth !== undefined) {
    trace?.record('resolved.auth', {
      kind: 'config',
      detail: `provider '${args.providerName}' oauth`,
    });
    return {
      oauth: args.provider.oauth,
      oauthProviderKey: args.model.providerId ?? args.model.provider,
    };
  }
  trace?.record('resolved.auth', {
    kind: 'none',
    detail: 'no credential resolved at any layer (adapter construction receives an empty key to suppress process.env fallback)',
  });
  return {};
}

export function effectiveModelConfig(
  model: ModelRecord,
  providerType?: string,
): ModelRecord {
  const { overrides, ...base } = model;
  const effective: ModelRecord = overrides === undefined ? model : {
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
  const clamped =
    effective.maxInputSize !== undefined &&
    effective.maxContextSize !== undefined &&
    effective.maxInputSize > effective.maxContextSize
      ? { ...effective, maxInputSize: effective.maxContextSize }
      : effective;
  return withAnthropicProfile(clamped, providerType);
}

function withAnthropicProfile(model: ModelRecord, providerType?: string): ModelRecord {
  const wireName = model.name ?? model.model;
  const protocol = model.protocol ?? providerType;
  const profile =
    wireName === undefined
      ? undefined
      : providerType !== undefined && !drivesThinkingThroughTraits(providerType) && protocol === 'anthropic'
        ? (matchKnownAnthropicModelProfile(wireName) ?? matchUnknownClaudeProfile(wireName))
        : matchKnownAnthropicModelProfile(wireName);
  if (profile === undefined) return model;
  const capability = profile.canDisableThinking ? 'thinking' : 'always_thinking';
  const capabilities = model.capabilities ?? [];
  const hasCapability = capabilities.some(
    (candidate) => candidate.trim().toLowerCase() === capability,
  );
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

export function deriveProviderId(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.host;
  } catch {
    return baseUrl;
  }
}

export type BindingOrigin = 'model' | 'provider' | 'env' | 'vendor' | 'none';

export interface BindingOriginExplanation {
  readonly source: BindingOrigin;
  readonly envName?: string;
  readonly baseUrl?: string;
}

export function explainModelEndpointOrigin(
  model: Pick<ModelRecord, 'baseUrl' | 'protocol'>,
  provider?: Pick<ProviderConfig, 'baseUrl' | 'type' | 'env'>,
): BindingOriginExplanation {
  const fromModel = nonEmpty(model.baseUrl);
  if (fromModel !== undefined) return { source: 'model', baseUrl: fromModel };
  const fromProvider = nonEmpty(provider?.baseUrl);
  if (fromProvider !== undefined) return { source: 'provider', baseUrl: fromProvider };
  const endpointType = provider?.type ?? model.protocol;
  if (endpointType === undefined) return { source: 'none' };
  const explained = explainProviderEndpoint(endpointType, provider?.env ?? {});
  const fromBag = nonEmpty(explained.baseUrl);
  if (fromBag === undefined) return { source: 'none' };
  if (explained.baseUrlIsDefault === true) return { source: 'vendor', baseUrl: fromBag };
  return { source: 'env', baseUrl: fromBag, envName: explained.baseUrlEnvName };
}

export function explainModelAuthOrigin(
  model: Pick<ModelRecord, 'apiKey' | 'oauth' | 'protocol'>,
  provider?: Pick<ProviderConfig, 'baseUrl' | 'apiKey' | 'apiKeyEnv' | 'oauth' | 'type' | 'env'>,
): BindingOriginExplanation {
  if (nonEmpty(model.apiKey) !== undefined || model.oauth !== undefined) return { source: 'model' };
  if (nonEmpty(provider?.apiKey) !== undefined) return { source: 'provider' };
  const explained = resolveProviderApiKey({ ...provider, type: provider?.type ?? model.protocol });
  if (explained.apiKey !== undefined) {
    return { source: 'env', envName: explained.envName };
  }
  if (provider?.oauth !== undefined) return { source: 'provider' };
  return { source: 'none' };
}

/** Shared endpoint precedence for the requester and the read-only key preview. */
export function resolveConfiguredModelBaseUrl(
  model: Pick<ModelRecord, 'baseUrl' | 'protocol'>,
  provider?: Pick<ProviderConfig, 'baseUrl' | 'type' | 'env'>,
): string | undefined {
  return explainModelEndpointOrigin(model, provider).baseUrl;
}

export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function authConflictError(kind: string, name: string): Error2 {
  return new Error2(
    CONFIG_INVALID_ERROR_CODE,
    `${kind} "${name}" has both apiKey and oauth set in config.toml - they are mutually exclusive. Remove one.`,
  );
}
