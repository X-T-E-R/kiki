import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { DEFAULT_VITEST_EXCLUDE } from '../../build/vitest-default-excludes.mjs';

const pkg = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@kiki\/plugin-sdk$/, replacement: pkg('plugin-sdk/src/index.ts') },
      { find: /^@kiki\/plugin-sdk\/(.+)$/, replacement: pkg('plugin-sdk/src/$1.ts') },
      { find: /^@kiki\/protocol$/, replacement: pkg('protocol/src/index.ts') },
      { find: /^@kiki\/protocol\/(.+)$/, replacement: pkg('protocol/src/$1.ts') },
      { find: /^@kiki\/kaos$/, replacement: pkg('kaos/src/index.ts') },
      { find: /^@kiki\/kaos\/(.+)$/, replacement: pkg('kaos/src/$1') },
      { find: /^@kiki\/agent-profiles$/, replacement: pkg('agent-profiles/src/index.ts') },
      { find: /^@kiki\/agent-profiles\/(.+)$/, replacement: pkg('agent-profiles/src/$1.ts') },
      { find: /^@kiki\/transcript$/, replacement: pkg('transcript/src/index.ts') },
    ],
  },
  test: {
    name: 'agent-core-v2',
    maxWorkers: 4,
    sequence: { groupOrder: 1 },
    include: ['test/**/*.{test,integration,e2e}.ts'],
    exclude: DEFAULT_VITEST_EXCLUDE,
    setupFiles: ['test/setup.ts'],
  },
});
