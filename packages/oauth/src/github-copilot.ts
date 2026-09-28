/**
 * GitHub Copilot sign-in — a port of pi-mono's `auth/oauth/github-copilot.ts`
 * (MIT, Copyright (c) 2025 Mario Zechner), adapted to `OAuthManager`.
 *
 * Flow: RFC 8628 device code against github.com with the Copilot editor
 * client id, then the GitHub OAuth token is exchanged for a short-lived
 * Copilot API token at `api.github.com/copilot_internal/v2/token`. The GitHub
 * token never expires, so it is stored as the refresh token and every
 * "refresh" is a fresh exchange. The Copilot token encodes its API host
 * (`proxy-ep=`), which becomes the provider base URL.
 *
 * Inference speaks OpenAI chat completions (Responses for models that only
 * expose `/responses`) with the editor headers Copilot requires.
 */

import { OAuthError, OAuthUnauthorizedError } from './errors';
import type { DevicePollResult } from './oauth';
import {
  assertWebUrl,
  type OAuthDeviceMethod,
  type OAuthMethodDescriptor,
  type OAuthMethodModel,
} from './oauth-method-types';
import type { DeviceAuthorization, TokenInfo } from './types';
import { isRecord } from './utils';

const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const GITHUB_DOMAIN = 'github.com';
const DEVICE_CODE_URL = `https://${GITHUB_DOMAIN}/login/device/code`;
const ACCESS_TOKEN_URL = `https://${GITHUB_DOMAIN}/login/oauth/access_token`;
const COPILOT_TOKEN_URL = `https://api.${GITHUB_DOMAIN}/copilot_internal/v2/token`;
const DEFAULT_BASE_URL = 'https://api.individual.githubcopilot.com';
const COPILOT_API_VERSION = '2026-06-01';
const DEFAULT_CONTEXT = 128_000;

/** Editor identity Copilot's API requires on every request. */
export const GITHUB_COPILOT_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
};

export const GITHUB_COPILOT_METHOD: OAuthMethodDescriptor = {
  id: 'github-copilot',
  label: 'GitHub Copilot',
  providerName: 'managed:github-copilot',
  protocol: 'openai',
  defaultBaseUrl: DEFAULT_BASE_URL,
  oauthKey: 'oauth/github-copilot',
  aliasPrefix: 'github-copilot',
};

/** `proxy-ep=proxy.individual.githubcopilot.com` → `https://api.individual.githubcopilot.com`. */
export function githubCopilotBaseUrlFromToken(token: string): string {
  const match = /(?:^|;)proxy-ep=([^;]+)/.exec(token);
  const host = match?.[1]?.replace(/^proxy\./, 'api.');
  if (host === undefined || !/^api\.[a-z0-9-]+\.githubcopilot\.com$/i.test(host)) return DEFAULT_BASE_URL;
  return `https://${host}`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export function createGitHubCopilotMethod(fetchImpl: typeof fetch = fetch): OAuthDeviceMethod {
  const post = (url: string, body: Record<string, string>) =>
    fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': GITHUB_COPILOT_HEADERS['User-Agent'] ?? 'GitHubCopilotChat',
      },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(30_000),
    });

  const requestDevice = async (): Promise<DeviceAuthorization> => {
    const response = await post(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: 'read:user' });
    const data = await readJson(response);
    if (!response.ok || !isRecord(data)) {
      throw new OAuthError(`GitHub device authorization failed (HTTP ${response.status}).`);
    }
    const deviceCode = data['device_code'];
    const userCode = data['user_code'];
    if (typeof deviceCode !== 'string' || typeof userCode !== 'string') {
      throw new OAuthError('GitHub device authorization response is missing fields.');
    }
    const verificationUri = assertWebUrl(data['verification_uri'], 'GitHub verification_uri');
    return {
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete: verificationUri,
      expiresIn: typeof data['expires_in'] === 'number' ? data['expires_in'] : null,
      interval: typeof data['interval'] === 'number' ? data['interval'] : 5,
    };
  };

  const exchange = async (githubToken: string): Promise<TokenInfo> => {
    const response = await fetchImpl(COPILOT_TOKEN_URL, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${githubToken}`,
        ...GITHUB_COPILOT_HEADERS,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new OAuthUnauthorizedError(
        'GitHub rejected the Copilot token exchange — the account has no active Copilot access or the sign-in was revoked.',
      );
    }
    const data = await readJson(response);
    if (!response.ok || !isRecord(data)) {
      throw new OAuthError(`Copilot token exchange failed (HTTP ${response.status}).`);
    }
    const token = data['token'];
    const expiresAt = data['expires_at'];
    if (typeof token !== 'string' || token.length === 0 || typeof expiresAt !== 'number') {
      throw new OAuthError('Copilot token response is missing fields.');
    }
    const now = Math.floor(Date.now() / 1000);
    return {
      accessToken: token,
      refreshToken: githubToken,
      expiresAt,
      scope: 'read:user',
      tokenType: 'Bearer',
      expiresIn: Math.max(1, expiresAt - now),
    };
  };

  const pollDevice = async (deviceCode: string): Promise<DevicePollResult> => {
    const response = await post(ACCESS_TOKEN_URL, {
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    const data = await readJson(response);
    if (!isRecord(data)) {
      throw new OAuthError(`GitHub device token polling failed (HTTP ${response.status}).`);
    }
    const accessToken = data['access_token'];
    if (typeof accessToken === 'string' && accessToken.length > 0) {
      return { kind: 'success', token: await exchange(accessToken) };
    }
    const error = typeof data['error'] === 'string' ? data['error'] : 'unknown_error';
    const description = typeof data['error_description'] === 'string' ? data['error_description'] : '';
    switch (error) {
      case 'authorization_pending':
      case 'slow_down':
        return { kind: 'pending', errorCode: error, description };
      case 'expired_token':
        return { kind: 'expired' };
      case 'access_denied':
        return { kind: 'denied', description };
      default:
        throw new OAuthError(`GitHub device flow failed: ${error}${description ? ` — ${description}` : ''}`);
    }
  };

  const requestHeaders = (): Record<string, string> => ({
    ...GITHUB_COPILOT_HEADERS,
    'X-GitHub-Api-Version': COPILOT_API_VERSION,
    'Openai-Intent': 'conversation-edits',
  });

  const listModels = async (accessToken: string): Promise<readonly OAuthMethodModel[]> => {
    const baseUrl = githubCopilotBaseUrlFromToken(accessToken);
    const response = await fetchImpl(`${baseUrl}/models`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...requestHeaders(),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new OAuthUnauthorizedError('Copilot rejected the model list request.');
    }
    const data = await readJson(response);
    if (!response.ok || !isRecord(data) || !Array.isArray(data['data'])) {
      throw new OAuthError(`Copilot model list failed (HTTP ${response.status}).`);
    }
    return parseGitHubCopilotModels(data['data'], baseUrl === DEFAULT_BASE_URL);
  };

  return {
    ...GITHUB_COPILOT_METHOD,
    requestDevice,
    pollDevice,
    refresh: exchange,
    baseUrlFor: githubCopilotBaseUrlFromToken,
    requestHeaders,
    listModels,
  };
}

/**
 * Keep enabled chat models with tool calls; Individual accounts may return no
 * picker-enabled models, so fall back to explicitly enabled policies there.
 * Models that only expose `/responses` route over Responses.
 */
export function parseGitHubCopilotModels(items: readonly unknown[], individual = false): OAuthMethodModel[] {
  const models: OAuthMethodModel[] = [];
  const seen = new Set<string>();
  const pickerEnabled = items.some((item) => isRecord(item) && item['model_picker_enabled'] === true
    && (!isRecord(item['policy']) || item['policy']['state'] !== 'disabled'));
  const policyFallback = individual && !pickerEnabled;
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = item['id'];
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    const policy = isRecord(item['policy']) ? item['policy'] : {};
    if (policyFallback ? policy['state'] !== 'enabled'
      : item['model_picker_enabled'] !== true || policy['state'] === 'disabled') continue;
    const capabilities = isRecord(item['capabilities']) ? item['capabilities'] : {};
    if (capabilities['type'] !== undefined && capabilities['type'] !== 'chat') continue;
    const supports = isRecord(capabilities['supports']) ? capabilities['supports'] : {};
    if (supports['tool_calls'] === false) continue;
    const limits = isRecord(capabilities['limits']) ? capabilities['limits'] : {};
    const context = firstPositive(limits['max_context_window_tokens'], limits['max_prompt_tokens']);
    const efforts = Array.isArray(supports['reasoning_effort'])
      ? supports['reasoning_effort'].filter((effort): effort is string => typeof effort === 'string')
      : [];
    const caps = ['tool_use'];
    if (efforts.length > 0 || supports['adaptive_thinking'] === true) caps.push('thinking');
    if (supports['vision'] === true) caps.push('image_in');
    const endpoints = Array.isArray(item['supported_endpoints']) ? item['supported_endpoints'] : [];
    const responsesOnly = endpoints.includes('/responses') && !endpoints.includes('/chat/completions');
    seen.add(id);
    models.push({
      id,
      displayName: typeof item['name'] === 'string' ? item['name'] : undefined,
      contextLength: context ?? DEFAULT_CONTEXT,
      capabilities: caps,
      supportEfforts: efforts.length > 0 ? efforts : undefined,
      protocol: responsesOnly ? 'openai_responses' : undefined,
    });
  }
  return models;
}

function firstPositive(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}
