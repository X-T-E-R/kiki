import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const SESSION_RESIDENCY_SECTION = 'sessionResidency';

export const SessionResidencyConfigSchema = z
  .object({
    idleTtlMs: z.number().int().min(0).max(86_400_000).optional(),
    maxLiveSessions: z.number().int().min(1).max(64).optional(),
    minIdleMs: z.number().int().min(0).max(86_400_000).optional(),
    sweepIntervalMs: z.number().int().min(1_000).max(300_000).optional(),
    maxConcurrentRestores: z.number().int().min(1).max(4).optional(),
    maxQueuedRestores: z.number().int().min(0).max(64).optional(),
  })
  .strict();

export type SessionResidencyConfig = z.infer<typeof SessionResidencyConfigSchema>;

export const DEFAULT_SESSION_RESIDENCY_CONFIG: Required<SessionResidencyConfig> = {
  idleTtlMs: 600_000,
  maxLiveSessions: 8,
  minIdleMs: 60_000,
  sweepIntervalMs: 30_000,
  maxConcurrentRestores: 1,
  maxQueuedRestores: 8,
};

registerConfigSection(SESSION_RESIDENCY_SECTION, SessionResidencyConfigSchema, {
  defaultValue: DEFAULT_SESSION_RESIDENCY_CONFIG,
});
