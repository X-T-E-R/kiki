import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { defineTestContract } from '../../../../scripts/ccp-chaos/check-test-hygiene.mjs';

defineTestContract({
  invariant: 'Windows NSIS installer and uninstaller preserve arbitrary-length REG_EXPAND_SZ user PATH entries without truncation or environment-variable expansion',
  mechanism: 'Prevents NSIS 1024-char ReadRegStr overflow from wiping user PATH on install or mangling long PATH values on uninstall while keeping fail-closed registry behavior',
  covers: ['apps/kiki-gui/src-tauri/windows/cli-path.nsh'],
  sunset_when: 'Physically delete this regression suite only if the Windows NSIS installer hook in cli-path.nsh is retired',
  sunset: { kind: 'permanent' },
  tags: ['installer', 'windows', 'regression'],
});

const NSH_PATH = path.join(import.meta.dirname, 'cli-path.nsh');

function normalizePathEntry(entry) {
  let s = entry.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).trim();
  }
  s = s.replaceAll('/', '\\');
  while (s.length > 3 && s.endsWith('\\')) {
    s = s.slice(0, -1);
  }
  return s;
}

function transformUserPath(rawPath, targetDir, action) {
  if (typeof targetDir !== 'string' || targetDir.trim().length === 0) {
    throw new Error('Target directory is required');
  }
  if (action !== 'add' && action !== 'remove') {
    throw new Error(`Unsupported action: ${String(action)}`);
  }
  let cleanTarget = targetDir.trim();
  while (cleanTarget.length > 3 && (cleanTarget.endsWith('\\') || cleanTarget.endsWith('/'))) {
    cleanTarget = cleanTarget.slice(0, -1);
  }
  const normTarget = normalizePathEntry(cleanTarget).toLowerCase();
  if (!normTarget) {
    throw new Error('Normalized target directory is empty');
  }

  if (rawPath === null || rawPath === undefined) {
    return action === 'add' ? { changed: true, nextValue: cleanTarget } : { changed: false, nextValue: null };
  }

  const parts = rawPath.split(';');
  if (action === 'add') {
    let hasNonEmpty = false;
    for (const part of parts) {
      const norm = normalizePathEntry(part);
      if (norm.length > 0) hasNonEmpty = true;
      if (norm.toLowerCase() === normTarget) {
        return { changed: false, nextValue: rawPath };
      }
    }
    let nextValue;
    if (!hasNonEmpty) {
      nextValue = cleanTarget;
    } else if (rawPath.endsWith(';')) {
      nextValue = `${rawPath}${cleanTarget}`;
    } else {
      nextValue = `${rawPath};${cleanTarget}`;
    }
    return { changed: true, nextValue };
  }

  const kept = [];
  let removed = false;
  for (const part of parts) {
    const norm = normalizePathEntry(part);
    if (norm.toLowerCase() === normTarget) {
      removed = true;
    } else {
      kept.push(part);
    }
  }
  if (!removed) {
    return { changed: false, nextValue: rawPath };
  }
  const hasKeptNonEmpty = kept.some((entry) => normalizePathEntry(entry).length > 0);
  return {
    changed: true,
    nextValue: hasKeptNonEmpty ? kept.join(';') : '',
  };
}

function extractEmbeddedPowerShell(nshText) {
  const lines = [];
  for (const rawLine of nshText.split(/\r?\n/u)) {
    const match = /^\s*FileWrite\s+\$0\s+"(.*)"\s*$/u.exec(rawLine);
    if (!match) continue;
    const decoded = match[1]
      .replaceAll('$\\r$\\n', '\n')
      .replaceAll('$\\"', '"')
      .replaceAll('$$', '$');
    lines.push(decoded);
  }
  return lines.join('');
}

function buildLongRealisticPath(minChars) {
  const seedEntries = [
    '%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin',
    '%LOCALAPPDATA%\\pnpm',
    '%LOCALAPPDATA%\\Microsoft\\WindowsApps',
    '%USERPROFILE%\\.cargo\\bin',
    "C:\\Program Files\\O'Reilly & Sons\\Developer Tools\\bin",
    "C:\\Users\\Alice's Dev Box\\Tools\\v2\\bin\\",
    'C:\\Program Files\\Git\\cmd',
    'C:\\Program Files\\nodejs\\',
  ];
  const entries = [...seedEntries];
  let idx = 0;
  while (entries.join(';').length < minChars) {
    idx += 1;
    entries.push(
      idx % 3 === 0
        ? `%LOCALAPPDATA%\\Custom Tooling\\Suite ${idx}\\O'Connor Binaries\\x64`
        : `C:\\Dev\\Workspace Toolchains\\Project_${String(idx).padStart(3, '0')}\\node_modules\\.bin`,
    );
  }
  return entries.join(';');
}

function resolveWindowsPowerShell() {
  const sysWow64Ps = path.join(process.env.WINDIR ?? 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(sysWow64Ps)) return sysWow64Ps;
  return 'powershell.exe';
}

function runPowerShell(psExe, script, envOverrides = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync(
    psExe,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ...envOverrides },
    },
  );
}

function findMakeNsis() {
  const candidates = [];
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'tauri', 'NSIS', 'makensis.exe'));
  }
  if (process.env.USERPROFILE) {
    candidates.push(path.join(process.env.USERPROFILE, '.tauri', 'NSIS', 'makensis.exe'));
  }
  candidates.push('C:\\Program Files (x86)\\NSIS\\makensis.exe');
  candidates.push('C:\\Program Files\\NSIS\\makensis.exe');
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const whereRes = spawnSync('where.exe', ['makensis.exe'], { encoding: 'utf8' });
  if (whereRes.status === 0) {
    const first = String(whereRes.stdout ?? '').split(/\r?\n/u).map((s) => s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  }
  return null;
}

describe('NSIS Windows CLI PATH Hook (Issue #103)', () => {
  it('removes 1024-char NSIS string operations and enforces fail-closed ExpandString registry updates in cli-path.nsh', () => {
    const nshText = fs.readFileSync(NSH_PATH, 'utf8');
    assert.ok(!nshText.includes('ReadRegStr'), 'cli-path.nsh must not use ReadRegStr (1024-char truncation bug)');
    assert.ok(!nshText.includes('StrFunc.nsh'), 'cli-path.nsh must not depend on 1024-char StrFunc.nsh');
    assert.ok(!nshText.includes('${StrStr}'), 'cli-path.nsh must not use ${StrStr}');
    assert.ok(!nshText.includes('${UnStrRep}'), 'cli-path.nsh must not use ${UnStrRep}');
    assert.ok(nshText.includes('DoNotExpandEnvironmentNames'), 'must preserve unexpanded %VAR% tokens');
    assert.ok(nshText.includes('[Microsoft.Win32.RegistryValueKind]::ExpandString'), 'must write REG_EXPAND_SZ');
    assert.ok(
      nshText.includes('SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000'),
      'must preserve WM_SETTINGCHANGE broadcast',
    );
    assert.ok(nshText.includes('SetEnvironmentVariable'), 'must pass target path via process env var to prevent quoting injection');

    for (const [index, line] of nshText.split(/\r?\n/u).entries()) {
      assert.ok(line.length < 256, `NSIS line ${index + 1} should stay compact and well below 1024-char limit (got ${line.length})`);
    }

    const psScript = extractEmbeddedPowerShell(nshText);
    assert.ok(psScript.includes('DoNotExpandEnvironmentNames'));
    assert.ok(psScript.includes('KIKI_CLI_PATH_TARGET'));
    assert.ok(psScript.includes('Normalize-PathEntry'));
  });

  it('transforms 5000+ and 16384+ char PATH strings idempotently while preserving unexpanded tokens, spaces, apostrophes, and trailing slashes', () => {
    const longPath5k = buildLongRealisticPath(5500);
    const longPath16k = buildLongRealisticPath(16_500);
    const targetDir = "C:\\Users\\Alice O'Neil\\AppData\\Local\\Kiki\\cli";

    for (const original of [longPath5k, longPath16k]) {
      assert.ok(original.length >= 5500);
      const installed = transformUserPath(original, `${targetDir}\\`, 'add');
      assert.equal(installed.changed, true);
      assert.equal(installed.nextValue, `${original};${targetDir}`);
      assert.ok(installed.nextValue.includes('%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin'));
      assert.ok(installed.nextValue.includes('%LOCALAPPDATA%\\pnpm'));

      const doubleInstalled = transformUserPath(installed.nextValue, `${targetDir.toUpperCase()}\\\\`, 'add');
      assert.equal(doubleInstalled.changed, false);
      assert.equal(doubleInstalled.nextValue, installed.nextValue);

      const uninstalled = transformUserPath(installed.nextValue, targetDir.toLowerCase(), 'remove');
      assert.equal(uninstalled.changed, true);
      assert.equal(uninstalled.nextValue, original);
    }

    assert.deepEqual(transformUserPath(null, targetDir, 'remove'), { changed: false, nextValue: null });
    assert.deepEqual(transformUserPath(null, targetDir, 'add'), { changed: true, nextValue: targetDir });
    assert.deepEqual(transformUserPath('', targetDir, 'add'), { changed: true, nextValue: targetDir });
    assert.deepEqual(transformUserPath(targetDir, targetDir, 'remove'), { changed: true, nextValue: '' });
    assert.deepEqual(transformUserPath(`;${targetDir};`, targetDir, 'remove'), { changed: true, nextValue: '' });
    assert.deepEqual(transformUserPath(`%LOCALAPPDATA%\\pnpm;`, targetDir, 'add'), {
      changed: true,
      nextValue: `%LOCALAPPDATA%\\pnpm;${targetDir}`,
    });
    assert.throws(() => transformUserPath(longPath5k, '   ', 'add'), /Target directory is required/u);
  });

  it('roundtrips 5000+ and 16384+ char REG_EXPAND_SZ Path values in an isolated HKCU test key on Windows (and verifies fail-closed safety)', () => {
    if (process.platform !== 'win32') {
      const nonWinCheck = transformUserPath(buildLongRealisticPath(5500), 'C:\\Kiki\\cli', 'add');
      assert.ok(nonWinCheck.nextValue.length > 5500);
      return;
    }

    const psExe = resolveWindowsPowerShell();
    const subKey = `Software\\KikiInstallerPathTest_${randomUUID().replaceAll('-', '')}`;
    const nshText = fs.readFileSync(NSH_PATH, 'utf8');
    const embeddedPs = extractEmbeddedPowerShell(nshText);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiki-nsis-path-test-'));
    const psFile = path.join(tempDir, 'kiki-cli-path.ps1');
    fs.writeFileSync(psFile, embeddedPs, 'utf8');

    const readRegState = () => {
      const res = runPowerShell(
        psExe,
        `
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:TEST_SUBKEY, $false)
if ($null -eq $k) { Write-Output '{"exists":false}'; exit 0 }
try {
  $names = @($k.GetValueNames())
  if (-not ($names -contains 'Path')) { Write-Output '{"exists":true,"hasPath":false}'; exit 0 }
  $kind = $k.GetValueKind('Path').ToString()
  $val = $k.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  @{ exists = $true; hasPath = $true; kind = $kind; value = $val } | ConvertTo-Json -Compress
} finally { $k.Dispose() }
`,
        { TEST_SUBKEY: subKey },
      );
      assert.equal(res.status, 0, `readRegState failed: ${res.stderr}`);
      return JSON.parse(res.stdout.trim());
    };

    const seedRegPath = (value, kind = 'ExpandString') => {
      const res = runPowerShell(
        psExe,
        `
$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($env:TEST_SUBKEY)
try {
  if ($env:TEST_KIND -eq 'DWord') {
    $k.SetValue('Path', 42, [Microsoft.Win32.RegistryValueKind]::DWord)
  } elseif ($env:TEST_KIND -eq 'DeleteValue') {
    $k.DeleteValue('Path', $false)
  } else {
    $k.SetValue('Path', $env:TEST_VAL, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  }
} finally { $k.Dispose() }
`,
        { TEST_SUBKEY: subKey, TEST_VAL: value ?? '', TEST_KIND: kind },
      );
      assert.equal(res.status, 0, `seedRegPath failed: ${res.stderr}`);
    };

    const runEmbedded = (action, targetDir) =>
      spawnSync(
        psExe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile, '-Action', action, '-RegSubKey', subKey],
        {
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...process.env,
            KIKI_CLI_PATH_TARGET: targetDir,
          },
        },
      );

    try {
      const targetDir = "C:\\Users\\Alice O'Neil\\AppData\\Local\\Kiki\\cli";

      for (const minChars of [5500, 16_500]) {
        const original = buildLongRealisticPath(minChars);
        seedRegPath(original, 'ExpandString');

        const add1 = runEmbedded('add', `${targetDir}\\`);
        assert.equal(add1.status, 0, `add1 failed: ${add1.stderr}`);
        const afterAdd1 = readRegState();
        assert.equal(afterAdd1.kind, 'ExpandString');
        assert.equal(afterAdd1.value, `${original};${targetDir}`);
        assert.ok(afterAdd1.value.includes('%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin'));
        assert.ok(afterAdd1.value.includes('%LOCALAPPDATA%\\pnpm'));

        const add2 = runEmbedded('add', `${targetDir.toUpperCase()}\\\\`);
        assert.equal(add2.status, 0, `add2 failed: ${add2.stderr}`);
        const afterAdd2 = readRegState();
        assert.equal(afterAdd2.kind, 'ExpandString');
        assert.equal(afterAdd2.value, afterAdd1.value);

        const rm1 = runEmbedded('remove', `${targetDir.toLowerCase()}\\`);
        assert.equal(rm1.status, 0, `rm1 failed: ${rm1.stderr}`);
        const afterRm1 = readRegState();
        assert.equal(afterRm1.kind, 'ExpandString');
        assert.equal(afterRm1.value, original);
      }

      seedRegPath('', 'DeleteValue');
      assert.equal(runEmbedded('remove', targetDir).status, 0);
      assert.equal(readRegState().hasPath, false);

      assert.equal(runEmbedded('add', targetDir).status, 0);
      assert.equal(readRegState().value, targetDir);
      assert.equal(runEmbedded('remove', targetDir).status, 0);
      assert.equal(readRegState().value, '');

      seedRegPath('', 'DWord');
      const failNonString = runEmbedded('add', targetDir);
      assert.notEqual(failNonString.status, 0, 'must fail closed on non-string Path value');
      assert.equal(readRegState().kind, 'DWord');
      assert.equal(readRegState().value, 42);

      const originalBeforeBadTarget = buildLongRealisticPath(5500);
      seedRegPath(originalBeforeBadTarget, 'ExpandString');
      const failEmptyTarget = runEmbedded('add', '   ');
      assert.notEqual(failEmptyTarget.status, 0, 'must fail closed on empty target dir');
      assert.equal(readRegState().value, originalBeforeBadTarget);
    } finally {
      runPowerShell(
        psExe,
        '[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:TEST_SUBKEY, $false)',
        { TEST_SUBKEY: subKey },
      );
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('compiles cli-path.nsh with makensis and runs real NSIS install/uninstall hooks against an isolated HKCU key when makensis is available', () => {
    const makensis = process.platform === 'win32' ? findMakeNsis() : null;
    if (!makensis) {
      const nshText = fs.readFileSync(NSH_PATH, 'utf8');
      assert.ok(nshText.includes('!macro NSIS_HOOK_POSTINSTALL'));
      assert.ok(nshText.includes('!macro NSIS_HOOK_PREUNINSTALL'));
      return;
    }

    const psExe = resolveWindowsPowerShell();
    const subKey = `Software\\KikiInstallerPathTest_${randomUUID().replaceAll('-', '')}`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiki-makensis-test-'));
    const installDir = path.join(tempDir, "Alice O'Neil Install", 'Kiki');
    const dummyServer = path.join(tempDir, 'kiki-server.exe');
    const installerExe = path.join(tempDir, 'kiki-path-harness-setup.exe');
    const harnessNsi = path.join(tempDir, 'harness.nsi');
    fs.writeFileSync(dummyServer, 'dummy-cli-payload', 'utf8');

    const nsiScript = [
      'Unicode True',
      'RequestExecutionLevel user',
      'SilentInstall silent',
      'SilentUninstall silent',
      `OutFile "${installerExe}"`,
      `InstallDir "${installDir}"`,
      `!include "${NSH_PATH}"`,
      'Section "Install"',
      '  SetOutPath "$INSTDIR"',
      `  File /oname=kiki-server.exe "${dummyServer}"`,
      '  WriteUninstaller "$INSTDIR\\uninstall.exe"',
      '  !insertmacro NSIS_HOOK_POSTINSTALL',
      'SectionEnd',
      'Section "Uninstall"',
      '  !insertmacro NSIS_HOOK_PREUNINSTALL',
      '  Delete "$INSTDIR\\cli\\kiki.exe"',
      '  RMDir "$INSTDIR\\cli"',
      '  Delete "$INSTDIR\\kiki-server.exe"',
      '  Delete "$INSTDIR\\uninstall.exe"',
      '  RMDir "$INSTDIR"',
      'SectionEnd',
      '',
    ].join('\r\n');
    fs.writeFileSync(harnessNsi, nsiScript, 'utf8');

    const compileRes = spawnSync(
      makensis,
      [`/DKIKI_PATH_REG_SUBKEY=${subKey}`, harnessNsi],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, MSYS_NO_PATHCONV: '1' },
      },
    );
    assert.equal(
      compileRes.status,
      0,
      `makensis failed (exit=${compileRes.status}):\nSTDOUT:\n${compileRes.stdout}\nSTDERR:\n${compileRes.stderr}`,
    );

    const readRegPath = () => {
      const res = runPowerShell(
        psExe,
        `
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:TEST_SUBKEY, $false)
try {
  @{
    kind = $k.GetValueKind('Path').ToString()
    value = $k.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  } | ConvertTo-Json -Compress
} finally { $k.Dispose() }
`,
        { TEST_SUBKEY: subKey },
      );
      assert.equal(res.status, 0, `readRegPath failed: ${res.stderr}`);
      return JSON.parse(res.stdout.trim());
    };

    try {
      const originalPath = buildLongRealisticPath(5500);
      const seedRes = runPowerShell(
        psExe,
        `
$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($env:TEST_SUBKEY)
try {
  $k.SetValue('Path', $env:TEST_VAL, [Microsoft.Win32.RegistryValueKind]::ExpandString)
} finally { $k.Dispose() }
`,
        { TEST_SUBKEY: subKey, TEST_VAL: originalPath },
      );
      assert.equal(seedRes.status, 0, `seed failed: ${seedRes.stderr}`);

      const expectedCliDir = path.join(installDir, 'cli');

      const runInstall1 = spawnSync(installerExe, ['/S'], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(runInstall1.status, 0, `silent install 1 failed: ${runInstall1.stderr}`);
      assert.ok(fs.existsSync(path.join(expectedCliDir, 'kiki.exe')), 'POSTINSTALL must copy kiki-server.exe to cli\\kiki.exe');

      const afterInstall1 = readRegPath();
      assert.equal(afterInstall1.kind, 'ExpandString');
      assert.equal(afterInstall1.value, `${originalPath};${expectedCliDir}`);
      assert.ok(afterInstall1.value.includes('%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin'));
      assert.ok(afterInstall1.value.includes('%LOCALAPPDATA%\\pnpm'));

      const runInstall2 = spawnSync(installerExe, ['/S'], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(runInstall2.status, 0, `silent install 2 failed: ${runInstall2.stderr}`);
      assert.equal(readRegPath().value, afterInstall1.value, 'double install must be idempotent');

      const uninstallerExe = path.join(installDir, 'uninstall.exe');
      const runUninstall = spawnSync(uninstallerExe, ['/S', `_?=${installDir}`], {
        encoding: 'utf8',
        timeout: 60_000,
        windowsVerbatimArguments: true,
      });
      assert.equal(runUninstall.status, 0, `silent uninstall failed: ${runUninstall.stderr}`);

      const afterUninstall = readRegPath();
      assert.equal(afterUninstall.kind, 'ExpandString');
      assert.equal(afterUninstall.value, originalPath);
    } finally {
      runPowerShell(
        psExe,
        '[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:TEST_SUBKEY, $false)',
        { TEST_SUBKEY: subKey },
      );
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
