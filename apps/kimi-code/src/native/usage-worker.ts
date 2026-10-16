import { basename } from 'node:path';
import { configureUsageWorkerRuntime } from '@kiki/kap-server/usage-worker-runtime';
import { KAP_USAGE_PARSER_WORKER_ASSET } from '../../scripts/native/manifest.mjs';
import { getEmbeddedNativeAssetManifest, getKapUsageWorkerFile, getSeaAssetSource, type NativeAssetOptions } from './native-assets';

export type UsageWorkerInstallStatus =
  | { readonly status: 'not-sea' | 'asset-missing' }
  | { readonly status: 'installed'; readonly basename: string; readonly assetSha256: string }
  | { readonly status: 'failed'; readonly errorCode: string };

export function installKapUsageWorker(options: NativeAssetOptions = {}): UsageWorkerInstallStatus {
  const source = options.source ?? getSeaAssetSource();
  if (source === null) return { status: 'not-sea' };
  try {
    const manifest = options.manifest ?? getEmbeddedNativeAssetManifest(source);
    const asset = manifest?.runtimeFiles.find((entry) => entry.key === KAP_USAGE_PARSER_WORKER_ASSET.key);
    if (manifest === null || asset === undefined) return { status: 'asset-missing' };
    const path = getKapUsageWorkerFile({ ...options, source, manifest });
    if (path === null) return { status: 'asset-missing' };
    configureUsageWorkerRuntime(path);
    return { status: 'installed', basename: basename(path), assetSha256: asset.sha256 };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return { status: 'failed', errorCode: typeof code === 'string' ? code : error instanceof Error ? error.name : 'UNKNOWN' };
  }
}
