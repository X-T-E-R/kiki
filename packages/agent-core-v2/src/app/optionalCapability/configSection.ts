import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const OPTIONAL_CAPABILITIES_SECTION = 'optionalCapabilities';

export const OPTIONAL_CAPABILITY_FACTORY_DEFAULTS = {
  browser: false,
  computer: false,
  memory: true,
  thread: true,
  web: true,
  send_message: false,
} as const;

export const OptionalCapabilityDefaultsSchema = z.object({
  browser: z.boolean().default(OPTIONAL_CAPABILITY_FACTORY_DEFAULTS.browser),
  computer: z.boolean().default(OPTIONAL_CAPABILITY_FACTORY_DEFAULTS.computer),
  memory: z.boolean().default(OPTIONAL_CAPABILITY_FACTORY_DEFAULTS.memory),
  thread: z.boolean().default(OPTIONAL_CAPABILITY_FACTORY_DEFAULTS.thread),
  web: z.boolean().default(OPTIONAL_CAPABILITY_FACTORY_DEFAULTS.web),
  send_message: z.boolean().default(OPTIONAL_CAPABILITY_FACTORY_DEFAULTS.send_message),
}).strict();

export const OptionalCapabilitiesConfigSchema = z.object({
  defaults: OptionalCapabilityDefaultsSchema.default({ ...OPTIONAL_CAPABILITY_FACTORY_DEFAULTS }),
  web: z.object({
    allowed: z.boolean().default(true),
  }).strict().default({ allowed: true }),
}).strict();

export type OptionalCapabilitiesConfig = z.infer<typeof OptionalCapabilitiesConfigSchema>;

registerConfigSection(OPTIONAL_CAPABILITIES_SECTION, OptionalCapabilitiesConfigSchema, {
  defaultValue: {
    defaults: { ...OPTIONAL_CAPABILITY_FACTORY_DEFAULTS },
    web: { allowed: true },
  },
});
