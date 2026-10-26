import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'lexical',
    include: ['test/**/*.{test,integration,e2e}.ts'],
  },
});
