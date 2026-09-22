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
 * (`revision`) the next PATCH must carry. It never reveals a stored secret —
 * authentication state is reported as `has_api_key`/`status`, not as the key
 * itself.
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

export {
  createModelRequestSchema,
  createProviderRequestSchema,
  getModelResponseSchema,
  patchModelRequestSchema,
  patchProviderRequestSchema,
};
