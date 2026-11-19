import { defineConfig } from 'tsdown';

const subpathEntries: Record<string, string>[] = [
  ...['native-fs-watch-error-guard', 'worker-heap-policy', 'proxy'].map(name => ({ [name]: `./src/${name}.ts` })),
  { logging: './src/logging/index.ts' },
];

export default defineConfig(subpathEntries.map(entry => ({
  entry,
  format: ['esm'],
  tsconfig: 'tsconfig.subpaths.json',
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
