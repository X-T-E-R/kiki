import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const BUILT_IN_CATALOG_ENV = 'KIKI_BUILT_IN_CATALOG_FILE';
const BUILT_IN_CATALOG_DEFINE = '__KIKI_BUILT_IN_CATALOG__';

function builtInCatalogDefine(env = process.env) {
  const file = env[BUILT_IN_CATALOG_ENV];
  if (file === undefined || file.length === 0) return 'undefined';
  return JSON.stringify(readFileSync(file, 'utf-8'));
}

export default defineConfig({
  entry: ['./src/index.ts', './src/mcp/stdio.ts', './src/mcp/stdioRuntime.ts'],
  format: ['esm'],
  dts: { eager: true },
  tsconfig: 'tsconfig.build.json',
  outDir: 'dist',
  clean: true,
  deps: {
    alwaysBundle: [/^@kiki\/klient\/procedures/u],
  },
  define: {
    [BUILT_IN_CATALOG_DEFINE]: builtInCatalogDefine(),
  },
});
