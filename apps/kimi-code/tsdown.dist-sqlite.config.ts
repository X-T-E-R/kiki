import { resolve } from 'node:path';
import { defineConfig } from 'tsdown';

const root = import.meta.dirname;

function worker(name: string, entry: string) {
  return defineConfig({
    entry: { [name]: resolve(root, entry) },
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
    deps: { alwaysBundle: [/^@kiki\//], onlyBundle: false },
    outputOptions: { codeSplitting: false, entryFileNames: '[name].mjs' },
  });
}

export default [
  worker('sqlite-indexer', '../../packages/kap-server/src/search/sqlite/indexerDev.ts'),
  worker('sqlite-query-worker', '../../packages/kap-server/src/search/sqlite/queryEntry.ts'),
];
