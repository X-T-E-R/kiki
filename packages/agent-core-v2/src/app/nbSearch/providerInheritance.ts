import type { CanonicalConfig } from '@nb-corp/nb-search';

import type { IConfigService } from '#/app/config/config';
import { CREDENTIALS_POOL_SECTION, resolvePoolCredential, type CredentialsPoolSection } from '#/app/config/credentialPool';
import { PROVIDERS_SECTION } from '#/app/kosongConfig/configSection';
import type { ProviderConfig, ProvidersSection } from '#/kosong/provider/provider';

type ProviderInstance = CanonicalConfig['provider_instances'][string];

/** Extracts the normalized HTTP(S) origin from a URL string, or undefined when missing or non-HTTP(S). */
export function nbSearchOriginOf(rawUrl: string | undefined): string | undefined {
  if (rawUrl === undefined) return undefined;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || !URL.canParse(trimmed)) return undefined;
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed.origin.toLowerCase();
}

function resolvePoolKey(credentials: CredentialsPoolSection | undefined, id: string | undefined): string | undefined {
  if (credentials === undefined || id === undefined) return undefined;
  const entry = credentials[id];
  if (entry === undefined) return undefined;
  const resolved = resolvePoolCredential(entry);
  const key = resolved.apiKey?.trim();
  return key !== undefined && key.length > 0 ? key : undefined;
}

function resolveProviderKey(
  providerId: string,
  provider: ProviderConfig,
  credentials: CredentialsPoolSection | undefined,
): string | undefined {
  const direct = provider.apiKey?.trim();
  if (direct !== undefined && direct.length > 0) return direct;
  const envName = provider.apiKeyEnv?.trim();
  if (envName !== undefined && envName.length > 0) {
    const envVal = process.env[envName]?.trim();
    if (envVal !== undefined && envVal.length > 0) return envVal;
  }
  const fromRef = resolvePoolKey(credentials, provider.credentialId?.trim());
  if (fromRef !== undefined) return fromRef;
  return resolvePoolKey(credentials, providerId);
}

function namedProviderSuffix(instanceId: string): string | undefined {
  const dot = instanceId.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const tail = instanceId.slice(dot + 1).trim();
  return tail.length > 0 ? tail : undefined;
}

/** Resolves an inherited API key for an nb-search instance strictly from a same-origin Kiki provider entry. */
export function resolveInheritedNbSearchKey(
  instanceId: string,
  instance: ProviderInstance,
  kikiConfig: IConfigService,
): string | undefined {
  const targetOrigin = nbSearchOriginOf(instance.base_url);
  if (targetOrigin === undefined) return undefined;
  const providers = kikiConfig.get<ProvidersSection | undefined>(PROVIDERS_SECTION);
  if (providers === undefined) return undefined;
  const credentials = kikiConfig.get<CredentialsPoolSection | undefined>(CREDENTIALS_POOL_SECTION);
  const suffix = namedProviderSuffix(instanceId);

  if (suffix !== undefined) {
    if (!Object.hasOwn(providers, suffix)) return undefined;
    const candidate = providers[suffix]!;
    if (nbSearchOriginOf(candidate.baseUrl) !== targetOrigin) return undefined;
    return resolveProviderKey(suffix, candidate, credentials);
  }

  for (const [providerId, provider] of Object.entries(providers)) {
    if (nbSearchOriginOf(provider.baseUrl) !== targetOrigin) continue;
    const key = resolveProviderKey(providerId, provider, credentials);
    if (key !== undefined) return key;
  }

  return undefined;
}
