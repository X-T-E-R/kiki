import { configureQueryStoreWorkerRuntime as configureCoreQueryStoreWorkerRuntime } from '@kiki/agent-core-v2';

export function configureQueryStoreWorkerRuntime(path: string): void {
  configureCoreQueryStoreWorkerRuntime(path);
}
