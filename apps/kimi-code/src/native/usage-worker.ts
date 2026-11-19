import { configureUsageWorkerRuntime } from '@kiki/kap-server/usage-worker-runtime';

import { KAP_USAGE_PARSER_WORKER_ASSET } from '../../scripts/native/manifest.mjs';
import {
  getKapUsageWorkerFile,
  installRuntimeAsset,
  type NativeAssetOptions,
  type RuntimeAssetInstallStatus,
} from './native-assets';

export type UsageWorkerInstallStatus = RuntimeAssetInstallStatus;

export function installKapUsageWorker(options: NativeAssetOptions = {}): UsageWorkerInstallStatus {
  return installRuntimeAsset(
    {
      assetKey: KAP_USAGE_PARSER_WORKER_ASSET.key,
      getFile: getKapUsageWorkerFile,
      configure: configureUsageWorkerRuntime,
    },
    options,
  );
}
