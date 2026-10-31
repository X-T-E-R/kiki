import { z } from 'zod';
import { envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { RESOURCE_DEFAULTS } from '#/_base/node/resourceDefaults';

export const CPU_WORKERS_SECTION = 'cpuWorkers';
export const CpuWorkersConfigSchema = z.object({
  maxWorkers: z.number().int().min(1).default(RESOURCE_DEFAULTS.cpuWorkers).meta({ 'x-default-formula': 'min(availableParallelism - 1, floor(totalmem / 4 / workerHeap)), at least 1; workerHeap = max(512 MiB, totalmem / 64)' }),
  maxQueue: z.number().int().min(1).default(RESOURCE_DEFAULTS.cpuQueue).meta({ 'x-default-formula': 'max(128, default CPU workers * 16)' }),
  maxQueuedBytes: z.number().int().min(1).default(RESOURCE_DEFAULTS.cpuQueuedBytes).meta({ 'x-default-formula': 'max(64 MiB, floor(totalmem / 128 / MiB) MiB)' }),
  timeoutMs: z.number().int().min(1).max(2_147_483_647).default(30_000),
});
export type CpuWorkersConfig = z.infer<typeof CpuWorkersConfigSchema>;

function integer(raw: string): number | undefined {
  return /^\d+$/.test(raw.trim()) ? Number(raw) : undefined;
}

const bindings = envBindings(CpuWorkersConfigSchema, {
  maxWorkers: { env: 'KIKI_CPU_MAX_WORKERS', parse: integer },
  maxQueue: { env: 'KIKI_CPU_MAX_QUEUE', parse: integer },
  maxQueuedBytes: { env: 'KIKI_CPU_MAX_QUEUED_BYTES', parse: integer },
  timeoutMs: { env: 'KIKI_CPU_TIMEOUT_MS', parse: integer },
});
registerConfigSection(CPU_WORKERS_SECTION, CpuWorkersConfigSchema, {
  defaultValue: CpuWorkersConfigSchema.parse({}), env: bindings, stripEnv: stripEnvBoundFields(bindings),
});
