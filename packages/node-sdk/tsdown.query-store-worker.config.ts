import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

const workerAlwaysBundle = [
  /^@kiki\//,
  /^@jimp\//,
  /^@jsquash\/webp(?:\/|$)/,
  /^jimp$/,
  /^wasm-feature-detect$/,
  /^zod$/,
];

const workerEntry = resolve(
  import.meta.dirname,
  '../agent-core-v2/src/persistence/backends/sqlite/entry.ts',
);
const usageReadModelWorkerEntry = resolve(
  import.meta.dirname,
  '../agent-core-v2/src/persistence/backends/sqlite/usageEntry.ts',
);
const mailboxWorkerEntry = resolve(
  import.meta.dirname,
  '../agent-core-v2/src/persistence/backends/sqliteMailbox/entry.ts',
);

function workerConfig(name: string, entry: string) {
  return defineConfig({
    name,
    entry: { [name]: entry },
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
  workerConfig('query-store-worker', workerEntry),
  workerConfig('usage-read-model-worker', usageReadModelWorkerEntry),
  workerConfig('mailbox-worker', mailboxWorkerEntry),
  workerConfig('memory-worker', resolve(import.meta.dirname, '../agent-core-v2/src/persistence/backends/sqliteMemory/entry.ts')),
  workerConfig('cpu-worker', resolve(import.meta.dirname, '../agent-core-v2/src/app/cpuWorker/entry.ts')),
];
