// Dedicated tsdown config that bundles the off-main-thread workers into
// self-contained ESM files so they can ride the SEA blob as assets
// (02-sea-blob.mjs) and be spawned from disk at runtime:
//   - text-build-worker.mjs: the minidb text-build worker
//     (packages/minidb/src/worker/text-build-worker.ts).
// Without it the bundled binary lacks the worker entry file on disk and heavy
// text-index work degrades to the inline main-thread core, stalling the event
// loop on large corpora. Runs after the main bundle with clean:false
// so all verified files remain.
//
// One config per entry: rolldown forbids `codeSplitting: false` with
// multiple inputs, and each worker must be a single self-contained file
// (check-bundle.mjs enforces zero remaining externals/relative imports).

import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

const here = import.meta.dirname;
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
    entry: { [name]: resolve(here, entry) },
    format: ['esm'],
    outDir: resolve(here, 'dist-native/intermediates'),
    entryFileNames: '[name].mjs',
    codeSplitting: false,
    platform: 'node',
    target: 'node24',
    dts: false,
    sourcemap: false,
    minify: false,
    silent: true,
    plugins: [rawTextPlugin()],
    deps: {
      // Force-bundle the workspace packages and image codecs the entries import
      // so every worker output is self-contained.
      alwaysBundle: workerAlwaysBundle,
    },
    outputOptions: {
      codeSplitting: false,
      entryFileNames: '[name].mjs',
    },
    // The intermediates dir also holds main.cjs & co. — never wipe it.
    clean: false,
  });
}

export default [
  workerConfig('text-build-worker', '../../packages/minidb/src/worker/text-build-worker.ts'),
  workerConfig('sqlite-query-worker', '../../packages/kap-server/src/search/sqlite/queryEntry.ts'),
  workerConfig('usage-parser-worker', '../../packages/kap-server/src/usage/worker/entry.ts'),
  workerConfig('query-store-worker', '../../packages/agent-core-v2/src/persistence/backends/sqlite/entry.ts'),
  workerConfig('usage-read-model-worker', '../../packages/agent-core-v2/src/persistence/backends/sqlite/usageEntry.ts'),
  workerConfig('mailbox-worker', '../../packages/agent-core-v2/src/persistence/backends/sqliteMailbox/entry.ts'),
  workerConfig('memory-worker', '../../packages/agent-core-v2/src/persistence/backends/sqliteMemory/entry.ts'),
  workerConfig('cpu-worker', '../../packages/agent-core-v2/src/app/cpuWorker/entry.ts'),
];
