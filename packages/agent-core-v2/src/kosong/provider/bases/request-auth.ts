import { ChatProviderError } from '#/kosong/contract/errors';
import type { ProviderRequestAuth } from '#/kosong/contract/provider';
import {
  SUPPRESS_REQUEST_IDENTITY_HEADER,
  SUPPRESS_USER_AGENT_HEADER,
} from '#/kosong/requestIdentity/requestIdentityProjector';
import { REQUEST_IDENTITY_RESERVED_HEADERS } from '#/kosong/requestIdentity/requestIdentityPolicy';

export function requireProviderApiKey(
  providerName: string,
  auth: ProviderRequestAuth | undefined,
  defaultApiKey?: string,
): string {
  const apiKey = auth?.apiKey ?? defaultApiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new ChatProviderError(
      `${providerName}: apiKey is required. Provide it via the constructor options, the provider's API-key environment variable, options.auth.apiKey on each request, or an OAuth login.`,
    );
  }
  return apiKey;
}

export function mergeRequestHeaders(
  defaultHeaders: Readonly<Record<string, string>> | undefined,
  requestHeaders: Readonly<Record<string, string>> | undefined,
  runtimeHeaders?: Readonly<Record<string, string>>,
): Record<string, string> | undefined {
  const merged = new Map<string, [string, string]>();
  const merge = (
    headers: Readonly<Record<string, string>> | undefined,
    allowReserved: boolean,
  ): void => {
    if (headers === undefined) return;
    for (const [key, value] of Object.entries(headers)) {
      const normalized = key.toLowerCase();
      if (!allowReserved && normalized.startsWith('x-kiki-')) continue;
      merged.set(normalized, [key, value]);
    }
  };
  merge(defaultHeaders, false);
  merge(requestHeaders, false);
  merge(runtimeHeaders, true);
  return merged.size > 0 ? Object.fromEntries(merged.values()) : undefined;
}

export function mergeProviderRequestAuth(
  auth: ProviderRequestAuth | undefined,
  runtimeHeaders: Readonly<Record<string, string>> | undefined,
): ProviderRequestAuth | undefined {
  const headers = mergeRequestHeaders(undefined, auth?.headers, {
    ...runtimeHeaders, ...requiredOAuthHeaders(boundOAuthHeaders(auth)),
  });
  if (auth === undefined && headers === undefined) return undefined;
  return { ...auth, headers };
}

export function resolveAuthBackedClient<TClient>(
  state: {
    readonly cachedClient: TClient | undefined;
    readonly clientFactory: ((auth: ProviderRequestAuth) => TClient) | undefined;
  },
  auth: ProviderRequestAuth | undefined,
  build: (auth: ProviderRequestAuth | undefined) => TClient,
): TClient {
  if (state.clientFactory !== undefined) {
    return state.clientFactory(auth ?? {});
  }
  if (auth === undefined && state.cachedClient !== undefined) {
    return state.cachedClient;
  }
  return build(auth);
}

const OAUTH_AUTH_HEADERS = [
  'authorization', 'chatgpt-account-id', 'x-xai-token-auth', 'x-authenticateresponse', 'x-userid',
] as const;

function boundOAuthHeaders(auth: ProviderRequestAuth | undefined): Headers | undefined {
  if (!auth?.apiKey || auth.headers === undefined) return undefined;
  const headers = new Headers(auth.headers);
  if (headers.get('authorization') !== `Bearer ${auth.apiKey}`) return undefined;
  return headers.has('chatgpt-account-id') || headers.get('x-xai-token-auth') === 'xai-grok-cli'
    ? headers : undefined;
}

function requiredOAuthHeaders(headers: Headers | undefined): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const required: Record<string, string> = {};
  for (const name of OAUTH_AUTH_HEADERS) {
    const value = headers.get(name);
    if (value !== null) required[name] = value;
  }
  return required;
}

export const requestIdentityFetch: typeof fetch = (input, init) => fetchWithRequestIdentity(input, init);

export function requestIdentityFetchForAuth(auth: ProviderRequestAuth | undefined): typeof fetch {
  const oauthHeaders = boundOAuthHeaders(auth);
  return (input, init) => fetchWithRequestIdentity(input, init, oauthHeaders);
}

async function fetchWithRequestIdentity(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  oauthHeaders?: Headers,
): Promise<Response> {
  const request = new Request(input, { ...init, redirect: 'error' });
  if (!request.headers.has(SUPPRESS_REQUEST_IDENTITY_HEADER) && !request.headers.has(SUPPRESS_USER_AGENT_HEADER) && oauthHeaders === undefined) return globalThis.fetch(request);
  return globalThis.fetch(new Request(request, { headers: finalizeHeaders(request.headers, oauthHeaders), redirect: 'error' }));
}

export function finalizeProviderRequestHeaders(input: ConstructorParameters<typeof Headers>[0], auth?: ProviderRequestAuth): Headers {
  return finalizeHeaders(input, boundOAuthHeaders(auth));
}

function finalizeHeaders(input: ConstructorParameters<typeof Headers>[0], oauthHeaders?: Headers): Headers {
  const headers = new Headers(input);
  const suppressIdentity = headers.has(SUPPRESS_REQUEST_IDENTITY_HEADER);
  const suppressUserAgent = suppressIdentity || headers.has(SUPPRESS_USER_AGENT_HEADER);
  headers.delete(SUPPRESS_USER_AGENT_HEADER);
  headers.delete(SUPPRESS_REQUEST_IDENTITY_HEADER);
  if (suppressUserAgent) headers.delete('user-agent');
  if (suppressIdentity) {
    for (const name of REQUEST_IDENTITY_RESERVED_HEADERS) headers.delete(name);
    const names: string[] = [];
    headers.forEach((_value, name) => names.push(name));
    for (const name of names) {
      if (name.startsWith('x-msh-')) headers.delete(name);
    }
  }
  for (const [name, value] of Object.entries(requiredOAuthHeaders(oauthHeaders) ?? {})) headers.set(name, value);
  if (oauthHeaders?.get('x-xai-token-auth') === 'xai-grok-cli') {
    headers.delete('x-api-key');
    if (!headers.get('x-grok-client-version')) {
      const version = oauthHeaders.get('x-grok-client-version');
      if (version !== null) headers.set('x-grok-client-version', version);
    }
  }
  return headers;
}
