import { defineConfig } from 'tsdown';

import {
  BUILT_IN_CATALOG_DEFINE,
  builtInCatalogDefine,
} from '../../apps/kimi-code/scripts/built-in-catalog.mjs';

export default defineConfig({
  entry: ['./src/index.ts', './src/mcp/stdio.ts'],
  format: ['esm'],
  dts: { eager: true },
  outDir: 'dist',
  clean: true,
  deps: {
    alwaysBundle: [/^@kiki\/klient\/procedures/u],
  },
  define: {
    [BUILT_IN_CATALOG_DEFINE]: builtInCatalogDefine(),
  },
});
