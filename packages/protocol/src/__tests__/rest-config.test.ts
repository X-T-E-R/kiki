import { describe, expect, it } from 'vitest';

import { configResponseSchema, patchConfigRequestSchema } from '../rest/config';
import {
  modelGenerationMigrationApplyRequestSchema,
  modelGenerationMigrationPreviewSchema,
  modelGenerationMigrationRestoreRequestSchema,
} from '../rest/modelGenerationMigration';
import {
  findUnknownNbSearchProviderOptions,
  nbSearchCapabilitiesSchema,
  nbSearchConfigPatchSchema,
} from '../rest/nbSearch';

describe('config REST protocol', () => {
  it('preserves legacy and declarative hooks through response and patch schemas', () => {
    const legacy = [{ event: 'PreToolUse', command: 'echo example', matcher: '^Read$', timeout: 600 }];
    const hooks = {
      schemaVersion: 2,
      enabled: false,
      disabled: ['project.reminder'],
      files: ['hooks/example.toml'],
      legacy,
      rules: [
        {
          id: 'reminder',
          event: 'step.before',
          priority: -10,
          enabled: true,
          match: {
            models: ['example/model'],
            profiles: ['example'],
            routes: ['native'],
            executors: ['native'],
            agentRoles: ['root'],
            tools: ['Read'],
            statuses: ['success'],
            sources: ['user'],
            outcomes: ['completed'],
          },
          cadence: { everyCompletedSteps: 3, counterScope: 'turn', partitionBy: 'model' },
          action: { type: 'inject', textFile: 'guidance/example.txt' },
        },
        { id: 'audit', event: 'turn.after', priority: 200, enabled: false, match: {}, action: { type: 'observe' } },
        { id: 'greeting', event: 'prompt.submit', priority: 100, enabled: true, match: {}, action: { type: 'inject', text: 'Example guidance' } },
      ],
    };
    for (const value of [legacy, hooks]) {
      expect(configResponseSchema.parse({ hooks: value }).hooks).toEqual(value);
      expect(patchConfigRequestSchema.parse({ hooks: value }).hooks).toEqual(value);
    }
  });

  it('preserves space_ui, subagent fields, model overrides, and null resets', () => {
    expect(configResponseSchema.parse({ space_ui: { defaultSkin: 'linen', landingPage: '/bots', plugins: [] } }).space_ui)
      .toEqual({ defaultSkin: 'linen', landingPage: '/bots', plugins: [] });
    expect(patchConfigRequestSchema.parse({ space_ui: { landing_page: '/new' } })).toEqual({ space_ui: { landing_page: '/new' } });
    expect(patchConfigRequestSchema.safeParse({ space_ui: { landing_page: 'https://example.com' } }).success).toBe(false);

    for (const allowedTools of [['BoardRead'], []]) {
      expect(patchConfigRequestSchema.parse({ subagent: { allowed_tools: allowedTools } }))
        .toEqual({ subagent: { allowed_tools: allowedTools } });
      expect(configResponseSchema.parse({ subagent: { allowedTools } }).subagent).toEqual({ allowedTools });
    }
    for (const fields of [['model', 'context_tokens'] as const, [] as const]) {
      expect(patchConfigRequestSchema.parse({ subagent: { agent_list_fields: [...fields] } }))
        .toEqual({ subagent: { agent_list_fields: [...fields] } });
      expect(configResponseSchema.parse({ subagent: { agentListFields: [...fields] } }).subagent)
        .toEqual({ agentListFields: [...fields] });
    }
    expect(patchConfigRequestSchema.parse({ subagent: { agent_list_fields: null } })).toEqual({ subagent: { agent_list_fields: null } });
    expect(patchConfigRequestSchema.safeParse({ subagent: { agent_list_fields: ['unknown_field'] } }).success).toBe(false);

    expect(patchConfigRequestSchema.parse({ subagent: { default_model: 'explore/fast' }, fast_model: 'kimi-code/kimi-k2' }))
      .toEqual({ subagent: { default_model: 'explore/fast' }, fast_model: 'kimi-code/kimi-k2' });
    expect(patchConfigRequestSchema.parse({ subagent: { default_model: null }, fast_model: null }))
      .toEqual({ subagent: { default_model: null }, fast_model: null });
    expect(configResponseSchema.parse({ subagent: { defaultModel: 'explore/fast' }, fast_model: 'kimi-code/kimi-k2' }))
      .toMatchObject({ subagent: { defaultModel: 'explore/fast' }, fast_model: 'kimi-code/kimi-k2' });
  });

  it('distinguishes system transport sections, explicit off, omission, and null clears', () => {
    const request_compression = {
      encoding: 'zstd' as const,
      targets: ['https://b.example.test/v1', 'https://a.example.test/v1'],
      min_bytes: 0,
      dictionary: false,
    };
    const responses_web_socket = { targets: ['https://example.test/v1'] };

    expect(configResponseSchema.parse({ request_compression, responses_web_socket }))
      .toMatchObject({ request_compression, responses_web_socket });
    expect(patchConfigRequestSchema.parse({ request_compression, responses_web_socket }))
      .toEqual({ request_compression, responses_web_socket });
    expect(patchConfigRequestSchema.parse({ request_compression: { encoding: 'off' }, responses_web_socket: { off: true } }))
      .toEqual({ request_compression: { encoding: 'off' }, responses_web_socket: { off: true } });
    expect(patchConfigRequestSchema.parse({ request_compression: { min_bytes: 0, targets: request_compression.targets } }).request_compression)
      .toEqual({ min_bytes: 0, targets: request_compression.targets });

    expect(patchConfigRequestSchema.parse({})).not.toHaveProperty('request_compression');
    expect(patchConfigRequestSchema.parse({})).not.toHaveProperty('responses_web_socket');
    expect(patchConfigRequestSchema.parse({ request_compression: null, responses_web_socket: null }))
      .toEqual({ request_compression: null, responses_web_socket: null });
    expect(configResponseSchema.safeParse({ request_compression: null }).success).toBe(false);
    expect(
      patchConfigRequestSchema.safeParse({ request_compression: { encoding: 'gzip', dictionary: true, targets: ['https://example.test/v1'] } }).success,
    ).toBe(false);
    expect(patchConfigRequestSchema.safeParse({ responses_web_socket: {} }).success).toBe(false);
  });

  it('omits or rejects retired fields and preserves shared prompt/passthrough patches', () => {
    expect(patchConfigRequestSchema.parse({ subagent: { main_dispatch_policy: 'strict', subagent_dispatch_policy: 'advisory', allowed_tools: ['Read'] } }))
      .toEqual({ subagent: { allowed_tools: ['Read'] } });
    expect(configResponseSchema.parse({ subagent: { mainDispatchPolicy: 'strict', subagentDispatchPolicy: 'advisory', allowedTools: ['Read'] } }).subagent)
      .toEqual({ allowedTools: ['Read'] });

    expect(patchConfigRequestSchema.parse({ telemetry: false })).toEqual({});
    expect(configResponseSchema.parse({ providers: {}, telemetry: true })).toEqual({ providers: {} });
    expect(configResponseSchema.parse({ providers: {}, services: {} })).toEqual({ providers: {} });
    expect(patchConfigRequestSchema.safeParse({ services: {} }).success).toBe(false);

    const prompt = {
      shared: '${team_note}',
      variables: { team_note: 'Example team', search_guidance: 'Native GMA SSE' },
      tools: { WebSearch: '${search_guidance}' },
    };
    expect(patchConfigRequestSchema.parse({ prompt })).toEqual({ prompt });
    expect(configResponseSchema.parse({ prompt }).prompt).toEqual(prompt);
    expect(patchConfigRequestSchema.safeParse({ prompt: { variables: { invalid: 42 } } }).success).toBe(false);
    expect(patchConfigRequestSchema.safeParse({ thread_communication: { enabled: true }, replace_domains: ['thread_communication'] }).success).toBe(true);
  });

  it('validates scoped retry policies and optional capability defaults vs availability', () => {
    const patch = {
      retry: {
        max_attempts: 5,
        retry_partial_responses: false,
        policies: [{ match: '^provider\\.rate_limit$', models: ['gemini-4-argon'], providers: ['google-native'], max_attempts: 20, backoff: 15_000, retry: true }],
      },
    };
    expect(patchConfigRequestSchema.parse(patch)).toEqual(patch);
    expect(
      configResponseSchema.parse({
        providers: {},
        retry: {
          maxAttempts: 5,
          retryPartialResponses: false,
          policies: [{ match: '^provider\\.rate_limit$', models: ['gemini-4-argon'], providers: ['google-native'], maxAttempts: 20, backoff: 15_000, retry: true }],
        },
      }).retry,
    ).toEqual({
      maxAttempts: 5,
      retryPartialResponses: false,
      policies: [{ match: '^provider\\.rate_limit$', models: ['gemini-4-argon'], providers: ['google-native'], maxAttempts: 20, backoff: 15_000, retry: true }],
    });
    expect(patchConfigRequestSchema.safeParse({ retry: { policies: [{ match: '429', models: [] }] } }).success).toBe(false);
    expect(patchConfigRequestSchema.safeParse({ retry: { policies: [{ match: '429', provider: 'google-native' }] } }).success).toBe(false);

    const state = { allowed: true, host_locked: false, default_on: false, origin: 'default' as const, unresolved: false };
    expect(
      configResponseSchema.parse({
        providers: {},
        optional_capabilities: { browser: state, computer: state, memory: state, branch: state, thread: state, web: { ...state, default_on: true }, send_message: state },
      }).optional_capabilities?.thread,
    ).toEqual(state);
    expect(patchConfigRequestSchema.parse({ optional_capabilities: { defaults: { thread: true, web: null, send_message: false }, web_allowed: false } }))
      .toEqual({ optional_capabilities: { defaults: { thread: true, web: null, send_message: false }, web_allowed: false } });
    expect(patchConfigRequestSchema.safeParse({ optional_capabilities: { enabled: true } }).success).toBe(false);
  });

  it('separates local-source preferences from canonical nb_search config and rejects secrets', () => {
    expect(patchConfigRequestSchema.parse({ nb_search_source: {} })).toEqual({ nb_search_source: { reuse_local_config: true } });
    expect(configResponseSchema.parse({ nb_search_source: { reuse_local_config: false } }).nb_search_source)
      .toEqual({ reuse_local_config: false });
    expect(nbSearchConfigPatchSchema.safeParse({ reuse_local_config: false }).success).toBe(false);
    expect(patchConfigRequestSchema.safeParse({ nb_search_source: { reuse_local_config: false, api_key: 'fixture-private-key' } }).success).toBe(false);

    const nb_search = {
      defaults: { search_lane: 'context7.docs' },
      provider_instances: { 'tavily.default': { key_strategy: 'priority', balance_ttl_ms: 600_000 } },
      execution: { search_timeout_ms: 15_000 },
    };
    expect(patchConfigRequestSchema.parse({ nb_search })).toEqual({ nb_search });
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
      limits: { max_source_bytes: 2_097_152, max_response_bytes: 2_097_152, max_content_chars: 200_000, max_redirects: 5, max_timeout_ms: 60_000, max_inline_bytes: 65_536 },
    },
    jobs: { result_ttl_seconds: 259_200, cancel_supported: true },
  };

  it('validates readiness fields, canonical patch keys, and unknown provider options', () => {
    expect(nbSearchCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(
      nbSearchCapabilitiesSchema.safeParse({
        ...capabilities,
        search: { ...capabilities.search, lanes: [{ ...capabilities.search.lanes[0], availability: 'unknown' }] },
      }).success,
    ).toBe(false);
    expect(nbSearchConfigPatchSchema.safeParse({ defaults: { search_lane: 'context7.docs' } }).success).toBe(true);
    expect(nbSearchConfigPatchSchema.safeParse({ api_key: 'secret-value' }).success).toBe(false);
    expect(
      findUnknownNbSearchProviderOptions(
        { provider_instances: { unknown: { provider_id: 'unknown-provider' } } },
        [{ provider_id: 'exa', option_keys: ['search_path'] }],
      ),
    ).toEqual([{ provider_instance_id: 'unknown', provider_id: 'unknown-provider' }]);
  });
});

describe('model generation migration REST contract', () => {
  const revision = 'f'.repeat(64);

  it('exposes only revision, field names, reason codes, and backup identifiers', () => {
    const preview = {
      revision,
      changes: [{ model_id: 'model', fields: ['temperature'] }],
      needs_review: [{ model_id: 'model', code: 'differs', field: 'top_p' }],
      backups: ['config.toml.generation-backup-123e4567-e89b-42d3-a456-426614174000'],
    };
    expect(modelGenerationMigrationPreviewSchema.parse(preview)).toEqual(preview);
    expect(modelGenerationMigrationPreviewSchema.safeParse({ ...preview, backups: [{ backup_key: preview.backups[0], secret: 'sk-secret' }] }).success).toBe(false);
    expect(modelGenerationMigrationPreviewSchema.safeParse({ ...preview, original_text: 'sk-secret' }).success).toBe(false);
    expect(modelGenerationMigrationPreviewSchema.safeParse({ ...preview, needs_review: [{ model_id: 'model', reason: 'raw' }] }).success).toBe(false);
  });

  it('requires a revision and affirmative confirmation on both write endpoints', () => {
    expect(modelGenerationMigrationApplyRequestSchema.safeParse({ revision }).success).toBe(false);
    expect(modelGenerationMigrationApplyRequestSchema.safeParse({ revision, confirmed: false }).success).toBe(false);
    expect(modelGenerationMigrationApplyRequestSchema.safeParse({ revision, confirmed: true }).success).toBe(true);
    expect(modelGenerationMigrationRestoreRequestSchema.safeParse({ backup_key: 'backup', confirmed: true }).success).toBe(false);
    expect(modelGenerationMigrationRestoreRequestSchema.safeParse({ revision, backup_key: 'backup', confirmed: true }).success).toBe(true);
  });

  it('round-trips retry max_retry_after_ms and maxRetryAfterMs on section and policy schemas', () => {
    const patch = {
      retry: {
        max_attempts: 5,
        max_retry_after_ms: 120_000,
        policies: [{ match: '^provider\\.rate_limit$', max_retry_after_ms: 90_000, retry: true }],
      },
    };
    expect(patchConfigRequestSchema.parse(patch)).toEqual(patch);
    const response = {
      retry: {
        maxAttempts: 5,
        maxRetryAfterMs: 120_000,
        policies: [{ match: '^provider\\.rate_limit$', maxRetryAfterMs: 90_000, retry: true }],
      },
    };
    expect(configResponseSchema.parse(response).retry).toEqual(response.retry);
    expect(patchConfigRequestSchema.safeParse({ retry: { max_retry_after_ms: 0 } }).success).toBe(false);
    expect(configResponseSchema.safeParse({ retry: { maxRetryAfterMs: -1 } }).success).toBe(false);
  });
});
