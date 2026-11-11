import { availableParallelism, totalmem } from 'node:os';

export type MobilePlatform = 'android' | 'ios';

export interface ResourceHardware {
  readonly parallelism: number;
  readonly memoryBytes: number;
  readonly platform?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function mobilePlatformOf(
  platform: string = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): MobilePlatform | undefined {
  const configured = env['KIKI_PLATFORM']?.trim().toLowerCase();
  if (configured === 'android' || configured === 'ios') return configured;
  if (platform === 'android' || platform === 'ios') return platform;
  if (env['KIKI_RUNTIME_PROFILE']?.trim().toLowerCase() === 'mobile') return 'android';
  return undefined;
}

export function isMobileRuntimeProfile(
  platform: string = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return mobilePlatformOf(platform, env) !== undefined;
}

function parseMobileMemoryBudgetMb(
  env: Readonly<Record<string, string | undefined>> | undefined,
): number | undefined {
  const raw = env?.['KIKI_MOBILE_MEMORY_BUDGET_MB']?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 64 ? parsed : undefined;
}

export function resourceDefaults(hardware: ResourceHardware = { parallelism: availableParallelism(), memoryBytes: totalmem() }) {
  const memoryMiB = Math.floor(hardware.memoryBytes / 1024 / 1024);
  const spareCpus = Math.max(1, hardware.parallelism - 1);
  if (isMobileRuntimeProfile(hardware.platform, hardware.env)) {
    const budgetMiB = parseMobileMemoryBudgetMb(hardware.env);
    const effectiveMiB = budgetMiB !== undefined ? Math.min(memoryMiB, budgetMiB) : memoryMiB;
    const workerHeapMb = budgetMiB !== undefined
      ? Math.max(48, Math.min(96, Math.floor(budgetMiB / 4)))
      : 96;
    const searchIndexerSoftMb = budgetMiB !== undefined
      ? Math.max(64, Math.min(160, Math.floor(budgetMiB / 3)))
      : 160;
    const searchIndexerHardMb = budgetMiB !== undefined
      ? Math.max(96, Math.min(256, Math.floor(budgetMiB / 2)))
      : 256;
    const cpuWorkers = Math.max(1, Math.min(2, spareCpus, Math.floor(effectiveMiB / 4 / workerHeapMb)));
    const residentHeapMiB = budgetMiB !== undefined
      ? Math.max(64, Math.floor(budgetMiB / 2))
      : Math.max(256, Math.floor(memoryMiB / 8));
    return {
      workerHeapMb,
      searchIndexerSoftMb,
      searchIndexerHardMb,
      cpuWorkers,
      workerQueue: Math.max(128, hardware.parallelism * 16),
      cpuQueue: Math.max(128, cpuWorkers * 16),
      cpuQueuedBytes: Math.max(32, Math.floor(effectiveMiB / 128)) * 1024 * 1024,
      liveSessions: Math.max(8, Math.floor(effectiveMiB / 128)),
      queuedRestores: Math.max(128, hardware.parallelism * 16),
      residentHeapBytes: residentHeapMiB * 1024 * 1024,
    };
  }
  const workerHeapMb = Math.max(512, Math.floor(memoryMiB / 64));
  const cpuWorkers = Math.max(1, Math.min(spareCpus, Math.floor(memoryMiB / 4 / workerHeapMb)));
  return {
    workerHeapMb,
    searchIndexerSoftMb: workerHeapMb * 2 + 256,
    searchIndexerHardMb: workerHeapMb * 3 + 256,
    cpuWorkers,
    workerQueue: Math.max(128, hardware.parallelism * 16),
    cpuQueue: Math.max(128, cpuWorkers * 16),
    cpuQueuedBytes: Math.max(64, Math.floor(memoryMiB / 128)) * 1024 * 1024,
    liveSessions: Math.max(16, Math.floor(memoryMiB / 128)),
    queuedRestores: Math.max(128, hardware.parallelism * 16),
    residentHeapBytes: Math.max(256, Math.floor(memoryMiB / 8)) * 1024 * 1024,
  };
}

export const RESOURCE_DEFAULTS = resourceDefaults();
