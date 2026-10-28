import { configureUsageReadModelWorkerRuntime as configureCoreUsageReadModelWorkerRuntime } from '@kiki/agent-core-v2';

export function configureUsageReadModelWorkerRuntime(path: string | undefined): void {
  configureCoreUsageReadModelWorkerRuntime(path);
}
