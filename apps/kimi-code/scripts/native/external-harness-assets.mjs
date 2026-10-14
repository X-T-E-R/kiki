import { createHash } from 'node:crypto';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildRuntimeAssetKey } from './manifest.mjs';
import {
  SOURCE_OWNED_ADAPTER_ENTRY,
  SOURCE_OWNED_ADAPTER_FILES,
} from '../../../../scripts/external-harness/production-manifest.mjs';

export async function collectSourceOwnedAdapterAssets({ appRoot, target, repoRoot }) {
  const root = resolve(repoRoot ?? resolve(appRoot, '../..'), 'scripts/external-harness');
  const runtimeFiles = [];
  const assets = {};
  for (const name of SOURCE_OWNED_ADAPTER_FILES) {
    const file = resolve(root, name);
    const bytes = await readFile(file);
    const key = `external-harness/${name}`;
    const assetKey = buildRuntimeAssetKey(target, key);
    runtimeFiles.push({
      key,
      assetKey,
      relativePath: `runtime/external-harness/${name}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mode: 0o644,
    });
    assets[assetKey] = file;
  }
  if (!runtimeFiles.some((file) => file.key === `external-harness/${SOURCE_OWNED_ADAPTER_ENTRY}`)) {
    throw new Error('Source-owned adapter entry is missing');
  }
  return { runtimeFiles, assets };
}

export async function copySourceOwnedAdapterAssets({ repoRoot, outDir }) {
  const source = resolve(repoRoot, 'scripts/external-harness');
  const destination = resolve(outDir, 'external-harness');
  await mkdir(destination, { recursive: true });
  for (const name of SOURCE_OWNED_ADAPTER_FILES) {
    await cp(resolve(source, name), resolve(destination, name));
  }
}
