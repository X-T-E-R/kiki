import { ModelRecordSchema, modelsFromToml } from '#/app/kosongConfig/configSection';
import type { ModelRecord } from '#/kosong/model/model';

export const RecipeModelSettingsSchema = ModelRecordSchema.omit({
  providerId: true, baseUrl: true, apiKey: true, oauth: true, protocol: true,
  name: true, aliases: true, provider: true, model: true, pricingModel: true,
  betaApi: true, recipe: true, cognition: true, promptOverrides: true,
  requestIdentity: true, overrides: true,
}).extend({
  parameters: ModelRecordSchema.shape.parameters.unwrap().strict().optional(),
  images: ModelRecordSchema.shape.images.unwrap().strict().optional(),
}).strict();

export function recipeModelSettingsFromToml(value: unknown): Record<string, unknown> {
  const converted = modelsFromToml({ recipe: value }) as Record<string, unknown>;
  return RecipeModelSettingsSchema.parse(converted['recipe']);
}

export function mergeRecipeModelSettings(parent: Record<string, unknown>, child: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(parent);
  for (const [key, value] of Object.entries(child)) {
    if (value !== undefined) result[key] = isRecord(value) && isRecord(result[key])
      ? mergeRecipeModelSettings(result[key], value) : structuredClone(value);
  }
  return result;
}

export function applyRecipeModelSettings(record: ModelRecord, settings?: Record<string, unknown>): ModelRecord {
  if (settings === undefined) return record;
  const validated = RecipeModelSettingsSchema.parse(settings);
  const result = mergeRecipeModelSettings(record, validated) as ModelRecord;
  if (result.overrides !== undefined) {
    result.overrides = { ...result.overrides };
    removeDeclaredKeys(result.overrides as Record<string, unknown>, validated);
  }
  return result;
}

export function recipeModelLeaves(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, leaf]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return isRecord(leaf) && !('kind' in leaf) ? recipeModelLeaves(leaf, path) : [path];
  });
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
