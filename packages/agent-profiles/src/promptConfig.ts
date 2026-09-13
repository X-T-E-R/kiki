import { z } from 'zod';

import { renderPrompt } from './renderPrompt';

export const RESERVED_PROMPT_VARIABLES = new Set([
  'role_additional', 'product_name', 'reply_style_guide', 'os', 'windows_notes',
  'shell', 'now', 'cwd', 'cwd_listing', 'agents_md', 'additional_dirs_info',
  'additional_dirs_section', 'skills', 'skills_section', 'plugin_sections',
  'base_prompt', 'parent_prompt', 'builtin_prompt', '__proto__', 'constructor', 'prototype',
]);

const variableName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine((name) => !RESERVED_PROMPT_VARIABLES.has(name), 'Built-in prompt variable names are reserved.');

export const PromptConfigPatchSchema = z.object({
  shared: z.string().optional(),
  variables: z.unknown().superRefine((value, ctx) => {
    if (typeof value === 'object' && value !== null && Object.hasOwn(value, '__proto__')) {
      ctx.addIssue({ code: 'custom', message: 'Built-in prompt variable names are reserved.' });
    }
  }).pipe(z.record(variableName, z.string())).optional(),
  tools: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/), z.string()).optional(),
}).strict();

/** Validates a complete prompt section after merging a patch. Shared/tool references must name configured variables; variable values remain literal, non-recursive text. */
export const PromptConfigSchema = PromptConfigPatchSchema.superRefine((config, ctx) => {
  const templates: Array<{ text: string; path: string[] }> = [
    { text: config.shared ?? '', path: ['shared'] },
    ...Object.entries(config.tools ?? {}).map(([name, text]) => ({ text, path: ['tools', name] })),
  ];
  for (const { text, path } of templates) {
    for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      const name = match[1]!;
      if (!Object.hasOwn(config.variables ?? {}, name)) {
        ctx.addIssue({ code: 'custom', path, message: `Unknown prompt variable: ${name}. Define it in prompt.variables; only configured variables are available here.` });
      }
    }
  }
});

export type PromptConfig = z.infer<typeof PromptConfigSchema>;

export function customPromptVariables(variables: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(variables ?? {}).filter(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED_PROMPT_VARIABLES.has(name) && typeof value === 'string'));
}

/** Browser-safe preview of configured additions, shared with native request rendering. It excludes base prompts and capability descriptions; profile templates receive variables through AgentProfileContext.promptVariables. */
export function previewPromptConfig(config: PromptConfig | undefined): { shared: string; tools: Record<string, string> } {
  const variables = customPromptVariables(config?.variables);
  return {
    shared: renderPrompt(config?.shared ?? '', variables),
    tools: Object.fromEntries(Object.entries(config?.tools ?? {}).map(([name, text]) => [name, renderPrompt(text, variables)])),
  };
}

/** Append once in the common final profile projection (all executors) or an explicit request override, never inside nested profile rendering. */
export function appendSharedPrompt(base: string, config: PromptConfig | undefined): string {
  const shared = previewPromptConfig(config).shared;
  return shared.length === 0 ? base : `${base}\n\n${shared}`;
}

export function supplementToolDescription(name: string, description: string, config: PromptConfig | undefined): string {
  const supplement = previewPromptConfig(config).tools[name];
  return supplement === undefined || supplement.length === 0 ? description : `${description}\n\nUser-configured guidance:\n${supplement}`;
}
