import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@kiki/plugin-sdk/harness-quota': fileURLToPath(new URL('../plugin-sdk/src/harness-quota.ts', import.meta.url)),
    },
  },
  test: {
    name: 'agent-core-v2',
    maxWorkers: 4,
    sequence: { groupOrder: 1 },
    include: ['test/**/*.{test,integration,e2e}.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
