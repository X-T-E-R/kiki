import { basename } from 'node:path';

import { configureMemoryWorkerRuntime } from '@kiki/node-sdk';

import { MEMORY_WORKER_ASSET } from '../../scripts/native/manifest.mjs';
import {
  getEmbeddedNativeAssetManifest,
  getMemoryWorkerFile,
  getSeaAssetSource,
  type NativeAssetOptions,
} from './native-assets';

export type MemoryWorkerInstallStatus =
  | { readonly status: 'not-sea' }
  | { readonly status: 'asset-missing' }
  | { readonly status: 'installed'; readonly assetSha256: string; readonly basename: string }
  | { readonly status: 'failed'; readonly errorCode: string; readonly assetSha256?: string };

export function installMemoryWorker(options: NativeAssetOptions = {}): MemoryWorkerInstallStatus {
  const source = options.source ?? getSeaAssetSource();
  if (source === null) return { status: 'not-sea' };
  let assetSha256: string | undefined;
  try {
    const manifest = options.manifest ?? getEmbeddedNativeAssetManifest(source);
    const file = manifest?.runtimeFiles.find((entry) => entry.key === MEMORY_WORKER_ASSET.key);
    if (manifest === null || file === undefined) return { status: 'asset-missing' };
    assetSha256 = file.sha256;
    const workerPath = getMemoryWorkerFile({ ...options, source, manifest });
    if (workerPath === null) return { status: 'asset-missing' };
    configureMemoryWorkerRuntime(workerPath);
    return { status: 'installed', assetSha256, basename: basename(workerPath) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return { status: 'failed', errorCode: typeof code === 'string' && code.length > 0 ? code : error instanceof Error ? error.name : 'UNKNOWN', assetSha256 };
  }
}
