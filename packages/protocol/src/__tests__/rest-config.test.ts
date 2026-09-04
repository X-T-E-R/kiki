import { describe, expect, it } from 'vitest';

import { configResponseSchema, patchConfigRequestSchema } from '../rest/config';
import {
  findUnknownNbSearchProviderOptions,
  nbSearchCapabilitiesSchema,
  nbSearchConfigPatchSchema,
} from '../rest/nbSearch';

describe('config REST protocol', () => {
  it('omits the retired telemetry patch field', () => {
    expect(patchConfigRequestSchema.parse({ telemetry: false })).toEqual({});
  });

  it('keeps accepting server patch fields not mirrored by the shared schema', () => {
    expect(patchConfigRequestSchema.safeParse({
      thread_communication: { enabled: true },
      replace_domains: ['thread_communication'],
    }).success).toBe(true);
  });

  it('omits the retired telemetry response field', () => {
    expect(configResponseSchema.parse({ providers: {}, telemetry: true })).toEqual({ providers: {} });
  });

  it('removes the retired services response field and rejects it in patches', () => {
    expect(configResponseSchema.parse({ providers: {}, services: {} })).toEqual({ providers: {} });
    expect(patchConfigRequestSchema.safeParse({ services: {} }).success).toBe(false);
  });

  it('accepts the explicit nb_search config contract', () => {
    expect(patchConfigRequestSchema.parse({
      nb_search: {
        defaults: { search_lane: 'context7.docs' },
        execution: { search_timeout_ms: 15_000 },
      },
    })).toEqual({
      nb_search: {
        defaults: { search_lane: 'context7.docs' },
        execution: { search_timeout_ms: 15_000 },
      },
    });
  });
});

describe('nb-search REST protocol', () => {
  const capabilities = {
    schema_version: '3.0',
    revision: 'config-test',
    providers: { descriptors: [], instances: [] },
    search: {
      default_lane: 'context7.docs',
      lanes: [{
        id: 'context7.docs',
        output: { channel: 'typed', schema_id: 'nb-search.docs-context@1' },
        execution_modes: ['sync'],
        availability: 'ready',
        issues: [],
        latency: 'medium',
        cost: 'cheap',
      }],
      presets: [],
      limits: { max_queries: 64, max_results: 100, max_timeout_ms: 3_600_000, max_inline_bytes: 65_536 },
    },
    fetch: {
      default_representation: 'markdown',
      inputs: [{ kind: 'url', enabled: true }],
      chains: [{ input_kind: 'url', representation: 'markdown', pipelines: ['direct.fetch'] }],
      pipelines: [{
        id: 'direct.fetch',
        input_kinds: ['url'],
        media_types: ['text/html'],
        representations: ['markdown'],
        execution_modes: ['sync'],
        egress: 'url',
        stages: [{ id: 'direct.http', role: 'acquire' }],
        availability: 'ready',
        issues: [],
        latency: 'fast',
        cost: 'free',
      }],
      limits: {
        max_source_bytes: 2_097_152,
        max_response_bytes: 2_097_152,
        max_content_chars: 200_000,
        max_redirects: 5,
        max_timeout_ms: 60_000,
        max_inline_bytes: 65_536,
      },
    },
    jobs: { result_ttl_seconds: 259_200, cancel_supported: true },
  };

  it('validates typed lane and fetch pipeline readiness fields', () => {
    expect(nbSearchCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(nbSearchCapabilitiesSchema.safeParse({
      ...capabilities,
      search: {
        ...capabilities.search,
        lanes: [{ ...capabilities.search.lanes[0], availability: 'unknown' }],
      },
    }).success).toBe(false);
  });

  it('rejects unknown canonical config fields', () => {
    expect(nbSearchConfigPatchSchema.safeParse({ defaults: { search_lane: 'context7.docs' } }).success).toBe(true);
    expect(nbSearchConfigPatchSchema.safeParse({ api_key: 'secret-value' }).success).toBe(false);
  });

  it('reports an unknown provider even when it has no options', () => {
    expect(findUnknownNbSearchProviderOptions({
      provider_instances: {
        unknown: { provider_id: 'unknown-provider' },
      },
    }, [{ provider_id: 'exa', option_keys: ['search_path'] }])).toEqual([{
      provider_instance_id: 'unknown',
      provider_id: 'unknown-provider',
    }]);
  });
});
