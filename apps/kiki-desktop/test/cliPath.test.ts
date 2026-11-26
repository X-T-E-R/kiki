import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineTestContract } from '../../../scripts/ccp-chaos/check-test-hygiene.mjs';

defineTestContract({
  invariant:
    'Windows NSIS installer and uninstaller preserve arbitrary-length REG_EXPAND_SZ user PATH entries without truncation or environment-variable expansion',
  mechanism:
    'Prevents NSIS 1024-char ReadRegStr overflow from wiping user PATH on install or mangling long PATH values on uninstall while keeping fail-closed registry behavior',
  covers: ['apps/kiki-desktop/build/installer.nsh'],
  sunset_when:
    'Physically delete this regression suite only if the Windows NSIS installer hook in installer.nsh is retired',
  sunset: { kind: 'permanent' },
  tags: ['installer', 'windows', 'regression'],
});

const NSH_PATH = path.resolve(import.meta.dirname, '..', 'build', 'installer.nsh');

function normalizePathEntry(entry: string): string {
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

function transformUserPath(
  rawPath: string | null | undefined,
  targetDir: string,
  action: 'add' | 'remove',
): { readonly changed: boolean; readonly nextValue: string | null } {
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
    return action === 'add'
      ? { changed: true, nextValue: cleanTarget }
      : { changed: false, nextValue: null };
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
    let nextValue: string;
    if (!hasNonEmpty) {
      nextValue = cleanTarget;
    } else if (rawPath.endsWith(';')) {
      nextValue = `${rawPath}${cleanTarget}`;
    } else {
      nextValue = `${rawPath};${cleanTarget}`;
    }
    return { changed: true, nextValue };
  }

  const kept: string[] = [];
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

function extractEmbeddedPowerShell(nshText: string): string {
  const pathBlockEnd = nshText.indexOf('!macro KIKI_WRITE_CLI_SHIMS');
  const slice = pathBlockEnd >= 0 ? nshText.slice(0, pathBlockEnd) : nshText;
  const lines: string[] = [];
  for (const rawLine of slice.split(/\r?\n/u)) {
    const match = /^\s*FileWrite\s+\$0\s+"(.*)"\s*$/u.exec(rawLine);
    if (!match || match[1] === undefined) continue;
    const decoded = match[1]
      .replaceAll('$\\r$\\n', '\n')
      .replaceAll('$\\"', '"')
      .replaceAll('$$', '$');
    lines.push(decoded);
  }
  return lines.join('');
}

function buildLongRealisticPath(minChars: number): string {
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

function resolveWindowsPowerShell(): string {
  const sysWow64Ps = path.join(
    process.env['WINDIR'] ?? 'C:\\Windows',
    'SysWOW64',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  if (fs.existsSync(sysWow64Ps)) return sysWow64Ps;
  return 'powershell.exe';
}

function runPowerShell(
  psExe: string,
  script: string,
  envOverrides: Record<string, string> = {},
) {
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

function findMakeNsis(): string | null {
  const candidates: string[] = [];
  const localAppData = process.env['LOCALAPPDATA'];
  if (localAppData) {
    const ebNsisRoot = path.join(localAppData, 'electron-builder', 'Cache', 'nsis');
    if (fs.existsSync(ebNsisRoot)) {
      for (const entry of fs.readdirSync(ebNsisRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          candidates.push(path.join(ebNsisRoot, entry.name, 'makensis.exe'));
        }
      }
    }
    candidates.push(path.join(localAppData, 'tauri', 'NSIS', 'makensis.exe'));
  }
  candidates.push('C:\\Program Files (x86)\\NSIS\\makensis.exe');
  candidates.push('C:\\Program Files\\NSIS\\makensis.exe');
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const whereRes = spawnSync('where.exe', ['makensis.exe'], { encoding: 'utf8' });
  if (whereRes.status === 0) {
    const first = String(whereRes.stdout ?? '')
      .split(/\r?\n/u)
      .map((s) => s.trim())
      .find(Boolean);
    if (first && fs.existsSync(first)) return first;
  }
  return null;
}

describe('NSIS Windows CLI PATH & Shim Hook (installer.nsh)', () => {
  it('removes 1024-char NSIS string operations and enforces fail-closed ExpandString registry updates', () => {
    const nshText = fs.readFileSync(NSH_PATH, 'utf8');
    expect(nshText).not.toContain('ReadRegStr');
    expect(nshText).not.toContain('StrFunc.nsh');
    expect(nshText).not.toContain('${StrStr}');
    expect(nshText).not.toContain('${UnStrRep}');
    expect(nshText).toContain('DoNotExpandEnvironmentNames');
    expect(nshText).toContain('[Microsoft.Win32.RegistryValueKind]::ExpandString');
    expect(nshText).toContain(
      'SendMessageTimeoutW(p 0xffff, i ${WM_SETTINGCHANGE}, p 0, w "Environment", i 2, i 1000, *p .r3)',
    );
    expect(nshText).toContain('SetEnvironmentVariable');
    expect(nshText).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(nshText).toContain('!macro customInstall');
    expect(nshText).toContain('!macro customUnInstall');

    for (const line of nshText.split(/\r?\n/u)) {
      expect(line.length).toBeLessThan(256);
    }

    const psScript = extractEmbeddedPowerShell(nshText);
    expect(psScript).toContain('DoNotExpandEnvironmentNames');
    expect(psScript).toContain('KIKI_CLI_PATH_TARGET');
    expect(psScript).toContain('Normalize-PathEntry');
  });

  it('transforms 5000+ and 16384+ char PATH strings idempotently while preserving unexpanded tokens, spaces, apostrophes, and trailing slashes', () => {
    const longPath5k = buildLongRealisticPath(5500);
    const longPath16k = buildLongRealisticPath(16_500);
    const targetDir = "C:\\Users\\Alice O'Neil\\AppData\\Local\\Kiki\\cli";

    for (const original of [longPath5k, longPath16k]) {
      expect(original.length).toBeGreaterThanOrEqual(5500);
      const installed = transformUserPath(original, `${targetDir}\\`, 'add');
      expect(installed.changed).toBe(true);
      expect(installed.nextValue).toBe(`${original};${targetDir}`);
      expect(installed.nextValue).toContain('%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin');
      expect(installed.nextValue).toContain('%LOCALAPPDATA%\\pnpm');

      const doubleInstalled = transformUserPath(
        installed.nextValue,
        `${targetDir.toUpperCase()}\\\\`,
        'add',
      );
      expect(doubleInstalled.changed).toBe(false);
      expect(doubleInstalled.nextValue).toBe(installed.nextValue);

      const uninstalled = transformUserPath(installed.nextValue, targetDir.toLowerCase(), 'remove');
      expect(uninstalled.changed).toBe(true);
      expect(uninstalled.nextValue).toBe(original);
    }

    expect(transformUserPath(null, targetDir, 'remove')).toEqual({
      changed: false,
      nextValue: null,
    });
    expect(transformUserPath(null, targetDir, 'add')).toEqual({
      changed: true,
      nextValue: targetDir,
    });
    expect(transformUserPath('', targetDir, 'add')).toEqual({
      changed: true,
      nextValue: targetDir,
    });
    expect(transformUserPath(targetDir, targetDir, 'remove')).toEqual({
      changed: true,
      nextValue: '',
    });
    expect(transformUserPath(`;${targetDir};`, targetDir, 'remove')).toEqual({
      changed: true,
      nextValue: '',
    });
    expect(transformUserPath('%LOCALAPPDATA%\\pnpm;', targetDir, 'add')).toEqual({
      changed: true,
      nextValue: `%LOCALAPPDATA%\\pnpm;${targetDir}`,
    });
    expect(() => transformUserPath(longPath5k, '   ', 'add')).toThrow(
      /Target directory is required/u,
    );
  });

  it(
    'roundtrips 5000+ and 16384+ char REG_EXPAND_SZ Path values in an isolated HKCU test key on Windows',
    { timeout: 60_000 },
    () => {
      if (process.platform !== 'win32') {
        const nonWinCheck = transformUserPath(buildLongRealisticPath(5500), 'C:\\Kiki\\cli', 'add');
        expect((nonWinCheck.nextValue ?? '').length).toBeGreaterThan(5500);
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
        expect(res.status, `readRegState failed: ${res.stderr}`).toBe(0);
        return JSON.parse(res.stdout.trim()) as {
          exists: boolean;
          hasPath?: boolean;
          kind?: string;
          value?: unknown;
        };
      };

      const seedRegPath = (value: string | null, kind = 'ExpandString') => {
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
        expect(res.status, `seedRegPath failed: ${res.stderr}`).toBe(0);
      };

      const runEmbedded = (action: 'add' | 'remove', targetDir: string) =>
        spawnSync(
          psExe,
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            psFile,
            '-Action',
            action,
            '-RegSubKey',
            subKey,
          ],
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
          expect(add1.status, `add1 failed: ${add1.stderr}`).toBe(0);
          const afterAdd1 = readRegState();
          expect(afterAdd1.kind).toBe('ExpandString');
          expect(afterAdd1.value).toBe(`${original};${targetDir}`);

          const add2 = runEmbedded('add', `${targetDir.toUpperCase()}\\\\`);
          expect(add2.status, `add2 failed: ${add2.stderr}`).toBe(0);
          const afterAdd2 = readRegState();
          expect(afterAdd2.kind).toBe('ExpandString');
          expect(afterAdd2.value).toBe(afterAdd1.value);

          const rm1 = runEmbedded('remove', `${targetDir.toLowerCase()}\\`);
          expect(rm1.status, `rm1 failed: ${rm1.stderr}`).toBe(0);
          const afterRm1 = readRegState();
          expect(afterRm1.kind).toBe('ExpandString');
          expect(afterRm1.value).toBe(original);
        }

        seedRegPath('', 'DeleteValue');
        expect(runEmbedded('remove', targetDir).status).toBe(0);
        expect(readRegState().hasPath).toBe(false);

        expect(runEmbedded('add', targetDir).status).toBe(0);
        expect(readRegState().value).toBe(targetDir);
        expect(runEmbedded('remove', targetDir).status).toBe(0);
        expect(readRegState().value).toBe('');

        seedRegPath('', 'DWord');
        const failNonString = runEmbedded('add', targetDir);
        expect(failNonString.status).not.toBe(0);
        expect(readRegState().kind).toBe('DWord');
        expect(readRegState().value).toBe(42);

        const originalBeforeBadTarget = buildLongRealisticPath(5500);
        seedRegPath(originalBeforeBadTarget, 'ExpandString');
        const failEmptyTarget = runEmbedded('add', '   ');
        expect(failEmptyTarget.status).not.toBe(0);
        expect(readRegState().value).toBe(originalBeforeBadTarget);
      } finally {
        runPowerShell(
          psExe,
          '[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:TEST_SUBKEY, $false)',
          { TEST_SUBKEY: subKey },
        );
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it(
    'compiles installer.nsh with makensis and runs real NSIS customInstall/customUnInstall hooks when makensis is available',
    { timeout: 60_000 },
    () => {
      const makensis = process.platform === 'win32' ? findMakeNsis() : null;
      if (!makensis) {
        const nshText = fs.readFileSync(NSH_PATH, 'utf8');
        expect(nshText).toContain('!macro customInstall');
        expect(nshText).toContain('!macro customUnInstall');
        return;
      }

      const psExe = resolveWindowsPowerShell();
      const testId = randomUUID().replaceAll('-', '');
      const subKey = `Software\\KikiInstallerPathTest_${testId}`;
      const urlSubKey = `Software\\KikiInstallerUrlTest_${testId}`;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiki-makensis-test-'));
      const installDir = path.join(tempDir, "Alice O'Neil Install", 'Kiki');
      const dummyDesktop = path.join(tempDir, 'kiki-desktop.exe');
      const installerExe = path.join(tempDir, 'kiki-path-harness-setup.exe');
      const harnessNsi = path.join(tempDir, 'harness.nsi');
      fs.writeFileSync(dummyDesktop, 'dummy-electron-payload', 'utf8');

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
        `  File /oname=kiki-desktop.exe "${dummyDesktop}"`,
        '  WriteUninstaller "$INSTDIR\\uninstall.exe"',
        '  !insertmacro customInstall',
        'SectionEnd',
        'Section "Uninstall"',
        '  !insertmacro customUnInstall',
        '  Delete "$INSTDIR\\kiki-desktop.exe"',
        '  Delete "$INSTDIR\\uninstall.exe"',
        '  RMDir "$INSTDIR"',
        'SectionEnd',
        '',
      ].join('\r\n');
      fs.writeFileSync(harnessNsi, nsiScript, 'utf8');

      const compileRes = spawnSync(
        makensis,
        [
          `/DKIKI_PATH_REG_SUBKEY=${subKey}`,
          `/DKIKI_URL_REG_SUBKEY=${urlSubKey}`,
          '/DKIKI_SKIP_WM_BROADCAST=1',
          harnessNsi,
        ],
        {
          encoding: 'utf8',
          timeout: 60_000,
          env: { ...process.env, MSYS_NO_PATHCONV: '1' },
        },
      );
      expect(
        compileRes.status,
        `makensis failed:\n${compileRes.stdout}\n${compileRes.stderr}`,
      ).toBe(0);

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
        expect(res.status, `readRegPath failed: ${res.stderr}`).toBe(0);
        return JSON.parse(res.stdout.trim()) as { kind: string; value: string };
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
        expect(seedRes.status, `seed failed: ${seedRes.stderr}`).toBe(0);

        const expectedCliDir = path.join(installDir, 'cli');
        fs.mkdirSync(expectedCliDir, { recursive: true });
        fs.writeFileSync(path.join(expectedCliDir, 'kiki.exe'), 'legacy-v1-exe', 'utf8');

        const runInstall1 = spawnSync(installerExe, ['/S'], { encoding: 'utf8', timeout: 60_000 });
        expect(runInstall1.status, `silent install 1 failed: ${runInstall1.stderr}`).toBe(0);
        expect(fs.existsSync(path.join(expectedCliDir, 'kiki.cmd'))).toBe(true);
        expect(fs.existsSync(path.join(expectedCliDir, 'kiki'))).toBe(true);
        expect(fs.existsSync(path.join(expectedCliDir, 'kiki.exe'))).toBe(false);

        const afterInstall1 = readRegPath();
        expect(afterInstall1.kind).toBe('ExpandString');
        expect(afterInstall1.value).toBe(`${originalPath};${expectedCliDir}`);

        const runInstall2 = spawnSync(installerExe, ['/S'], { encoding: 'utf8', timeout: 60_000 });
        expect(runInstall2.status, `silent install 2 failed: ${runInstall2.stderr}`).toBe(0);
        expect(readRegPath().value).toBe(afterInstall1.value);

        const uninstallerExe = path.join(installDir, 'uninstall.exe');
        const runUninstall = spawnSync(uninstallerExe, ['/S', `_?=${installDir}`], {
          encoding: 'utf8',
          timeout: 60_000,
          windowsVerbatimArguments: true,
        });
        expect(runUninstall.status, `silent uninstall failed: ${runUninstall.stderr}`).toBe(0);

        const afterUninstall = readRegPath();
        expect(afterUninstall.kind).toBe('ExpandString');
        expect(afterUninstall.value).toBe(originalPath);
      } finally {
        runPowerShell(
          psExe,
          '[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:TEST_SUBKEY, $false); [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:TEST_URL_SUBKEY, $false)',
          { TEST_SUBKEY: subKey, TEST_URL_SUBKEY: urlSubKey },
        );
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});
