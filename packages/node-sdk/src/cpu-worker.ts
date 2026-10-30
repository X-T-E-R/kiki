import { configureCpuWorkerRuntime as configureCoreCpuWorkerRuntime } from '@kiki/agent-core-v2/app/cpuWorker/protocol';

export function configureCpuWorkerRuntime(options: { entry?: string }): void {
  configureCoreCpuWorkerRuntime(options);
}
