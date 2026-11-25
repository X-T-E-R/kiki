import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const ERROR_TELEMETRY_SECTION = 'errorTelemetry';

export const ErrorTelemetryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.url().optional(),
  connection: z.string().trim().min(1).optional(),
  flush_interval_ms: z.number().int().min(1000).max(300_000).default(5000),
  max_batch_size: z.number().int().min(1).max(100).default(20),
}).strict();

export type ErrorTelemetryConfig = z.infer<typeof ErrorTelemetryConfigSchema>;

const preserveCanonicalKeys = (value: unknown): unknown => value;

registerConfigSection(ERROR_TELEMETRY_SECTION, ErrorTelemetryConfigSchema, {
  defaultValue: {
    enabled: false,
    flush_interval_ms: 5000,
    max_batch_size: 20,
  },
  syncScope: 'portable',
  fromToml: preserveCanonicalKeys,
  toToml: preserveCanonicalKeys,
});
