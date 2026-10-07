import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@kiki/plugin-sdk/media': fileURLToPath(new URL('../plugin-sdk/src/media.ts', import.meta.url)),
      '@kiki/plugin-sdk/media-download': fileURLToPath(new URL('../plugin-sdk/src/media-download.ts', import.meta.url)),
      '@kiki/plugin-sdk/session-import': fileURLToPath(new URL('../plugin-sdk/src/session-import.ts', import.meta.url)),
      '@kiki/plugin-sdk': fileURLToPath(new URL('../plugin-sdk/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'protocol',
    include: ['src/__tests__/**/*.{test,integration,e2e}.ts'],
  },
});
