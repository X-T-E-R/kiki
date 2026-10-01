import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import { isPlainObject, plainObjectToToml, transformPlainObject } from '#/app/config/toml';

import { compileHookMatcher, HOOK_EVENT_TYPES } from './internal/types';
import { HookRuleSchema } from './internal/rules';

export const HOOKS_SECTION = 'hooks';

const HookMatcherSchema = z.string().refine((value) => {
  try {
    compileHookMatcher(value);
    return true;
  } catch {
    return false;
  }
}, 'matcher must be a valid regular expression');

export const HookDefSchema = z
  .object({
    event: z.enum(HOOK_EVENT_TYPES),
    matcher: HookMatcherSchema.optional(),
    command: z.string().min(1),
    timeout: z.number().int().min(1).max(600).optional(),
  })
  .strict();

export type HookDefConfig = z.infer<typeof HookDefSchema>;

export const HooksV2ConfigSchema = z.object({
  schemaVersion: z.literal(2),
  enabled: z.boolean().default(true),
  disabled: z.array(z.string()).default([]),
  files: z.array(z.string().min(1)).default([]),
  rules: z.array(HookRuleSchema).default([]),
  legacy: z.array(HookDefSchema).default([]),
}).strict();

export const HooksConfigSchema = z.union([z.array(HookDefSchema), HooksV2ConfigSchema]);
export type HooksV2Config = z.infer<typeof HooksV2ConfigSchema>;
export type HooksConfig = z.infer<typeof HooksConfigSchema>;

export function legacyHooks(value: HooksConfig | undefined): readonly HookDefConfig[] {
  return Array.isArray(value) ? value : value?.legacy ?? [];
}

export const hooksFromToml = (rawSnake: unknown): unknown => {
  if (Array.isArray(rawSnake)) return rawSnake.map((hook) => isPlainObject(hook) ? transformPlainObject(hook) : hook);
  return mapKeys(rawSnake, false);
};

export const hooksToToml = (value: unknown, _rawSnake: unknown): unknown => {
  if (Array.isArray(value)) return value.map((hook) => isPlainObject(hook) ? plainObjectToToml(hook, undefined) : hook);
  return mapKeys(value, true);
};

function mapKeys(value: unknown, toToml: boolean): unknown {
  if (Array.isArray(value)) return value.map((entry) => mapKeys(entry, toToml));
  if (!isPlainObject(value)) return value;
  const converted = toToml ? plainObjectToToml(value, undefined) : transformPlainObject(value);
  return Object.fromEntries(Object.entries(converted).map(([key, entry]) => [key, mapKeys(entry, toToml)]));
}

registerConfigSection(HOOKS_SECTION, HooksConfigSchema, {
  fromToml: hooksFromToml,
  toToml: hooksToToml,
});
