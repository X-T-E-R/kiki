import { z } from 'zod';

import {
  createModelRequestSchema,
  createProviderRequestSchema,
  discoveredProviderModelsSchema,
  getModelResponseSchema,
  modelCatalogItemSchema,
  modelEntitySchema,
  patchModelRequestSchema,
  patchProviderRequestSchema,
  providerCatalogItemSchema,
  providerRefreshChangeSchema,
  providerRefreshFailureSchema,
  providerWireTypeSchema,
} from '../modelCatalog';

export const listModelsResponseSchema = z.object({
  items: z.array(modelCatalogItemSchema),
});
export type ListModelsResponse = z.infer<typeof listModelsResponseSchema>;

export const listProvidersResponseSchema = z.object({
  items: z.array(providerCatalogItemSchema),
});
export type ListProvidersResponse = z.infer<typeof listProvidersResponseSchema>;

/**
 * One provider entity: the connection projection plus the write token
 * (`revision`) the next PATCH must carry. Locally stored provider API keys
 * are returned for editing; env-backed credentials expose only the variable name.
 */
export const providerEntitySchema = providerCatalogItemSchema.extend({
  revision: z.string().min(1),
});
export type ProviderEntity = z.infer<typeof providerEntitySchema>;

export const getProviderResponseSchema = providerEntitySchema;
export type GetProviderResponse = z.infer<typeof getProviderResponseSchema>;

export const patchProviderResponseSchema = z.object({
  provider: providerCatalogItemSchema,
  revision: z.string().min(1),
});
export type PatchProviderResponse = z.infer<typeof patchProviderResponseSchema>;

export const createProviderResponseSchema = providerEntitySchema;
export type CreateProviderResponse = z.infer<typeof createProviderResponseSchema>;

export const createModelResponseSchema = modelEntitySchema;
export type CreateModelResponse = z.infer<typeof createModelResponseSchema>;

export const setDefaultModelResponseSchema = z.object({
  default_model: z.string().min(1),
  model: modelCatalogItemSchema,
});
export type SetDefaultModelResponse = z.infer<typeof setDefaultModelResponseSchema>;

export const refreshOAuthProviderModelsResponseSchema = z.object({
  changed: z.array(providerRefreshChangeSchema),
  unchanged: z.array(z.string().min(1)),
  failed: z.array(providerRefreshFailureSchema),
});
export type RefreshOAuthProviderModelsResponse = z.infer<
  typeof refreshOAuthProviderModelsResponseSchema
>;

export const refreshProviderModelsResponseSchema = z.object({
  changed: z.array(providerRefreshChangeSchema),
  unchanged: z.array(z.string().min(1)),
  failed: z.array(providerRefreshFailureSchema),
  discovered: z.array(discoveredProviderModelsSchema).optional(),
});
export type RefreshProviderModelsResponse = z.infer<
  typeof refreshProviderModelsResponseSchema
>;

export const probeProviderRequestSchema = z.object({
  type: providerWireTypeSchema,
  base_url: z.string().trim().min(1),
  api_key: z.string(),
}).strict();
export type ProbeProviderRequest = z.infer<typeof probeProviderRequestSchema>;

export const probeProviderResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), models: z.array(z.string().min(1)) }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      kind: z.enum(['network', 'unauthorized', 'endpoint', 'other']),
      message: z.string().min(1),
      status: z.number().int().optional(),
    }),
  }),
]);
export type ProbeProviderResponse = z.infer<typeof probeProviderResponseSchema>;

export {
  createModelRequestSchema,
  createProviderRequestSchema,
  getModelResponseSchema,
  patchModelRequestSchema,
  patchProviderRequestSchema,
};
