import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'tsdown';
import { describe, expect, it, vi } from 'vitest';
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
  it('dispatches the indexer before evaluating the application import graph', async () => {
    mkdirSync(resolve('.tmp'), { recursive: true });
    const dir = mkdtempSync(resolve('.tmp', 'native-entry-bundle-'));
    try {
      const main = join(dir, 'main.ts');
      const indexer = join(dir, 'indexer.ts');
      const attached = join(dir, 'attached.ts');
      writeFileSync(main, "console.log('application-loaded');\n");
      writeFileSync(indexer, "export async function runSqliteIndexerCommand(path: string) { if (!path) throw new Error('missing-index-path'); console.log(JSON.stringify({ indexer: path })); }\n");
      writeFileSync(attached, "console.log('attached-mcp-loaded');\n");
      expect(nativeConfig.entry).toEqual(['./src/native-entry.ts']);
      await build({
        ...nativeConfig,
        config: false,
        entry: [resolve(import.meta.dirname, '../../../src/native-entry.ts')],
        outDir: join(dir, 'out'),
        alias: {
          ...nativeConfig.alias,
          './main': main,
          './mcp-sea-entry': attached,
          '@kiki/kap-server/sqlite-indexer-runtime': indexer,
        },
      });
      const bundle = join(dir, 'out/main.cjs');
      const indexed = spawnSync(process.execPath, ['--max-old-space-size=384', bundle, '__search-indexer', 'example.sqlite'], { encoding: 'utf8', timeout: 10_000 });
      expect(indexed.status).toBe(0);
      expect(indexed.stderr).toBe('');
      expect(JSON.parse(indexed.stdout)).toEqual({ indexer: 'example.sqlite' });
      const exit = vi.fn();
      const stderr = vi.fn();
      const stdout = vi.fn();
      runInNewContext(readFileSync(bundle, 'utf8'), {
        require: createRequire(import.meta.url),
        exports: {},
        console: { log: stdout },
        process: {
          argv: [process.execPath, bundle, '__search-indexer'],
          execPath: process.execPath,
          stderr: { write: stderr },
          exit,
        },
      });
      await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(1));
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledExactlyOnceWith('missing-index-path\n');
      const normal = spawnSync(process.execPath, [bundle, '--version'], { encoding: 'utf8', timeout: 10_000 });
      expect(normal.status).toBe(0);
      expect(normal.stderr).toBe('');
      expect(normal.stdout).toBe('application-loaded\n');
      const attachedProcess = spawnSync(process.execPath, [bundle, 'mcp', '--workspace', 'C:/fixture', '--attached'], { encoding: 'utf8', timeout: 10_000 });
      expect(attachedProcess.status).toBe(0);
      expect(attachedProcess.stderr).toBe('');
      expect(attachedProcess.stdout).toBe('attached-mcp-loaded\n');
      const prompted = spawnSync(process.execPath, [bundle, '-p', 'mcp', '--attached'], { encoding: 'utf8', timeout: 10_000 });
      expect(prompted.status).toBe(0);
      expect(prompted.stdout).toBe('application-loaded\n');
      const valued = spawnSync(process.execPath, [bundle, '--agent', 'mcp', '--attached'], { encoding: 'utf8', timeout: 10_000 });
      expect(valued.status).toBe(0);
      expect(valued.stdout).toBe('application-loaded\n');
      const illegal = spawnSync(process.execPath, [bundle, 'mcp', '--client', 'fixture', '--tools', '--attached'], { encoding: 'utf8', timeout: 10_000 });
      expect(illegal.status).toBe(1);
      expect(illegal.stdout).toBe('');
      expect(illegal.stderr).toBe('--client cannot be combined with --attached or --workspace.\n');
      const missingTools = spawnSync(process.execPath, [bundle, 'mcp', '--client', 'fixture', '--attached'], { encoding: 'utf8', timeout: 10_000 });
      expect(missingTools.status).toBe(1);
      expect(missingTools.stdout).toBe('');
      expect(missingTools.stderr).toBe('--tools is required with --client.\n');
      const workspaceClient = spawnSync(process.execPath, [bundle, 'mcp', '--workspace', 'C:/fixture', '--client', 'fixture', '--tools'], { encoding: 'utf8', timeout: 10_000 });
      expect(workspaceClient.status).toBe(1);
      expect(workspaceClient.stdout).toBe('');
      expect(workspaceClient.stderr).toBe('--client cannot be combined with --attached or --workspace.\n');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

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
      writeFileSync(entry, `import { runPluginNodeEntry } from ${JSON.stringify(resolve(import.meta.dirname, '../../../src/cli/sub/plugin-run-node.ts'))};\nrunPluginNodeEntry(process.argv[2], process.argv.slice(3)).catch(error => { console.error(error); process.exitCode = 1; });\n`);
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
