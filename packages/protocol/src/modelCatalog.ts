import { z } from 'zod';

export const modelCatalogItemSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  display_name: z.string().min(1).optional(),
  max_context_size: z.number().int().min(1),
  capabilities: z.array(z.string()).optional(),
  support_efforts: z.array(z.string()).optional(),
  default_effort: z.string().optional(),
});
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;

export const providerCatalogStatusSchema = z.enum([
  'connected',
  'error',
  'unconfigured',
]);
export type ProviderCatalogStatus = z.infer<typeof providerCatalogStatusSchema>;

export const requestIdentityPolicySchema = z.object({
  preset: z.enum(['codex_compatible', 'grok_build_compatible', 'kiki', 'none']),
  overrides: z
    .object({
      lineage: z
        .object({
          format: z.enum(['codex', 'grok_build', 'kiki', 'none']).optional(),
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
              z.object({ mode: z.literal('custom'), value: z.string().min(1) }).strict(),
            ])
            .optional(),
          user_agent: z.enum(['codex', 'grok_build', 'host', 'none']).optional(),
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
    }).strict()
    .optional(),
}).strict();
export type RequestIdentityPolicyWire = z.infer<typeof requestIdentityPolicySchema>;

export const providerCatalogItemSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  base_url: z.string().min(1).optional(),
  default_model: z.string().min(1).optional(),
  request_identity: requestIdentityPolicySchema.optional(),
  request_attribution: z.enum(['codex', 'kimi', 'kiki', 'none']).optional(),
  request_originator: z.string().optional(),
  has_api_key: z.boolean(),
  status: providerCatalogStatusSchema,
  models: z.array(z.string().min(1)).optional(),
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
