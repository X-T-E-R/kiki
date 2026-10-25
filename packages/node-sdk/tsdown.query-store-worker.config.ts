import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

const workerEntry = resolve(
  import.meta.dirname,
  '../agent-core-v2/src/persistence/backends/sqlite/entry.ts',
);

export default defineConfig({
  entry: { 'query-store-worker': workerEntry },
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
