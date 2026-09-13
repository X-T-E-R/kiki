import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';
import { BUILT_IN_CATALOG_DEFINE, builtInCatalogDefine } from './scripts/built-in-catalog.mjs';

const appRoot = import.meta.dirname;
const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string };

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const optionalNativeDependencies = new Set(['cpu-features']);

function shouldAlwaysBundle(id: string): boolean {
  if (builtins.has(id) || id.startsWith('node:')) return false;
  if (optionalNativeDependencies.has(id)) return false;
  // Everything else is force-bundled, including `@kiki/*` and its
  // transitive dependencies, so the SEA bundle is self-contained.
  return true;
}

function buildTarget(): string {
  return process.env['KIKI_BUILD_TARGET'] ?? `${process.platform}-${process.arch}`;
}

export default defineConfig({
  entry: ['./src/main.ts'],
  format: ['cjs'],
  outDir: 'dist-native/intermediates',
  clean: true,
  dts: false,
  fixedExtension: true,
  hash: false,
  platform: 'node',
  target: 'node24',
  banner: { js: '#!/usr/bin/env node' },
  plugins: [rawTextPlugin()],
  alias: {
    '@': resolve(appRoot, 'src'),
  },
  define: {
    [BUILT_IN_CATALOG_DEFINE]: builtInCatalogDefine(),
    __KIKI_VERSION__: JSON.stringify(packageJson.version),
    __KIKI_CHANNEL__: JSON.stringify(process.env['KIKI_CHANNEL'] ?? ''),
    __KIKI_COMMIT__: JSON.stringify(process.env['KIKI_COMMIT'] ?? ''),
    __KIKI_BUILD_TARGET__: JSON.stringify(buildTarget()),
    __KIKI_NATIVE_BUNDLE__: 'true',
  },
  deps: {
    alwaysBundle: shouldAlwaysBundle,
    neverBundle: [...optionalNativeDependencies],
    onlyBundle: false,
  },
  outputOptions: {
    codeSplitting: false,
    entryFileNames: 'main.cjs',
  },
  checks: {
    legacyCjs: false,
  },
});
