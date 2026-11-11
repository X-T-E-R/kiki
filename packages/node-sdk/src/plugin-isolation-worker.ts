import { configurePluginIsolationWorkerRuntime as configureCorePluginIsolationWorkerRuntime } from '@kiki/agent-core-v2/app/cordisRuntime/pluginIsolationPoolService';

export function configurePluginIsolationWorkerRuntime(entryPath: string): void {
  configureCorePluginIsolationWorkerRuntime(entryPath);
}
