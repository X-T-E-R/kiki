import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectAuthNativePackage, collectNodePtyPackage } from '../../../scripts/native/assets.mjs';

import {
  nativeDeps,
  resolveTargetDeps,
  isSupportedTarget,
  SUPPORTED_TARGETS,
} from '../../../scripts/native/native-deps.mjs';

describe('SUPPORTED_TARGETS', () => {
  it('contains the six published targets', () => {
    expect([...SUPPORTED_TARGETS].toSorted()).toEqual(
      [
        'darwin-arm64',
        'darwin-x64',
        'linux-arm64',
        'linux-x64',
        'win32-arm64',
        'win32-x64',
      ].toSorted(),
    );
  });
});

describe('isSupportedTarget', () => {
  it('accepts every supported target', () => {
    for (const t of SUPPORTED_TARGETS) {
      expect(isSupportedTarget(t)).toBe(true);
    }
  });

  it('rejects unknown targets', () => {
    expect(isSupportedTarget('linux-x64-musl')).toBe(false);
    expect(isSupportedTarget('darwin-arm')).toBe(false);
  });
});

describe('resolveTargetDeps', () => {
  it('returns one descriptor per package for darwin-arm64', () => {
    const deps = resolveTargetDeps('darwin-arm64');
    const names = deps.map((d) => d.resolvedName);
    expect(names).toContain('@mariozechner/clipboard');
    expect(names).toContain('@mariozechner/clipboard-darwin-arm64');
    expect(names).toContain('@kiki/pi-tui');
  });

  it('picks the right clipboard subpackage per target', () => {
    expect(
      resolveTargetDeps('linux-x64').map((d) => d.resolvedName),
    ).toContain('@mariozechner/clipboard-linux-x64-gnu');
    expect(
      resolveTargetDeps('win32-x64').map((d) => d.resolvedName),
    ).toContain('@mariozechner/clipboard-win32-x64-msvc');
    expect(
      resolveTargetDeps('win32-arm64').map((d) => d.resolvedName),
    ).toContain('@mariozechner/clipboard-win32-arm64-msvc');
  });

  it('picks the keyring host and platform binding for every target', () => {
    const expected = {
      'darwin-arm64': '@napi-rs/keyring-darwin-arm64',
      'darwin-x64': '@napi-rs/keyring-darwin-x64',
      'linux-arm64': '@napi-rs/keyring-linux-arm64-gnu',
      'linux-x64': '@napi-rs/keyring-linux-x64-gnu',
      'win32-arm64': '@napi-rs/keyring-win32-arm64-msvc',
      'win32-x64': '@napi-rs/keyring-win32-x64-msvc',
    };
    for (const target of SUPPORTED_TARGETS) {
      const deps = resolveTargetDeps(target);
      expect(deps.find((dep) => dep.id === 'keyring-host')?.resolvedName).toBe('@napi-rs/keyring');
      expect(deps.find((dep) => dep.id === 'keyring-target')).toMatchObject({
        resolvedName: expected[target as keyof typeof expected],
        parentName: '@napi-rs/keyring',
      });
    }
  });

  it('encodes pi-tui native file path per target', () => {
    const linuxPiTui = resolveTargetDeps('linux-arm64').find(
      (d) => d.resolvedName === '@kiki/pi-tui',
    );
    expect(linuxPiTui?.nativeFileRelatives).toEqual([]);
    const macPiTui = resolveTargetDeps('darwin-x64').find(
      (d) => d.resolvedName === '@kiki/pi-tui',
    );
    expect(macPiTui?.nativeFileRelatives).toEqual([
      'native/darwin/prebuilds/darwin-x64/darwin-modifiers.node',
    ]);
    const winArmPiTui = resolveTargetDeps('win32-arm64').find(
      (d) => d.resolvedName === '@kiki/pi-tui',
    );
    expect(winArmPiTui?.nativeFileRelatives).toEqual([
      'native/win32/prebuilds/win32-arm64/win32-console-mode.node',
    ]);
  });

  it('throws on unsupported target', () => {
    expect(() => resolveTargetDeps('linux-x64-musl')).toThrow(/unsupported/i);
  });
});

describe('nativeDeps registry shape', () => {
  it('has clipboard host (collect=js-only)', () => {
    const host = nativeDeps.find((d) => d.id === 'clipboard-host');
    expect(host?.collect).toBe('js-only');
  });

  it('has clipboard-target (collect=native-files, parent=clipboard-host)', () => {
    const target = nativeDeps.find((d) => d.id === 'clipboard-target');
    expect(target?.collect).toBe('native-files');
    expect(target?.parent).toBe('clipboard-host');
  });

  it('collects the keyring host and its per-target native binding', () => {
    expect(nativeDeps.find((d) => d.id === 'agent-core')?.collect).toBe('virtual');
    expect(nativeDeps.find((d) => d.id === 'keyring-host')).toMatchObject({
      collect: 'js-only', parent: 'agent-core',
    });
    expect(nativeDeps.find((d) => d.id === 'keyring-target')).toMatchObject({
      collect: 'native-files', parent: 'keyring-host',
    });
  });

  it('has pi-tui (collect=native-file-only, no parent)', () => {
    const piTui = nativeDeps.find((d) => d.id === 'pi-tui');
    expect(piTui?.collect).toBe('native-file-only');
    expect(piTui?.parent).toBe(null);
  });
});


describe('auth-native loading unit', () => {
  it('registers all six targets and collects only the selected host binding with licenses', async () => {
    for (const target of SUPPORTED_TARGETS) {
      expect(resolveTargetDeps(target).find((dep) => dep.id === 'auth-native')).toMatchObject({
        collect: 'auth-native', resolvedName: '@kiki/auth-native', parentName: null,
      });
    }
    const packageRoot = resolve(import.meta.dirname, '../../../../../packages/auth-native');
    const target = `${process.platform}-${process.arch}`;
    const collected = await collectAuthNativePackage({ packageRoot, target });
    const paths = collected.packageManifest.files.map((file: { relativePath: string }) => file.relativePath);
    expect(paths).toContain(`node_modules/@kiki/auth-native/prebuilds/${target}/auth-native.node`);
    expect(paths).toContain('node_modules/@kiki/auth-native/index.cjs');
    expect(paths).toContain('node_modules/@kiki/auth-native/licenses/Apache-2.0.txt');
    expect(paths).toContain('node_modules/@kiki/auth-native/licenses/upstream-mit.txt');
    expect(paths.filter((path: string) => path.endsWith('.node'))).toHaveLength(1);
    expect(paths.some((path: string) => /\/src\/|\/target\/|\/tests\//.test(path))).toBe(false);
    mkdirSync(resolve('.tmp'), { recursive: true });
    const missingRoot = mkdtempSync(resolve('.tmp', 'auth-native-missing-'));
    try {
      writeFileSync(join(missingRoot, 'package.json'), '{"main":"index.cjs"}');
      writeFileSync(join(missingRoot, 'index.cjs'), 'module.exports = {};');
      for (const foreign of SUPPORTED_TARGETS.filter((candidate) => candidate !== target)) {
        await expect(collectAuthNativePackage({ packageRoot: missingRoot, target: foreign })).rejects.toThrow(`prebuilds/${foreign}/auth-native.node`);
      }
    } finally {
      rmSync(missingRoot, { recursive: true, force: true });
    }
  });
});

describe('node-pty loading unit', () => {
  it('registers node-pty under the engine install root for every target', () => {
    for (const target of SUPPORTED_TARGETS) {
      expect(resolveTargetDeps(target).find((dep) => dep.id === 'node-pty')).toMatchObject({
        collect: 'node-pty', resolvedName: 'node-pty', parentName: '@kiki/agent-core-v2',
      });
    }
  });

  it('collects the installed host binding and dynamic worker/agent entrypoints', async () => {
    const req = createRequire(new URL('../../../../../packages/agent-core-v2/package.json', import.meta.url));
    const packageRoot = dirname(req.resolve('node-pty/package.json'));
    const result = await collectNodePtyPackage({ packageRoot, target: `${process.platform}-${process.arch}` });
    const paths = result.packageManifest.files.map((file: { relativePath: string }) => file.relativePath);
    expect(paths).toContain('node_modules/node-pty/LICENSE');
    expect(paths).toContain('node_modules/node-pty/lib/worker/conoutSocketWorker.js');
    expect(paths).toContain('node_modules/node-pty/lib/conpty_console_list_agent.js');
    expect(paths.some((path: string) => path.endsWith('/pty.node'))).toBe(true);
    expect(paths.some((path: string) => path.endsWith('/spawn-helper'))).toBe(process.platform === 'darwin');
    expect(paths.some((path: string) => /\.test\.js|\.pdb|\.map/.test(path))).toBe(false);
  });

  it('selects only the named foreign target, including helper mode, and rejects missing helpers', async () => {
    mkdirSync(resolve('.tmp'), { recursive: true });
    const packageRoot = mkdtempSync(resolve('.tmp', 'pty-collector-'));
    const put = (path: string, content = 'fixture') => {
      mkdirSync(dirname(join(packageRoot, path)), { recursive: true });
      writeFileSync(join(packageRoot, path), content);
    };
    try {
      put('package.json', '{"main":"lib/index.js"}');
      put('lib/index.js', 'module.exports = {};');
      put('lib/worker/conoutSocketWorker.js');
      put('lib/unused.test.js');
      put('LICENSE', 'MIT');
      put('deps/winpty/LICENSE', 'MIT');
      for (const target of SUPPORTED_TARGETS.filter((target) => target !== `${process.platform}-${process.arch}`)) {
        const binaries = target.startsWith('win32-')
          ? ['pty.node', 'conpty.node', 'conpty_console_list.node', 'winpty.dll', 'winpty-agent.exe', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']
          : target.startsWith('darwin-') ? ['pty.node', 'spawn-helper'] : ['pty.node'];
        for (const name of binaries) put(`prebuilds/${target}/${name}`);
        const result = await collectNodePtyPackage({ packageRoot, target });
        const files = result.packageManifest.files as Array<{ relativePath: string; mode?: number }>;
        expect(files.filter((file) => file.relativePath.includes('/prebuilds/')).map((file) => file.relativePath)).toEqual(
          binaries.map((name) => `node_modules/node-pty/prebuilds/${target}/${name}`).toSorted((a, b) => a.localeCompare(b)),
        );
        expect(files.filter((file) => file.relativePath.endsWith('.node')).every((file) => file.mode === undefined)).toBe(true);
        if (target.startsWith('darwin-')) {
          expect(files.find((file) => file.relativePath.endsWith('/spawn-helper'))?.mode).toBe(0o755);
          rmSync(join(packageRoot, `prebuilds/${target}/spawn-helper`));
          await expect(collectNodePtyPackage({ packageRoot, target })).rejects.toThrow(`prebuilds/${target}/spawn-helper`);
        } else {
          expect(files.some((file) => file.relativePath.endsWith('/spawn-helper'))).toBe(false);
        }
        rmSync(join(packageRoot, `prebuilds/${target}/pty.node`));
        await expect(collectNodePtyPackage({ packageRoot, target })).rejects.toThrow(`prebuilds/${target}/pty.node`);
      }
    } finally {
      rmSync(packageRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
});
