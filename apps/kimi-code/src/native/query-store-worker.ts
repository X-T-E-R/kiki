import { basename } from 'node:path';

import { configureQueryStoreWorkerRuntime } from '@kiki/node-sdk';

import { QUERY_STORE_WORKER_ASSET } from '../../scripts/native/manifest.mjs';
import {
  getEmbeddedNativeAssetManifest,
  getQueryStoreWorkerFile,
  getSeaAssetSource,
  type NativeAssetOptions,
} from './native-assets';

export type QueryStoreWorkerInstallStatus =
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

export function installQueryStoreWorker(
  options: NativeAssetOptions = {},
): QueryStoreWorkerInstallStatus {
  const source = options.source ?? getSeaAssetSource();
  if (source === null) return { status: 'not-sea' };

  let assetSha256: string | undefined;
  try {
    const manifest = options.manifest ?? getEmbeddedNativeAssetManifest(source);
    const file = manifest?.runtimeFiles.find((entry) => entry.key === QUERY_STORE_WORKER_ASSET.key);
    if (manifest === null || file === undefined) return { status: 'asset-missing' };
    assetSha256 = file.sha256;

    const workerPath = getQueryStoreWorkerFile({ ...options, source, manifest });
    if (workerPath === null) return { status: 'asset-missing' };
    configureQueryStoreWorkerRuntime(workerPath);
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
