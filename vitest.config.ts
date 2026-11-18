import { defineConfig } from 'vitest/config';
import { DEFAULT_VITEST_EXCLUDE } from './build/vitest-default-excludes.mjs';

export default defineConfig({
  test: {
    exclude: DEFAULT_VITEST_EXCLUDE,
    projects: ['packages/*/vitest.config.ts', 'apps/kimi-code', 'apps/kiki-gui', 'apps/vscode'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', ...DEFAULT_VITEST_EXCLUDE],
      reporter: ['text', 'html'],
    },
  },
});
