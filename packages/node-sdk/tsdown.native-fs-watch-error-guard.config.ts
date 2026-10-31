import { defineConfig } from 'tsdown';

export default defineConfig(['native-fs-watch-error-guard', 'worker-heap-policy'].map(name => ({
  entry: [`./src/${name}.ts`],
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
})));
