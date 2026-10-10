import type { ModelRecord } from './model';

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
