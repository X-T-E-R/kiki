import { z } from 'zod';

import { PromptOverridesSchema } from './promptOverrides';

export const RESERVED_PROMPT_VARIABLES = new Set([
  'role_additional', 'product_name', 'reply_style_guide', 'os', 'windows_notes',
  'shell', 'now', 'cwd', 'cwd_listing', 'agents_md', 'additional_dirs_info',
  'additional_dirs_section', 'skills', 'skills_section', 'plugin_sections',
  'base_prompt', 'parent_prompt', 'builtin_prompt', '__proto__', 'constructor', 'prototype',
]);

const variableName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine((name) => !RESERVED_PROMPT_VARIABLES.has(name), 'Built-in prompt variable names are reserved.');

export const PromptConfigPatchSchema = z.object({
  variables: z.unknown().superRefine((value, ctx) => {
    if (typeof value === 'object' && value !== null && Object.hasOwn(value, '__proto__')) {
      ctx.addIssue({ code: 'custom', message: 'Built-in prompt variable names are reserved.' });
    }
  }).pipe(z.record(variableName, z.string())).optional(),
  overrides: PromptOverridesSchema.optional(),
}).strict();

export const PromptConfigSchema = PromptConfigPatchSchema;

export type PromptConfig = z.infer<typeof PromptConfigSchema>;

export function customPromptVariables(variables: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(variables ?? {}).filter(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED_PROMPT_VARIABLES.has(name) && typeof value === 'string'));
}
