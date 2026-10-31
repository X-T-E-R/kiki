import { getHeapStatistics } from 'node:v8';
import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';
import { RESOURCE_DEFAULTS } from '#/_base/node/resourceDefaults';

export const SESSION_RESIDENCY_SECTION = 'sessionResidency';

export const SessionResidencyConfigSchema = z
  .object({
    idleTtlMs: z.number().int().min(0).max(2_147_483_647).optional(),
    maxLiveSessions: z.number().int().min(1).optional().meta({ 'x-default-formula': 'max(16, floor(totalmem / 128 MiB))' }),
    minIdleMs: z.number().int().min(0).max(2_147_483_647).optional(),
    sweepIntervalMs: z.number().int().min(1_000).max(2_147_483_647).optional(),
    maxConcurrentRestores: z.number().int().min(1).optional().meta({ 'x-default-formula': 'CPU worker default: min(availableParallelism - 1, floor(totalmem / 4 / workerHeap)), at least 1' }),
    maxQueuedRestores: z.number().int().min(0).optional().meta({ 'x-default-formula': 'max(128, availableParallelism * 16)' }),
    maxResidentHeapBytes: z.number().int().min(0).optional().meta({ 'x-default-formula': 'max(256 MiB, floor(totalmem / 8 / MiB) MiB), further bounded by 60% of the effective V8 heap' }),
  })
  .strict();

export type SessionResidencyConfig = z.infer<typeof SessionResidencyConfigSchema>;

export const DEFAULT_SESSION_RESIDENCY_CONFIG: Required<SessionResidencyConfig> = {
  idleTtlMs: 600_000,
  maxLiveSessions: RESOURCE_DEFAULTS.liveSessions,
  minIdleMs: 60_000,
  sweepIntervalMs: 30_000,
  maxConcurrentRestores: RESOURCE_DEFAULTS.cpuWorkers,
  maxQueuedRestores: RESOURCE_DEFAULTS.queuedRestores,
  maxResidentHeapBytes: Math.min(RESOURCE_DEFAULTS.residentHeapBytes, Math.floor(getHeapStatistics().heap_size_limit * 0.6)),
};

registerConfigSection(SESSION_RESIDENCY_SECTION, SessionResidencyConfigSchema, {
  defaultValue: DEFAULT_SESSION_RESIDENCY_CONFIG,
});
