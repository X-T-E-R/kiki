import { resolve } from 'node:path';
import { stageAuthNativeLane } from './lane-assets.mjs';
const packageRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(packageRoot, '../..');
const target = process.env.KIKI_BUILD_TARGET ?? `${process.platform}-${process.arch}`;
const path = await stageAuthNativeLane({
  packageRoot, target,
  artifactRoot: resolve(repoRoot, 'apps/kimi-code/dist-native/artifacts/auth-native'),
});
console.log(`Staged auth-native complete lane unit: ${target}; ${path}`);
