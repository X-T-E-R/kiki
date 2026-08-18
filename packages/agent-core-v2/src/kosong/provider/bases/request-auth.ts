/**
 * `kosong/provider` domain — per-request auth resolution for the bases.
 *
 * A base caches a construction-time client when an apiKey is available; a
 * per-request `ProviderRequestAuth` (OAuth token, extra headers) rebuilds the
 * client for that call. Runtime request headers are merged last, while the
 * reserved `x-kiki-*` namespace is removed from config/auth inputs.
 * `requireProviderApiKey` is the single "no credential" failure — it never
 * invents a key from a vendor-specific source.
 */

import { ChatProviderError } from '#/kosong/contract/errors';
import type { ProviderRequestAuth } from '#/kosong/contract/provider';

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
  const headers = mergeRequestHeaders(undefined, auth?.headers, runtimeHeaders);
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
