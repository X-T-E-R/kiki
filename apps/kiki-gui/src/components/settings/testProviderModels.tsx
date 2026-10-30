import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useConnection } from '../../state/connection';
import { ModelDetailSplit, ProviderModelList } from './ModelsSection';

/**
 * Test harness: every connection's model list, the way Providers & accounts
 * mounts them, without the provider form around each one. Model-editor tests
 * open a model through this exactly as a person does from its connection.
 */
export function ProviderModelsHarness() {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const modelsQuery = useQuery({ queryKey: ['models'], queryFn: () => client.listModels(), staleTime: 60_000 });
  const providersQuery = useQuery({ queryKey: ['providers'], queryFn: () => client.listProviders(), staleTime: 60_000 });
  const models = modelsQuery.data?.items ?? [];
  const providerIds = [...new Set(models.map((model) => model.provider_id))];
  const refresh = async () => {
    await Promise.all(['models', 'providers', 'config', 'generation-entity'].map((key) =>
      queryClient.invalidateQueries({ queryKey: [key] })));
  };
  const list = (
    <div data-test-provider-models>
      {modelsQuery.isError ? <p>{String(modelsQuery.error)}</p> : null}
      {providerIds.map((providerId) => (
        <ProviderModelList key={providerId} providerId={providerId} models={models} />
      ))}
    </div>
  );
  return <ModelDetailSplit list={list} models={models} providers={providersQuery.data?.items ?? []}
    ready={modelsQuery.isSuccess} onChanged={refresh} />;
}
