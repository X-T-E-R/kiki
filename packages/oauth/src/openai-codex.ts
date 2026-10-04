/**
 * ChatGPT (Codex) sign-in — a port of the headless device-code path in
 * pi-mono's `auth/oauth/openai-codex.ts` (MIT, Copyright (c) 2025 Mario
 * Zechner), cross-checked against OpenAI's own `codex-rs/login`
 * (Apache-2.0): same issuer, client id, device endpoints and account-id claim.
 *
 * Flow: POST `deviceauth/usercode` → the user enters the code at
 * `auth.openai.com/codex/device` → polling `deviceauth/token` yields an
 * authorization code plus the PKCE verifier the server generated → a normal
 * `authorization_code` exchange returns access/refresh/id tokens. Refresh is
 * the standard `refresh_token` grant against the same token endpoint.
 *
 * Inference speaks the OpenAI Responses protocol at
 * `chatgpt.com/backend-api/codex` with `chatgpt-account-id` taken from the
 * access token's `https://api.openai.com/auth` claim.
 */

import { OAuthError, OAuthUnauthorizedError } from './errors';
import type { DevicePollResult } from './oauth';
import {
  decodeJwtPayload,
  type OAuthDeviceMethod,
  type OAuthMethodDescriptor,
  type OAuthMethodModel,
} from './oauth-method-types';
import type { DeviceAuthorization, TokenInfo } from './types';
import { isRecord } from './utils';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE_URL = 'https://auth.openai.com';
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';

export const OPENAI_CODEX_METHOD: OAuthMethodDescriptor = {
  id: 'openai-codex',
  label: 'ChatGPT',
  providerName: 'managed:openai-codex',
  protocol: 'openai_responses',
  defaultBaseUrl: DEFAULT_BASE_URL,
  oauthKey: 'oauth/openai-codex',
  aliasPrefix: 'openai-codex',
};

/**
 * Models a ChatGPT plan exposes to Codex clients. Mirrors the listed
 * (`visibility: list`) entries of codex-rs `models-manager/models.json`; the
 * backend has no stable public listing endpoint for third-party clients.
 */
export const OPENAI_CODEX_MODELS: readonly OAuthMethodModel[] = [
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    contextLength: 272_000,
    capabilities: ['thinking', 'tool_use', 'image_in'],
    supportEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
  },
];

/** The ChatGPT account id Codex requests must carry, or undefined. */
export function openaiCodexAccountId(accessToken: string): string | undefined {
  const claim = decodeJwtPayload(accessToken)?.[JWT_CLAIM_PATH];
  if (!isRecord(claim)) return undefined;
  const accountId = claim['chatgpt_account_id'];
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function tokenFromResponse(data: unknown, operation: 'exchange' | 'refresh', priorRefresh?: string): TokenInfo {
  if (!isRecord(data)) throw new OAuthError(`ChatGPT token ${operation} returned no JSON body.`);
  const accessToken = data['access_token'];
  const refreshToken = typeof data['refresh_token'] === 'string' && data['refresh_token'].length > 0
    ? data['refresh_token'] : priorRefresh;
  const now = Math.floor(Date.now() / 1000);
  const exp = typeof accessToken === 'string' ? decodeJwtPayload(accessToken)?.['exp'] : undefined;
  const expiresIn = data['expires_in'] === undefined
    ? (typeof exp === 'number' ? exp - now : 3600) : Number(data['expires_in']);
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new OAuthError(`ChatGPT token ${operation} response is missing access_token.`);
  }
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new OAuthError(`ChatGPT token ${operation} response is missing refresh_token.`);
  }
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new OAuthError(`ChatGPT token ${operation} response is missing expires_in.`);
  }
  if (openaiCodexAccountId(accessToken) === undefined) {
    throw new OAuthError('The ChatGPT token does not carry an account id; sign in with a ChatGPT plan account.');
  }
  return {
    accessToken,
    refreshToken,
    idToken: typeof data['id_token'] === 'string' && data['id_token'].length > 0 ? data['id_token'] : undefined,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    scope: typeof data['scope'] === 'string' ? data['scope'] : '',
    tokenType: typeof data['token_type'] === 'string' ? data['token_type'] : 'Bearer',
    expiresIn,
  };
}

export function createOpenAICodexMethod(fetchImpl: typeof fetch = fetch): OAuthDeviceMethod {
  /** device_code carries `<device_auth_id>\n<user_code>`: both are needed to poll. */
  const requestDevice = async (): Promise<DeviceAuthorization> => {
    const response = await fetchImpl(DEVICE_USER_CODE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) {
      throw new OAuthError('ChatGPT device sign-in is not enabled for this account.');
    }
    const data = await readJson(response);
    if (!response.ok || !isRecord(data)) {
      throw new OAuthError(`ChatGPT device authorization failed (HTTP ${response.status}).`);
    }
    const deviceAuthId = data['device_auth_id'];
    const userCode = data['user_code'];
    const interval = typeof data['interval'] === 'string' ? Number(data['interval']) : data['interval'];
    if (typeof deviceAuthId !== 'string' || deviceAuthId.length === 0
      || typeof userCode !== 'string' || userCode.length === 0) {
      throw new OAuthError('ChatGPT device authorization response is missing fields.');
    }
    return {
      deviceCode: `${deviceAuthId}\n${userCode}`,
      userCode,
      verificationUri: DEVICE_VERIFICATION_URI,
      verificationUriComplete: DEVICE_VERIFICATION_URI,
      expiresIn: DEVICE_CODE_TIMEOUT_SECONDS,
      interval: typeof interval === 'number' && Number.isFinite(interval) && interval > 0 ? interval : 5,
    };
  };

  const exchangeCode = async (code: string, verifier: string): Promise<TokenInfo> => {
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: DEVICE_REDIRECT_URI,
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await readJson(response);
    if (!response.ok) {
      throw new OAuthError(`ChatGPT token exchange failed (HTTP ${response.status}).`);
    }
    return tokenFromResponse(data, 'exchange');
  };

  const pollDevice = async (deviceCode: string): Promise<DevicePollResult> => {
    const [deviceAuthId, userCode] = deviceCode.split('\n');
    const response = await fetchImpl(DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      const data = await readJson(response);
      const code = isRecord(data) ? data['authorization_code'] : undefined;
      const verifier = isRecord(data) ? data['code_verifier'] : undefined;
      if (typeof code !== 'string' || typeof verifier !== 'string') {
        throw new OAuthError('ChatGPT device token response is missing the authorization code.');
      }
      return { kind: 'success', token: await exchangeCode(code, verifier) };
    }
    if (response.status === 403 || response.status === 404) {
      return { kind: 'pending', errorCode: 'authorization_pending', description: '' };
    }
    const data = await readJson(response);
    const raw = isRecord(data) ? data['error'] : undefined;
    const errorCode = isRecord(raw) ? raw['code'] : raw;
    if (errorCode === 'deviceauth_authorization_pending') {
      return { kind: 'pending', errorCode: 'authorization_pending', description: '' };
    }
    if (errorCode === 'slow_down') {
      return { kind: 'pending', errorCode: 'slow_down', description: '' };
    }
    if (errorCode === 'access_denied') return { kind: 'denied', description: '' };
    if (errorCode === 'expired_token' || errorCode === 'deviceauth_expired') return { kind: 'expired' };
    throw new OAuthError(`ChatGPT device sign-in failed (HTTP ${response.status}).`);
  };

  const refresh = async (refreshToken: string): Promise<TokenInfo> => {
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await readJson(response);
    const rawError = isRecord(data) ? data['error'] : undefined;
    const errorCode = isRecord(rawError) ? rawError['code'] : rawError ?? (isRecord(data) ? data['code'] : undefined);
    const permanent = typeof errorCode === 'string'
      && ['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'].includes(errorCode);
    if (response.status === 401 || response.status === 403 || permanent) {
      throw new OAuthUnauthorizedError('ChatGPT rejected the refresh token; sign in again.');
    }
    if (!response.ok) {
      throw new OAuthError(`ChatGPT token refresh failed (HTTP ${response.status}).`);
    }
    return tokenFromResponse(data, 'refresh', refreshToken);
  };

  const requestHeaders = (accessToken: string): Record<string, string> => {
    const accountId = openaiCodexAccountId(accessToken);
    return {
      originator: 'kiki',
      'OpenAI-Beta': 'responses=experimental',
      ...(accountId === undefined ? {} : { 'chatgpt-account-id': accountId }),
    };
  };

  return {
    ...OPENAI_CODEX_METHOD,
    requestDevice,
    pollDevice,
    refresh,
    baseUrlFor: () => DEFAULT_BASE_URL,
    requestHeaders,
    listModels: () => Promise.resolve(OPENAI_CODEX_MODELS),
  };
}
