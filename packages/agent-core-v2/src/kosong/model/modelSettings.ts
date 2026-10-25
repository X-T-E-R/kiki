import { Error2 } from '#/_base/errors/errors';
import { CONFIG_INVALID_ERROR_CODE } from '#/kosong/contract/errors';

import type { ModelRecord } from './model';

const CONNECTION_FIELDS = new Set([
  'providerId', 'provider', 'model', 'name', 'aliases', 'protocol',
  'baseUrl', 'apiKey', 'oauth', 'requestIdentity', 'pricingModel', 'betaApi',
  'provider_id', 'base_url', 'api_key', 'request_identity', 'pricing_model', 'beta_api',
]);

export function mergeModelSettings(parent: Record<string, unknown>, child: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(parent);
  for (const [key, value] of Object.entries(child)) {
    if (value !== undefined) result[key] = isRecord(value) && isRecord(result[key])
      ? mergeModelSettings(result[key], value) : structuredClone(value);
  }
  return result;
}

export function applyModelSettings(record: ModelRecord, settings?: Record<string, unknown>): ModelRecord {
  if (settings === undefined) return record;
  const rejected = Object.keys(settings).filter((key) => settings[key] !== undefined && CONNECTION_FIELDS.has(key));
  if (isRecord(settings['overrides'])) {
    for (const [key, value] of Object.entries(settings['overrides'])) {
      if (value !== undefined && CONNECTION_FIELDS.has(key)) rejected.push(`overrides.${key}`);
    }
  }
  if (rejected.length > 0) {
    throw new Error2(
      CONFIG_INVALID_ERROR_CODE,
      `Model settings cannot override connection fields: ${rejected.join(', ')}. Set them on the model itself.`,
      { details: { fields: rejected } },
    );
  }
  const result = mergeModelSettings(record, settings) as ModelRecord;
  if (result.overrides !== undefined) {
    result.overrides = { ...result.overrides };
    removeDeclaredKeys(result.overrides as Record<string, unknown>, settings);
  }
  return result;
}

function removeDeclaredKeys(target: Record<string, unknown>, declared: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(declared)) {
    if (isRecord(value) && isRecord(target[key])) removeDeclaredKeys(target[key], value);
    else delete target[key];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
