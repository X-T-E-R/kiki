import { configureCpuWorkerRuntime } from '@kiki/node-sdk';

import { CPU_WORKER_ASSET } from '../../scripts/native/manifest.mjs';
import {
  getCpuWorkerFile,
  installRuntimeAsset,
  type NativeAssetOptions,
  type RuntimeAssetInstallStatus,
} from './native-assets';

export type CpuWorkerInstallStatus = RuntimeAssetInstallStatus;

export function installCpuWorker(options: NativeAssetOptions = {}): CpuWorkerInstallStatus {
  return installRuntimeAsset(
    {
      assetKey: CPU_WORKER_ASSET.key,
      getFile: getCpuWorkerFile,
      configure: (entry) => configureCpuWorkerRuntime({ entry }),
    },
    options,
  );
}
