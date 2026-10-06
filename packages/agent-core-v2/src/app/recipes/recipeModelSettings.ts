import { ModelRecordSchema, modelsFromToml } from '#/app/kosongConfig/configSection';
import type { ModelRecord } from '#/kosong/model/model';
import { effectiveModelConfig } from '#/kosong/model/modelAuth';
import { applyModelSettings } from '#/kosong/model/modelSettings';

export { mergeModelSettings as mergeRecipeModelSettings } from '#/kosong/model/modelSettings';

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

export function applyRecipeModelSettings(record: ModelRecord, settings?: Record<string, unknown>): ModelRecord {
  return applyModelSettings(record, settings === undefined ? undefined : RecipeModelSettingsSchema.parse(settings));
}

export function snapshotRecipeModelSettings(record: ModelRecord, settings: Record<string, unknown>): Record<string, unknown> {
  const effective = effectiveModelConfig(applyRecipeModelSettings(record, settings));
  return RecipeModelSettingsSchema.parse(Object.fromEntries(Object.keys(RecipeModelSettingsSchema.shape).flatMap((key) => {
    const value = effective[key as keyof ModelRecord];
    return value === undefined ? [] : [[key, value]];
  })));
}

export function recipeModelLeaves(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, leaf]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return isRecord(leaf) && !('kind' in leaf) ? recipeModelLeaves(leaf, path) : [path];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
