import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const COMPUTER_CONFIG_SECTION = 'computerControl';
export const ComputerUsagePreferenceSchema = z.enum(['avoid', 'prefer']);
export type ComputerUsagePreference = z.infer<typeof ComputerUsagePreferenceSchema>;
export const ComputerConfigSchema = z.object({ usagePreference: ComputerUsagePreferenceSchema.optional() }).strict();
export type ComputerConfig = z.infer<typeof ComputerConfigSchema>;
export const DEFAULT_COMPUTER_USAGE_PREFERENCE: ComputerUsagePreference = 'avoid';

registerConfigSection(COMPUTER_CONFIG_SECTION, ComputerConfigSchema, {
  defaultValue: { usagePreference: DEFAULT_COMPUTER_USAGE_PREFERENCE },
});
