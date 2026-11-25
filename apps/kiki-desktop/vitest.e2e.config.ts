import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
