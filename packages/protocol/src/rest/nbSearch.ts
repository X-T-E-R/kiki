import { z } from 'zod';

export const nbSearchSourceConfigSchema = z.object({
  reuse_local_config: z.boolean().default(true),
}).strict();

export type NbSearchSourceConfig = z.infer<typeof nbSearchSourceConfigSchema>;

export const nbSearchConfigSourceStatusSchema = z.object({
  reuse_local_config: z.boolean(),
  layers: z.array(z.enum(['defaults', 'local', 'environment', 'kiki'])),
  local_config: z.enum(['present', 'missing', 'ignored', 'unreadable', 'invalid']),
  local_credentials: z.enum(['present', 'missing', 'ignored', 'unreadable', 'invalid', 'rejected']).optional(),
  credential_source: z.enum(['environment', 'environment+local']).optional(),
  availability: z.enum(['ready', 'unavailable']),
  issues: z.array(z.string()),
}).strict();

export type NbSearchConfigSourceStatus = z.infer<typeof nbSearchConfigSourceStatusSchema>;

const fetchInputKindSchema = z.enum(['url', 'inline_text', 'inline_bytes', 'file']);
const fetchRepresentationSchema = z.enum(['markdown', 'text']);
const executionModeSchema = z.enum(['sync', 'async']);
const latencySchema = z.enum(['fast', 'medium', 'slow']);
const costSchema = z.enum(['free', 'cheap', 'expensive']);

const providerInstancePatchSchema = z
  .object({
    provider_id: z.string().trim().min(1).max(128).optional(),
    enabled: z.boolean().optional(),
    credential_slot_id: z.string().trim().min(1).max(256).optional(),
    base_url: z.string().url().optional(),
    options: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

const credentialSlotSchema = z
  .object({
    provider_id: z.string().trim().min(1).max(128),
    env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  })
  .strict();

const laneConfigSchema = z
  .object({
    provider_instance_id: z.string().trim().min(1).max(256),
    operation_id: z.string().trim().min(1).max(128),
    latency: latencySchema,
    cost: costSchema,
    evidence_groups: z.array(z.string().trim().min(1).max(128)).min(1).max(32).optional(),
  })
  .strict();

const fetchChainConfigSchema = z
  .object({
    input_kind: fetchInputKindSchema,
    representation: fetchRepresentationSchema.optional(),
    pipelines: z.array(z.string().trim().min(1).max(256)).min(1),
  })
  .strict();

const presetConfigSchema = z
  .object({ lanes: z.array(z.string().trim().min(1).max(256)).min(1) })
  .strict();

const fileScopeSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    root: z.string().trim().min(1),
    media_types: z.array(z.string().trim().min(1).max(256)).min(1).optional(),
  })
  .strict();

const qualityPatchSchema = z
  .object({
    min_content_chars: z.number().int().min(0).max(10_000_000).optional(),
    blocked_markers: z.array(z.string().min(1).max(256)).max(64).optional(),
  })
  .strict();

const fetchExecutionPatchSchema = z
  .object({
    max_source_bytes: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
    max_response_bytes: z.number().int().min(1024).max(64 * 1024 * 1024).optional(),
    max_content_chars: z.number().int().min(256).max(10_000_000).optional(),
    max_redirects: z.number().int().min(0).max(20).optional(),
    quality: qualityPatchSchema.nullable().optional(),
  })
  .strict();

const executionPatchSchema = z
  .object({
    max_provider_calls: z.number().int().min(1).max(1024).optional(),
    max_concurrency: z.number().int().min(1).max(128).optional(),
    retry_count: z.number().int().min(0).max(9).optional(),
    search_timeout_ms: z.number().int().min(100).max(3_600_000).optional(),
    fetch_timeout_ms: z.number().int().min(100).max(120_000).optional(),
    max_inline_bytes: z.number().int().min(1024).max(16 * 1024 * 1024).optional(),
    fetch: fetchExecutionPatchSchema.nullable().optional(),
  })
  .strict();

export const nbSearchConfigPatchSchema = z
  .object({
    schema_version: z.literal('4').nullable().optional(),
    home: z.string().trim().min(1).nullable().optional(),
    jobs_root: z.string().trim().min(1).nullable().optional(),
    retention_hours: z.number().positive().max(24 * 3650).nullable().optional(),
    log_level: z.enum(['error', 'warn', 'info', 'debug']).nullable().optional(),
    provider_instances: z
      .record(z.string().min(1), providerInstancePatchSchema.nullable())
      .nullable()
      .optional(),
    credential_slots: z
      .record(z.string().min(1), credentialSlotSchema.nullable())
      .nullable()
      .optional(),
    lanes: z.record(z.string().min(1), laneConfigSchema.nullable()).nullable().optional(),
    defaults: z
      .object({
        search_lane: z.string().min(1).nullable().optional(),
        fetch_chain: z.array(fetchChainConfigSchema).min(1).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    presets: z.record(z.string().min(1), presetConfigSchema.nullable()).nullable().optional(),
    fetch: z
      .object({ file_scopes: z.array(fileScopeSchema).max(64).nullable().optional() })
      .strict()
      .nullable()
      .optional(),
    execution: executionPatchSchema.nullable().optional(),
  })
  .strict();

export type NbSearchConfigPatch = z.infer<typeof nbSearchConfigPatchSchema>;

const capabilityIssueSchema = z
  .object({
    code: z.string(),
    execution: executionModeSchema.optional(),
  })
  .passthrough();

const queryOutputSchema = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('results'), schema_id: z.literal('nb-search.results@1') }),
  z.object({ channel: z.literal('typed'), schema_id: z.string().min(1) }),
]);

const providerDescriptorSchema = z
  .object({
    provider_id: z.string(),
    adapter_version: z.string(),
    query_operations: z.array(
      z.object({
        operation_id: z.string(),
        output: queryOutputSchema,
        built_in_async: z.boolean(),
      }),
    ),
    fetch_operations: z.array(z.object({ operation_id: z.string() }).passthrough()),
    activation: z.object({
      credential: z.enum(['required', 'none']),
      endpoint: z.enum(['required', 'optional', 'none']),
    }),
    option_keys: z.array(z.string()),
  })
  .passthrough();

const providerInstanceCapabilitySchema = z
  .object({
    id: z.string(),
    provider_id: z.string(),
    enabled: z.boolean(),
    availability: z.enum(['ready', 'unavailable']),
    issues: z.array(capabilityIssueSchema),
    credential: z
      .object({
        requirement: z.enum(['required', 'none', 'unknown']),
        configured: z.boolean(),
        slot_id: z.string().optional(),
      })
      .passthrough(),
    endpoint: z
      .object({
        requirement: z.enum(['required', 'optional', 'none', 'unknown']),
        configured: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

const searchLaneCapabilitySchema = z
  .object({
    id: z.string(),
    output: queryOutputSchema,
    execution_modes: z.array(executionModeSchema),
    availability: z.enum(['ready', 'unavailable']),
    issues: z.array(capabilityIssueSchema),
    latency: latencySchema,
    cost: costSchema,
  })
  .passthrough();

const searchPresetCapabilitySchema = z
  .object({
    name: z.string(),
    lanes: z.array(z.string()),
    execution_modes: z.array(executionModeSchema),
    availability: z.enum(['ready', 'unavailable']),
    issues: z.array(capabilityIssueSchema),
  })
  .passthrough();

const fetchPipelineCapabilitySchema = z
  .object({
    id: z.string(),
    input_kinds: z.array(fetchInputKindSchema),
    media_types: z.array(z.string()),
    representations: z.array(fetchRepresentationSchema),
    execution_modes: z.array(executionModeSchema),
    egress: z.enum(['none', 'url', 'content']),
    stages: z.array(
      z.object({
        id: z.string(),
        role: z.enum(['acquire', 'extract', 'convert', 'reader']),
      }),
    ),
    availability: z.enum(['ready', 'unavailable']),
    issues: z.array(capabilityIssueSchema),
    latency: latencySchema,
    cost: costSchema,
  })
  .passthrough();

export const nbSearchCapabilitiesSchema = z
  .object({
    config_source: nbSearchConfigSourceStatusSchema.optional(),
    schema_version: z.literal('3.0'),
    revision: z.string(),
    providers: z
      .object({
        descriptors: z.array(providerDescriptorSchema),
        instances: z.array(providerInstanceCapabilitySchema),
      })
      .passthrough(),
    search: z
      .object({
        default_lane: z.string().optional(),
        lanes: z.array(searchLaneCapabilitySchema),
        presets: z.array(searchPresetCapabilitySchema),
        limits: z.object({
          max_queries: z.number().int(),
          max_results: z.number().int(),
          max_timeout_ms: z.number().int(),
          max_inline_bytes: z.number().int(),
        }),
      })
      .passthrough(),
    fetch: z
      .object({
        default_representation: z.literal('markdown'),
        inputs: z.array(z.object({ kind: fetchInputKindSchema, enabled: z.boolean() }).passthrough()),
        chains: z.array(fetchChainConfigSchema),
        pipelines: z.array(fetchPipelineCapabilitySchema),
        limits: z.object({
          max_source_bytes: z.number().int(),
          max_response_bytes: z.number().int(),
          max_content_chars: z.number().int(),
          max_redirects: z.number().int(),
          max_timeout_ms: z.number().int(),
          max_inline_bytes: z.number().int(),
        }),
      })
      .passthrough(),
    jobs: z
      .object({
        result_ttl_seconds: z.number().int(),
        cancel_supported: z.literal(true),
      })
      .passthrough(),
  })
  .passthrough();

export type NbSearchCapabilities = z.infer<typeof nbSearchCapabilitiesSchema>;

export const nbSearchReadinessSchema = z.object({
  configured: z.boolean(),
  available: z.boolean(),
  selection: z.string().optional(),
  issues: z.array(z.string()),
});

export const nbSearchTestStatusSchema = z.object({
  revision: z.string(),
  search: nbSearchReadinessSchema,
  fetch: nbSearchReadinessSchema,
});

export type NbSearchTestStatus = z.infer<typeof nbSearchTestStatusSchema>;

export interface NbSearchProviderOptionDescriptor {
  readonly provider_id: string;
  readonly option_keys: readonly string[];
}

export interface UnknownNbSearchProviderOption {
  readonly provider_instance_id: string;
  readonly provider_id?: string;
  readonly option_key?: string;
}

export interface NbSearchProviderOptionsConfig {
  readonly provider_instances?: Readonly<Record<string, {
    readonly provider_id?: string;
    readonly options?: Readonly<Record<string, unknown>> | null;
  } | null>> | null;
}

export function findUnknownNbSearchProviderOptions(
  config: NbSearchProviderOptionsConfig,
  descriptors: readonly NbSearchProviderOptionDescriptor[],
): UnknownNbSearchProviderOption[] {
  const allowedByProvider = new Map(
    descriptors.map((descriptor) => [descriptor.provider_id, new Set(descriptor.option_keys)]),
  );
  const issues: UnknownNbSearchProviderOption[] = [];
  for (const [instanceId, instance] of Object.entries(config.provider_instances ?? {})) {
    if (instance === null) continue;
    const inferredProviderId = instanceId.endsWith('.default')
      ? instanceId.slice(0, -'.default'.length)
      : undefined;
    const providerId = instance.provider_id ?? inferredProviderId;
    const allowed = providerId === undefined ? undefined : allowedByProvider.get(providerId);
    if (allowed === undefined) {
      issues.push({ provider_instance_id: instanceId, provider_id: providerId });
      continue;
    }
    if (instance.options === null || instance.options === undefined) continue;
    for (const optionKey of Object.keys(instance.options)) {
      if (!allowed.has(optionKey)) {
        issues.push({
          provider_instance_id: instanceId,
          provider_id: providerId,
          option_key: optionKey,
        });
      }
    }
  }
  return issues;
}
