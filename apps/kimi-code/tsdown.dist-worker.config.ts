// Bundle each kap-server worker as a self-contained sibling of dist/main.mjs.
// Dev uses source entries; SEA uses the matching extracted worker assets.
// Each config has one input because codeSplitting:false forbids multiple inputs.

import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

const appRoot = import.meta.dirname;
const workerAlwaysBundle = [
  /^@kiki\//,
  /^@jimp\//,
  /^@jsquash\/webp(?:\/|$)/,
  /^jimp$/,
  /^wasm-feature-detect$/,
  /^zod$/,
];

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
    plugins: [rawTextPlugin()],
    deps: {
      alwaysBundle: workerAlwaysBundle,
      onlyBundle: false,
    },
    outputOptions: {
      codeSplitting: false,
      entryFileNames: '[name].mjs',
    },
  });
}

export default [
  workerConfig('usage-parser-worker', '../../packages/kap-server/src/usage/worker/entry.ts'),
  workerConfig('query-store-worker', '../../packages/agent-core-v2/src/persistence/backends/sqlite/entry.ts'),
  workerConfig('usage-read-model-worker', '../../packages/agent-core-v2/src/persistence/backends/sqlite/usageEntry.ts'),
  workerConfig('mailbox-worker', '../../packages/agent-core-v2/src/persistence/backends/sqliteMailbox/entry.ts'),
  workerConfig('memory-worker', '../../packages/agent-core-v2/src/persistence/backends/sqliteMemory/entry.ts'),
  workerConfig('cpu-worker', '../../packages/agent-core-v2/src/app/cpuWorker/entry.ts'),
];
