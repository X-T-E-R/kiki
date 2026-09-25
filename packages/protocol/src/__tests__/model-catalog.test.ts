import { describe, expect, it } from 'vitest';

import {
  configResponseSchema,
  createProviderRequestSchema,
  getProviderResponseSchema,
  listModelsResponseSchema,
  listDiscoveredModelsResponseSchema,
  refreshProviderModelsResponseSchema,
  patchConfigRequestSchema,
  listProvidersResponseSchema,
  modelCatalogItemSchema,
  patchModelRequestSchema,
  patchProviderRequestSchema,
  providerCatalogItemSchema,
  providerCatalogStatusSchema,
  probeProviderRequestSchema,
  probeProviderResponseSchema,
  refreshProviderRequestSchema,
  requestIdentityPolicySchema,
  setDefaultModelResponseSchema,
  type ModelCatalogItem,
  type ProviderCatalogItem,
} from '../index';

describe('model catalog schemas', () => {
  const model: ModelCatalogItem = {
    id: 'fast',
    provider_id: 'edge',
    remote_id: 'vendor/model:v1',
    display_name: 'Kimi K2',
    max_context_size: 131072,
    capabilities: ['thinking'],
    request_identity: { overrides: { client: { user_agent: 'host' } } },
    images: { accepted_types: ['image/png'], convert_unsupported: 'png' },
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
    images: { accepted_types: ['image/jpeg', 'image/png'], convert_unsupported: 'auto' },
    has_api_key: true,
    status: 'connected',
    models: ['k2'],
  };

  it('round-trips process-local suggestions without inventing configured aliases', () => {
    const items = [{ provider_id: 'edge', fetched_at: null, attempted_at: 100, failure_reason: 'HTTP 401', models: [] },
      { provider_id: 'other', fetched_at: 99, attempted_at: 100, models: [{ remote_id: 'vendor/new' }] }];
    expect(listDiscoveredModelsResponseSchema.parse({ items })).toEqual({ items });
    expect(refreshProviderModelsResponseSchema.parse({ changed: [], unchanged: [], failed: [], discovered: items }).discovered).toEqual(items);
  });

  it('accepts a request-only key for single-provider refresh', () => {
    expect(refreshProviderRequestSchema.parse({ api_key: 'sk-draft' })).toEqual({ api_key: 'sk-draft' });
    expect(refreshProviderRequestSchema.safeParse({ api_key: '' }).success).toBe(false);
    expect(refreshProviderRequestSchema.safeParse({ provider_id: 'edge' }).success).toBe(false);
  });

  it('validates unsaved provider probes and structured error categories', () => {
    const draft = { type: 'anthropic', base_url: 'https://api.example.test/v1', api_key: 'draft-key' };
    expect(probeProviderRequestSchema.parse(draft)).toEqual(draft);
    expect(probeProviderRequestSchema.safeParse({ ...draft, type: 'unknown' }).success).toBe(false);
    expect(probeProviderRequestSchema.safeParse({ ...draft, persistent: true }).success).toBe(false);
    expect(probeProviderResponseSchema.parse({ ok: true, models: ['claude-example'] })).toEqual({ ok: true, models: ['claude-example'] });
    expect(probeProviderResponseSchema.parse({ ok: false, error: { kind: 'unauthorized', status: 401, message: 'Rejected.' } }))
      .toEqual({ ok: false, error: { kind: 'unauthorized', status: 401, message: 'Rejected.' } });
    expect(probeProviderResponseSchema.safeParse({ ok: false, error: { kind: 'unknown', message: 'Failed.' } }).success).toBe(false);
  });

  it('round-trips a model catalog item', () => {
    expect(modelCatalogItemSchema.parse(model)).toEqual(model);
  });

  it('keeps the local alias and the remote id independent', () => {
    const item = modelCatalogItemSchema.parse(model);
    expect(item.id).toBe('fast');
    expect(item.remote_id).toBe('vendor/model:v1');
    expect(item.provider_id).toBe('edge');
    expect(modelCatalogItemSchema.safeParse({ ...model, remote_id: undefined }).success).toBe(false);
    expect(modelCatalogItemSchema.safeParse({ ...model, id: '' }).success).toBe(false);
    // An unresolved flat model reports an empty provider id instead of a
    // fabricated one; the model still names a local alias and a remote id.
    expect(
      modelCatalogItemSchema.safeParse({ ...model, provider_id: '' }).success,
    ).toBe(true);
  });

  it('rejects invalid model context sizes', () => {
    expect(modelCatalogItemSchema.safeParse({ ...model, max_context_size: -1 }).success).toBe(false);
  });

  it('accepts a sparse model patch and rejects unknown fields', () => {
    expect(patchModelRequestSchema.parse({ display_name: 'Fast' })).toEqual({
      display_name: 'Fast',
    });
    expect(patchModelRequestSchema.parse({ adaptive_thinking: null })).toEqual({
      adaptive_thinking: null,
    });
    expect(patchModelRequestSchema.safeParse({ max_output_size: 0 }).success).toBe(false);
    expect(patchModelRequestSchema.safeParse({ models: [] }).success).toBe(false);
  });

  it('accepts sparse image-policy leaf updates and null clears', () => {
    expect(
      patchModelRequestSchema.parse({ images: { convert_unsupported: 'off' } }),
    ).toEqual({ images: { convert_unsupported: 'off' } });
    expect(
      patchProviderRequestSchema.parse({ images: { accepted_types: ['IMAGE/JPG'] } }),
    ).toEqual({ images: { accepted_types: ['image/jpeg'] } });
    expect(
      patchProviderRequestSchema.parse({ images: { accepted_types: null } }),
    ).toEqual({ images: { accepted_types: null } });
    expect(patchModelRequestSchema.parse({ images: null })).toEqual({ images: null });
    expect(
      patchProviderRequestSchema.safeParse({ images: { accepted_types: [] } }).success,
    ).toBe(false);
    expect(
      patchProviderRequestSchema.safeParse({ images: { future_option: true } }).success,
    ).toBe(false);
  });

  it('never accepts a model list inside a provider patch', () => {
    expect(patchProviderRequestSchema.parse({ base_url: null })).toEqual({ base_url: null });
    expect(
      patchProviderRequestSchema.safeParse({ models: [{ remote_id: 'k2' }] }).success,
    ).toBe(false);
  });

  it('allows creating a connection with zero models', () => {
    const created = createProviderRequestSchema.parse({
      id: 'edge',
      type: 'openai',
      base_url: 'https://api.example.test/v1',
    });
    expect(created.models).toBeUndefined();
    expect(
      createProviderRequestSchema.safeParse({
        id: 'edge',
        type: 'openai',
        default_model: 'k2',
        models: [{ remote_id: 'other' }],
      }).success,
    ).toBe(false);
  });

  it.each(['connected', 'error', 'unconfigured'] as const)(
    'accepts provider status %s',
    (status) => {
      expect(providerCatalogStatusSchema.parse(status)).toBe(status);
    },
  );

  it('round-trips inline keys or env names across provider and config responses', () => {
    expect(providerCatalogItemSchema.parse({ ...provider, api_key: 'sk-inline' }).api_key).toBe('sk-inline');
    expect(getProviderResponseSchema.parse({ ...provider, api_key_env: 'KIMI_API_KEY', revision: 'rev-1' }).api_key_env).toBe('KIMI_API_KEY');
    expect(configResponseSchema.parse({ providers: { kimi: { type: 'kimi', api_key: 'sk-inline', has_api_key: true } } }).providers['kimi']?.api_key).toBe('sk-inline');
    expect(providerCatalogItemSchema.parse(provider)).toEqual(provider);
    expect(getProviderResponseSchema.parse({ ...provider, revision: 'rev-1' })).toEqual({
      ...provider,
      revision: 'rev-1',
    });
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
