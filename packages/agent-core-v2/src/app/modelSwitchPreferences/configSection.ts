import { modelSwitchConfigSchema, modelSwitchRuleSchema } from '@kiki/protocol';
import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import { isPlainObject, plainObjectToToml, transformPlainObject } from '#/app/config/toml';

export const MODEL_SWITCH_SECTION = 'modelSwitch';

export const ModelSwitchPreferenceRuleSchema = z.object({
  id: modelSwitchRuleSchema.shape.id,
  enabled: modelSwitchRuleSchema.shape.enabled,
  fromModels: modelSwitchRuleSchema.shape.from_models,
  toModels: modelSwitchRuleSchema.shape.to_models,
  mode: modelSwitchRuleSchema.shape.mode,
  confirm: modelSwitchRuleSchema.shape.confirm,
}).strict();

export const ModelSwitchPreferencesConfigSchema = z.object({
  defaultMode: modelSwitchConfigSchema.shape.default_mode,
  confirm: modelSwitchConfigSchema.shape.confirm,
  rules: z.array(ModelSwitchPreferenceRuleSchema).refine(
    (rules) => new Set(rules.map((rule) => rule.id)).size === rules.length,
    { message: 'Model switch rule IDs must be unique' },
  ).default([]),
}).strict();
export type ModelSwitchPreferencesConfig = z.infer<typeof ModelSwitchPreferencesConfigSchema>;

export function modelSwitchPreferencesFromToml(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const transformed = transformPlainObject(value);
  if (Array.isArray(transformed['rules'])) {
    transformed['rules'] = transformed['rules'].map((rule) => isPlainObject(rule) ? transformPlainObject(rule) : rule);
  }
  return transformed;
}

export function modelSwitchPreferencesToToml(value: unknown, raw: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const transformed = plainObjectToToml(value, raw);
  if (Array.isArray(value['rules'])) {
    transformed['rules'] = value['rules'].map((rule) => isPlainObject(rule) ? plainObjectToToml(rule, {}) : rule);
  }
  return transformed;
}

registerConfigSection(MODEL_SWITCH_SECTION, ModelSwitchPreferencesConfigSchema, {
  defaultValue: { defaultMode: 'direct', confirm: true, rules: [] },
  fromToml: modelSwitchPreferencesFromToml,
  toToml: modelSwitchPreferencesToToml,
});
