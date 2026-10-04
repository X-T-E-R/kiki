import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { createOAuthDeviceMethod } from '@kiki/oauth';
import type { ProviderRequestAuth } from '#/kosong/contract/provider';

/** Shared account authentication material for configured connection consumers. */
export function oauthRequestAuth(providerKey: string, oauthRef: OAuthRef, apiKey: string): ProviderRequestAuth {
  const method = providerKey === 'managed:openai-codex' || providerKey === 'managed:grok-build'
    ? createOAuthDeviceMethod(providerKey) : undefined;
  return {
    apiKey,
    headers: method === undefined ? undefined : {
      ...method.requestHeaders(apiKey),
      ...(oauthRef.source?.provider === 'grok-build' && providerKey === 'managed:grok-build' ? { 'x-userid': oauthRef.source.accountId } : {}),
      Authorization: `Bearer ${apiKey}`,
    },
  };
}

import type { OAuthRef } from '../provider/provider';

export interface IModelOAuthTokens {
  readonly _serviceBrand: undefined;

  hasCachedAccessToken(provider: string, oauthRef: OAuthRef): Promise<boolean>;
  getAccessToken(
    provider: string,
    oauthRef: OAuthRef,
    options?: { readonly force?: boolean },
  ): Promise<string>;
}

export const IModelOAuthTokens: ServiceIdentifier<IModelOAuthTokens> =
  createDecorator<IModelOAuthTokens>('modelOAuthTokens');
