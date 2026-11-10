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
  return mapHooksV2Keys(rawSnake, false);
};

export const hooksToToml = (value: unknown, _rawSnake: unknown): unknown => {
  if (Array.isArray(value)) return value.map((hook) => isPlainObject(hook) ? plainObjectToToml(hook, undefined) : hook);
  return mapHooksV2Keys(value, true);
};

function convertRecordKeys(value: Record<string, unknown>, toToml: boolean): Record<string, unknown> {
  return toToml ? plainObjectToToml(value, undefined) : transformPlainObject(value);
}

function mapHookMatchKeys(value: unknown, toToml: boolean): unknown {
  if (!isPlainObject(value)) return value;
  const converted = convertRecordKeys(value, toToml);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(converted)) {
    if ((key === 'toolArgMatches' || key === 'tool_arg_matches') && isPlainObject(entry)) {
      out[key] = structuredClone(entry);
    } else {
      out[key] = entry;
    }
  }
  return out;
}

function mapHookRuleKeys(value: unknown, toToml: boolean): unknown {
  if (!isPlainObject(value)) return value;
  const converted = convertRecordKeys(value, toToml);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(converted)) {
    if (key === 'match') {
      out[key] = mapHookMatchKeys(entry, toToml);
    } else if ((key === 'cadence' || key === 'action') && isPlainObject(entry)) {
      out[key] = convertRecordKeys(entry, toToml);
    } else {
      out[key] = entry;
    }
  }
  return out;
}

function mapHooksV2Keys(value: unknown, toToml: boolean): unknown {
  if (!isPlainObject(value)) return value;
  const converted = convertRecordKeys(value, toToml);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(converted)) {
    if (key === 'rules' && Array.isArray(entry)) {
      out[key] = entry.map((rule) => mapHookRuleKeys(rule, toToml));
    } else if (key === 'legacy' && Array.isArray(entry)) {
      out[key] = entry.map((hook) => isPlainObject(hook) ? convertRecordKeys(hook, toToml) : hook);
    } else {
      out[key] = entry;
    }
  }
  return out;
}

registerConfigSection(HOOKS_SECTION, HooksConfigSchema, {
  fromToml: hooksFromToml,
  toToml: hooksToToml,
});
