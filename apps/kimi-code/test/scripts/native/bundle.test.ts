import { describe, expect, it } from 'vitest';

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
