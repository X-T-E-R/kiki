/** App-local vitest config: keeps `pnpm --filter @kiki/gui test` scoped to this
 * package instead of bubbling up to the root projects config. */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.{test,integration,e2e}.ts', 'src/**/*.{test,integration,e2e}.tsx'],
  },
});
