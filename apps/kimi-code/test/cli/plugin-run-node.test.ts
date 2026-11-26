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

it('supports standalone KIKI_NODE_SHIM --eval, --print, and script args while keeping KIKI_PLUGIN_ROOT bounds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kiki-node-shim-'));
  try {
    const pluginDir = join(root, 'plugin');
    mkdirSync(pluginDir, { recursive: true });
    const insideScript = join(pluginDir, 'echo-args.mjs');
    const outsideScript = join(root, 'outside.mjs');
    writeFileSync(insideScript, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    writeFileSync(outsideScript, 'console.log("escaped");\n');

    await build({
      ...nativeConfig,
      config: false,
      entry: [fileURLToPath(new URL('../../src/plugin-node-entry.ts', import.meta.url))],
      outDir: join(root, 'out'),
    });
    const bundleEntry = join(root, 'out/main.cjs');
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      KIKI_NODE_SHIM: '1',
      KIKI_HOME: join(root, 'home'),
      KIKI_CACHE_DIR: join(root, 'cache'),
      NODE_OPTIONS: '',
    };
    delete baseEnv['KIKI_PLUGIN_ROOT'];

    const evalRun = spawnSync(
      process.execPath,
      [bundleEntry, '__plugin_run_node', '-e', "console.log('node-ok')"],
      { encoding: 'utf8', timeout: 10_000, env: baseEnv },
    );
    expect(evalRun.status).toBe(0);
    expect(evalRun.stdout.trim()).toBe('node-ok');

    const printRun = spawnSync(
      process.execPath,
      [bundleEntry, '__plugin_run_node', '-p', '20 + 22'],
      { encoding: 'utf8', timeout: 10_000, env: baseEnv },
    );
    expect(printRun.status).toBe(0);
    expect(printRun.stdout.trim()).toBe('42');

    const scriptRun = spawnSync(
      process.execPath,
      [bundleEntry, '__plugin_run_node', insideScript, '-v', '--flag'],
      { encoding: 'utf8', timeout: 10_000, env: baseEnv },
    );
    expect(scriptRun.status).toBe(0);
    expect(JSON.parse(scriptRun.stdout)).toEqual(['-v', '--flag']);

    const escapedPluginRun = spawnSync(
      process.execPath,
      [bundleEntry, '__plugin_run_node', outsideScript],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...baseEnv, KIKI_PLUGIN_ROOT: pluginDir },
      },
    );
    expect(escapedPluginRun.status).toBe(1);
    expect(escapedPluginRun.stderr).toContain('inside KIKI_PLUGIN_ROOT');

    if (process.platform === 'win32') {
      const { createToolchainNodeCmd } = await import('../../../kiki-gui/scripts/stage-windows-toolchain.mjs');
      const nodeCmdPath = join(root, 'node.cmd');
      const fakeSeaWrapper = join(root, 'sea-wrapper.cmd');
      const exit3Script = join(pluginDir, 'exit3.mjs');
      writeFileSync(nodeCmdPath, createToolchainNodeCmd(), 'utf8');
      writeFileSync(fakeSeaWrapper, `@echo off\r\n"${process.execPath}" "${bundleEntry}" %*\r\nexit /b %ERRORLEVEL%\r\n`, 'utf8');
      writeFileSync(exit3Script, 'process.exit(3);\n', 'utf8');

      const comSpec = process.env['ComSpec'] ?? 'C:\\Windows\\System32\\cmd.exe';
      const cmdParenRun = spawnSync(
        comSpec,
        ['/d', '/s', '/c', `""${nodeCmdPath}" -e "console.log('node-ok')""`],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env: { ...baseEnv, KIKI_SEA_EXEC: fakeSeaWrapper },
          windowsVerbatimArguments: true,
        },
      );
      expect(cmdParenRun.status).toBe(0);
      expect(cmdParenRun.stdout.trim()).toBe('node-ok');

      const cmdExit3Run = spawnSync(
        comSpec,
        ['/d', '/s', '/c', `""${nodeCmdPath}" "${exit3Script}""`],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env: { ...baseEnv, KIKI_SEA_EXEC: fakeSeaWrapper, KIKI_PLUGIN_ROOT: pluginDir },
          windowsVerbatimArguments: true,
        },
      );
      expect(cmdExit3Run.status).toBe(3);

      const cmdMissingRun = spawnSync(
        comSpec,
        ['/d', '/s', '/c', `""${nodeCmdPath}" "${join(pluginDir, 'nonexistent.mjs')}""`],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env: { ...baseEnv, KIKI_SEA_EXEC: fakeSeaWrapper, KIKI_PLUGIN_ROOT: pluginDir },
          windowsVerbatimArguments: true,
        },
      );
      expect(cmdMissingRun.status).toBe(1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
