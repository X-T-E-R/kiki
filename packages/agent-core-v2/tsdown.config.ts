import { cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  plugins: [rawTextPlugin()],
  onSuccess: async () => {
    await cp(resolve(import.meta.dirname, 'src/app/pluginImport/builtin'), resolve(import.meta.dirname, 'dist/builtin'), { recursive: true });
    await cp(resolve(import.meta.dirname, 'src/app/plugin/hostRunner.mjs'), resolve(import.meta.dirname, 'dist/hostRunner.mjs'));
  },
  deps: {
    neverBundle: ['@kiki/oauth'],
  },
});
