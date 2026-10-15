import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const COMPUTER_CONFIG_SECTION = 'computerControl';
export const ComputerUsagePreferenceSchema = z.enum(['avoid', 'prefer']);
export type ComputerUsagePreference = z.infer<typeof ComputerUsagePreferenceSchema>;
export const ComputerConfigSchema = z.object({
  usagePreference: ComputerUsagePreferenceSchema.optional(),
  enabled: z.boolean().optional(),
}).strict();
export type ComputerConfig = z.infer<typeof ComputerConfigSchema>;
export const DEFAULT_COMPUTER_USAGE_PREFERENCE: ComputerUsagePreference = 'avoid';

/** Absent `enabled` stays on. Only an explicit `false` withholds the computer tool group. */
export function computerToolsEnabled(config: ComputerConfig | undefined): boolean {
  return config?.enabled !== false;
}

registerConfigSection(COMPUTER_CONFIG_SECTION, ComputerConfigSchema, {
  defaultValue: { usagePreference: DEFAULT_COMPUTER_USAGE_PREFERENCE },
});
