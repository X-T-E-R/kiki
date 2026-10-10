/** App-local vitest config: keeps `pnpm --filter @kiki/gui test` scoped to this
 * package instead of bubbling up to the root projects config. */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * `zod` belongs to `@kiki/protocol`, not to this app, and nothing the app
 * ships imports it. A test that checks a manifest against the real protocol
 * schema still needs it, so it is resolved from the package that owns it
 * rather than added as a dependency here.
 *
 * `fileURLToPath`, not `URL.pathname`: a pathname is percent-encoded, so a
 * checkout under a path with a space or a non-ASCII character would resolve to
 * a directory that does not exist.
 */
const protocolZod = createRequire(import.meta.url).resolve('zod', {
  paths: [fileURLToPath(new URL('../../packages/protocol', import.meta.url))],
});

export default defineConfig({
  resolve: {
    alias: {
      zod: protocolZod,
    },
  },
  test: {
    include: ['src/**/*.{test,integration,e2e}.ts', 'src/**/*.{test,integration,e2e}.tsx'],
  },
});
