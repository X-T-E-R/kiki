import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'transcript-live',
    include: ['test/**/*.{test,integration,e2e}.ts'],
  },
});
