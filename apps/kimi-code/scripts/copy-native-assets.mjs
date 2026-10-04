import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { collectAuthNativePackage } from './native/assets.mjs';
import { copyHistoryImportAssets } from './native/history-assets.mjs';
import { mergeAuthNativeLanes } from '../../../packages/auth-native/scripts/lane-assets.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');
const source = resolve(repoRoot, 'packages/pi-tui/native');
const target = resolve(appRoot, 'native');

// pi-tui ships platform-specific native helpers only for darwin/win32;
// Linux has no native helper, so there is nothing to copy for it.
const PLATFORMS = ['darwin', 'win32'];

async function assertPrebuilds(platform) {
  const dir = resolve(source, platform, 'prebuilds');
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw new Error(
      `pi-tui native prebuilds were not found at ${dir}. Build or restore packages/pi-tui first.`,
    );
  }
  return dir;
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

for (const platform of PLATFORMS) {
  const srcPrebuilds = await assertPrebuilds(platform);
  const dstPrebuilds = resolve(target, platform, 'prebuilds');
  await cp(srcPrebuilds, dstPrebuilds, { recursive: true });
}

if (process.env.KIKI_AUTH_NATIVE_ARTIFACT_ROOT) {
  await mergeAuthNativeLanes({
    artifactRoot: resolve(process.env.KIKI_AUTH_NATIVE_ARTIFACT_ROOT),
    destination: resolve(target, 'auth-native'),
  });
} else {
  const authAssets = await collectAuthNativePackage({
    packageRoot: resolve(repoRoot, 'packages/auth-native'),
    target: process.env.KIKI_BUILD_TARGET ?? `${process.platform}-${process.arch}`,
  });
  for (const file of authAssets.packageManifest.files) {
    const relativePath = file.relativePath.slice('node_modules/@kiki/auth-native/'.length);
    const destination = resolve(target, 'auth-native', relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await cp(authAssets.assets[file.assetKey], destination);
  }
}

await cp(
  resolve(repoRoot, 'packages/agent-core-v2/src/app/plugin/hostRunner.mjs'),
  resolve(appRoot, 'dist/hostRunner.mjs'),
);

await copyHistoryImportAssets({ appRoot, outDir: resolve(appRoot, 'dist') });

console.log(`Copied pi-tui native prebuilds to ${target}, plugin host runner and history rules to dist`);
