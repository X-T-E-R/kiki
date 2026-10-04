import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { buildRuntimeAssetKey, BROWSER_DRIVER_ASSET } from './manifest.mjs';

export async function collectBrowserDriverAssets({ appRoot, target, artifactDirectory }) {
  if (target !== 'win32-x64') return { runtimeFiles: [], assets: {} };
  const donor = resolve(appRoot, '..', '..', 'packages', 'agent-core-v2', 'src', 'app', 'browser', 'donor');
  const metadata = JSON.parse(await readFile(resolve(donor, 'build.json'), 'utf8'));
  if (metadata.version !== '0.38.2' || metadata.marker !== 'kiki-no-replay-r1' || metadata.stdioMarker !== 'kiki-stdio-r1' || !/^[a-f0-9]{64}$/.test(metadata.artifactSha256)) {
    throw new Error('Invalid managed browser build metadata');
  }
  const sourceRoot = artifactDirectory ?? process.env.KIKI_BROWSER_ARTIFACT_DIR ?? resolve(appRoot, 'vendor', 'agent-browser', target);
  const files = [
    [resolve(sourceRoot, metadata.artifactName), BROWSER_DRIVER_ASSET.key, BROWSER_DRIVER_ASSET.relativePath, 0o755, metadata.artifactSha256],
    ...['LICENSE', 'NOTICE', 'build.json', 'kiki-no-replay-r1.patch'].map((name) => [resolve(donor, name), `browser-driver/${name}`, `runtime/browser-driver/${name}`, 0o644, name === metadata.patch ? metadata.patchSha256 : undefined]),
  ];
  const runtimeFiles = [];
  const assets = {};
  for (const [source, key, relativePath, mode, expected] of files) {
    let bytes;
    try { bytes = await readFile(source); }
    catch (error) { throw new Error(`Managed browser resource is missing: ${source}. Stage the fixed derivative via KIKI_BROWSER_ARTIFACT_DIR before the Windows SEA build.`, { cause: error }); }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (expected !== undefined && sha256 !== expected) throw new Error(`Managed browser resource checksum mismatch: ${key}`);
    const assetKey = buildRuntimeAssetKey(target, key);
    runtimeFiles.push({ key, assetKey, relativePath, mode, sha256 });
    assets[assetKey] = source;
  }
  return { runtimeFiles, assets };
}
