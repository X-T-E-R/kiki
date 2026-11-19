import { resolve } from 'node:path';
import { stageAuthNativeLane } from './lane-assets.mjs';

const packageRoot = resolve(import.meta.dirname, '..');
const target = process.env.KIKI_BUILD_TARGET ?? `${process.platform}-${process.arch}`;
const argIndex = process.argv.indexOf('--artifact-root');
const artifactRootArg = argIndex >= 0 ? process.argv[argIndex + 1] : undefined;
const artifactRoot = artifactRootArg
  ? resolve(process.cwd(), artifactRootArg)
  : process.env.KIKI_AUTH_NATIVE_ARTIFACT_ROOT
    ? resolve(process.cwd(), process.env.KIKI_AUTH_NATIVE_ARTIFACT_ROOT)
    : resolve(packageRoot, 'dist/artifacts/auth-native');

const path = await stageAuthNativeLane({
  packageRoot,
  target,
  artifactRoot,
});
console.log(`Staged auth-native complete lane unit: ${target}; ${path}`);
