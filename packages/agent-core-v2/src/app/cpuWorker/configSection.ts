import { z } from 'zod';
import { envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const CPU_WORKERS_SECTION = 'cpuWorkers';
export const CpuWorkersConfigSchema = z.object({
  maxWorkers: z.number().int().min(1).max(64).default(4),
  maxQueue: z.number().int().min(1).max(1024).default(64),
  maxQueuedBytes: z.number().int().min(1).default(64 * 1024 * 1024),
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
