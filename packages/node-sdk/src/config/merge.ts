import { ErrorCodes, KimiError } from '../errors';
import {
  KimiConfigPatchSchema,
  formatConfigValidationError,
  type KimiConfig,
  type KimiConfigPatch,
  validateConfig,
} from './schema';

export function mergeConfigPatch(config: KimiConfig, patch: KimiConfigPatch): KimiConfig {
  const base = validateConfig(config);
  const parsedPatch = parsePatch(patch);
  const merged = deepMerge(base, parsedPatch);
  return validateConfig(merged);
}

function parsePatch(patch: KimiConfigPatch): KimiConfigPatch {
  try {
    return stripUndefinedDeep(KimiConfigPatchSchema.parse(patch)) as KimiConfigPatch;
  } catch (error) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, `Invalid configuration patch: ${formatConfigValidationError(error)}`, {
      cause: error,
    });
  }
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    if (sourceValue === undefined) continue;
    const targetValue = result[key];
    if (key === 'nbSearch' && isPlainObject(sourceValue)) {
      result[key] = mergeCanonicalPatch(isPlainObject(targetValue) ? targetValue : {}, sourceValue);
    } else if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      result[key] = deepMerge(targetValue, sourceValue);
    } else {
      result[key] = sourceValue;
    }
  }
  return result;
}

function mergeCanonicalPatch(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    if (sourceValue === null) {
      delete result[key];
    } else if (isPlainObject(sourceValue)) {
      result[key] = mergeCanonicalPatch(
        isPlainObject(result[key]) ? result[key] : {},
        sourceValue,
      );
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue;
    }
  }
  return result;
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefinedDeep);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (entryValue !== undefined) {
      out[key] = stripUndefinedDeep(entryValue);
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
