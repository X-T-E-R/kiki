import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  getModelPricingRuntimeState,
  resetModelPricingRuntime,
} from '@kiki/kap-server/model-pricing-runtime';

import { KAP_MODEL_PRICES_ASSET } from '../../scripts/native/manifest.mjs';
import {
  NATIVE_ASSET_MANIFEST_VERSION,
  type NativeAssetManifest,
  type NativeAssetSource,
} from '#/native/native-assets';
import { installKapModelPricing } from '#/native/model-pricing';

const dirs: string[] = [];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(() => {
  resetModelPricingRuntime();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe('installKapModelPricing', () => {
  it('extracts the SEA runtime asset and configures kap-server with its path', () => {
    const cacheBase = mkdtempSync(join(tmpdir(), 'kimi-model-pricing-'));
    dirs.push(cacheBase);
    const content = '{"gpt-5":{"input_cost_per_token":0.1}}';
    const assetKey = 'native/test-target/runtime/kap-model-prices';
    const manifest: NativeAssetManifest = {
      version: NATIVE_ASSET_MANIFEST_VERSION,
      target: 'test-target',
      packages: [],
      runtimeFiles: [
        {
          key: KAP_MODEL_PRICES_ASSET.key,
          assetKey,
          relativePath: KAP_MODEL_PRICES_ASSET.relativePath,
          sha256: sha256(content),
          mode: KAP_MODEL_PRICES_ASSET.mode,
        },
      ],
    };
    const source: NativeAssetSource = {
      getAssetKeys: () => [assetKey],
      getRawAsset: (key) => {
        if (key !== assetKey) throw new Error(`unexpected asset ${key}`);
        return Buffer.from(content);
      },
    };

    expect(
      installKapModelPricing({ cacheBase, manifest, source, version: 'test' }),
    ).toMatchObject({
      status: 'installed',
      assetSha256: sha256(content),
      basename: 'model_prices_and_context_window.json',
    });
    const runtime = getModelPricingRuntimeState();
    expect(runtime.configured).toBe(true);
    if (!runtime.configured) throw new Error('expected configured pricing runtime');
    expect(readFileSync(runtime.path, 'utf8')).toBe(content);
  });
});
