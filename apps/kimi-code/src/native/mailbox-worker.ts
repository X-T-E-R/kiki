import { configureMailboxWorkerRuntime } from '@kiki/node-sdk';

import { MAILBOX_WORKER_ASSET } from '../../scripts/native/manifest.mjs';
import {
  getMailboxWorkerFile,
  installRuntimeAsset,
  type NativeAssetOptions,
  type RuntimeAssetInstallStatus,
} from './native-assets';

export type MailboxWorkerInstallStatus = RuntimeAssetInstallStatus;

export function installMailboxWorker(
  options: NativeAssetOptions = {},
): MailboxWorkerInstallStatus {
  return installRuntimeAsset(
    {
      assetKey: MAILBOX_WORKER_ASSET.key,
      getFile: getMailboxWorkerFile,
      configure: configureMailboxWorkerRuntime,
    },
    options,
  );
}
