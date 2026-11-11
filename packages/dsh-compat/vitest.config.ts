import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/cosmokit': fileURLToPath(new URL('../cordis-runtime/src/vendor/cosmokit/index.ts', import.meta.url)),
      '@deepseek-ai/cordis': fileURLToPath(new URL('../cordis-runtime/src/vendor/cordis/index.ts', import.meta.url)),
      '@deepseek-ai/schemastery': fileURLToPath(new URL('../cordis-runtime/src/vendor/schemastery/index.ts', import.meta.url)),
      '@deepseek-ai/dsh-scope': fileURLToPath(new URL('../cordis-runtime/src/vendor/scope/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'dsh-compat',
    pool: 'forks',
    execArgv: ['--import', 'tsx/esm'],
    server: {
      deps: {
        external: [/packages[\\/]dsh-compat[\\/]src[\\/]/],
      },
    },
    include: ['test/**/*.{test,integration,e2e}.ts'],
  },
});
