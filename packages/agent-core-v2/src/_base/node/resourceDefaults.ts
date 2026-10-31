import { availableParallelism, totalmem } from 'node:os';

export interface ResourceHardware {
  readonly parallelism: number;
  readonly memoryBytes: number;
}

export function resourceDefaults(hardware: ResourceHardware = { parallelism: availableParallelism(), memoryBytes: totalmem() }) {
  const memoryMiB = Math.floor(hardware.memoryBytes / 1024 / 1024);
  const spareCpus = Math.max(1, hardware.parallelism - 1);
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
