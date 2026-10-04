import { describe, expect, it } from 'vitest';

import { configResponseSchema, patchConfigRequestSchema } from '../rest/config';
import {
  findUnknownNbSearchProviderOptions,
  nbSearchCapabilitiesSchema,
  nbSearchConfigPatchSchema,
} from '../rest/nbSearch';

describe('config REST protocol', () => {
  it('preserves legacy and declarative hooks through response and patch schemas', () => {
    const legacy = [{ event: 'PreToolUse', command: 'echo example', matcher: '^Read$', timeout: 600 }];
    const hooks = {
      schemaVersion: 2, enabled: false, disabled: ['project.reminder'], files: ['hooks/example.toml'], legacy,
      rules: [
        { id: 'reminder', event: 'step.before', priority: -10, enabled: true,
          match: { models: ['example/model'], profiles: ['example'], routes: ['native'], executors: ['native'], agentRoles: ['root'], tools: ['Read'], statuses: ['success'], sources: ['user'], outcomes: ['completed'] },
          cadence: { everyCompletedSteps: 3, counterScope: 'turn', partitionBy: 'model' }, action: { type: 'inject', textFile: 'guidance/example.txt' } },
        { id: 'audit', event: 'turn.after', priority: 200, enabled: false, match: {}, action: { type: 'observe' } },
        { id: 'greeting', event: 'prompt.submit', priority: 100, enabled: true, match: {}, action: { type: 'inject', text: 'Example guidance' } },
      ],
    };
    for (const value of [legacy, hooks]) {
      expect(configResponseSchema.parse({ hooks: value }).hooks).toEqual(value);
      expect(patchConfigRequestSchema.parse({ hooks: value }).hooks).toEqual(value);
    }
  });

  it('preserves space UI defaults and validates partial user patches', () => {
    expect(configResponseSchema.parse({ space_ui: { defaultSkin: 'linen', landingPage: '/bots', plugins: [] } }).space_ui)
      .toEqual({ defaultSkin: 'linen', landingPage: '/bots', plugins: [] });
    expect(patchConfigRequestSchema.parse({ space_ui: { landing_page: '/new' } })).toEqual({ space_ui: { landing_page: '/new' } });
    expect(patchConfigRequestSchema.safeParse({ space_ui: { landing_page: 'https://example.com' } }).success).toBe(false);
  });
  it('preserves subagent tool opt-ins and an explicit reset on the wire', () => {
    for (const allowedTools of [['BoardRead'], []]) {
      expect(patchConfigRequestSchema.parse({ subagent: { allowed_tools: allowedTools } }))
        .toEqual({ subagent: { allowed_tools: allowedTools } });
      expect(configResponseSchema.parse({ subagent: { allowedTools } }).subagent)
        .toEqual({ allowedTools });
    }
  });

  it('omits removed host dispatch policies from the typed request and response', () => {
    expect(patchConfigRequestSchema.parse({ subagent: {
      main_dispatch_policy: 'strict', subagent_dispatch_policy: 'advisory', allowed_tools: ['Read'],
    } })).toEqual({ subagent: { allowed_tools: ['Read'] } });
    expect(configResponseSchema.parse({ subagent: {
      mainDispatchPolicy: 'strict', subagentDispatchPolicy: 'advisory', allowedTools: ['Read'],
    } }).subagent).toEqual({ allowedTools: ['Read'] });
  });

  it('round-trips the subagent default_model and the top-level fast_model, clearing each with null', () => {
    expect(patchConfigRequestSchema.parse({
      subagent: { default_model: 'explore/fast' },
      fast_model: 'kimi-code/kimi-k2',
    })).toEqual({
      subagent: { default_model: 'explore/fast' },
      fast_model: 'kimi-code/kimi-k2',
    });
    expect(patchConfigRequestSchema.parse({
      subagent: { default_model: null },
      fast_model: null,
    })).toEqual({
      subagent: { default_model: null },
      fast_model: null,
    });
    expect(configResponseSchema.parse({
      subagent: { defaultModel: 'explore/fast' },
      fast_model: 'kimi-code/kimi-k2',
    })).toMatchObject({
      subagent: { defaultModel: 'explore/fast' },
      fast_model: 'kimi-code/kimi-k2',
    });
  });

  it('omits the retired telemetry patch field', () => {
    expect(patchConfigRequestSchema.parse({ telemetry: false })).toEqual({});
  });

  it('retains shared prompt text, case-sensitive tool names and underscore variables on the SDK wire', () => {
    const prompt = { shared: '${team_note}', variables: { team_note: 'Example team', search_guidance: 'Native GMA SSE' }, tools: { WebSearch: '${search_guidance}' } };
    expect(patchConfigRequestSchema.parse({ prompt })).toEqual({ prompt });
    expect(configResponseSchema.parse({ prompt }).prompt).toEqual(prompt);
    expect(patchConfigRequestSchema.safeParse({ prompt: { variables: { invalid: 42 } } }).success).toBe(false);
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

  it('keeps local-source preferences outside the canonical config and rejects source secrets', () => {
    expect(patchConfigRequestSchema.parse({ nb_search_source: {} })).toEqual({ nb_search_source: { reuse_local_config: true } });
    expect(configResponseSchema.parse({ nb_search_source: { reuse_local_config: false } }).nb_search_source).toEqual({ reuse_local_config: false });
    expect(nbSearchConfigPatchSchema.safeParse({ reuse_local_config: false }).success).toBe(false);
    expect(patchConfigRequestSchema.safeParse({ nb_search_source: { reuse_local_config: false, api_key: 'fixture-private-key' } }).success).toBe(false);
  });

  it('accepts the explicit nb_search config contract', () => {
    expect(patchConfigRequestSchema.parse({
      nb_search: {
        defaults: { search_lane: 'context7.docs' },
        provider_instances: { 'tavily.default': { key_strategy: 'priority', balance_ttl_ms: 600_000 } },
        execution: { search_timeout_ms: 15_000 },
      },
    })).toEqual({
      nb_search: {
        defaults: { search_lane: 'context7.docs' },
        provider_instances: { 'tavily.default': { key_strategy: 'priority', balance_ttl_ms: 600_000 } },
        execution: { search_timeout_ms: 15_000 },
      },
    });
    expect(patchConfigRequestSchema.safeParse({ nb_search: { provider_instances: { 'tavily.default': { key_strategy: 'random' } } } }).success).toBe(false);
    expect(patchConfigRequestSchema.safeParse({ nb_search: { provider_instances: { 'tavily.default': { balance_ttl_ms: 999 } } } }).success).toBe(false);
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
