import { configureQueryStoreWorkerRuntime } from '@kiki/node-sdk';

import { QUERY_STORE_WORKER_ASSET } from '../../scripts/native/manifest.mjs';
import {
  getQueryStoreWorkerFile,
  installRuntimeAsset,
  type NativeAssetOptions,
  type RuntimeAssetInstallStatus,
} from './native-assets';

export type QueryStoreWorkerInstallStatus = RuntimeAssetInstallStatus;

export function installQueryStoreWorker(
  options: NativeAssetOptions = {},
): QueryStoreWorkerInstallStatus {
  return installRuntimeAsset(
    {
      assetKey: QUERY_STORE_WORKER_ASSET.key,
      getFile: getQueryStoreWorkerFile,
      configure: configureQueryStoreWorkerRuntime,
    },
    options,
  );
}
