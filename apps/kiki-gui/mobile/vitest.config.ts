import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@kiki/protocol/pairing': fileURLToPath(
        new URL('../../../packages/protocol/src/pairing.ts', import.meta.url),
      ),
      '@kiki/protocol': fileURLToPath(
        new URL('../../../packages/protocol/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'mobile-launcher',
    include: ['test/**/*.test.ts'],
  },
});
