import type { ConfigEffectiveOverlay } from '#/app/config/config';
import { registerConfigOverlay } from '#/app/config/configOverlayContributions';
import {
  CREDENTIALS_POOL_SECTION,
  resolvePoolCredential,
  type CredentialPoolEntry,
  type CredentialsPoolSection,
} from '#/app/config/credentialPool';
import { isPlainObject } from '#/app/config/configPure';
import type { ProviderConfig, ProvidersSection } from '#/kosong/provider/provider';

import { PROVIDERS_SECTION } from './configSection';

/** Resolves `credential_id` references on providers against the named `[credentials.<id>]` pool. */
export function resolveProvidersWithCredentialPool(
  providers: ProvidersSection,
  credentials: CredentialsPoolSection,
  getEnv: (name: string) => string | undefined = (name) => process.env[name],
  readKeyring?: (service: string, account: string) => string | undefined,
): ProvidersSection {
  let changed = false;
  const out: Record<string, ProviderConfig> = { ...providers };
  for (const [name, provider] of Object.entries(providers)) {
    if (provider.credentialId === undefined) continue;
    const poolEntry = credentials[provider.credentialId];
    if (poolEntry === undefined) continue;
    const resolved = resolvePoolCredential(poolEntry, getEnv, readKeyring);
    const next: ProviderConfig = { ...provider };
    let entryChanged = false;
    if ((next.apiKey === undefined || next.apiKey.length === 0) && resolved.apiKey !== undefined) {
      next.apiKey = resolved.apiKey;
      entryChanged = true;
    }
    if (next.apiKeyEnv === undefined && resolved.apiKeyEnv !== undefined) {
      next.apiKeyEnv = resolved.apiKeyEnv;
      entryChanged = true;
    }
    if (entryChanged) {
      out[name] = next;
      changed = true;
    }
  }
  return changed ? out : providers;
}

export const credentialPoolOverlay: ConfigEffectiveOverlay = {
  apply(effective, getEnv, validate) {
    const rawProviders = effective[PROVIDERS_SECTION];
    const rawCredentials = effective[CREDENTIALS_POOL_SECTION];
    if (!isPlainObject(rawProviders) || !isPlainObject(rawCredentials)) return [];
    const providers = rawProviders as ProvidersSection;
    const credentials = rawCredentials as Record<string, CredentialPoolEntry>;
    const resolved = resolveProvidersWithCredentialPool(providers, credentials, getEnv);
    if (resolved === providers) return [];
    effective[PROVIDERS_SECTION] = validate(PROVIDERS_SECTION, resolved);
    return [PROVIDERS_SECTION];
  },

  strip(domain, value, rawSnake) {
    if (domain !== PROVIDERS_SECTION || !isPlainObject(value)) return value;
    const rawProviders = isPlainObject(rawSnake[PROVIDERS_SECTION]) ? rawSnake[PROVIDERS_SECTION] : {};
    let modified = false;
    const out: Record<string, unknown> = { ...value };
    for (const [name, entry] of Object.entries(value)) {
      if (!isPlainObject(entry) || typeof entry['credentialId'] !== 'string') continue;
      const rawEntry = isPlainObject(rawProviders[name]) ? rawProviders[name] : {};
      const next = { ...entry };
      let entryModified = false;
      if (rawEntry['api_key'] === undefined && next['apiKey'] !== undefined) {
        delete next['apiKey'];
        entryModified = true;
      }
      if (rawEntry['api_key_env'] === undefined && next['apiKeyEnv'] !== undefined) {
        delete next['apiKeyEnv'];
        entryModified = true;
      }
      if (entryModified) {
        out[name] = next;
        modified = true;
      }
    }
    return modified ? out : value;
  },
};

registerConfigOverlay(credentialPoolOverlay);
