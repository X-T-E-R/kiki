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

  it('uses the Windows shim when invoked directly with node', () => {
    expect(resolvePnpmInvocation({}, 'win32', 'C:\\node\\node.exe')).toEqual({
      command: 'pnpm.cmd',
      args: [],
    });
  });

  it('uses pnpm on non-Windows platforms when npm_execpath is absent', () => {
    expect(resolvePnpmInvocation({}, 'linux', '/usr/bin/node')).toEqual({
      command: 'pnpm',
      args: [],
    });
  });
});
