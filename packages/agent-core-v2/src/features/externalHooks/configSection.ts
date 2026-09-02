import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import { isPlainObject, plainObjectToToml, transformPlainObject } from '#/app/config/toml';

import { compileHookMatcher, HOOK_EVENT_TYPES } from './internal/types';

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

export const HooksConfigSchema = z.array(HookDefSchema);

export const hooksFromToml = (rawSnake: unknown): unknown => {
  if (!Array.isArray(rawSnake)) return rawSnake;
  return rawSnake.map((hook) => (isPlainObject(hook) ? transformPlainObject(hook) : hook));
};

export const hooksToToml = (value: unknown, _rawSnake: unknown): unknown => {
  if (!Array.isArray(value)) return value;
  return value.map((hook) => (isPlainObject(hook) ? plainObjectToToml(hook, undefined) : hook));
};

registerConfigSection(HOOKS_SECTION, HooksConfigSchema, {
  fromToml: hooksFromToml,
  toToml: hooksToToml,
});
