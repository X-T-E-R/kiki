import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'vis-web',
    include: ['test/**/*.{test,integration,e2e}.ts', 'src/**/*.{test,integration,e2e}.ts'],
    environment: 'node',
  },
});
