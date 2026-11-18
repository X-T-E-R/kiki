import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';
import { DEFAULT_VITEST_EXCLUDE } from '../../build/vitest-default-excludes.mjs';

const localExclude = DEFAULT_VITEST_EXCLUDE.filter(
  (pattern) => pattern !== '**/*.local.test.ts' && pattern !== '**/*.local.test.tsx',
);

export default defineConfig({
  plugins: [rawTextPlugin()],
  resolve: {
    alias: {
      '@kiki/plugin-sdk/harness-quota': fileURLToPath(new URL('../plugin-sdk/src/harness-quota.ts', import.meta.url)),
    },
  },
  test: {
    name: 'kap-server-perf-local',
    setupFiles: ['test/setup.ts'],
    pool: 'forks',
    testTimeout: 180_000,
    hookTimeout: 60_000,
    teardownTimeout: 15_000,
    include: ['test/perf/**/*.local.test.ts'],
    exclude: localExclude,
    fileParallelism: false,
  },
});
