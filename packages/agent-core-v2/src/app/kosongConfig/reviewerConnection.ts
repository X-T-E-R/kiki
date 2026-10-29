import type { MoveReviewerKeyResult } from '@kiki/protocol';
import { Error2 } from '#/errors';
import { ConfigTarget, type IConfigService } from '#/app/config/config';
import { withoutUndefined } from '#/app/config/configPure';
import type { PermissionConfig } from '#/agent/permissionRules/configSection';
import type { ProviderConfig, ProvidersSection } from '#/kosong/provider/provider';
import type { IModelCatalogMutationService } from './modelCatalogMutation';

export async function moveReviewerKeyToConnection(config: IConfigService, mutation: IModelCatalogMutationService, connection: string): Promise<MoveReviewerKeyResult> {
  await config.ready;
  const read = () => config.inspect<PermissionConfig>('permission').userValue;
  const permission = structuredClone(read());
  const reviewer = permission?.reviewer;
  const existing = (config.get<ProvidersSection>('providers') ?? {})[connection];
  if (reviewer?.apiKey === undefined) {
    if (reviewer?.source?.kind === 'connection' && reviewer.source.connection === connection && existing !== undefined) return { connection, state: 'complete', retryable: false };
    throw new Error2('config.invalid', 'There is no saved legacy Reviewer key to move');
  }
  const key = reviewer.apiKey;
  const model = reviewer.model ?? 'jev-latest';
  if (existing !== undefined) {
    if (!holdsMovedKey(existing, key, model)) throw new Error2('config.invalid', 'Connection name is already in use; choose another name');
  } else {
    await mutation.createProvider({ id: connection, type: 'system_one', base_url: 'https://api.typesafe.ai/v1', api_key: key, default_model: model });
  }
  const providers = structuredClone(config.inspect<ProvidersSection>('providers').userValue);
  const expectedProviders = withoutUndefined(providers);
  const switched = { ...permission, reviewer: { ...reviewer, source: { kind: 'connection' as const, connection } } };
  try {
    if (!holdsMovedKey(providers?.[connection], key, model)) return { connection, state: 'connection_saved', retryable: true };
    await config.replaceSections({ permission: switched }, ConfigTarget.User, { permission: withoutUndefined(permission), providers: expectedProviders });
  } catch {
    return { connection, state: 'connection_saved', retryable: true };
  }
  try {
    const { apiKey: _moved, ...kept } = switched.reviewer;
    await config.replaceSections({ permission: { ...switched, reviewer: kept } }, ConfigTarget.User, { permission: withoutUndefined(switched), providers: expectedProviders });
    if (read()?.reviewer?.apiKey !== undefined) return { connection, state: 'source_switched', retryable: true };
    return { connection, state: 'complete', retryable: false };
  } catch {
    return { connection, state: 'source_switched', retryable: true };
  }
}

function holdsMovedKey(provider: ProviderConfig | undefined, key: string, model: string): boolean {
  return provider !== undefined && provider.type === 'system_one' && provider.baseUrl === 'https://api.typesafe.ai/v1' && provider.apiKey === key && provider.defaultModel === model && provider.oauth === undefined && provider.customHeaders === undefined && provider.decisionEndpoint === undefined && provider.apiKeyEnv === undefined && provider.env === undefined;
}
