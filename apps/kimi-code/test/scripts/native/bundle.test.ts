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
