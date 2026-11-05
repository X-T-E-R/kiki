import type { PluginModelCatalog } from '@kiki/protocol';

import type { IModelCatalog } from '#/kosong/model/catalog';

export async function pluginModelCatalog(catalog: IModelCatalog): Promise<PluginModelCatalog> {
  const [models, providers] = await Promise.all([catalog.listModels(), catalog.listProviders()]);
  return {
    models: models.map((model) => ({
      id: model.id,
      provider_id: model.provider_id,
      remote_id: model.remote_id,
      display_name: model.display_name,
      max_context_size: model.max_context_size,
      effective_capabilities: model.effective_capabilities === undefined ? undefined : [...model.effective_capabilities],
      effective_protocol: model.effective_protocol,
    })),
    connections: providers.map((provider) => ({
      id: provider.id,
      type: provider.type,
      status: provider.status,
      service: provider.decision_protocol !== undefined ? 'decision' : provider.service ?? 'chat',
      default_model: provider.default_model,
      models: provider.models === undefined ? undefined : [...provider.models],
      authentication: provider.oauth !== undefined ? 'oauth' : provider.has_api_key ? 'api-key' : 'none',
    })),
  };
}
