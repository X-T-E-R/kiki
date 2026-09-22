/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Event2 } from '#/app/event/event2';

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

export const discoveredModelSchema = z.object({
  remote_id: z.string().min(1),
  display_name: z.string().optional(),
  max_context_size: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  support_efforts: z.array(z.string()).optional(),
});
export type DiscoveredModel = z.infer<typeof discoveredModelSchema>;

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

export const refreshProviderModelsResponseSchema = z.object({
  changed: z.array(providerRefreshChangeSchema),
  unchanged: z.array(z.string().min(1)),
  failed: z.array(providerRefreshFailureSchema),
  discovered: z.array(discoveredProviderModelsSchema).optional(),
});
export type RefreshProviderModelsResponse = z.infer<
  typeof refreshProviderModelsResponseSchema
>;

export type RefreshProviderModelsScope = 'all' | 'oauth';

export class ModelCatalogChanged extends Event2<{
  readonly payload: RefreshProviderModelsResponse;
}> {
  static override readonly type = 'event.model_catalog.changed';
}
export interface ModelCatalogChanged {
  readonly payload: RefreshProviderModelsResponse;
}

export interface RefreshProviderModelsOptions {
  readonly scope?: RefreshProviderModelsScope;
  readonly providerId?: string;
}

export interface IProviderDiscoveryService {
  readonly _serviceBrand: undefined;

  listDiscoveredModels(): Promise<ListDiscoveredModelsResponse>;

  refreshProviderModels(
    options?: RefreshProviderModelsOptions,
  ): Promise<RefreshProviderModelsResponse>;
}

export const IProviderDiscoveryService: ServiceIdentifier<IProviderDiscoveryService> =
  createDecorator<IProviderDiscoveryService>('providerDiscovery');
