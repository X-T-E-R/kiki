import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'agent-profiles',
    include: ['test/**/*.{test,integration,e2e}.ts'],
  },
});
