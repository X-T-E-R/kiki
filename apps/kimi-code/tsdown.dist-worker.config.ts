// Bundle each kap-server worker as a self-contained sibling of dist/main.mjs.
// Dev uses source entries; SEA uses the matching extracted worker assets.
// Each config has one input because codeSplitting:false forbids multiple inputs.

import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

const appRoot = import.meta.dirname;

function workerConfig(name: string, entry: string) {
  return defineConfig({
    name,
    entry: { [name]: resolve(appRoot, entry) },
    format: ['esm'],
    outDir: 'dist',
    clean: false,
    dts: false,
    hash: false,
    platform: 'node',
    target: 'node24',
    sourcemap: false,
    minify: false,
    silent: true,
    deps: {
      alwaysBundle: [/^@kiki\//],
      onlyBundle: false,
    },
    outputOptions: {
      codeSplitting: false,
      entryFileNames: '[name].mjs',
    },
  });
}

export default [
  workerConfig('search-worker', '../../packages/kap-server/src/search/worker/entry.ts'),
  workerConfig('usage-parser-worker', '../../packages/kap-server/src/usage/worker/entry.ts'),
  workerConfig('query-store-worker', '../../packages/agent-core-v2/src/persistence/backends/sqlite/entry.ts'),
];
