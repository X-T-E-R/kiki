import { configureMemoryWorkerRuntime as configureCoreMemoryWorkerRuntime } from '@kiki/agent-core-v2/persistence/backends/sqliteMemory/protocol';

export function configureMemoryWorkerRuntime(path: string | undefined): void {
  configureCoreMemoryWorkerRuntime(path);
}
