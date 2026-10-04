/**
 * Device-grant and refresh port adapted from OpenCode's MIT xai.ts plugin
 * (Copyright (c) 2025 opencode). The Grok Build session endpoint, auth marker,
 * and catalog fields follow the original CLI's public protocol, not API keys.
 */
import { OAuthError, OAuthUnauthorizedError } from './errors';
import type { DevicePollResult } from './oauth';
import { assertWebUrl, decodeJwtPayload, type OAuthDeviceMethod, type OAuthMethodDescriptor, type OAuthMethodModel } from './oauth-method-types';
import type { DeviceAuthorization, TokenInfo } from './types';
import { isRecord } from './utils';

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const ISSUER = 'https://auth.x.ai';
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const COMPATIBLE_GROK_VERSION = '1.0.45';

export const GROK_BUILD_METHOD: OAuthMethodDescriptor = {
  id: 'grok-build', label: 'Grok Build', providerName: 'managed:grok-build',
  protocol: 'openai', defaultBaseUrl: BASE_URL, oauthKey: 'oauth/grok-build', aliasPrefix: 'grok-build',
};

function positiveSeconds(value: unknown, fallback: number): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}

function tokenFromResponse(data: unknown, priorRefresh?: string): TokenInfo {
  if (!isRecord(data) || typeof data['access_token'] !== 'string' || data['access_token'].length === 0) {
    throw new OAuthError('Grok token response is missing access_token.');
  }
  const accessToken = data['access_token'];
  const refreshToken = typeof data['refresh_token'] === 'string' && data['refresh_token'].length > 0
    ? data['refresh_token'] : priorRefresh;
  if (!refreshToken) throw new OAuthError('Grok token response is missing refresh_token.');
  const now = Math.floor(Date.now() / 1000);
  const exp = decodeJwtPayload(accessToken)?.['exp'];
  const expiresIn = positiveSeconds(data['expires_in'], typeof exp === 'number' && exp > now ? exp - now : 3600);
  return {
    accessToken, refreshToken, expiresAt: now + expiresIn, expiresIn,
    scope: typeof data['scope'] === 'string' ? data['scope'] : SCOPE,
    tokenType: typeof data['token_type'] === 'string' ? data['token_type'] : 'Bearer',
  };
}

function requestHeaders(accessToken: string): Record<string, string> {
  const claims = decodeJwtPayload(accessToken);
  const principalType = claims?.['principal_type'] ?? claims?.['principalType'];
  const principalId = claims?.['principal_id'] ?? claims?.['principalId'];
  const sub = principalType === 'Team' || principalType === 'Organization' ? principalId : claims?.['sub'];
  const headers: Record<string, string> = {
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-authenticateresponse': 'authenticate-response',
    'x-grok-client-version': COMPATIBLE_GROK_VERSION,
    'x-grok-client-identifier': 'kiki',
    'x-grok-client-mode': 'interactive',
  };
  if (typeof sub === 'string' && sub.length > 0) headers['x-userid'] = sub;
  return headers;
}

/** Read the Build catalog; never project server-supplied credential URLs or secrets into config. */
export function parseGrokBuildModels(payload: unknown): readonly OAuthMethodModel[] {
  if (!isRecord(payload) || !Array.isArray(payload['data'])) return [];
  const models = new Map<string, OAuthMethodModel>();
  for (const row of payload['data']) {
    if (!isRecord(row) || row['hidden'] === true || row['user_selectable'] === false) continue;
    const id = row['model'] ?? row['modelId'] ?? row['id'];
    if (typeof id !== 'string' || id.length === 0) continue;
    const backend = row['apiBackend'] ?? row['api_backend'] ?? 'chat_completions';
    const protocol = backend === 'responses' ? 'openai_responses' : backend === 'messages' ? 'anthropic'
      : backend === 'chat_completions' ? 'openai' : undefined;
    if (protocol === undefined) continue;
    const baseUrl = row['baseUrl'] ?? row['base_url'];
    if (typeof baseUrl === 'string' && baseUrl.replace(/\/$/, '') !== BASE_URL) continue;
    const meta = isRecord(row['_meta']) ? row['_meta'] : {};
    const caps = isRecord(row['capabilities']) ? row['capabilities'] : {};
    const context = row['contextWindow'] ?? row['context_window'] ?? meta['contextWindow'] ?? meta['totalContextTokens'];
    const contextLength = typeof context === 'number' && Number.isSafeInteger(context) && context > 0 ? context : 200_000;
    const menu = row['reasoningEfforts'] ?? row['reasoning_efforts'] ?? caps['reasoning_effort'];
    const efforts = Array.isArray(menu) ? menu.flatMap((item): string[] => {
      const value = typeof item === 'string' ? item : isRecord(item) ? item['value'] : undefined;
      return typeof value === 'string' && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value) ? [value] : [];
    }) : [];
    const marked = Array.isArray(menu) ? menu.find((item) => isRecord(item) && item['default'] === true) : undefined;
    const defaultValue = isRecord(marked) ? marked['value'] : caps['default_reasoning_effort'];
    const capabilities = ['tool_use'];
    if (row['supports_reasoning_effort'] === true || row['supportsReasoningEffort'] === true || efforts.length > 0) capabilities.push('thinking');
    if (caps['vision'] === true) capabilities.push('image_in');
    models.set(id, { id, displayName: typeof row['name'] === 'string' ? row['name'] : id,
      contextLength, capabilities, protocol, supportEfforts: efforts.length > 0 ? [...new Set(efforts)] : undefined,
      defaultEffort: typeof defaultValue === 'string' && efforts.includes(defaultValue) ? defaultValue : undefined });
  }
  return [...models.values()];
}

export function createGrokBuildMethod(fetchImpl: typeof fetch = fetch): OAuthDeviceMethod {
  const post = (url: string, fields: Record<string, string>): Promise<Response> => fetchImpl(url, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields).toString(), signal: AbortSignal.timeout(30_000),
  });
  const requestDevice = async (): Promise<DeviceAuthorization> => {
    const response = await post(`${ISSUER}/oauth2/device/code`, { client_id: CLIENT_ID, scope: SCOPE, referrer: 'kiki' });
    const data = await readJson(response);
    if (!response.ok || !isRecord(data)) throw new OAuthError(`Grok device authorization failed (HTTP ${response.status}).`);
    if (typeof data['device_code'] !== 'string' || data['device_code'].length === 0
      || typeof data['user_code'] !== 'string' || !/^[A-Za-z0-9-]+$/.test(data['user_code'])) {
      throw new OAuthError('Grok device authorization response is missing valid fields.');
    }
    const verificationUri = assertWebUrl(data['verification_uri'], 'Grok verification URI');
    return { deviceCode: data['device_code'], userCode: data['user_code'], verificationUri,
      verificationUriComplete: data['verification_uri_complete'] === undefined ? verificationUri
        : assertWebUrl(data['verification_uri_complete'], 'Grok complete verification URI'),
      expiresIn: positiveSeconds(data['expires_in'], 300), interval: positiveSeconds(data['interval'], 5) };
  };
  const pollDevice = async (deviceCode: string): Promise<DevicePollResult> => {
    const response = await post(TOKEN_URL, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: CLIENT_ID, device_code: deviceCode });
    const data = await readJson(response);
    if (response.ok) return { kind: 'success', token: tokenFromResponse(data) };
    const code = isRecord(data) ? data['error'] : undefined;
    if (code === 'authorization_pending' || code === 'slow_down') return { kind: 'pending', errorCode: code, description: '' };
    if (code === 'access_denied' || code === 'authorization_denied') return { kind: 'denied', description: '' };
    if (code === 'expired_token') return { kind: 'expired' };
    throw new OAuthError(`Grok device token exchange failed (HTTP ${response.status}).`);
  };
  const refresh: OAuthDeviceMethod['refresh'] = async (refreshToken, context) => {
    const response = await post(TOKEN_URL, { grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refreshToken,
      ...(context?.principalType ? { principal_type: context.principalType } : {}),
      ...(context?.principalId ? { principal_id: context.principalId } : {}),
    });
    const data = await readJson(response);
    if (response.status === 401 || response.status === 403 || (isRecord(data) && data['error'] === 'invalid_grant')) {
      throw new OAuthUnauthorizedError('Grok rejected the refresh token; sign in again.');
    }
    if (!response.ok) throw new OAuthError(`Grok token refresh failed (HTTP ${response.status}).`);
    return tokenFromResponse(data, refreshToken);
  };
  const listModels = async (accessToken: string): Promise<readonly OAuthMethodModel[]> => {
    const response = await fetchImpl(`${BASE_URL}/models`, {
      headers: { ...requestHeaders(accessToken), Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new OAuthError(`Grok Build model catalog failed (HTTP ${response.status}).`);
    const models = parseGrokBuildModels(await readJson(response));
    if (models.length === 0) throw new OAuthError('Grok Build returned no usable models for this account.');
    return models;
  };
  return { ...GROK_BUILD_METHOD, requestDevice, pollDevice, refresh, requestHeaders, listModels, baseUrlFor: () => BASE_URL };
}
