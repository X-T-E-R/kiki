import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/native-fs-watch-error-guard.ts'],
  format: ['esm'],
  dts: { eager: true },
  outDir: 'dist',
  clean: false,
  deps: {
    alwaysBundle: [/^@kiki\//],
    neverBundle: [],
  },
  outputOptions: {
    codeSplitting: false,
  },
});
