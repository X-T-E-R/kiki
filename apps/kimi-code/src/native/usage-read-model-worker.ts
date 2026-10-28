import { basename } from 'node:path';

import { configureUsageReadModelWorkerRuntime } from '@kiki/node-sdk';

import { USAGE_READ_MODEL_WORKER_ASSET } from '../../scripts/native/manifest.mjs';
import {
  getEmbeddedNativeAssetManifest,
  getSeaAssetSource,
  getUsageReadModelWorkerFile,
  type NativeAssetOptions,
} from './native-assets';

export type UsageReadModelWorkerInstallStatus =
  | { readonly status: 'not-sea' }
  | { readonly status: 'asset-missing' }
  | {
      readonly status: 'installed';
      readonly assetSha256: string;
      readonly basename: string;
    }
  | {
      readonly status: 'failed';
      readonly errorCode: string;
      readonly assetSha256?: string;
    };

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  return error instanceof Error ? error.name : 'UNKNOWN';
}

export function installUsageReadModelWorker(
  options: NativeAssetOptions = {},
): UsageReadModelWorkerInstallStatus {
  const source = options.source ?? getSeaAssetSource();
  if (source === null) return { status: 'not-sea' };

  let assetSha256: string | undefined;
  try {
    const manifest = options.manifest ?? getEmbeddedNativeAssetManifest(source);
    const file = manifest?.runtimeFiles.find((entry) => entry.key === USAGE_READ_MODEL_WORKER_ASSET.key);
    if (manifest === null || file === undefined) return { status: 'asset-missing' };
    assetSha256 = file.sha256;

    const workerPath = getUsageReadModelWorkerFile({ ...options, source, manifest });
    if (workerPath === null) return { status: 'asset-missing' };
    configureUsageReadModelWorkerRuntime(workerPath);
    return {
      status: 'installed',
      assetSha256,
      basename: basename(workerPath),
    };
  } catch (error) {
    return {
      status: 'failed',
      errorCode: errorCode(error),
      assetSha256,
    };
  }
}
