import { configureMemoryWorkerRuntime } from '@kiki/node-sdk';

import { MEMORY_WORKER_ASSET } from '../../scripts/native/manifest.mjs';
import {
  getMemoryWorkerFile,
  installRuntimeAsset,
  type NativeAssetOptions,
  type RuntimeAssetInstallStatus,
} from './native-assets';

export type MemoryWorkerInstallStatus = RuntimeAssetInstallStatus;

export function installMemoryWorker(options: NativeAssetOptions = {}): MemoryWorkerInstallStatus {
  return installRuntimeAsset(
    {
      assetKey: MEMORY_WORKER_ASSET.key,
      getFile: getMemoryWorkerFile,
      configure: configureMemoryWorkerRuntime,
    },
    options,
  );
}
