import { getHeapStatistics } from 'node:v8';
import { z } from 'zod';

import { envBindings, stripEnvBoundFields, type EnvBindings } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { RESOURCE_DEFAULTS } from '#/_base/node/resourceDefaults';
import { SESSION_RESTORE_TIMEOUT_ENV, SESSION_RESTORE_TIMEOUT_MS } from '#/session/agentLifecycle/restoreTiming';

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
    restoreTimeoutMs: z.number().int().min(5_000).max(2_147_483_647).optional(),
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
  restoreTimeoutMs: SESSION_RESTORE_TIMEOUT_MS,
};

function parseRestoreTimeoutMs(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 5_000 && parsed <= 2_147_483_647 ? parsed : undefined;
}

export const sessionResidencyEnvBindings: EnvBindings<SessionResidencyConfig> = envBindings(
  SessionResidencyConfigSchema,
  {
    restoreTimeoutMs: { env: SESSION_RESTORE_TIMEOUT_ENV, parse: parseRestoreTimeoutMs },
  },
);

registerConfigSection(SESSION_RESIDENCY_SECTION, SessionResidencyConfigSchema, {
  defaultValue: DEFAULT_SESSION_RESIDENCY_CONFIG,
  env: sessionResidencyEnvBindings,
  stripEnv: stripEnvBoundFields(sessionResidencyEnvBindings),
});
