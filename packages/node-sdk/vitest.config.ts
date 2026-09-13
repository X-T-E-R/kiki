import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@kiki/oauth': fileURLToPath(
        new URL('../oauth/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'kimi-sdk',
    env: {
      KIMI_LOG_LEVEL: 'off',
    },
    include: ['test/**/*.{test,integration,e2e}.ts'],
    // Every harness in this suite boots the v2 engine in-process against a
    // fresh temp home: config hydration, the session-index projection and the
    // workspace store put a single `createKimiHarness` in the seconds range,
    // and a test that stands up two or three of them blows past vitest's 5s
    // default long before anything is actually stuck.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
