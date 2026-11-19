import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    launcher: './src/launcher.ts',
  },
  format: ['iife'],
  platform: 'browser',
  target: 'es2020',
  dts: false,
  sourcemap: false,
  minify: false,
  clean: false,
  outDir: 'launcher',
  deps: {
    alwaysBundle: ['jsqr'],
    onlyBundle: ['jsqr'],
  },
  alias: {
    '@kiki/protocol/pairing': fileURLToPath(
      new URL('../../../packages/protocol/src/pairing.ts', import.meta.url),
    ),
    '@kiki/protocol': fileURLToPath(
      new URL('../../../packages/protocol/src/index.ts', import.meta.url),
    ),
  },
  outputOptions: {
    entryFileNames: 'launcher.js',
    banner: '/* eslint-disable */\n/* oxlint-disable */',
  },
});
