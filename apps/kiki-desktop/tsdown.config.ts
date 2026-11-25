import { defineConfig } from 'tsdown';

export default defineConfig([
  {
    entry: ['./src/main/index.ts'],
    format: ['esm'],
    target: 'node24',
    outDir: 'dist/main',
    clean: true,
    dts: false,
    sourcemap: true,
    deps: {
      neverBundle: ['electron', 'electron-updater'],
    },
    outputOptions: {
      entryFileNames: 'index.js',
    },
  },
  {
    entry: ['./src/preload/index.ts'],
    format: ['cjs'],
    target: 'node24',
    outDir: 'dist/preload',
    clean: false,
    dts: false,
    sourcemap: true,
    deps: {
      neverBundle: ['electron'],
    },
    outputOptions: {
      entryFileNames: 'index.cjs',
    },
  },
]);
