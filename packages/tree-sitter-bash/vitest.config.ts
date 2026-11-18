import { defineConfig } from 'vitest/config';
import { DEFAULT_VITEST_EXCLUDE } from '../../build/vitest-default-excludes.mjs';

export default defineConfig({
  test: {
    name: 'tree-sitter-bash',
    include: ['test/**/*.{test,integration,e2e}.ts'],
    exclude: DEFAULT_VITEST_EXCLUDE,
  },
});
