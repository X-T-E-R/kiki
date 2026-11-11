import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  copy: [{ from: 'src/esmImportHelper.cjs', to: 'dist' }],
  deps: {
    onlyBundle: false,
  },
});
