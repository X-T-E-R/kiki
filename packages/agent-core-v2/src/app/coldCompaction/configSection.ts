import { z } from 'zod';

import { envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const COLD_COMPACTION_SECTION = 'coldCompaction';

export const ColdCompactionConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    initialDelayMs: z.number().int().min(0).max(2_147_483_647).default(600_000),
    sweepIntervalMs: z.number().int().min(1_000).max(2_147_483_647).default(300_000),
    minIdleAgeMs: z.number().int().min(0).max(2_147_483_647).default(1_800_000),
    maxSessionsPerSweep: z.number().int().min(1).max(64).default(1),
    reclaimSparse: z.boolean().default(true),
  })
  .strict();

export type ColdCompactionConfig = z.infer<typeof ColdCompactionConfigSchema>;

function integer(raw: string): number | undefined {
  return /^\d+$/.test(raw.trim()) ? Number(raw) : undefined;
}

function booleanFlag(raw: string): boolean | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return undefined;
}

const bindings = envBindings(ColdCompactionConfigSchema, {
  enabled: { env: 'KIKI_COLD_COMPACTION_ENABLED', parse: booleanFlag },
  initialDelayMs: { env: 'KIKI_COLD_COMPACTION_INITIAL_DELAY_MS', parse: integer },
  sweepIntervalMs: { env: 'KIKI_COLD_COMPACTION_SWEEP_INTERVAL_MS', parse: integer },
  minIdleAgeMs: { env: 'KIKI_COLD_COMPACTION_MIN_IDLE_AGE_MS', parse: integer },
  maxSessionsPerSweep: { env: 'KIKI_COLD_COMPACTION_MAX_SESSIONS_PER_SWEEP', parse: integer },
  reclaimSparse: { env: 'KIKI_COLD_COMPACTION_RECLAIM_SPARSE', parse: booleanFlag },
});

registerConfigSection(COLD_COMPACTION_SECTION, ColdCompactionConfigSchema, {
  defaultValue: ColdCompactionConfigSchema.parse({}),
  env: bindings,
  stripEnv: stripEnvBoundFields(bindings),
});
