import { isPlainObject } from './configPure';

type TomlValue = Record<string, unknown>;

function isSecretKey(key: string): boolean {
  const normalized = key.replaceAll(/[_-]/g, '').toLowerCase();
  return normalized.endsWith('apikey')
    || normalized.endsWith('accesskey')
    || normalized.endsWith('token')
    || normalized.endsWith('secret')
    || normalized.endsWith('password')
    || normalized.endsWith('authorization')
    || normalized === 'privatekey';
}

function splitValue(value: unknown): { publicValue?: unknown; secretValue?: unknown } {
  if (Array.isArray(value)) {
    const entries = value.map(splitValue);
    if (!entries.some((entry) => entry.secretValue !== undefined)) return { publicValue: value };
    return {
      publicValue: entries.map((entry) => entry.publicValue ?? {}),
      secretValue: entries.map((entry) => entry.secretValue ?? {}),
    };
  }
  if (!isPlainObject(value)) return { publicValue: value };
  const publicValue: TomlValue = {};
  const secretValue: TomlValue = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretKey(key)) {
      secretValue[key] = entry;
      continue;
    }
    const split = splitValue(entry);
    if (split.publicValue !== undefined) publicValue[key] = split.publicValue;
    if (split.secretValue !== undefined) secretValue[key] = split.secretValue;
  }
  return {
    publicValue: Object.keys(publicValue).length > 0 || Object.keys(value).length === 0 ? publicValue : undefined,
    secretValue: Object.keys(secretValue).length > 0 ? secretValue : undefined,
  };
}

export function splitConfigCredentials(data: TomlValue): { config: TomlValue; credentials: TomlValue } {
  const result = splitValue(data);
  return {
    config: (result.publicValue ?? {}) as TomlValue,
    credentials: (result.secretValue ?? {}) as TomlValue,
  };
}

export function mergeConfigCredentials(config: TomlValue, credentials: TomlValue): TomlValue {
  const merge = (base: unknown, override: unknown): unknown => {
    if (Array.isArray(base) && Array.isArray(override)) {
      return base.map((item, index) => index < override.length ? merge(item, override[index]) : item);
    }
    if (!isPlainObject(base) || !isPlainObject(override)) return override;
    const result: TomlValue = { ...base };
    for (const [key, value] of Object.entries(override)) {
      result[key] = key in result ? merge(result[key], value) : value;
    }
    return result;
  };
  return merge(config, credentials) as TomlValue;
}
