import { resolve } from 'node:path';
import { defineConfig } from 'tsdown';

export default defineConfig({
  cwd: import.meta.dirname,
  entry: {
    'agy-cli-acp': resolve(import.meta.dirname, 'src/index.ts'),
  },
  outDir: import.meta.dirname,
  tsconfig: resolve(import.meta.dirname, 'tsconfig.json'),
  clean: false,
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  dts: false,
  minify: false,
  fixedExtension: true,
  banner: {
    js: [
      '/* oxlint-disable */',
      '// Denial accounting, step usage and subagent projection are adapted from Paseo (Apache-2.0).',
      "// Copyright (c) 2025-present Mohamed Boudra. Modified for Kiki's ACP bridge; see packages/acp-client/THIRD_PARTY_NOTICES.md.",
    ].join('\n'),
  },
  deps: {
    alwaysBundle: ['@bufbuild/protobuf', '@bufbuild/protobuf/wire'],
    onlyBundle: ['@bufbuild/protobuf'],
    neverBundle: [/^node:/],
  },
  plugins: [
    {
      name: 'externalize-sibling-adapters',
      resolveId(source) {
        const match = /^\.\.\/(agy-[a-z-]+\.mjs)$/.exec(source);
        if (match) {
          return { id: `./${match[1]}`, external: true };
        }
        return null;
      },
    },
  ],
});
