import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

// Perf harnesses live outside the default suite: they report timings instead of
// asserting behaviour, so a shared machine must not fail the build on them.
// Run with `pnpm --filter @moonshot-ai/kap-server run bench`.
export default defineConfig({
  plugins: [rawTextPlugin()],
  test: {
    name: 'kap-server-bench',
    include: ['bench/**/*.bench.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 120_000,
  },
});
