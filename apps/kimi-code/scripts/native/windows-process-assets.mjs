import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { buildWindowsProcessHelper as buildHelper } from '../../../../packages/agent-core-v2/scripts/build-windows-process-helper.mjs';
import { WINDOWS_PROCESS_HELPER_ASSET, buildRuntimeAssetKey } from './manifest.mjs';

export function buildWindowsProcessHelper({ appRoot, target, outputDir }) {
  return buildHelper({ target, outputDir: outputDir ?? resolve(appRoot, 'dist-native/intermediates/native-assets', target, 'windows-process') });
}

export async function collectWindowsProcessAssets(options) {
  const built = await buildWindowsProcessHelper(options);
  if (built === null) return { runtimeFiles: [], assets: {} };
  const asset = WINDOWS_PROCESS_HELPER_ASSET;
  const assetKey = buildRuntimeAssetKey(options.target, asset.key);
  return {
    runtimeFiles: [{ ...asset, assetKey, sha256: createHash('sha256').update(built.bytes).digest('hex') }],
    assets: { [assetKey]: built.path },
  };
}
