import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  createToolchainNodeCmd,
  createToolchainNodePosixWrapper,
  detectSysPrefix,
  parsePeImports,
  rewriteMsystemDefault,
  sanitizeGitConfig,
  sanitizeProfileAliases,
  stageWindowsToolchain,
} from './stage-windows-toolchain.mjs';

function buildMinimalPe64WithImports(dllNames) {
  const buf = Buffer.alloc(0x600, 0);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(0x80, 0x3c);

  const pe = 0x80;
  buf.write('PE\0\0', pe, 'ascii');
  const coff = pe + 4;
  buf.writeUInt16LE(0x8664, coff);
  buf.writeUInt16LE(1, coff + 2);
  buf.writeUInt16LE(240, coff + 16);

  const opt = coff + 20;
  buf.writeUInt16LE(0x20b, opt);
  buf.writeBigUInt64LE(0x140000000n, opt + 24);
  buf.writeUInt32LE(16, opt + 108);

  const importRva = 0x1000;
  buf.writeUInt32LE(importRva, opt + 112 + 8);

  const sec = opt + 240;
  buf.write('.rdata\0\0', sec, 'ascii');
  buf.writeUInt32LE(0x400, sec + 8);
  buf.writeUInt32LE(importRva, sec + 12);
  buf.writeUInt32LE(0x400, sec + 16);
  buf.writeUInt32LE(0x200, sec + 20);

  let strOffset = 0x200 + (dllNames.length + 1) * 20;
  dllNames.forEach((name, index) => {
    const descOffset = 0x200 + index * 20;
    const nameRva = importRva + (strOffset - 0x200);
    buf.writeUInt32LE(nameRva, descOffset + 12);
    buf.writeUInt32LE(importRva + 0x300, descOffset + 16);
    buf.write(`${name}\0`, strOffset, 'ascii');
    strOffset += name.length + 1;
  });

  return buf;
}

describe('stage-windows-toolchain helpers', () => {
  it('parses PE32+ import descriptors accurately', () => {
    const pe = buildMinimalPe64WithImports(['KERNEL32.dll', 'msys-2.0.dll', 'libcurl-4.dll']);
    assert.deepEqual(parsePeImports(pe), ['KERNEL32.dll', 'msys-2.0.dll', 'libcurl-4.dll']);

    if (process.platform === 'win32') {
      const cmdImports = parsePeImports(readFileSync('C:\\Windows\\System32\\cmd.exe'));
      assert.ok(
        cmdImports.some((d) => d.toLowerCase().includes('kernel32.dll') || d.toLowerCase().startsWith('api-ms-win-')),
      );
    }
  });

  it('sanitizes gitconfig by stripping git-lfs/astextplain and switching credential.helper to wincred', () => {
    const raw = [
      '[diff "astextplain"]',
      '\ttextconv = astextplain',
      '[filter "lfs"]',
      '\tclean = git-lfs clean -- %f',
      '\trequired = true',
      '[http]',
      '\tsslBackend = schannel',
      '[credential]',
      '\thelper = manager',
      '[core]',
      '\tautocrlf = true',
    ].join('\r\n');

    const cleaned = sanitizeGitConfig(raw);
    assert.ok(!cleaned.includes('git-lfs'));
    assert.ok(!cleaned.includes('astextplain'));
    assert.ok(!cleaned.includes('helper = manager'));
    assert.ok(cleaned.includes('helper = wincred'));
    assert.ok(cleaned.includes('sslBackend = schannel'));
  });

  it('rewrites msystem default and detects ucrt64/mingw64/clang64/clangarm64 layouts (Git for Windows 2.56+)', () => {
    const msys = 'export MSYSTEM="${MSYSTEM:-MSYS}"\n';
    assert.equal(rewriteMsystemDefault(msys, 'UCRT64'), 'export MSYSTEM="${MSYSTEM:-UCRT64}"\n');
    assert.equal(rewriteMsystemDefault(msys, 'MINGW64'), 'export MSYSTEM="${MSYSTEM:-MINGW64}"\n');
    assert.equal(rewriteMsystemDefault(msys, 'CLANGARM64'), 'export MSYSTEM="${MSYSTEM:-CLANGARM64}"\n');

    const root = mkdtempSync(join(tmpdir(), 'kiki-git-layout-'));
    try {
      const ucrtCore = join(root, 'ucrt64', 'libexec', 'git-core');
      mkdirSync(ucrtCore, { recursive: true });
      writeFileSync(join(ucrtCore, 'git.exe'), 'MZ');
      assert.deepEqual(detectSysPrefix(root, 'x86_64-pc-windows-msvc'), {
        sysPrefix: 'ucrt64',
        msystem: 'UCRT64',
      });

      const armBin = join(root, 'clangarm64', 'bin');
      mkdirSync(armBin, { recursive: true });
      writeFileSync(join(armBin, 'git.exe'), 'MZ');
      assert.deepEqual(detectSysPrefix(root, 'aarch64-pc-windows-msvc'), {
        sysPrefix: 'clangarm64',
        msystem: 'CLANGARM64',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const aliases = "alias ls='ls -F'\ncase \"$TERM\" in\nxterm*)\n  alias node=\"winpty node.exe\"\n;;\nesac\n";
    const stripped = sanitizeProfileAliases(aliases);
    assert.ok(stripped.includes("alias ls='ls -F'"));
    assert.ok(!stripped.includes('winpty'));
  });

  it('skips non-Windows targets cleanly and emits valid SEA node shims', async () => {
    const skipped = await stageWindowsToolchain({ target: 'aarch64-apple-darwin' });
    assert.deepEqual(skipped, {
      skipped: true,
      target: 'aarch64-apple-darwin',
      reason: 'non-windows-target',
    });

    const cmdShim = createToolchainNodeCmd();
    assert.ok(cmdShim.includes('__plugin_run_node %*'));
    assert.ok(!cmdShim.includes('(') && !cmdShim.includes(')'), 'node.cmd must not use parenthesized blocks around %* or %ERRORLEVEL%');
    assert.ok(createToolchainNodePosixWrapper().includes('exec "$KIKI_SEA_EXEC" __plugin_run_node "$@"'));

    if (process.platform === 'win32') {
      const tempDir = mkdtempSync(join(tmpdir(), 'kiki-toolchain-cmd-'));
      try {
        const nodeCmdPath = join(tempDir, 'node.cmd');
        const fakeSeaPath = join(tempDir, 'fake-sea.cmd');
        writeFileSync(nodeCmdPath, cmdShim, 'utf8');
        writeFileSync(
          fakeSeaPath,
          [
            '@echo off',
            'if "%~2"=="-e" echo %~3& exit /b 0',
            'if "%~2"=="exit3" exit /b 3',
            'exit /b 2',
            '',
          ].join('\r\n'),
          'utf8',
        );
        const comSpec = process.env['ComSpec'] ?? 'C:\\Windows\\System32\\cmd.exe';
        const parenRes = spawnSync(
          comSpec,
          ['/d', '/s', '/c', `""${nodeCmdPath}" -e "console.log('node-ok')""`],
          { env: { ...process.env, KIKI_SEA_EXEC: fakeSeaPath }, encoding: 'utf8', windowsVerbatimArguments: true },
        );
        assert.equal(parenRes.status, 0, parenRes.stderr);
        assert.equal(parenRes.stdout.trim(), "console.log('node-ok')");

        const exit3Res = spawnSync(
          comSpec,
          ['/d', '/s', '/c', `""${nodeCmdPath}" exit3"`],
          { env: { ...process.env, KIKI_SEA_EXEC: fakeSeaPath }, encoding: 'utf8', windowsVerbatimArguments: true },
        );
        assert.equal(exit3Res.status, 3);

        const missingSeaEnv = { ...process.env };
        delete missingSeaEnv['KIKI_SEA_EXEC'];
        const missingRes = spawnSync(
          comSpec,
          ['/d', '/s', '/c', `""${nodeCmdPath}" -v"`],
          { env: missingSeaEnv, encoding: 'utf8', windowsVerbatimArguments: true },
        );
        assert.equal(missingRes.status, 127);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });
});
