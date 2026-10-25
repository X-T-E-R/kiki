import { OAuthConnectionError, OAuthUnauthorizedError, RetryableRefreshError } from '@kiki/oauth';
import { describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import { IOAuthService } from '#/app/auth/auth';
import { ModelOAuthTokenAdapter } from '#/app/kosongConfig/oauthTokenAdapter';
import { IModelOAuthTokens } from '#/kosong/model/modelOAuth';
import { Error2, ErrorCodes, toErrorPayload } from '#/errors';

function setup(getAccessToken: () => Promise<string>) {
  const ix = new TestInstantiationService();
  ix.stub(IOAuthService, {
    resolveTokenProvider: () => ({ getAccessToken }),
  });
  ix.set(IModelOAuthTokens, new SyncDescriptor(ModelOAuthTokenAdapter));
  return { ix, tokens: ix.get(IModelOAuthTokens) };
}

const oauthRef = { storage: 'file', key: 'example-provider' } as const;

describe('ModelOAuthTokenAdapter', () => {
  it('uses a valid token and forwards forced refresh without changing it', async () => {
    const getAccessToken = vi.fn(async () => 'example-access-token');
    const { ix, tokens } = setup(getAccessToken);
    try {
      await expect(tokens.getAccessToken('example-provider', oauthRef, { force: true })).resolves.toBe('example-access-token');
      expect(getAccessToken).toHaveBeenCalledWith({ force: true });
    } finally { await ix.dispose(); }
  });

  it.each([
    [new OAuthUnauthorizedError('No token'), ErrorCodes.AUTH_LOGIN_REQUIRED, false],
    [new OAuthConnectionError('Connection failed'), ErrorCodes.PROVIDER_CONNECTION_ERROR, true],
    [new RetryableRefreshError('Refresh busy'), ErrorCodes.PROVIDER_CONNECTION_ERROR, true],
  ] as const)('classifies token failures for every prompt caller (%s)', async (cause, code, retryable) => {
    const { ix, tokens } = setup(async () => { throw cause; });
    try {
      const error = await tokens.getAccessToken('example-provider', oauthRef).catch((error: unknown) => error);
      expect(toErrorPayload(error)).toMatchObject({ code, retryable, details: { provider: 'example-provider' }, cause: { message: cause.message } });
    } finally { await ix.dispose(); }
  });

  it.each([new Error('Storage is locked'), new Error2(ErrorCodes.AUTH_LOGIN_REQUIRED, 'Already classified')])('preserves unknown and already coded errors (%s)', async (error) => {
    const { ix, tokens } = setup(async () => { throw error; });
    try {
      await expect(tokens.getAccessToken('example-provider', oauthRef)).rejects.toBe(error);
    } finally { await ix.dispose(); }
  });

  it('rejects a missing token provider as login required', async () => {
    const ix = new TestInstantiationService();
    ix.stub(IOAuthService, { resolveTokenProvider: () => undefined });
    ix.set(IModelOAuthTokens, new SyncDescriptor(ModelOAuthTokenAdapter));
    try {
      await expect(ix.get(IModelOAuthTokens).getAccessToken('example-provider', oauthRef)).rejects.toMatchObject({ code: ErrorCodes.AUTH_LOGIN_REQUIRED, details: { provider: 'example-provider' } });
    } finally { await ix.dispose(); }
  });

  it('rejects an empty token as login required', async () => {
    const { ix, tokens } = setup(async () => ' ');
    try {
      await expect(tokens.getAccessToken('example-provider', oauthRef)).rejects.toMatchObject({ code: ErrorCodes.AUTH_LOGIN_REQUIRED, details: { provider: 'example-provider' } });
    } finally { await ix.dispose(); }
  });
});
