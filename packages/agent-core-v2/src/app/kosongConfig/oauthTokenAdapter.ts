import { OAuthConnectionError, OAuthUnauthorizedError, RetryableRefreshError } from '@kiki/oauth';

import { LifecycleScope } from '#/app/scopes';
import { ProtocolErrors } from '#/kosong/protocol/errors';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';

import { IOAuthService } from '#/app/auth/auth';
import { AuthErrors } from '#/app/auth/errors';
import { nonEmpty } from '#/kosong/model/modelAuth';
import { IModelOAuthTokens } from '#/kosong/model/modelOAuth';
import type { OAuthRef } from '#/kosong/provider/provider';

export class ModelOAuthTokenAdapter implements IModelOAuthTokens {
  declare readonly _serviceBrand: undefined;

  constructor(@IOAuthService private readonly oauth: IOAuthService) {}

  async hasCachedAccessToken(provider: string, oauthRef: OAuthRef): Promise<boolean> {
    try {
      const token = await this.oauth.getCachedAccessToken(provider, oauthRef);
      return nonEmpty(token) !== undefined;
    } catch {
      return false;
    }
  }

  async getAccessToken(
    provider: string,
    oauthRef: OAuthRef,
    options?: { readonly force?: boolean },
  ): Promise<string> {
    const tokenProvider = this.oauth.resolveTokenProvider(provider, oauthRef);
    if (tokenProvider === undefined) throw loginRequired(provider);
    try {
      const token = await tokenProvider.getAccessToken(
        options?.force === true ? { force: true } : undefined,
      );
      if (token.trim().length === 0) throw loginRequired(provider);
      return token;
    } catch (error) {
      if (error instanceof OAuthUnauthorizedError) throw loginRequired(provider, error);
      if (error instanceof OAuthConnectionError || error instanceof RetryableRefreshError) {
        throw new Error2(ProtocolErrors.codes.PROVIDER_CONNECTION_ERROR, `OAuth provider "${provider}" failed to fetch an access token.`, {
          cause: error,
          details: { provider },
        });
      }
      throw error;
    }
  }
}

function loginRequired(provider: string, cause?: unknown): Error2 {
  return new Error2(
    AuthErrors.codes.AUTH_LOGIN_REQUIRED,
    `OAuth provider "${provider}" requires login before it can be used.`,
    { cause, details: { provider } },
  );
}

registerScopedService(
  LifecycleScope.App,
  IModelOAuthTokens,
  ModelOAuthTokenAdapter,
  ScopeActivation.OnScopeCreated,
  'kosongConfig',
);
