import { credentialPoolKindSchema, credentialSyncPolicySchema, type CredentialPoolKind, type CredentialSyncPolicy } from '@kiki/protocol';
import { z } from 'zod';

import { registerConfigSection } from './configSectionContributions';
import { camelToSnake, cloneRecord, isPlainObject, setDefined, snakeToCamel } from './toml';

export type { CredentialPoolKind, CredentialSyncPolicy };

export const CREDENTIALS_POOL_SECTION = 'credentials';

export const CredentialPoolEntrySchema = z.object({
  kind: credentialPoolKindSchema.optional(),
  syncPolicy: credentialSyncPolicySchema.optional(),
  apiKey: z.string().min(1).optional(),
  secret: z.string().min(1).optional(),
  envVar: z.string().trim().min(1).optional(),
  keyringService: z.string().trim().min(1).optional(),
  keyringAccount: z.string().trim().min(1).optional(),
  label: z.string().max(128).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  revision: z.string().min(1).max(128).optional(),
});

export type CredentialPoolEntry = z.infer<typeof CredentialPoolEntrySchema>;

export const CredentialsPoolSectionSchema = z.record(
  z.string().regex(/^[a-zA-Z0-9._-]+$/),
  CredentialPoolEntrySchema,
);

export type CredentialsPoolSection = z.infer<typeof CredentialsPoolSectionSchema>;

/** Resolves the effective sync policy for a credential entry, defaulting fail-closed to `machine`. */
export function effectiveCredentialSyncPolicy(
  entry: Pick<CredentialPoolEntry, 'kind' | 'syncPolicy'>,
): CredentialSyncPolicy {
  if (entry.syncPolicy !== undefined) return entry.syncPolicy;
  if (entry.kind === 'oauth') return 'machine';
  return 'machine';
}

/** Returns whether a credential entry is authorized for encrypted cross-machine secret sync. */
export function isCredentialEligibleForEncryptedSync(entry: CredentialPoolEntry): boolean {
  if (entry.kind === 'oauth' && entry.syncPolicy !== 'synced') return false;
  if (effectiveCredentialSyncPolicy(entry) !== 'synced') return false;
  return (entry.apiKey !== undefined && entry.apiKey.length > 0) || (entry.secret !== undefined && entry.secret.length > 0);
}

/** Resolved credential material for a provider referencing `credential_id`. */
export interface ResolvedPoolCredential {
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly source: 'inline_pool' | 'env_ref' | 'keyring_ref' | 'unresolved';
}

/** Resolves concrete secret material from a named `[credentials.<id>]` pool entry. */
export function resolvePoolCredential(
  entry: CredentialPoolEntry,
  getEnv: (name: string) => string | undefined = (name) => process.env[name],
  readKeyring?: (service: string, account: string) => string | undefined,
): ResolvedPoolCredential {
  const direct = entry.apiKey ?? entry.secret;
  if (direct !== undefined && direct.length > 0) {
    return { apiKey: direct, source: 'inline_pool' };
  }
  if (entry.envVar !== undefined && entry.envVar.length > 0) {
    const envVal = getEnv(entry.envVar);
    return {
      apiKey: envVal !== undefined && envVal.length > 0 ? envVal : undefined,
      apiKeyEnv: entry.envVar,
      source: 'env_ref',
    };
  }
  if (
    entry.keyringAccount !== undefined &&
    entry.keyringAccount.length > 0 &&
    readKeyring !== undefined
  ) {
    const val = readKeyring(entry.keyringService ?? 'kiki-credentials', entry.keyringAccount);
    if (val !== undefined && val.length > 0) {
      return { apiKey: val, source: 'keyring_ref' };
    }
  }
  return { source: 'unresolved' };
}

export const credentialsPoolFromToml = (rawSnake: unknown): unknown => {
  if (!isPlainObject(rawSnake)) return rawSnake;
  const out: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(rawSnake)) {
    if (!isPlainObject(entry)) {
      out[id] = entry;
      continue;
    }
    const converted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      converted[snakeToCamel(key)] = value;
    }
    out[id] = converted;
  }
  return out;
};

export const credentialsPoolToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (!isPlainObject(value)) return value;
  const rawSub = cloneRecord(rawSnake);
  const out: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      out[id] = entry;
      continue;
    }
    const merged = cloneRecord(rawSub[id]);
    for (const [key, field] of Object.entries(entry)) {
      setDefined(merged, camelToSnake(key), field);
    }
    out[id] = merged;
  }
  return out;
};

registerConfigSection(CREDENTIALS_POOL_SECTION, CredentialsPoolSectionSchema, {
  defaultValue: {},
  syncScope: 'machine',
  fromToml: credentialsPoolFromToml,
  toToml: credentialsPoolToToml,
  entryKeyed: CredentialPoolEntrySchema,
});
