/** App-local vitest config: keeps `pnpm --filter @moonshot-ai/kimi-inspect test` scoped. */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.{test,integration,e2e}.ts',
      'src/**/*.{test,integration,e2e}.tsx',
      'vite/**/*.{test,integration,e2e}.ts',
    ],
  },
});
