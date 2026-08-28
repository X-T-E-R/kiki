import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'vis-server',
    include: ['test/**/*.{test,integration,e2e}.ts'],
  },
});
