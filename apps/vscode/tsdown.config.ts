import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/extension.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: false,
  deps: {
    neverBundle: ['vscode'],
  },
  outputOptions: {
    entryFileNames: 'extension.js',
  },
});
