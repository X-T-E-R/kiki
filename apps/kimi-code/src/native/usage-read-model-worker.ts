import { configureUsageReadModelWorkerRuntime } from '@kiki/node-sdk';

import { USAGE_READ_MODEL_WORKER_ASSET } from '../../scripts/native/manifest.mjs';
import {
  getUsageReadModelWorkerFile,
  installRuntimeAsset,
  type NativeAssetOptions,
  type RuntimeAssetInstallStatus,
} from './native-assets';

export type UsageReadModelWorkerInstallStatus = RuntimeAssetInstallStatus;

export function installUsageReadModelWorker(
  options: NativeAssetOptions = {},
): UsageReadModelWorkerInstallStatus {
  return installRuntimeAsset(
    {
      assetKey: USAGE_READ_MODEL_WORKER_ASSET.key,
      getFile: getUsageReadModelWorkerFile,
      configure: configureUsageReadModelWorkerRuntime,
    },
    options,
  );
}
