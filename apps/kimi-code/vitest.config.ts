import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';
import { DEFAULT_VITEST_EXCLUDE } from '../../build/vitest-default-excludes.mjs';

const appRoot = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(appRoot, 'src'),
    },
  },
  test: {
    name: 'cli',
    env: {
      KIKI_LOG_LEVEL: 'off',
    },
    include: ['test/**/*.{test,integration,e2e}.ts', 'test/**/*.{test,integration,e2e}.tsx'],
    exclude: DEFAULT_VITEST_EXCLUDE,
  },
});
