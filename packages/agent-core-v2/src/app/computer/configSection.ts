import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const COMPUTER_CONFIG_SECTION = 'computerControl';
export const ComputerUsagePreferenceSchema = z.enum(['avoid', 'prefer']);
export type ComputerUsagePreference = z.infer<typeof ComputerUsagePreferenceSchema>;
export const ComputerConfigSchema = z.object({
  usagePreference: ComputerUsagePreferenceSchema.optional(),
  enabled: z.boolean().optional(),
  connection: z.string().trim().min(1).optional(),
}).strict();
export type ComputerConfig = z.infer<typeof ComputerConfigSchema>;
export const DEFAULT_COMPUTER_USAGE_PREFERENCE: ComputerUsagePreference = 'avoid';

/** Absent `enabled` stays on on desktop hosts and off on mobile hosts unless explicitly configured. */
export function computerToolsEnabled(config: ComputerConfig | undefined, mobile = false): boolean {
  if (config?.enabled !== undefined) return config.enabled;
  return !mobile;
}

registerConfigSection(COMPUTER_CONFIG_SECTION, ComputerConfigSchema, {
  defaultValue: { usagePreference: DEFAULT_COMPUTER_USAGE_PREFERENCE },
});
