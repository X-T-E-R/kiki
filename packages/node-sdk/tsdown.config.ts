import { fileURLToPath } from 'node:url';
import { cp } from 'node:fs/promises';
import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: false,
  outDir: 'dist',
  clean: true,
  plugins: [rawTextPlugin()],
  onSuccess: async ({ outDir }) => {
    await cp(resolve(import.meta.dirname, '../agent-core-v2/src/app/pluginImport/builtin'), resolve(outDir, 'builtin'), { recursive: true });
    await cp(resolve(import.meta.dirname, '../agent-core-v2/src/app/plugin/hostRunner.mjs'), resolve(outDir, 'hostRunner.mjs'));
  },
  banner: {
    js: [
      "import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';",
      "import { dirname as __cjsShimDirname } from 'node:path';",
      'const __filename = __cjsShimFileURLToPath(import.meta.url);',
      'const __dirname = __cjsShimDirname(__filename);',
    ].join('\n'),
  },
  alias: {
    '@kiki/kaos': fileURLToPath(new URL('../kaos/src/index.ts', import.meta.url)),
    '@kiki/oauth/local-original-types': fileURLToPath(new URL('../oauth/src/local-original-types.ts', import.meta.url)),
    '@kiki/oauth': fileURLToPath(new URL('../oauth/src/index.ts', import.meta.url)),
  },
  deps: {
    alwaysBundle: [/^@kiki\//],
    neverBundle: [],
  },
});
