import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const OPTIONAL_CAPABILITIES_SECTION = 'optionalCapabilities';

export const OptionalCapabilityDefaultsSchema = z.object({
  browser: z.boolean().default(true),
  computer: z.boolean().default(true),
  memory: z.boolean().default(true),
  thread: z.boolean().default(false),
  web: z.boolean().default(true),
}).strict();

export const OptionalCapabilitiesConfigSchema = z.object({
  defaults: OptionalCapabilityDefaultsSchema.default({
    browser: true,
    computer: true,
    memory: true,
    thread: false,
    web: true,
  }),
  web: z.object({
    allowed: z.boolean().default(true),
  }).strict().default({ allowed: true }),
}).strict();

export type OptionalCapabilitiesConfig = z.infer<typeof OptionalCapabilitiesConfigSchema>;

export const OPTIONAL_CAPABILITY_FACTORY_DEFAULTS = {
  browser: true,
  computer: true,
  memory: true,
  thread: false,
  web: true,
} as const;

registerConfigSection(OPTIONAL_CAPABILITIES_SECTION, OptionalCapabilitiesConfigSchema, {
  defaultValue: {
    defaults: { browser: true, computer: true, memory: true, thread: false, web: true },
    web: { allowed: true },
  },
});
