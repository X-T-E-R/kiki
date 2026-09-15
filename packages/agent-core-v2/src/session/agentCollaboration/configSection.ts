import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import { collectRemovedKeyDiagnostics } from '#/app/config/deprecations';

export const AGENTS_SECTION = 'agents';

export const AgentsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  delegation: z
    .object({
      sub: z.boolean().optional(),
      independent: z.boolean().optional(),
    })
    .strict()
    .optional(),
}).strict();

export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

const REMOVED_AGENTS_KEYS = [
  'default_subagent_model',
  'default_subagent_reasoning_effort',
] as const;

registerConfigSection(AGENTS_SECTION, AgentsConfigSchema, {
  defaultValue: { enabled: true },
  collectDiagnostics: (rawSection) =>
    collectRemovedKeyDiagnostics(AGENTS_SECTION, rawSection, REMOVED_AGENTS_KEYS),
});
