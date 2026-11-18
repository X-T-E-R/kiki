import { defineConfig } from 'vitest/config';
import { DEFAULT_VITEST_EXCLUDE } from '../../build/vitest-default-excludes.mjs';

export default defineConfig({
  test: {
    name: 'kaos',
    include: ['test/**/*.{test,integration,e2e}.ts'],
    exclude: DEFAULT_VITEST_EXCLUDE,
    setupFiles: ['./test/setup.ts'],
  },
});
