import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';
import { DEFAULT_VITEST_EXCLUDE } from '../../build/vitest-default-excludes.mjs';

const localExclude = DEFAULT_VITEST_EXCLUDE.filter(
  (pattern) => pattern !== '**/*.local.test.ts' && pattern !== '**/*.local.test.tsx',
);

const pkg = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

export default defineConfig({
  plugins: [rawTextPlugin()],
  resolve: {
    alias: [
      { find: /^@kiki\/plugin-sdk$/, replacement: pkg('plugin-sdk/src/index.ts') },
      { find: /^@kiki\/plugin-sdk\/(.+)$/, replacement: pkg('plugin-sdk/src/$1.ts') },
      { find: /^@kiki\/protocol$/, replacement: pkg('protocol/src/index.ts') },
      { find: /^@kiki\/protocol\/(.+)$/, replacement: pkg('protocol/src/$1.ts') },
      { find: /^@kiki\/kaos$/, replacement: pkg('kaos/src/index.ts') },
      { find: /^@kiki\/kaos\/(.+)$/, replacement: pkg('kaos/src/$1') },
      { find: /^@kiki\/agent-core-v2$/, replacement: pkg('agent-core-v2/src/index.ts') },
      { find: /^@kiki\/agent-core-v2\/(.+)$/, replacement: pkg('agent-core-v2/src/$1') },
      { find: /^@kiki\/agent-profiles$/, replacement: pkg('agent-profiles/src/index.ts') },
      { find: /^@kiki\/agent-profiles\/(.+)$/, replacement: pkg('agent-profiles/src/$1.ts') },
      { find: /^@kiki\/transcript$/, replacement: pkg('transcript/src/index.ts') },
    ],
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
