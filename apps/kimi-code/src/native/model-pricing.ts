import {
  configureModelPricingRuntime,
  getModelPricingRuntimeState,
} from '@kiki/kap-server/model-pricing-runtime';

import { KAP_MODEL_PRICES_ASSET } from '../../scripts/native/manifest.mjs';
import {
  getKapModelPricesFile,
  installRuntimeAsset,
  type NativeAssetOptions,
  type RuntimeAssetInstallStatus,
} from './native-assets';

export type KapModelPricingInstallStatus = RuntimeAssetInstallStatus;

/** Install the SEA-bundled LiteLLM snapshot before kap-server starts. */
export function installKapModelPricing(
  options: NativeAssetOptions = {},
): KapModelPricingInstallStatus {
  return installRuntimeAsset(
    {
      assetKey: KAP_MODEL_PRICES_ASSET.key,
      getFile: getKapModelPricesFile,
      configure: configureModelPricingRuntime,
      verify: () => {
        const runtime = getModelPricingRuntimeState();
        if (!runtime.configured) throw new Error('model pricing runtime was not configured');
      },
    },
    options,
  );
}
