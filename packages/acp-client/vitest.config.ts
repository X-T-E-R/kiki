import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'acp-client',
    include: ['test/**/*.{test,integration}.ts'],
  },
});
