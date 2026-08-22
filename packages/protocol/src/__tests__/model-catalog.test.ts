import { describe, expect, it } from 'vitest';

import {
  configResponseSchema,
  getProviderResponseSchema,
  listModelsResponseSchema,
  patchConfigRequestSchema,
  listProvidersResponseSchema,
  modelCatalogItemSchema,
  providerCatalogItemSchema,
  providerCatalogStatusSchema,
  requestIdentityPolicySchema,
  setDefaultModelResponseSchema,
  type ModelCatalogItem,
  type ProviderCatalogItem,
} from '../index';

describe('model catalog schemas', () => {
  const model: ModelCatalogItem = {
    provider: 'kimi',
    model: 'k2',
    display_name: 'Kimi K2',
    max_context_size: 131072,
    capabilities: ['thinking'],
    request_identity: { overrides: { client: { user_agent: 'host' } } },
  };

  const provider: ProviderCatalogItem = {
    id: 'kimi',
    type: 'kimi',
    base_url: 'https://api.example.test/v1',
    default_model: 'k2',
    request_identity: {
      preset: 'grok_build_compatible',
      overrides: { client: { user_agent: 'grok_build' } },
    },
    has_api_key: true,
    status: 'connected',
    models: ['k2'],
  };

  it('round-trips a model catalog item', () => {
    expect(modelCatalogItemSchema.parse(model)).toEqual(model);
  });

  it('rejects invalid model context sizes', () => {
    expect(
      modelCatalogItemSchema.safeParse({ ...model, max_context_size: 0 }).success,
    ).toBe(false);
  });

  it.each(['connected', 'error', 'unconfigured'] as const)(
    'accepts provider status %s',
    (status) => {
      expect(providerCatalogStatusSchema.parse(status)).toBe(status);
    },
  );

  it('round-trips a provider catalog item', () => {
    expect(providerCatalogItemSchema.parse(provider)).toEqual(provider);
    expect(getProviderResponseSchema.parse(provider)).toEqual(provider);
  });

  it('rejects unknown request-identity fields recursively', () => {
    expect(requestIdentityPolicySchema.safeParse({ preset: 'none', future_root: true }).success).toBe(false);
    expect(
      requestIdentityPolicySchema.safeParse({
        preset: 'none',
        overrides: { request: { future_axis: 'value' } },
      }).success,
    ).toBe(false);
  });

  it('rejects recursively empty layers and accepts one override leaf', () => {
    expect(requestIdentityPolicySchema.safeParse({}).success).toBe(false);
    expect(requestIdentityPolicySchema.safeParse({ overrides: {} }).success).toBe(false);
    expect(
      requestIdentityPolicySchema.safeParse({ overrides: { lineage: {}, client: {} } }).success,
    ).toBe(false);
    expect(
      requestIdentityPolicySchema.safeParse({
        overrides: { client: { user_agent: 'host' } },
      }).success,
    ).toBe(true);
  });

  it('accepts kimi_code and rejects the removed kiki preset name', () => {
    expect(requestIdentityPolicySchema.safeParse({ preset: 'kimi_code' }).success).toBe(true);
    expect(requestIdentityPolicySchema.safeParse({ preset: 'kiki' }).success).toBe(false);
  });

  it('accepts an object to replace global request identity', () => {
    const request_identity = { overrides: { client: { user_agent: 'host' as const } } };
    expect(configResponseSchema.parse({ request_identity })).toMatchObject({ request_identity });
    expect(patchConfigRequestSchema.parse({ request_identity })).toEqual({ request_identity });
  });

  it('accepts omission to keep global request identity', () => {
    expect(patchConfigRequestSchema.parse({})).not.toHaveProperty('request_identity');
  });

  it('accepts null to clear global request identity', () => {
    expect(patchConfigRequestSchema.parse({ request_identity: null })).toEqual({
      request_identity: null,
    });
    expect(configResponseSchema.safeParse({ request_identity: null }).success).toBe(false);
  });

  it('round-trips list responses and set-default response', () => {
    expect(listModelsResponseSchema.parse({ items: [model] })).toEqual({
      items: [model],
    });
    expect(listProvidersResponseSchema.parse({ items: [provider] })).toEqual({
      items: [provider],
    });
    expect(
      setDefaultModelResponseSchema.parse({ default_model: 'k2', model }),
    ).toEqual({
      default_model: 'k2',
      model,
    });
  });
});
