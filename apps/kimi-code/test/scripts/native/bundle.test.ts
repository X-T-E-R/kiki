import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'tsdown';
import { describe, expect, it } from 'vitest';
import nativeConfig from '../../../tsdown.native.config';

import { resolvePnpmInvocation } from '../../../scripts/native/01-bundle.mjs';

describe('resolvePnpmInvocation', () => {
  it('runs the package-manager script through the active Node executable', () => {
    expect(
      resolvePnpmInvocation(
        { npm_execpath: 'C:\\corepack\\pnpm.js' },
        'win32',
        'C:\\node\\node.exe',
      ),
    ).toEqual({
      command: 'C:\\node\\node.exe',
      args: ['C:\\corepack\\pnpm.js'],
    });
  });

  it('uses Corepack beside the active Node executable when invoked directly', () => {
    expect(resolvePnpmInvocation({}, 'win32', 'C:\\node\\node.exe', () => true)).toEqual({
      command: 'C:\\node\\node.exe',
      args: ['C:\\node\\node_modules\\corepack\\dist\\pnpm.js'],
    });
    expect(resolvePnpmInvocation({}, 'linux', '/usr/bin/node', () => true)).toEqual({
      command: '/usr/bin/node',
      args: ['/usr/bin/node_modules/corepack/dist/pnpm.js'],
    });
  });

  it('uses the platform shim when the active Node installation has no Corepack', () => {
    expect(resolvePnpmInvocation({}, 'win32', 'C:\\node\\node.exe', () => false)).toEqual({
      command: 'pnpm.cmd',
      args: [],
    });
    expect(resolvePnpmInvocation({}, 'linux', '/usr/bin/node', () => false)).toEqual({
      command: 'pnpm',
      args: [],
    });
  });
});


describe('SEA native package imports', () => {
  it('loads validated disk ESM with top-level await through the bundled plugin entry', async () => {
    mkdirSync(resolve('.tmp'), { recursive: true });
    const dir = mkdtempSync(resolve('.tmp', 'plugin-node-bundle-'));
    try {
      const entry = join(dir, 'entry.ts');
      const nativeAssets = join(dir, 'native-assets.ts');
      const pluginRoot = join(dir, 'plugin');
      const plugin = join(pluginRoot, 'entry.mjs');
      mkdirSync(pluginRoot);
      writeFileSync(nativeAssets, 'export function getPluginHostRunnerFile() { return null; }\n');
      writeFileSync(plugin, "await Promise.resolve(); console.log(JSON.stringify(process.argv.slice(1)));\n");
      writeFileSync(entry, `import { runPluginNodeEntry } from ${JSON.stringify(resolve('src/cli/sub/plugin-run-node.ts'))};\nrunPluginNodeEntry(process.argv[2], process.argv.slice(3)).catch(error => { console.error(error); process.exitCode = 1; });\n`);
      await build({
        ...nativeConfig,
        config: false,
        entry: [entry],
        outDir: join(dir, 'out'),
        alias: { ...nativeConfig.alias, '#/native/native-assets': nativeAssets },
      });
      const result = spawnSync(process.execPath, [join(dir, 'out/main.cjs'), plugin, 'example'], {
        env: { ...process.env, KIKI_PLUGIN_ROOT: pluginRoot },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([plugin, 'example']);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('keeps node-pty external and routes its dynamic import through regular CJS require', async () => {
    mkdirSync(resolve('.tmp'), { recursive: true });
    const dir = mkdtempSync(resolve('.tmp', 'native-bundle-'));
    try {
      const entry = join(dir, 'entry.ts');
      writeFileSync(entry, "export async function load() { return await import('node-pty'); }\n");
      await build({ ...nativeConfig, config: false, entry: [entry], outDir: join(dir, 'out') });
      const output = readFileSync(join(dir, 'out/main.cjs'), 'utf8');
      expect(output).toContain('createRequire(process.execPath)');
      expect(output).toMatch(/require\(["']node-pty["']\)/);
      expect(output).not.toMatch(/import\(["']node-pty["']\)/);
      expect(output).not.toContain('class WindowsTerminal');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
