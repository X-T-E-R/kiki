import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { server: 'src/index.ts' },
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  external: [
    '@moonshot-ai/agent-core-v2',
    '@moonshot-ai/kimi-code-sdk',
    '@moonshot-ai/kosong',
    '@moonshot-ai/kaos',
  ],
});
