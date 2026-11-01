import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'tsdown';
import { describe, expect, it } from 'vitest';

import { validatePluginNodeEntry } from '#/cli/sub/plugin-run-node';
import nativeConfig from '../../tsdown.native.config';

describe('plugin node entry boundary', () => {
  it('runs plugin entries and only the pinned host runner outside the plugin root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kiki-plugin-node-'));
    try {
      const plugin = join(root, 'plugin');
      const outside = join(root, 'outside.mjs');
      const runner = join(root, 'hostRunner.mjs');
      const entry = join(plugin, 'entry.mjs');
      mkdirSync(plugin);
      for (const file of [entry, outside, runner]) writeFileSync(file, 'export {};\n');
      expect(await validatePluginNodeEntry(entry, ['argument'], plugin, null))
        .toEqual({ entryReal: entry, argsReal: ['argument'] });
      await expect(validatePluginNodeEntry(outside, [], plugin, runner)).rejects.toThrow('inside KIKI_PLUGIN_ROOT');
      await expect(validatePluginNodeEntry(runner, [outside], plugin, runner)).rejects.toThrow('inside KIKI_PLUGIN_ROOT');
      await expect(validatePluginNodeEntry(runner, [entry, 'extra'], plugin, runner)).rejects.toThrow('inside KIKI_PLUGIN_ROOT');
      expect(await validatePluginNodeEntry(runner, [entry], plugin, runner))
        .toEqual({ entryReal: runner, argsReal: [entry] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it('runs the narrow plugin entry under 64 MiB and exits after its owner pipe closes despite plugin timers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kiki-plugin-owner-'));
  try {
    const entry = join(root, 'entry.mjs');
    writeFileSync(entry, `
      process.stdin.resume();
      setInterval(() => {}, 100);
      console.log(JSON.stringify({ args: process.argv.slice(2), rss: process.memoryUsage().rss }));
    `);
    await build({
      ...nativeConfig,
      config: false,
      entry: [fileURLToPath(new URL('../../src/plugin-node-entry.ts', import.meta.url))],
      outDir: join(root, 'out'),
    });
    const result = spawnSync(process.execPath, [
      '--max-old-space-size=64', join(root, 'out/main.cjs'), '__plugin_run_node', entry, '--fixture-arg',
    ], {
      input: '',
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        KIKI_PLUGIN_ROOT: root,
        KIKI_HOME: join(root, 'home'),
        KIKI_CACHE_DIR: join(root, 'cache'),
        NODE_OPTIONS: '',
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const observed = JSON.parse(result.stdout);
    expect(observed.args).toEqual(['--fixture-arg']);
    expect(observed.rss).toBeLessThan(160 * 1024 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
