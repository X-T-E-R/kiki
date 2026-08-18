import { describe, expect, it } from 'vitest';

import {
  KAP_MODEL_PRICES_ASSET,
  NATIVE_ASSET_MANIFEST_VERSION,
  buildManifestKey,
  isManifestVersionSupported,
} from '../../../scripts/native/manifest.mjs';

describe('NATIVE_ASSET_MANIFEST_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(NATIVE_ASSET_MANIFEST_VERSION)).toBe(true);
    expect(NATIVE_ASSET_MANIFEST_VERSION).toBeGreaterThan(0);
  });
});

describe('buildManifestKey', () => {
  it('namespaces by target', () => {
    expect(buildManifestKey('darwin-arm64')).toBe('native/darwin-arm64/manifest.json');
    expect(buildManifestKey('linux-x64')).toBe('native/linux-x64/manifest.json');
  });

  it('keeps the LiteLLM snapshot in the kap-server runtime asset tree', () => {
    expect(KAP_MODEL_PRICES_ASSET).toMatchObject({
      key: 'kap-model-prices',
      relativePath: 'runtime/kap-server/model_prices_and_context_window.json',
      mode: 0o644,
    });
  });
});

describe('isManifestVersionSupported', () => {
  it('accepts current version', () => {
    expect(isManifestVersionSupported(NATIVE_ASSET_MANIFEST_VERSION)).toBe(true);
  });

  it('rejects other versions', () => {
    expect(isManifestVersionSupported(NATIVE_ASSET_MANIFEST_VERSION + 1)).toBe(false);
    expect(isManifestVersionSupported(0)).toBe(false);
  });
});
