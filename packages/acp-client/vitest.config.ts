import { defineConfig } from 'vitest/config';
import { DEFAULT_VITEST_EXCLUDE } from '../../build/vitest-default-excludes.mjs';

export default defineConfig({
  test: {
    name: 'acp-client',
    include: ['test/**/*.{test,integration}.ts'],
    exclude: DEFAULT_VITEST_EXCLUDE,
  },
});
