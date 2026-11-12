import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';
import { BUILT_IN_CATALOG_DEFINE, builtInCatalogDefine } from './scripts/built-in-catalog.mjs';

const appRoot = import.meta.dirname;
const outDir = resolve(appRoot, 'dist-android');
const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string };

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

const optionalNativeDependencies = new Set([
  '@napi-rs/keyring',
  '@kiki/auth-native',
  'node-pty',
  '@mariozechner/clipboard',
  'cpu-features',
  'zlib-sync',
]);

function shouldAlwaysBundle(id: string): boolean {
  if (builtins.has(id) || id.startsWith('node:')) return false;
  if (optionalNativeDependencies.has(id)) return false;
  return true;
}

const cjsCompatBanner = [
  "import { createRequire as __androidCreateRequire } from 'node:module';",
  "import { fileURLToPath as __androidFileURLToPath } from 'node:url';",
  "import { dirname as __androidDirname } from 'node:path';",
  'const require = __androidCreateRequire(import.meta.url);',
  'const __filename = __androidFileURLToPath(import.meta.url);',
  'const __dirname = __androidDirname(__filename);',
].join('\n');

function bundleConfig(name: string, entry: string, clean = false) {
  return defineConfig({
    name,
    entry: { [name]: resolve(appRoot, entry) },
    format: ['esm'],
    outDir,
    clean,
    dts: false,
    hash: false,
    platform: 'node',
    target: 'node24',
    sourcemap: false,
    minify: false,
    banner: { js: cjsCompatBanner },
    plugins: [rawTextPlugin()],
    alias: {
      '@': resolve(appRoot, 'src'),
    },
    define: {
      [BUILT_IN_CATALOG_DEFINE]: builtInCatalogDefine(),
      __KIKI_VERSION__: JSON.stringify(packageJson.version),
      __KIKI_CHANNEL__: JSON.stringify(process.env['KIKI_CHANNEL'] ?? 'android'),
      __KIKI_COMMIT__: JSON.stringify(process.env['KIKI_COMMIT'] ?? ''),
      __KIKI_BUILD_TARGET__: JSON.stringify(process.env['KIKI_BUILD_TARGET'] ?? 'android-arm64'),
    },
    deps: {
      alwaysBundle: shouldAlwaysBundle,
      neverBundle: [...optionalNativeDependencies],
      onlyBundle: false,
    },
    outputOptions: {
      codeSplitting: false,
      entryFileNames: '[name].mjs',
    },
  });
}

export default [
  bundleConfig('entry', './src/android-entry.ts', true),
  bundleConfig('text-build-worker', '../../packages/minidb/src/worker/text-build-worker.ts'),
  bundleConfig('sqlite-indexer', '../../packages/kap-server/src/search/sqlite/indexerDev.ts'),
  bundleConfig('sqlite-query-worker', '../../packages/kap-server/src/search/sqlite/queryEntry.ts'),
  bundleConfig('history-navigation-worker', '../../packages/kap-server/src/services/history/worker/entry.ts'),
  bundleConfig('usage-parser-worker', '../../packages/kap-server/src/usage/worker/entry.ts'),
  bundleConfig('query-store-worker', '../../packages/agent-core-v2/src/persistence/backends/sqlite/entry.ts'),
  bundleConfig('usage-read-model-worker', '../../packages/agent-core-v2/src/persistence/backends/sqlite/usageEntry.ts'),
  bundleConfig('mailbox-worker', '../../packages/agent-core-v2/src/persistence/backends/sqliteMailbox/entry.ts'),
  bundleConfig('memory-worker', '../../packages/agent-core-v2/src/persistence/backends/sqliteMemory/entry.ts'),
  bundleConfig('cpu-worker', '../../packages/agent-core-v2/src/app/cpuWorker/entry.ts'),
  bundleConfig('plugin-isolation-worker', '../../packages/agent-core-v2/src/app/cordisRuntime/isolationWorkerEntry.ts'),
];
