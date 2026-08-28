import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'kaos',
    include: ['test/**/*.{test,integration,e2e}.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
