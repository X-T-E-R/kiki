import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.{test,integration,e2e}.ts'],
    environment: 'node',
  },
});
