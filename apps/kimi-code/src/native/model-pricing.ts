import { basename } from 'node:path';

import {
  configureModelPricingRuntime,
  getModelPricingRuntimeState,
} from '@kiki/kap-server/model-pricing-runtime';

import { KAP_MODEL_PRICES_ASSET } from '../../scripts/native/manifest.mjs';
import {
  getEmbeddedNativeAssetManifest,
  getKapModelPricesFile,
  getSeaAssetSource,
  type NativeAssetOptions,
} from './native-assets';

export type KapModelPricingInstallStatus =
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

/** Install the SEA-bundled LiteLLM snapshot before kap-server starts. */
export function installKapModelPricing(
  options: NativeAssetOptions = {},
): KapModelPricingInstallStatus {
  const source = options.source ?? getSeaAssetSource();
  if (source === null) return { status: 'not-sea' };

  let assetSha256: string | undefined;
  try {
    const manifest = options.manifest ?? getEmbeddedNativeAssetManifest(source);
    const file = manifest?.runtimeFiles.find((entry) => entry.key === KAP_MODEL_PRICES_ASSET.key);
    if (manifest === null || file === undefined) return { status: 'asset-missing' };
    assetSha256 = file.sha256;

    const snapshotPath = getKapModelPricesFile({ ...options, source, manifest });
    if (snapshotPath === null) return { status: 'asset-missing' };
    configureModelPricingRuntime(snapshotPath);
    const runtime = getModelPricingRuntimeState();
    if (!runtime.configured) throw new Error('model pricing runtime was not configured');
    return {
      status: 'installed',
      assetSha256,
      basename: basename(snapshotPath),
    };
  } catch (error) {
    return {
      status: 'failed',
      errorCode: errorCode(error),
      assetSha256,
    };
  }
}
