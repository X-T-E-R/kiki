import { basename } from 'node:path';

import { configurePluginIsolationWorkerRuntime } from '@kiki/node-sdk';

import { PLUGIN_ISOLATION_WORKER_ASSET } from '../../scripts/native/manifest.mjs';
import {
  getEmbeddedNativeAssetManifest,
  getPluginIsolationWorkerFile,
  getSeaAssetSource,
  type NativeAssetOptions,
} from './native-assets';

export type PluginIsolationWorkerInstallStatus =
  | { readonly status: 'not-sea' }
  | { readonly status: 'asset-missing' }
  | { readonly status: 'installed'; readonly assetSha256: string; readonly basename: string }
  | { readonly status: 'failed'; readonly errorCode: string; readonly assetSha256?: string };

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  return error instanceof Error ? error.name : 'UNKNOWN';
}

export function installPluginIsolationWorker(options: NativeAssetOptions = {}): PluginIsolationWorkerInstallStatus {
  const source = options.source ?? getSeaAssetSource();
  if (source === null) return { status: 'not-sea' };

  let assetSha256: string | undefined;
  try {
    const manifest = options.manifest ?? getEmbeddedNativeAssetManifest(source);
    const file = manifest?.runtimeFiles.find((entry) => entry.key === PLUGIN_ISOLATION_WORKER_ASSET.key);
    if (manifest === null || file === undefined) return { status: 'asset-missing' };
    assetSha256 = file.sha256;
    const workerPath = getPluginIsolationWorkerFile({ ...options, source, manifest });
    if (workerPath === null) return { status: 'asset-missing' };
    configurePluginIsolationWorkerRuntime(workerPath);
    return { status: 'installed', assetSha256, basename: basename(workerPath) };
  } catch (error) {
    return { status: 'failed', errorCode: errorCode(error), assetSha256 };
  }
}
