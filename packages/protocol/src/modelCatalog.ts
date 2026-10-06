import { z } from 'zod';
import { recipeModelBindingSchema } from './recipe';
import { modelSteeringCadenceSchema } from './modelSteering';
import { modelBehaviorWireSchema, modelBehaviorPatchSchema } from './questionGuard';
export * from './questionGuard';

export const providerCatalogStatusSchema = z.enum([
  'connected',
  'error',
  'unconfigured',
]);
export type ProviderCatalogStatus = z.infer<typeof providerCatalogStatusSchema>;

export const requestIdentityOverridesSchema = z
  .object({
    lineage: z
      .object({
        format: z.enum(['codex', 'claude_code', 'grok_build', 'opencode', 'kimi_code', 'none']).optional(),
        session_scope: z.enum(['shared_session', 'agent_session', 'none']).optional(),
        thread_identity: z.enum(['agent', 'none']).optional(),
        parent_thread: z.enum(['immediate_agent', 'none']).optional(),
        subagent_marker: z.enum(['enabled', 'none']).optional(),
        turn_ancestry: z.enum(['spawn_context', 'none']).optional(),
      }).strict()
      .optional(),
    client: z
      .object({
        installation_identity: z.enum(['persistent_local', 'none']).optional(),
        originator: z
          .discriminatedUnion('mode', [
            z.object({ mode: z.literal('none') }).strict(),
            z.object({ mode: z.literal('codex_default') }).strict(),
            z.object({
              mode: z.literal('custom'),
              value: z.string().min(1).refine((value) => !/[\u0000-\u001F\u007F]/u.test(value)),
            }).strict(),
          ])
          .optional(),
        user_agent: z.enum(['codex', 'claude_code', 'grok_build', 'opencode', 'kimi_code', 'host', 'none']).optional(),
      }).strict()
      .optional(),
    request: z
      .object({
        logical_id: z.enum(['turn', 'none']).optional(),
        turn_index: z.enum(['agent_session', 'none']).optional(),
      }).strict()
      .optional(),
    cache: z
      .object({
        source: z.enum(['session', 'none']).optional(),
        responses: z.enum(['prompt_cache_key', 'none']).optional(),
        messages: z.enum(['metadata_user_id', 'none']).optional(),
      }).strict()
      .optional(),
    responses_metadata: z.enum(['codex', 'none']).optional(),
  })
  .strict()
  .refine(hasDefinedLeaf, { message: 'request identity overrides must contain a leaf value' });

export const requestIdentityPresetSchema = z.enum([
  'codex_compatible',
  'claude_code_compatible',
  'grok_build_compatible',
  'opencode_compatible',
  'kimi_code',
  'none',
]);
export type RequestIdentityPresetWire = z.infer<typeof requestIdentityPresetSchema>;

/** Built-in ids are bare snake_case; user profiles live under `custom:`. */
export const requestIdentityProfileIdSchema = z
  .string()
  .regex(/^(?:[a-z][a-z0-9_]{0,31}|custom:[a-z0-9][a-z0-9_-]{0,47})$/u);

export const requestIdentityPolicySchema = z
  .object({
    preset: requestIdentityPresetSchema.optional(),
    profile: requestIdentityProfileIdSchema.optional(),
    overrides: requestIdentityOverridesSchema.optional(),
  })
  .strict()
  .refine((policy) => policy.preset !== undefined || policy.profile !== undefined || policy.overrides !== undefined, {
    message: 'request identity policy must contain preset, profile or overrides',
  })
  .refine((policy) => policy.preset === undefined || policy.profile === undefined, {
    message: 'request identity policy cannot set both preset and profile',
  });
export type RequestIdentityPolicyWire = z.infer<typeof requestIdentityPolicySchema>;

export const serviceTierSchema = z.enum(['auto', 'default', 'flex', 'priority']);
export type ServiceTierWire = z.infer<typeof serviceTierSchema>;

export const apiDefaultParameterSchema = z.object({ kind: z.literal('api_default') }).strict();
export const generationParametersSchema = z.object({
  temperature: z.union([z.number().finite().min(0), apiDefaultParameterSchema]).optional(),
  top_p: z.union([z.number().finite().min(0).max(1), apiDefaultParameterSchema]).optional(),
  max_completion_tokens: z.number().int().positive().finite().optional(),
  thinking_effort: z.string().trim().min(1).optional(),
  service_tier: z.union([serviceTierSchema, apiDefaultParameterSchema]).optional(),
}).strict();
export type GenerationParametersWire = z.infer<typeof generationParametersSchema>;
export const generationParametersPatchSchema = z.object({
  temperature: generationParametersSchema.shape.temperature.unwrap().nullable().optional(),
  top_p: generationParametersSchema.shape.top_p.unwrap().nullable().optional(),
  max_completion_tokens: generationParametersSchema.shape.max_completion_tokens.unwrap().nullable().optional(),
  thinking_effort: generationParametersSchema.shape.thinking_effort.unwrap().nullable().optional(),
  service_tier: generationParametersSchema.shape.service_tier.unwrap().nullable().optional(),
}).strict();
export type GenerationParametersPatch = z.infer<typeof generationParametersPatchSchema>;

export const modelUsageParametersSchema = generationParametersSchema.pick({
  thinking_effort: true, service_tier: true, max_completion_tokens: true,
}).extend({
  auto_compact: z.number().int().positive().safe().optional(),
  context_budget: z.number().int().positive().safe().optional(),
}).strict();
export type ModelUsageParametersWire = z.infer<typeof modelUsageParametersSchema>;
export const modelUsagePolicySchema = z.object({
  main: modelUsageParametersSchema.optional(),
  independent: modelUsageParametersSchema.optional(),
}).strict();
export type ModelUsagePolicyWire = z.infer<typeof modelUsagePolicySchema>;
export const modelUsageParametersPatchSchema = generationParametersPatchSchema.pick({
  thinking_effort: true, service_tier: true, max_completion_tokens: true,
}).extend({
  auto_compact: modelUsageParametersSchema.shape.auto_compact.unwrap().nullable().optional(),
  context_budget: modelUsageParametersSchema.shape.context_budget.unwrap().nullable().optional(),
}).strict();
export const modelUsagePolicyPatchSchema = z.object({
  main: modelUsageParametersPatchSchema.nullable().optional(),
  independent: modelUsageParametersPatchSchema.nullable().optional(),
}).strict();
export type ModelUsagePolicyPatch = z.infer<typeof modelUsagePolicyPatchSchema>;
export const modelUsageEffectiveSchema = z.object({
  main: modelUsageParametersSchema,
  sub: modelUsageParametersSchema,
  independent: modelUsageParametersSchema,
});
export const modelUsageSourcesSchema = z.object({
  main: z.record(z.string(), z.string()),
  sub: z.record(z.string(), z.string()),
  independent: z.record(z.string(), z.string()),
});

export const imageMimeSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toLowerCase();
    return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
  },
  z.enum([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/heic',
    'image/heif',
    'image/avif',
    'image/tiff',
    'image/x-icon',
  ]),
);
export const imageConversionModeSchema = z.enum(['off', 'auto', 'png', 'jpeg']);
export const imagePolicySchema = z
  .object({
    accepted_types: z.array(imageMimeSchema).min(1).optional(),
    convert_unsupported: imageConversionModeSchema.optional(),
  })
  .strict();
export type ImagePolicyWire = z.infer<typeof imagePolicySchema>;

export const imagePolicyPatchSchema = z
  .object({
    accepted_types: z.array(imageMimeSchema).min(1).nullable().optional(),
    convert_unsupported: imageConversionModeSchema.nullable().optional(),
  })
  .strict();
export type ImagePolicyPatch = z.infer<typeof imagePolicyPatchSchema>;

/**
 * One configured model, as read back by `GET /models`. `id` is the local
 * alias (the `[models]` config key — what sessions, profiles and the default
 * pointer reference); `remote_id` is the exact wire value sent upstream.
 * They are independent: a local alias never encodes the remote id, and the
 * remote id is never recovered by stripping a provider prefix from `id`.
 */
export const modelCatalogItemSchema = z.object({
  id: z.string().min(1),
  provider_id: z.string(),
  remote_id: z.string().min(1),
  pricing_model: z.string().trim().min(1).optional(),
  display_name: z.string().min(1).optional(),
  max_context_size: z.number().int().min(0),
  auto_compact: z.number().int().positive().safe().optional(),
  capabilities: z.array(z.string()).optional(),
  effective_capabilities: z.array(z.string()).optional(),
  support_efforts: z.array(z.string()).optional(),
  default_effort: z.string().optional(),
  service_tier: serviceTierSchema.optional(),
  parameters: generationParametersSchema.optional(),
  behavior: modelBehaviorWireSchema.optional(),
  request_identity: requestIdentityPolicySchema.optional(),
  images: imagePolicySchema.optional(),
});
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;

export const providerCatalogItemSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  base_url: z.string().min(1).optional(),
  default_model: z.string().min(1).optional(),
  defaults: generationParametersSchema.optional(),
  request_identity: requestIdentityPolicySchema.optional(),
  images: imagePolicySchema.optional(),
  api_key: z.string().min(1).optional(),
  api_key_env: z.string().min(1).optional(),
  has_api_key: z.boolean(),
  status: providerCatalogStatusSchema,
  models: z.array(z.string().min(1)).optional(),
  model_source: z.enum(['static', 'discover', 'oauth-catalog']).optional(),
  // Header and env values may be credentials: only their names are read back.
  custom_header_keys: z.array(z.string()).optional(),
  env_keys: z.array(z.string()).optional(),
  oauth: z.object({ storage: z.enum(['file', 'keyring']), signed_in: z.boolean() }).optional(),
});
export type ProviderCatalogItem = z.infer<typeof providerCatalogItemSchema>;

export const providerRefreshChangeSchema = z.object({
  provider_id: z.string().min(1),
  provider_name: z.string().min(1),
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
});
export type ProviderRefreshChange = z.infer<typeof providerRefreshChangeSchema>;

export const providerRefreshFailureSchema = z.object({
  provider: z.string().min(1),
  reason: z.string().min(1),
});
export type ProviderRefreshFailure = z.infer<typeof providerRefreshFailureSchema>;

/** Remote suggestions are not configured model entities and cannot be used until saved. */
export const discoveredModelSchema = z.object({
  remote_id: z.string().min(1),
  display_name: z.string().optional(),
  max_context_size: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  support_efforts: z.array(z.string()).optional(),
});
export type DiscoveredModel = z.infer<typeof discoveredModelSchema>;

/** Process-local results of explicit fetches; timestamps are epoch milliseconds. */
export const discoveredProviderModelsSchema = z.object({
  provider_id: z.string().min(1),
  fetched_at: z.number().int().min(0).nullable(),
  attempted_at: z.number().int().min(0),
  failure_reason: z.string().min(1).optional(),
  models: z.array(discoveredModelSchema),
});
export type DiscoveredProviderModels = z.infer<typeof discoveredProviderModelsSchema>;

export const listDiscoveredModelsResponseSchema = z.object({
  items: z.array(discoveredProviderModelsSchema),
});
export type ListDiscoveredModelsResponse = z.infer<typeof listDiscoveredModelsResponseSchema>;

/**
 * Where the model's routed provider came from. `flat` means the model carries
 * its own `base_url` and no provider reference; the reported `provider_id` is
 * then the synthesized origin, not a configured provider.
 */
export const modelProviderSourceSchema = z.enum([
  'provider',
  'provider_id',
  'default_provider',
  'flat',
]);
export type ModelProviderSource = z.infer<typeof modelProviderSourceSchema>;

/**
 * One machine-readable configuration problem of a single model entity. `code`
 * is stable and localized by the client; `message` is diagnostic text. An
 * `error` issue means the model cannot currently be built into a requester, a
 * `warning` means it is usable but incomplete.
 */
export const modelIssueSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(['error', 'warning']),
  path: z.string(),
  message: z.string().min(1),
});
export type ModelIssue = z.infer<typeof modelIssueSchema>;

/**
 * Advanced per-model fields that already exist in `[models.<alias>]`. The wire
 * uses snake_case; `overrides` keys are the same snake_case model fields.
 */
export const cognitionInlineTextSchema = z.object({ text: z.string().max(2_097_152) }).strict();
const cognitionPathSchema = z.string().min(1).refine((ref) => {
  const path = ref.trim().replaceAll('\\', '/');
  if (path.length === 0 || path.includes('\0') || path.startsWith('/') || /^[a-z]:/iu.test(path)) return false;
  let depth = 0;
  for (const part of path.split('/')) {
    if (part === '..') depth--;
    else if (part !== '' && part !== '.') depth++;
    if (depth < 0) return false;
  }
  return true;
}, { message: 'Cognition paths must stay inside the Kiki home directory' });
export const cognitionSlotSchema = z.union([cognitionInlineTextSchema, cognitionPathSchema, z.array(cognitionPathSchema).min(1)]);
const cognitionPathRefSchema = cognitionSlotSchema;
const modelCognitionContentSchema = z
  .object({
    overlay: cognitionPathRefSchema.optional(),
    steering: cognitionPathRefSchema.optional(),
    anchor: cognitionPathRefSchema.optional(),
    overlay_mode: z.enum(['append', 'prepend', 'wrap', 'persona', 'replace']).optional(),
    anchor_steps: z.number().int().min(1).optional(),
    anchor_scope: z.enum(['session', 'turn']).optional(),
    ...modelSteeringCadenceSchema.shape,
  })
  .strict();
const modelCognitionBranchSchema = z.union([
  z.enum(['same', 'off']),
  modelCognitionContentSchema.refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Set at least one cognition field or use off',
  }),
]);
export const modelCognitionSchema = modelCognitionContentSchema.extend({
  main: modelCognitionBranchSchema.optional(),
  independent: modelCognitionBranchSchema.optional(),
}).superRefine((value, ctx) => {
  const hasCommon = Object.entries(value).some(([key, field]) => key !== 'main' && key !== 'independent' && field !== undefined);
  for (const position of ['main', 'independent'] as const) {
    if (value[position] === 'same' && !hasCommon) {
      ctx.addIssue({ code: 'custom', path: [position], message: 'same requires common cognition fields' });
    }
  }
});
export type ModelCognitionWire = z.infer<typeof modelCognitionSchema>;
const modelCognitionBodySchema = z.object({
  channel: z.enum(['cognition_overlay', 'cognition_steering', 'cognition_anchor']),
  source: z.enum(['inline', 'files', 'unset']),
  text: z.string().optional(),
  files: z.array(z.object({ path: z.string(), text: z.string() })).optional(),
  writable: z.boolean(),
  source_read_only: z.boolean(),
  error: z.string().optional(),
});
const modelCognitionBodyBranchSchema = z.object({
  selection: z.enum(['common', 'custom', 'off']),
  source_scope: z.enum(['common', 'main', 'independent']),
  slots: z.object({ overlay: modelCognitionBodySchema, steering: modelCognitionBodySchema, anchor: modelCognitionBodySchema }),
});
export const modelCognitionBodiesSchema = z.object({
  revision: z.string().min(1),
  branches: z.object({ common: modelCognitionBodyBranchSchema, main: modelCognitionBodyBranchSchema, independent: modelCognitionBodyBranchSchema }),
});
export type ModelCognitionBodies = z.infer<typeof modelCognitionBodiesSchema>;
const modelPromptOverrideContentSchema = z.object({
  files: z.array(z.string().trim().min(1)).optional(),
  fields: z.record(z.string(), z.string()).optional(),
}).strict();
const hasOverrideContent = (value: z.infer<typeof modelPromptOverrideContentSchema>): boolean =>
  (value.files?.length ?? 0) > 0 || Object.keys(value.fields ?? {}).length > 0;
const modelPromptOverrideBranchSchema = z.union([
  z.enum(['same', 'off']),
  modelPromptOverrideContentSchema.refine(hasOverrideContent, { message: 'Set files or fields, or use off' }),
]);
export const modelPromptOverridesSchema = modelPromptOverrideContentSchema.extend({
  main: modelPromptOverrideBranchSchema.optional(),
  independent: modelPromptOverrideBranchSchema.optional(),
}).superRefine((value, ctx) => {
  for (const position of ['main', 'independent'] as const) {
    if (value[position] === 'same' && !hasOverrideContent(value)) ctx.addIssue({ code: 'custom', path: [position], message: 'same requires common files or fields' });
  }
});
export const modelRequestParamsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export const modelOverridesSchema = z.record(z.string(), z.unknown());

/**
 * The single-model read/write projection (`GET`/`PATCH /models/{id}`). The
 * stored entity is exposed field by field; `revision` is the compare-and-swap
 * token the next PATCH must carry so a concurrent edit cannot be silently
 * overwritten. Absent optional fields mean "not configured" — they are never
 * filled with fabricated defaults.
 */
export const modelEntitySchema = z.object({
  id: z.string().min(1),
  provider_id: z.string().min(1),
  provider_source: modelProviderSourceSchema,
  remote_id: z.string().min(1).optional(),
  pricing_model: z.string().trim().min(1).optional(),
  display_name: z.string().min(1).optional(),
  max_context_size: z.number().int().min(1).optional(),
  max_input_size: z.number().int().min(1).optional(),
  max_output_size: z.number().int().min(1).optional(),
  auto_compact: z.number().int().positive().safe().optional(),
  capabilities: z.array(z.string()).optional(),
  support_efforts: z.array(z.string()).optional(),
  default_effort: z.string().optional(),
  adaptive_thinking: z.boolean().optional(),
  service_tier: serviceTierSchema.optional(),
  parameters: generationParametersSchema.optional(),
  effective_parameters: generationParametersSchema,
  parameter_sources: z.record(z.string(), z.string()),
  behavior: modelBehaviorWireSchema.optional(),
  usage: modelUsagePolicySchema.optional(),
  usage_effective: modelUsageEffectiveSchema.optional(),
  usage_sources: modelUsageSourcesSchema.optional(),
  request_identity: requestIdentityPolicySchema.optional(),
  images: imagePolicySchema.optional(),
  aliases: z.array(z.string()).optional(),
  reasoning_key: z.string().optional(),
  off_effort: z.string().optional(),
  context_budget: z.number().int().min(1).optional(),
  request_params: modelRequestParamsSchema.optional(),
  recipe: z.string().min(1).optional(),
  recipe_model_binding: recipeModelBindingSchema.optional(),
  cognition: modelCognitionSchema.optional(),
  cognition_bodies: modelCognitionBodiesSchema.optional(),
  prompt_overrides: modelPromptOverridesSchema.optional(),
  overrides: modelOverridesSchema.optional(),
  protocol: z.string().min(1).optional(),
  base_url: z.string().min(1).optional(),
  revision: z.string().min(1),
  issues: z.array(modelIssueSchema),
});
export type ModelEntity = z.infer<typeof modelEntitySchema>;

/**
 * Sparse local-model patch: only the listed fields change, everything else —
 * including fields this client version does not know about — is preserved
 * verbatim. `null` explicitly clears a field, `undefined`/absent leaves it
 * untouched, so "not sent" can never destroy stored data. `remote_id` is
 * identity, not a value to clear. Writing or clearing `cognition` or
 * `prompt_overrides` requires `base_revision` from the model read.
 */
export const patchModelRequestSchema = z
  .object({
    base_revision: z.string().min(1).optional(),
    remote_id: z.string().min(1).optional(),
    pricing_model: z.string().trim().min(1).nullable().optional(),
    display_name: z.string().min(1).nullable().optional(),
    max_context_size: z.number().int().min(1).nullable().optional(),
    max_input_size: z.number().int().min(1).nullable().optional(),
    max_output_size: z.number().int().min(1).nullable().optional(),
    auto_compact: z.number().int().positive().safe().nullable().optional(),
    capabilities: z.array(z.string().min(1)).nullable().optional(),
    support_efforts: z.array(z.string().min(1)).nullable().optional(),
    default_effort: z.string().min(1).nullable().optional(),
    adaptive_thinking: z.boolean().nullable().optional(),
    service_tier: serviceTierSchema.nullable().optional(),
    parameters: generationParametersPatchSchema.nullable().optional(),
    behavior: modelBehaviorPatchSchema.nullable().optional(),
    usage: modelUsagePolicyPatchSchema.nullable().optional(),
    request_identity: requestIdentityPolicySchema.nullable().optional(),
    images: imagePolicyPatchSchema.nullable().optional(),
    aliases: z.array(z.string().min(1)).nullable().optional(),
    reasoning_key: z.string().min(1).nullable().optional(),
    off_effort: z.string().min(1).nullable().optional(),
    context_budget: z.number().int().min(1).nullable().optional(),
    request_params: modelRequestParamsSchema.nullable().optional(),
    recipe: z.string().min(1).nullable().optional(),
    cognition: modelCognitionSchema.nullable().optional(),
    prompt_overrides: modelPromptOverridesSchema.nullable().optional(),
    overrides: modelOverridesSchema.nullable().optional(),
  })
  .strict().superRefine((value, ctx) => {
    if ((value.cognition !== undefined || value.prompt_overrides !== undefined) && value.base_revision === undefined) {
      ctx.addIssue({ code: 'custom', path: ['base_revision'], message: 'Model prompt edits require base_revision' });
    }
  });
export type PatchModelRequest = z.infer<typeof patchModelRequestSchema>;

/**
 * Create one local model entity. `id` is the local alias; when omitted the
 * server suggests `provider_id/remote_id` — a creation-time naming
 * suggestion, never a rule for reading an existing id back.
 */
export const createModelRequestSchema = z
  .object({
    id: z.string().min(1).optional(),
    provider_id: z.string().min(1),
    remote_id: z.string().min(1),
    pricing_model: z.string().trim().min(1).optional(),
    display_name: z.string().min(1).optional(),
    max_context_size: z.number().int().min(1).optional(),
    max_input_size: z.number().int().min(1).optional(),
    max_output_size: z.number().int().min(1).optional(),
    auto_compact: z.number().int().positive().safe().optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    support_efforts: z.array(z.string().min(1)).optional(),
    default_effort: z.string().min(1).optional(),
    adaptive_thinking: z.boolean().optional(),
    service_tier: serviceTierSchema.optional(),
    parameters: generationParametersSchema.optional(),
    behavior: modelBehaviorWireSchema.optional(),
    usage: modelUsagePolicySchema.optional(),
    request_identity: requestIdentityPolicySchema.optional(),
    images: imagePolicySchema.optional(),
  })
  .strict();
export type CreateModelRequest = z.infer<typeof createModelRequestSchema>;

/**
 * Sparse provider patch. It never carries a model list: models are edited as
 * their own entities (`/models`), so saving one field of a connection can no
 * longer rebuild or drop its models. `base_url`, `default_model` and
 * `request_identity` accept `null` to clear; `api_key` stays tri-state
 * (absent keeps the stored key, `""` clears, any other value replaces).
 */
export const patchProviderRequestSchema = z
  .object({
    base_revision: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    api_key: z.string().optional(),
    base_url: z.string().trim().nullable().optional(),
    default_model: z.string().min(1).nullable().optional(),
    defaults: generationParametersPatchSchema.nullable().optional(),
    request_identity: requestIdentityPolicySchema.nullable().optional(),
    images: imagePolicyPatchSchema.nullable().optional(),
    model_source: z.enum(['static', 'discover', 'oauth-catalog']).nullable().optional(),
    // Per-name writes: a string sets that entry, null removes it, absent names are kept.
    custom_headers: z.record(z.string().min(1), z.string().nullable()).optional(),
    env: z.record(z.string().min(1), z.string().nullable()).optional(),
  })
  .strict();
export type PatchProviderRequest = z.infer<typeof patchProviderRequestSchema>;

export const getModelResponseSchema = modelEntitySchema;
export type GetModelResponse = z.infer<typeof getModelResponseSchema>;

/**
 * Structured conflict payload: the request's `base_revision` no longer
 * matches the stored entity, so nothing was written. `current` is the current
 * entity projection the caller must merge against.
 */
export const revisionConflictDetailsSchema = z.object({
  entity: z.enum(['model', 'provider']),
  id: z.string().min(1),
  expected_revision: z.string().min(1).optional(),
  actual_revision: z.string().min(1),
  current: z.record(z.string(), z.unknown()),
});
export type RevisionConflictDetails = z.infer<typeof revisionConflictDetailsSchema>;

const modelDraftSchema = z.object({
  remote_id: z.string().min(1),
  max_context_size: z.number().int().min(1).optional(),
  display_name: z.string().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  max_output_size: z.number().int().min(1).optional(),
  support_efforts: z.array(z.string().min(1)).optional(),
  adaptive_thinking: z.boolean().optional(),
  images: imagePolicySchema.optional(),
});

export const createProviderModelSchema = modelDraftSchema.extend({
  auto_compact: createModelRequestSchema.shape.auto_compact,
  behavior: modelBehaviorWireSchema.optional(),
  request_identity: requestIdentityPolicySchema.optional(),
});
export type CreateProviderModel = z.infer<typeof createProviderModelSchema>;

function refineProviderForm(
  value: {
    base_url?: string | null;
    models?: Array<{ remote_id: string }>;
    default_model?: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (typeof value.base_url === 'string' && value.base_url.includes('${')) {
    ctx.addIssue({
      code: 'custom',
      message: 'base_url must not contain an environment variable placeholder',
      path: ['base_url'],
    });
  }
  const models = value.models;
  if (models === undefined) return;
  const seen = new Set<string>();
  for (const entry of models) {
    if (seen.has(entry.remote_id)) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate model: ${entry.remote_id}`,
        path: ['models'],
      });
      return;
    }
    seen.add(entry.remote_id);
  }
}

/**
 * The provider id shape accepted when creating a provider. It is a
 * create-time naming rule only: existing ids outside it (colons, spaces,
 * non-ASCII) stay valid forever, and no read path re-applies it.
 */
export const providerIdSchema = z
  .string()
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$/u,
    'id must start with a letter or digit and may only contain letters, digits, "-", "_" and spaces',
  );

/**
 * Create a connection. A connection may be saved with zero models: the model
 * list is optional and `default_model` is only checked against the models
 * actually listed. `default_model` is the model half of the provider default
 * (the full alias is `provider_id/default_model`).
 */
export const createProviderRequestSchema = z
  .object({
    id: providerIdSchema,
    type: z.string().min(1),
    api_key: z.string().optional(),
    base_url: z.string().trim().optional(),
    default_model: z.string().min(1).optional(),
    defaults: generationParametersSchema.optional(),
    request_identity: requestIdentityPolicySchema.optional(),
    images: imagePolicySchema.optional(),
    models: z.array(createProviderModelSchema).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    refineProviderForm(value, ctx);
    if (
      value.default_model !== undefined &&
      !(value.models ?? []).some((entry) => entry.remote_id === value.default_model)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'default_model must be one of models[].remote_id',
        path: ['default_model'],
      });
    }
  });
export type CreateProviderRequest = z.infer<typeof createProviderRequestSchema>;

/** Pruned catalog model shape — enough for the import preview, nothing more. */
export const catalogModelItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  max_context_size: z.number().int().min(1),
  capabilities: z.array(z.string()).optional(),
  support_efforts: z.array(z.string()).optional(),
  reasoning: z.boolean(),
});
export type CatalogModelItem = z.infer<typeof catalogModelItemSchema>;

export const providerWireTypeSchema = z.enum([
  'kimi',
  'openai',
  'openai_responses',
  'anthropic',
  'google-genai',
  'vertexai',
]);
export type ProviderWireType = z.infer<typeof providerWireTypeSchema>;

/**
 * Why this client version cannot import a models.dev entry. Codes are stable;
 * clients render their own wording from them.
 */
export const modelsDevRejectCodeSchema = z.enum([
  'unknown-explicit-type',
  'proprietary-sdk',
  'empty-base-url',
  'placeholder-base-url',
]);
export type ModelsDevRejectCode = z.infer<typeof modelsDevRejectCodeSchema>;

/**
 * One browsable models.dev entry. `rejected: true` means this client version
 * cannot import it at all (greyed out): `reject_code` names the reason for
 * clients that render their own wording, and `reject_reason` keeps the
 * upstream wording for tooltips and clients that only read text.
 * `needs_base_url: true` means the import form must collect a base URL.
 */
export const catalogProviderItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  wire_type: providerWireTypeSchema.nullable(),
  guessed: z.boolean(),
  needs_base_url: z.boolean(),
  rejected: z.boolean(),
  /** Absent from older servers and from entries that were not rejected. */
  reject_code: modelsDevRejectCodeSchema.nullable().optional(),
  reject_reason: z.string().nullable(),
  env_key: z.string().nullable(),
  models: z.array(catalogModelItemSchema),
});
export type CatalogProviderItem = z.infer<typeof catalogProviderItemSchema>;

/**
 * Body of the `/providers:action` collection route. Every field is optional
 * so the bodyless `:refresh` actions (and their legacy `{}` bodies) still
 * validate; the `:import_catalog` handler enforces `catalog_id` and the
 * `:import_registry` handler enforces `url` themselves.
 *
 * `:import_catalog` semantics: import a models.dev entry as a configured
 * provider; `id` overrides the catalog id as the local provider id, and
 * importing an id that already exists is a refresh (the provider and its
 * aliases are rewritten from the catalog — the same re-import semantics as
 * the TUI). The global default_provider/default_model pointers are never
 * modified.
 */
export const providerCollectionActionBodySchema = z.object({
  catalog_id: z.string().min(1).optional(),
  api_key: z.string().optional(),
  base_url: z.string().optional(),
  id: providerIdSchema.optional(),
  url: z.string().min(1).optional(),
});
export type ProviderCollectionActionBody = z.infer<typeof providerCollectionActionBodySchema>;

export const refreshProviderRequestSchema = z.object({
  api_key: z.string().min(1).optional(),
}).strict();
export type RefreshProviderRequest = z.infer<typeof refreshProviderRequestSchema>;

export const listCatalogProvidersResponseSchema = z.object({
  items: z.array(catalogProviderItemSchema),
});
export type ListCatalogProvidersResponse = z.infer<typeof listCatalogProvidersResponseSchema>;

export const getCatalogProviderResponseSchema = catalogProviderItemSchema;
export type GetCatalogProviderResponse = z.infer<typeof getCatalogProviderResponseSchema>;

export const importCatalogProviderResponseSchema = z.object({
  provider: providerCatalogItemSchema,
  models_imported: z.number().int().min(0),
});
export type ImportCatalogProviderResponse = z.infer<typeof importCatalogProviderResponseSchema>;

export const importCustomRegistryResponseSchema = z.object({
  providers: z.array(providerCatalogItemSchema),
  models_imported: z.number().int().min(0),
});
export type ImportCustomRegistryResponse = z.infer<typeof importCustomRegistryResponseSchema>;

function hasDefinedLeaf(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === null || typeof value !== 'object') return true;
  return Object.values(value).some(hasDefinedLeaf);
}
