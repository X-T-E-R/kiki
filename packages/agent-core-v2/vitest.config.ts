import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'agent-core-v2',
    include: ['test/**/*.{test,integration,e2e}.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
