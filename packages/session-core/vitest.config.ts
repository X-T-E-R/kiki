import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'session-core',
    include: ['src/**/*.{test,integration,e2e}.ts'],
  },
});
