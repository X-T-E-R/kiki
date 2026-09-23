/**
 * Provider credentials are persisted beside `config.toml` in a companion
 * `credentials.toml` so the main file never carries a secret. This module owns
 * the split/merge rules; the read path in `toml.ts` overlays the credentials
 * document on the config document and the write path peels secrets back out.
 *
 * The rules intentionally mirror the engine's `app/config/credentials.ts`
 * (same file name, same snake_case TOML paths, same secret-key predicate, same
 * "credentials win" overlay) so a `config.toml`/`credentials.toml` pair stays
 * consistent whether it is read by the SDK or by the engine.
 */
import { dirname, join } from 'pathe';

export const CREDENTIALS_FILE_NAME = 'credentials.toml';

/**
 * Reserved key names whose values are secrets. The comparison strips `_`/`-`
 * and lowercases, then matches by suffix, so `api_key`, `x-api-key`,
 * `OPENAI_API_KEY`, `access_token`, `client_secret`, `Authorization` and
 * `proxy-authorization` all match while `bearer_token_env_var` (an env-var
 * name, not a secret) does not. Must stay identical to the engine's
 * `app/config/credentials.ts#isSecretKey`.
 */
export function isSecretKey(key: string): boolean {
  const normalized = key.replaceAll(/[_-]/g, '').toLowerCase();
  return (
    normalized.endsWith('apikey') ||
    normalized.endsWith('accesskey') ||
    normalized.endsWith('token') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('password') ||
    normalized.endsWith('authorization') ||
    normalized === 'privatekey'
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The credentials file that belongs to `config.toml`, in the same directory. */
export function credentialsPathFor(configPath: string): string {
  return join(dirname(configPath), CREDENTIALS_FILE_NAME);
}

interface SplitValue {
  readonly publicValue?: unknown;
  readonly secretValue?: unknown;
}

function splitValue(value: unknown): SplitValue {
  if (Array.isArray(value)) {
    const entries = value.map(splitValue);
    if (!entries.some((entry) => entry.secretValue !== undefined)) return { publicValue: value };
    return {
      publicValue: entries.map((entry) => entry.publicValue ?? {}),
      secretValue: entries.map((entry) => entry.secretValue ?? {}),
    };
  }
  if (!isPlainObject(value)) return { publicValue: value };
  const publicValue: Record<string, unknown> = {};
  const secretValue: Record<string, unknown> = {};
  let hasSecret = false;
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) {
      secretValue[key] = entry;
      hasSecret = true;
      continue;
    }
    const split = splitValue(entry);
    if (split.secretValue !== undefined) {
      secretValue[key] = split.secretValue;
      hasSecret = true;
    }
    if (split.publicValue !== undefined) publicValue[key] = split.publicValue;
  }
  // Only a subtree that actually contains a secret is rebuilt. A secret-free
  // subtree is returned verbatim so empty tables (`options = {}`,
  // `custom_headers = {}`) survive the split instead of being dropped.
  if (!hasSecret) return { publicValue: value };
  return {
    publicValue: Object.keys(publicValue).length > 0 ? publicValue : undefined,
    secretValue,
  };
}

/**
 * Split one TOML document into its non-secret part (safe for `config.toml`)
 * and its secret part (destined for `credentials.toml`). Nesting and key
 * spelling are preserved, so re-merging the two yields the original document.
 */
export function splitConfigCredentials(data: Record<string, unknown>): {
  readonly config: Record<string, unknown>;
  readonly credentials: Record<string, unknown>;
} {
  const result = splitValue(data);
  return {
    config: (result.publicValue ?? {}) as Record<string, unknown>,
    credentials: (result.secretValue ?? {}) as Record<string, unknown>,
  };
}

/**
 * Deep-merge `credentials` over `config` at identical TOML paths: a credential
 * present in both files wins. This is the read-side overlay that makes
 * `credentials.toml` authoritative for secret keys.
 */
export function mergeConfigCredentials(
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
): Record<string, unknown> {
  const merge = (base: unknown, override: unknown): unknown => {
    if (Array.isArray(base) && Array.isArray(override)) {
      return base.map((item, index) => (index < override.length ? merge(item, override[index]) : item));
    }
    if (!isPlainObject(base) || !isPlainObject(override)) return override;
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      result[key] = key in result ? merge(result[key], value) : value;
    }
    return result;
  };
  return merge(config, credentials) as Record<string, unknown>;
}
