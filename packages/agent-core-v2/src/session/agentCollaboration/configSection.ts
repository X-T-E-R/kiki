import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const AGENTS_SECTION = 'agents';

export const AgentsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  defaultSubagentModel: z.string().trim().min(1).optional(),
  defaultSubagentReasoningEffort: z.string().trim().min(1).optional(),
}).strict();

export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

registerConfigSection(AGENTS_SECTION, AgentsConfigSchema, {
  defaultValue: { enabled: true },
});
