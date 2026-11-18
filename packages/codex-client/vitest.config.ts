import { defineConfig } from 'vitest/config';
import { DEFAULT_VITEST_EXCLUDE } from '../../build/vitest-default-excludes.mjs';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.integration.ts'],
    exclude: DEFAULT_VITEST_EXCLUDE,
  },
});
