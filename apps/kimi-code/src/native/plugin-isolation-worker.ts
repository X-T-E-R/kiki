import { configurePluginIsolationWorkerRuntime } from '@kiki/node-sdk';

import { PLUGIN_ISOLATION_WORKER_ASSET } from '../../scripts/native/manifest.mjs';
import {
  getPluginIsolationWorkerFile,
  installRuntimeAsset,
  type NativeAssetOptions,
  type RuntimeAssetInstallStatus,
} from './native-assets';

export type PluginIsolationWorkerInstallStatus = RuntimeAssetInstallStatus;

export function installPluginIsolationWorker(
  options: NativeAssetOptions = {},
): PluginIsolationWorkerInstallStatus {
  return installRuntimeAsset(
    {
      assetKey: PLUGIN_ISOLATION_WORKER_ASSET.key,
      getFile: getPluginIsolationWorkerFile,
      configure: configurePluginIsolationWorkerRuntime,
    },
    options,
  );
}
