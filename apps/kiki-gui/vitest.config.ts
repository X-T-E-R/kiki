/** App-local vitest config: keeps `pnpm --filter @kiki/gui test` scoped to this
 * package instead of bubbling up to the root projects config. */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';
import { DEFAULT_VITEST_EXCLUDE } from '../../build/vitest-default-excludes.mjs';
import { pdfAssetsPlugin } from './vite/pdfAssets';

/**
 * `zod` belongs to `@kiki/protocol`, not to this app, and nothing the app
 * ships imports it. A test that checks a manifest against the real protocol
 * schema still needs it, so it is resolved from the package that owns it
 * rather than added as a dependency here.
 *
 * `fileURLToPath`, not `URL.pathname`: a pathname is percent-encoded, so a
 * checkout under a path with a space or a non-ASCII character would resolve to
 * a directory that does not exist.
 */
const protocolZod = createRequire(import.meta.url).resolve('zod', {
  paths: [fileURLToPath(new URL('../../packages/protocol', import.meta.url))],
});

const sessionCoreSrc = fileURLToPath(new URL('../../packages/session-core/src', import.meta.url));

export default defineConfig({
  plugins: [pdfAssetsPlugin()],
  resolve: {
    alias: [
      { find: 'zod', replacement: protocolZod },
      { find: '@kiki/protocol/agentName', replacement: fileURLToPath(new URL('../../packages/protocol/src/agentName.ts', import.meta.url)) },
      { find: '@kiki/protocol/pairing', replacement: fileURLToPath(new URL('../../packages/protocol/src/pairing.ts', import.meta.url)) },
      { find: '@kiki/protocol', replacement: fileURLToPath(new URL('../../packages/protocol/src/index.ts', import.meta.url)) },
      { find: '@kiki/plugin-sdk/media', replacement: fileURLToPath(new URL('../../packages/plugin-sdk/src/media.ts', import.meta.url)) },
      { find: '@kiki/plugin-sdk/media-download', replacement: fileURLToPath(new URL('../../packages/plugin-sdk/src/media-download.ts', import.meta.url)) },
      { find: '@kiki/plugin-sdk/harness-account', replacement: fileURLToPath(new URL('../../packages/plugin-sdk/src/harness-account.ts', import.meta.url)) },
      { find: '@kiki/plugin-sdk/harness-quota', replacement: fileURLToPath(new URL('../../packages/plugin-sdk/src/harness-quota.ts', import.meta.url)) },
      { find: '@kiki/plugin-sdk/llm-provider', replacement: fileURLToPath(new URL('../../packages/plugin-sdk/src/llm-provider.ts', import.meta.url)) },
      { find: '@kiki/plugin-sdk/provider-quota', replacement: fileURLToPath(new URL('../../packages/plugin-sdk/src/provider-quota.ts', import.meta.url)) },
      { find: '@kiki/plugin-sdk/session-import', replacement: fileURLToPath(new URL('../../packages/plugin-sdk/src/session-import.ts', import.meta.url)) },
      { find: '@kiki/plugin-sdk/im', replacement: fileURLToPath(new URL('../../packages/plugin-sdk/src/im.ts', import.meta.url)) },
      { find: '@kiki/plugin-sdk/messages', replacement: fileURLToPath(new URL('../../packages/plugin-sdk/src/messages.ts', import.meta.url)) },
      { find: '@kiki/plugin-sdk/asr', replacement: fileURLToPath(new URL('../../packages/plugin-sdk/src/asr.ts', import.meta.url)) },
      { find: '@kiki/plugin-sdk', replacement: fileURLToPath(new URL('../../packages/plugin-sdk/src/index.ts', import.meta.url)) },
      { find: /^@kiki\/session-core$/, replacement: `${sessionCoreSrc}/index.ts` },
      { find: /^@kiki\/session-core\/(transport|wire)$/, replacement: `${sessionCoreSrc}/$1.ts` },
      { find: /^@kiki\/session-core\/session\/transcript$/, replacement: `${sessionCoreSrc}/session/transcript/index.ts` },
      { find: /^@kiki\/session-core\/([^/]+)$/, replacement: `${sessionCoreSrc}/$1/index.ts` },
      { find: /^@kiki\/session-core\/(.+?)(?:\.ts)?$/, replacement: `${sessionCoreSrc}/$1.ts` },
    ],
  },
  server: {
    deps: {
      inline: ['@kiki/protocol', '@kiki/plugin-sdk', '@kiki/session-core'],
    },
  },
  test: {
    name: 'gui',
    include: ['src/**/*.{test,integration,e2e}.ts', 'src/**/*.{test,integration,e2e}.tsx'],
    exclude: DEFAULT_VITEST_EXCLUDE,
  },
});
