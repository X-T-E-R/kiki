import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

// `rawTextPlugin` is required because server-v2 pulls in agent-core-v2's full
// barrel, which imports `*.md?raw` prompt templates.

/**
 * Files that cannot share the fork pool with another test file. `a23c2c5839`
 * turned file parallelism off for the whole package as a blunt fix; the
 * 2026-09-29 sweep found no file that conflicts with another one (see the
 * test-architecture note), so this list stays empty until one does.
 *
 * Add a file here only together with the failure it produces, never "to be
 * safe": a serial file is a file nobody else can run beside.
 */
const SERIAL_FILES: string[] = [];

const sharedTestOptions = {
  setupFiles: ['test/setup.ts'],
  pool: 'forks' as const,
  // A hung test costs 30s, not the two minutes the old 120_000 budget spent
  // waiting in silence. Timeouts are defects, not load spikes.
  testTimeout: 30_000,
  // `beforeEach` starts a real Fastify and mkdtemps a home; the 10s default
  // hook budget reports ordinary startup load as "Hook timed out".
  hookTimeout: 30_000,
  teardownTimeout: 10_000,
};

const parallel = {
  plugins: [rawTextPlugin()],
  test: {
    ...sharedTestOptions,
    name: 'kap-server',
    include: ['test/**/*.{test,integration,e2e}.ts'],
    exclude: SERIAL_FILES,
    fileParallelism: true,
    maxWorkers: 4,
  },
};

// An empty project keeps a pool waiting for files that never come, so it only
// exists once it has something to hold.
const serial = {
  plugins: [rawTextPlugin()],
  test: {
    ...sharedTestOptions,
    name: 'kap-server-serial',
    include: SERIAL_FILES,
    fileParallelism: false,
  },
};

export default defineConfig({
  test: {
    projects: SERIAL_FILES.length === 0 ? [parallel] : [parallel, serial],
  },
});
