#!/usr/bin/env node
/**
 * Stage a self-contained, relocatable Windows toolchain (`toolchain/`) for the
 * Kiki NSIS desktop installer so Virgin Windows hosts without Git for Windows,
 * ripgrep, or Node.js work out of the box with zero external downloads.
 *
 * Layout staged under `<outputDir>` (`apps/kiki-gui/src-tauri/toolchain`):
 *   - `git/`          Relocatable Git + MSYS2 Bash + essential POSIX coreutils
 *                     with PE Import + Delay-Load DLL closure verified
 *   - `bin/rg.exe`    Pinned ripgrep 15.0.0 MSVC binary (SHA-256 verified)
 *   - `bin/node.cmd`  Windows batch wrapper -> Kiki SEA `__plugin_run_node`
 *   - `bin/node`      POSIX shell wrapper -> Kiki SEA `__plugin_run_node`
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { unzipSync } from 'fflate';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GUI_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_OUTPUT_DIR = resolve(GUI_ROOT, 'src-tauri', 'toolchain');
const DEFAULT_CACHE_DIR = resolve(tmpdir(), 'kiki-windows-toolchain-cache');
const TOOLCHAIN_MANIFEST_SCHEMA = 1;

const RG_VERSION = '15.0.0';
const RG_CDN_BASE_URL = 'https://code.kimi.com/kimi-code/rg';
const RG_GITHUB_BASE_URL = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}`;

const RG_TARGETS = new Map([
  [
    'x86_64-pc-windows-msvc',
    {
      archive: `ripgrep-${RG_VERSION}-x86_64-pc-windows-msvc.zip`,
      sha256: '21a98bf42c4da97ca543c010e764cc6dec8b9b7538d05f8d21874016385e0860',
    },
  ],
  [
    'aarch64-pc-windows-msvc',
    {
      archive: `ripgrep-${RG_VERSION}-aarch64-pc-windows-msvc.zip`,
      sha256: '572709c8770cb7f9385d725cb06d2bcd9537ec24d4dd17b1be1d65a876f8b591',
    },
  ],
]);

const REQUIRED_USR_BIN_TOOLS = [
  'bash.exe',
  'sh.exe',
  'cygpath.exe',
  'sed.exe',
  'awk.exe',
  'grep.exe',
  'find.exe',
  'xargs.exe',
  'tar.exe',
  'gzip.exe',
  'ssh.exe',
  'diff.exe',
  'patch.exe',
  'cat.exe',
  'ls.exe',
  'head.exe',
  'tail.exe',
  'wc.exe',
  'sort.exe',
  'uniq.exe',
  'tr.exe',
  'cut.exe',
  'mkdir.exe',
  'rm.exe',
  'cp.exe',
  'mv.exe',
  'touch.exe',
  'env.exe',
  'which.exe',
  'dirname.exe',
  'basename.exe',
  'uname.exe',
  'expr.exe',
  'sleep.exe',
  'date.exe',
  'tee.exe',
  'mktemp.exe',
  'printf.exe',
  'pwd.exe',
  'test.exe',
  'true.exe',
  'false.exe',
  'hostname.exe',
  'locale.exe',
];

const OPTIONAL_USR_BIN_TOOLS = [
  '[.exe',
  'bzip2.exe',
  'chmod.exe',
  'cmp.exe',
  'dash.exe',
  'df.exe',
  'du.exe',
  'echo.exe',
  'egrep',
  'fgrep',
  'gawk.exe',
  'gunzip',
  'id.exe',
  'kill.exe',
  'ln.exe',
  'nohup.exe',
  'paste.exe',
  'ps.exe',
  'readlink.exe',
  'realpath.exe',
  'rmdir.exe',
  'scp.exe',
  'seq.exe',
  'ssh-add.exe',
  'ssh-agent.exe',
  'ssh-keygen.exe',
  'stat.exe',
  'timeout.exe',
  'whoami.exe',
  'xz.exe',
  'yes.exe',
];

const GIT_CORE_REQUIRED_BINARIES = [
  'git.exe',
  'git-remote-https.exe',
  'git-http-fetch.exe',
  'git-http-push.exe',
  'git-credential-wincred.exe',
];

const GIT_CORE_OPTIONAL_ITEMS = [
  'git-remote-http.exe',
  'git-sh-i18n--envsubst.exe',
  'headless-git.exe',
  'git-difftool--helper',
  'git-filter-branch',
  'git-merge-octopus',
  'git-merge-one-file',
  'git-merge-resolve',
  'git-mergetool',
  'git-mergetool--lib',
  'git-request-pull',
  'git-sh-i18n',
  'git-sh-setup',
  'git-submodule',
  'git-subtree',
  'git-web--browse',
  'mergetools',
];

/**
 * Parse imported DLL names from a PE32 or PE32+ executable/DLL buffer,
 * covering both IMAGE_DIRECTORY_ENTRY_IMPORT and IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT.
 */
export function parsePeImports(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 0x40) {
    throw new Error('Invalid PE buffer: shorter than DOS header.');
  }
  if (buffer.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('Invalid PE buffer: missing MZ signature.');
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error('Invalid PE buffer: missing PE\\0\\0 signature.');
  }

  const coffOffset = peOffset + 4;
  const numSections = buffer.readUInt16LE(coffOffset + 2);
  const sizeOfOptionalHeader = buffer.readUInt16LE(coffOffset + 16);
  const optOffset = coffOffset + 20;
  if (optOffset + sizeOfOptionalHeader > buffer.length) {
    throw new Error('Invalid PE buffer: truncated optional header.');
  }

  const magic = buffer.readUInt16LE(optOffset);
  let imageBase = 0n;
  let numRvaAndSizes = 0;
  let dataDirOffset = 0;
  if (magic === 0x10b) {
    imageBase = BigInt(buffer.readUInt32LE(optOffset + 28));
    numRvaAndSizes = buffer.readUInt32LE(optOffset + 92);
    dataDirOffset = optOffset + 96;
  } else if (magic === 0x20b) {
    imageBase = buffer.readBigUInt64LE(optOffset + 24);
    numRvaAndSizes = buffer.readUInt32LE(optOffset + 108);
    dataDirOffset = optOffset + 112;
  } else {
    throw new Error(`Unsupported PE optional header magic: 0x${magic.toString(16)}`);
  }

  const sectionTableOffset = optOffset + sizeOfOptionalHeader;
  const sections = [];
  for (let i = 0; i < numSections; i += 1) {
    const secOffset = sectionTableOffset + i * 40;
    if (secOffset + 40 > buffer.length) break;
    sections.push({
      virtualSize: buffer.readUInt32LE(secOffset + 8),
      virtualAddress: buffer.readUInt32LE(secOffset + 12),
      sizeOfRawData: buffer.readUInt32LE(secOffset + 16),
      pointerToRawData: buffer.readUInt32LE(secOffset + 20),
    });
  }

  const rvaToOffset = (rva) => {
    if (rva === 0) return -1;
    for (const sec of sections) {
      const span = Math.max(sec.virtualSize, sec.sizeOfRawData);
      if (rva >= sec.virtualAddress && rva < sec.virtualAddress + span) {
        const delta = rva - sec.virtualAddress;
        if (delta >= sec.sizeOfRawData) return -1;
        const fileOffset = sec.pointerToRawData + delta;
        return fileOffset < buffer.length ? fileOffset : -1;
      }
    }
    return -1;
  };

  const readCStringAtRva = (rva) => {
    const offset = rvaToOffset(rva);
    if (offset < 0) return undefined;
    let end = offset;
    while (end < buffer.length && buffer[end] !== 0) end += 1;
    if (end === offset) return undefined;
    return buffer.toString('ascii', offset, end);
  };

  const imports = new Set();

  if (numRvaAndSizes > 1 && dataDirOffset + 16 <= optOffset + sizeOfOptionalHeader) {
    const importTableRva = buffer.readUInt32LE(dataDirOffset + 8);
    const importTableOffset = rvaToOffset(importTableRva);
    if (importTableRva !== 0 && importTableOffset >= 0) {
      for (let cursor = importTableOffset; cursor + 20 <= buffer.length; cursor += 20) {
        const origFirstThunk = buffer.readUInt32LE(cursor);
        const nameRva = buffer.readUInt32LE(cursor + 12);
        const firstThunk = buffer.readUInt32LE(cursor + 16);
        if (origFirstThunk === 0 && nameRva === 0 && firstThunk === 0) break;
        const dllName = readCStringAtRva(nameRva);
        if (dllName !== undefined) imports.add(dllName);
      }
    }
  }

  if (numRvaAndSizes > 13 && dataDirOffset + 14 * 8 <= optOffset + sizeOfOptionalHeader) {
    const delayRva = buffer.readUInt32LE(dataDirOffset + 13 * 8);
    const delayOffset = rvaToOffset(delayRva);
    if (delayRva !== 0 && delayOffset >= 0) {
      for (let cursor = delayOffset; cursor + 32 <= buffer.length; cursor += 32) {
        const attrs = buffer.readUInt32LE(cursor);
        const rawDllName = buffer.readUInt32LE(cursor + 4);
        if (attrs === 0 && rawDllName === 0) break;
        const isRva = (attrs & 1) !== 0;
        const nameRva = isRva ? rawDllName : Number(BigInt(rawDllName) - imageBase);
        const dllName = readCStringAtRva(nameRva);
        if (dllName !== undefined) imports.add(dllName);
      }
    }
  }

  return [...imports];
}

/**
 * Remove Git LFS and Git Credential Manager sections that are intentionally
 * omitted from the lean toolchain, switching credential.helper to wincred.
 */
export function sanitizeGitConfig(rawText) {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');
  const output = [];
  let currentSection = '';
  let sawCredentialHelper = false;

  for (const line of lines) {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sectionMatch !== null) {
      currentSection = sectionMatch[1].trim().toLowerCase();
      if (currentSection === 'filter "lfs"' || currentSection === 'diff "astextplain"') {
        continue;
      }
      output.push(line);
      continue;
    }
    if (currentSection === 'filter "lfs"' || currentSection === 'diff "astextplain"') {
      continue;
    }
    if (currentSection === 'credential' && /^\s*helper\s*=/i.test(line)) {
      if (!sawCredentialHelper) {
        output.push('\thelper = wincred');
        sawCredentialHelper = true;
      }
      continue;
    }
    output.push(line);
  }

  if (!sawCredentialHelper) {
    output.push('[credential]', '\thelper = wincred');
  }
  return `${output.join('\n').trimEnd()}\n`;
}

export function rewriteMsystemDefault(rawText, defaultMsystem) {
  return rawText.replace(
    /export\s+MSYSTEM="\$\{MSYSTEM:-[A-Z0-9_]+\}"/,
    `export MSYSTEM="\${MSYSTEM:-${defaultMsystem}}"`,
  );
}

export function sanitizeProfileAliases(rawText) {
  const marker = '\ncase "$TERM" in';
  const index = rawText.indexOf(marker);
  return index >= 0 ? `${rawText.slice(0, index).trimEnd()}\n` : rawText;
}

export function createToolchainNodeCmd() {
  return [
    '@echo off',
    'setlocal',
    'set "KIKI_NODE_SHIM=1"',
    'if defined KIKI_SEA_EXEC goto :kiki_run',
    'if defined KIKI_ELECTRON_NODE_EXEC if defined KIKI_ELECTRON_SERVER_ENTRY goto :kiki_electron_run',
    'if exist "%~dp0..\\..\\kiki-desktop.exe" if exist "%~dp0..\\..\\resources\\app.asar.unpacked\\dist\\server\\server-entry.mjs" set "KIKI_ELECTRON_NODE_EXEC=%~dp0..\\..\\kiki-desktop.exe" & set "KIKI_ELECTRON_SERVER_ENTRY=%~dp0..\\..\\resources\\app.asar.unpacked\\dist\\server\\server-entry.mjs"',
    'if defined KIKI_ELECTRON_NODE_EXEC if defined KIKI_ELECTRON_SERVER_ENTRY goto :kiki_electron_run',
    'if exist "%~dp0..\\..\\..\\kiki-desktop.exe" if exist "%~dp0..\\..\\..\\resources\\app.asar.unpacked\\dist\\server\\server-entry.mjs" set "KIKI_ELECTRON_NODE_EXEC=%~dp0..\\..\\..\\kiki-desktop.exe" & set "KIKI_ELECTRON_SERVER_ENTRY=%~dp0..\\..\\..\\resources\\app.asar.unpacked\\dist\\server\\server-entry.mjs"',
    'if defined KIKI_ELECTRON_NODE_EXEC if defined KIKI_ELECTRON_SERVER_ENTRY goto :kiki_electron_run',
    'if exist "%~dp0..\\..\\active\\kiki-desktop.exe" if exist "%~dp0..\\..\\active\\resources\\app.asar.unpacked\\dist\\server\\server-entry.mjs" set "KIKI_ELECTRON_NODE_EXEC=%~dp0..\\..\\active\\kiki-desktop.exe" & set "KIKI_ELECTRON_SERVER_ENTRY=%~dp0..\\..\\active\\resources\\app.asar.unpacked\\dist\\server\\server-entry.mjs"',
    'if defined KIKI_ELECTRON_NODE_EXEC if defined KIKI_ELECTRON_SERVER_ENTRY goto :kiki_electron_run',
    'if exist "%~dp0..\\..\\kiki-desktop.exe" if exist "%~dp0..\\..\\server-entry.mjs" set "KIKI_ELECTRON_NODE_EXEC=%~dp0..\\..\\kiki-desktop.exe" & set "KIKI_ELECTRON_SERVER_ENTRY=%~dp0..\\..\\server-entry.mjs"',
    'if defined KIKI_ELECTRON_NODE_EXEC if defined KIKI_ELECTRON_SERVER_ENTRY goto :kiki_electron_run',
    'if exist "%~dp0..\\..\\active\\kiki-desktop.exe" if exist "%~dp0..\\..\\active\\server-entry.mjs" set "KIKI_ELECTRON_NODE_EXEC=%~dp0..\\..\\active\\kiki-desktop.exe" & set "KIKI_ELECTRON_SERVER_ENTRY=%~dp0..\\..\\active\\server-entry.mjs"',
    'if defined KIKI_ELECTRON_NODE_EXEC if defined KIKI_ELECTRON_SERVER_ENTRY goto :kiki_electron_run',
    'if exist "%~dp0..\\..\\kiki-server.exe" set "KIKI_SEA_EXEC=%~dp0..\\..\\kiki-server.exe"',
    'if defined KIKI_SEA_EXEC goto :kiki_run',
    'if exist "%~dp0..\\..\\active\\kiki-server.exe" set "KIKI_SEA_EXEC=%~dp0..\\..\\active\\kiki-server.exe"',
    'if defined KIKI_SEA_EXEC goto :kiki_run',
    'if exist "%~dp0..\\..\\cli\\kiki.exe" set "KIKI_SEA_EXEC=%~dp0..\\..\\cli\\kiki.exe"',
    'if defined KIKI_SEA_EXEC goto :kiki_run',
    'if exist "%~dp0..\\..\\binaries\\kiki-server-x86_64-pc-windows-msvc.exe" set "KIKI_SEA_EXEC=%~dp0..\\..\\binaries\\kiki-server-x86_64-pc-windows-msvc.exe"',
    'if defined KIKI_SEA_EXEC goto :kiki_run',
    'if exist "%~dp0..\\..\\binaries\\kiki-server-aarch64-pc-windows-msvc.exe" set "KIKI_SEA_EXEC=%~dp0..\\..\\binaries\\kiki-server-aarch64-pc-windows-msvc.exe"',
    'if defined KIKI_SEA_EXEC goto :kiki_run',
    'if exist "%~dp0..\\..\\..\\..\\kimi-code\\dist-native\\bin\\win32-x64\\kiki.exe" set "KIKI_SEA_EXEC=%~dp0..\\..\\..\\..\\kimi-code\\dist-native\\bin\\win32-x64\\kiki.exe"',
    'if defined KIKI_SEA_EXEC goto :kiki_run',
    'if exist "%~dp0..\\..\\..\\..\\kimi-code\\dist-native\\bin\\win32-arm64\\kiki.exe" set "KIKI_SEA_EXEC=%~dp0..\\..\\..\\..\\kimi-code\\dist-native\\bin\\win32-arm64\\kiki.exe"',
    'if defined KIKI_SEA_EXEC goto :kiki_run',
    'echo Kiki bundled node shim could not locate kiki-desktop.exe, kiki-server.exe, or KIKI_SEA_EXEC.>&2',
    'exit /b 127',
    ':kiki_electron_run',
    'set "ELECTRON_RUN_AS_NODE=1"',
    '"%KIKI_ELECTRON_NODE_EXEC%" "%KIKI_ELECTRON_SERVER_ENTRY%" __plugin_run_node %*',
    'exit /b %ERRORLEVEL%',
    ':kiki_run',
    '"%KIKI_SEA_EXEC%" __plugin_run_node %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

export function createToolchainNodePosixWrapper() {
  return [
    '#!/usr/bin/env sh',
    'export KIKI_NODE_SHIM=1',
    'if [ -n "${KIKI_SEA_EXEC:-}" ]; then',
    '  exec "$KIKI_SEA_EXEC" __plugin_run_node "$@"',
    'fi',
    'if [ -n "${KIKI_ELECTRON_NODE_EXEC:-}" ] && [ -n "${KIKI_ELECTRON_SERVER_ENTRY:-}" ]; then',
    '  ELECTRON_RUN_AS_NODE=1 exec "$KIKI_ELECTRON_NODE_EXEC" "$KIKI_ELECTRON_SERVER_ENTRY" __plugin_run_node "$@"',
    'fi',
    'script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    'for base_dir in "$script_dir/../.." "$script_dir/../../.." "$script_dir/../../active"; do',
    '  if [ -f "$base_dir/kiki-desktop.exe" ]; then',
    '    if [ -f "$base_dir/resources/app.asar.unpacked/dist/server/server-entry.mjs" ]; then',
    '      ELECTRON_RUN_AS_NODE=1 exec "$base_dir/kiki-desktop.exe" "$base_dir/resources/app.asar.unpacked/dist/server/server-entry.mjs" __plugin_run_node "$@"',
    '    fi',
    '    if [ -f "$base_dir/server-entry.mjs" ]; then',
    '      ELECTRON_RUN_AS_NODE=1 exec "$base_dir/kiki-desktop.exe" "$base_dir/server-entry.mjs" __plugin_run_node "$@"',
    '    fi',
    '  fi',
    'done',
    'for candidate in \\',
    '  "$script_dir/../../kiki-server.exe" \\',
    '  "$script_dir/../../active/kiki-server.exe" \\',
    '  "$script_dir/../../cli/kiki.exe" \\',
    '  "$script_dir/../../binaries/kiki-server-x86_64-pc-windows-msvc.exe" \\',
    '  "$script_dir/../../binaries/kiki-server-aarch64-pc-windows-msvc.exe" \\',
    '  "$script_dir/../../../../kimi-code/dist-native/bin/win32-x64/kiki.exe" \\',
    '  "$script_dir/../../../../kimi-code/dist-native/bin/win32-arm64/kiki.exe"',
    'do',
    '  if [ -f "$candidate" ]; then',
    '    exec "$candidate" __plugin_run_node "$@"',
    '  fi',
    'done',
    'echo "Kiki bundled node shim could not locate kiki-desktop.exe, kiki-server.exe, or KIKI_SEA_EXEC." >&2',
    'exit 127',
    '',
  ].join('\n');
}

function createProfileToolchainHook() {
  return [
    '# Append adjacent Kiki toolchain/bin (rg.exe, SEA node shim) at the tail of PATH.',
    'if command -v cygpath >/dev/null 2>&1; then',
    '  _kiki_git_win="$(cygpath -m / 2>/dev/null)"',
    '  if [ -n "$_kiki_git_win" ]; then',
    '    _kiki_bin_unix="$(cygpath -u "${_kiki_git_win%/}/../bin" 2>/dev/null)"',
    '    if [ -n "$_kiki_bin_unix" ] && [ -d "$_kiki_bin_unix" ]; then',
    '      case ":$PATH:" in',
    '        *":$_kiki_bin_unix:"*) ;;',
    '        *) PATH="$PATH:$_kiki_bin_unix" ;;',
    '      esac',
    '    fi',
    '  fi',
    '  unset _kiki_git_win _kiki_bin_unix',
    'fi',
    '',
  ].join('\n');
}

function resolveGitForWindowsRoot(explicitRoot, env = process.env) {
  const candidates = [];
  if (explicitRoot) candidates.push(resolve(explicitRoot));
  if (env['KIKI_WINDOWS_GIT_ROOT']) candidates.push(resolve(env['KIKI_WINDOWS_GIT_ROOT']));

  const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = env['LOCALAPPDATA'];
  candidates.push(join(programFiles, 'Git'), join(programFilesX86, 'Git'));
  if (localAppData) candidates.push(join(localAppData, 'Programs', 'Git'));

  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  for (const rawDir of pathVar.split(';')) {
    const trimmed = rawDir.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmed) continue;
    const gitExe = join(trimmed, 'git.exe');
    if (existsSync(gitExe)) {
      const parent = dirname(trimmed);
      const grandParent = dirname(parent);
      candidates.push(parent, grandParent);
    }
  }

  for (const root of candidates) {
    if (
      existsSync(join(root, 'cmd', 'git.exe')) &&
      existsSync(join(root, 'usr', 'bin', 'bash.exe'))
    ) {
      return root;
    }
  }

  throw new Error(
    'Git for Windows root not found. Install Git for Windows on the build host or set KIKI_WINDOWS_GIT_ROOT.',
  );
}

export function detectSysPrefix(gitRoot, target) {
  const hasPrefixGit = (prefix) =>
    existsSync(join(gitRoot, prefix, 'bin', 'git.exe')) ||
    existsSync(join(gitRoot, prefix, 'libexec', 'git-core', 'git.exe'));

  const order = target.startsWith('aarch64-')
    ? [
        { sysPrefix: 'clangarm64', msystem: 'CLANGARM64' },
        { sysPrefix: 'ucrt64', msystem: 'UCRT64' },
        { sysPrefix: 'mingw64', msystem: 'MINGW64' },
        { sysPrefix: 'clang64', msystem: 'CLANG64' },
      ]
    : [
        { sysPrefix: 'ucrt64', msystem: 'UCRT64' },
        { sysPrefix: 'mingw64', msystem: 'MINGW64' },
        { sysPrefix: 'clang64', msystem: 'CLANG64' },
        { sysPrefix: 'clangarm64', msystem: 'CLANGARM64' },
      ];

  for (const candidate of order) {
    if (hasPrefixGit(candidate.sysPrefix)) {
      return candidate;
    }
  }
  throw new Error(
    `Unsupported Git for Windows layout under ${gitRoot}: missing ucrt64/mingw64/clang64/clangarm64 git.exe.`,
  );
}

function buildCaseInsensitiveDirMap(dirPath) {
  const map = new Map();
  if (!existsSync(dirPath)) return map;
  for (const name of readdirSync(dirPath)) {
    const full = join(dirPath, name);
    try {
      if (statSync(full).isFile()) {
        map.set(name.toLowerCase(), { name, fullPath: full });
      }
    } catch {
      // Ignore transient inaccessible entries.
    }
  }
  return map;
}

function isWindowsSystemDll(dllName, system32Map) {
  const lower = dllName.toLowerCase();
  if (lower.startsWith('api-ms-win-') || lower.startsWith('ext-ms-')) {
    return true;
  }
  return system32Map.has(lower);
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fetchRgArchive(target, cacheDir, explicitArchive) {
  const spec = RG_TARGETS.get(target);
  if (!spec) {
    throw new Error(`No ripgrep ${RG_VERSION} archive configured for Windows target ${target}.`);
  }

  if (explicitArchive) {
    const bytes = readFileSync(resolve(explicitArchive));
    const actual = sha256Hex(bytes);
    if (actual !== spec.sha256) {
      throw new Error(`SHA-256 mismatch for ${explicitArchive}: expected ${spec.sha256}, got ${actual}`);
    }
    return bytes;
  }

  mkdirSync(cacheDir, { recursive: true });
  const cachedPath = join(cacheDir, spec.archive);
  if (existsSync(cachedPath)) {
    const cachedBytes = readFileSync(cachedPath);
    if (sha256Hex(cachedBytes) === spec.sha256) {
      return cachedBytes;
    }
    rmSync(cachedPath, { force: true });
  }

  const urls = [`${RG_CDN_BASE_URL}/${spec.archive}`, `${RG_GITHUB_BASE_URL}/${spec.archive}`];
  const errors = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      if (!response.ok) {
        errors.push(`${url} -> HTTP ${response.status}`);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const actual = sha256Hex(bytes);
      if (actual !== spec.sha256) {
        errors.push(`${url} -> SHA-256 mismatch (${actual})`);
        continue;
      }
      writeFileSync(cachedPath, bytes);
      return bytes;
    } catch (error) {
      errors.push(`${url} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Failed to fetch verified ${spec.archive}: ${errors.join('; ')}`);
}

function extractRgBinaryFromZip(zipBytes) {
  const entries = unzipSync(new Uint8Array(zipBytes));
  for (const [entryName, content] of Object.entries(entries)) {
    const normalized = entryName.replace(/\\/g, '/');
    if ((normalized === 'rg.exe' || normalized.endsWith('/rg.exe')) && content.byteLength > 0) {
      return Buffer.from(content);
    }
  }
  throw new Error('ripgrep zip archive did not contain rg.exe');
}

function computeDirectoryStats(rootDir) {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files += 1;
        bytes += statSync(full).size;
      }
    }
  };
  if (existsSync(rootDir)) walk(rootDir);
  return { files, bytes };
}

function readDefaultWindowsHostTarget() {
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  }
  try {
    const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
    const hostLine = out.split(/\r?\n/).find((line) => line.startsWith('host:'));
    if (hostLine) return hostLine.slice('host:'.length).trim();
  } catch {
    // Fall back below.
  }
  return 'x86_64-pc-windows-msvc';
}

function copyRelativeFile(gitRoot, outGitRoot, relPath) {
  const src = join(gitRoot, relPath);
  const dst = join(outGitRoot, relPath);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return dst;
}

export async function stageWindowsToolchain({
  target = process.env['TAURI_TARGET_TRIPLE'] ?? readDefaultWindowsHostTarget(),
  outputDir = DEFAULT_OUTPUT_DIR,
  gitRoot: explicitGitRoot,
  rgArchive,
  cacheDir = process.env['KIKI_RG_CACHE_DIR'] ?? DEFAULT_CACHE_DIR,
  force = false,
  env = process.env,
} = {}) {
  if (!target.includes('windows')) {
    return { skipped: true, target, reason: 'non-windows-target' };
  }
  if (
    process.platform !== 'win32' &&
    !explicitGitRoot &&
    !env['KIKI_WINDOWS_GIT_ROOT']
  ) {
    return { skipped: true, target, reason: 'non-windows-host' };
  }
  if (!RG_TARGETS.has(target)) {
    throw new Error(`Unsupported Windows toolchain target: ${target}`);
  }

  const resolvedOutput = resolve(outputDir);
  const gitRoot = resolveGitForWindowsRoot(explicitGitRoot, env);
  const { sysPrefix, msystem } = detectSysPrefix(gitRoot, target);
  const packageVersionsPath = join(gitRoot, 'etc', 'package-versions.txt');
  const gitFingerprint = existsSync(packageVersionsPath)
    ? sha256Hex(readFileSync(packageVersionsPath)).slice(0, 16)
    : String(statSync(join(gitRoot, 'cmd', 'git.exe')).size);
  const rgSpec = RG_TARGETS.get(target);
  const nodeCmdContent = createToolchainNodeCmd();
  const nodePosixContent = createToolchainNodePosixWrapper();
  const shimFingerprint = sha256Hex(Buffer.from(`${nodeCmdContent}\n${nodePosixContent}`, 'utf8')).slice(0, 16);

  const manifestPath = join(resolvedOutput, 'toolchain-manifest.json');
  if (!force && existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (
        existing.schemaVersion === TOOLCHAIN_MANIFEST_SCHEMA &&
        existing.target === target &&
        existing.gitFingerprint === gitFingerprint &&
        existing.rgSha256 === rgSpec.sha256 &&
        existing.shimFingerprint === shimFingerprint &&
        existsSync(join(resolvedOutput, 'git', 'bin', 'bash.exe')) &&
        existsSync(join(resolvedOutput, 'git', 'cmd', 'git.exe')) &&
        existsSync(join(resolvedOutput, 'bin', 'rg.exe')) &&
        existsSync(join(resolvedOutput, 'bin', 'node.cmd')) &&
        existsSync(join(resolvedOutput, 'bin', 'node'))
      ) {
        return {
          skipped: false,
          reused: true,
          target,
          outputDir: resolvedOutput,
          files: existing.files,
          bytes: existing.bytes,
        };
      }
    } catch {
      // Rebuild cleanly when manifest cannot be parsed.
    }
  }

  const stagingDir = `${resolvedOutput}.staging-${process.pid}`;
  rmSync(stagingDir, { recursive: true, force: true });
  const outGitRoot = join(stagingDir, 'git');
  const outBinDir = join(stagingDir, 'bin');
  mkdirSync(outGitRoot, { recursive: true });
  mkdirSync(outBinDir, { recursive: true });

  try {
    const stagedPeRelPaths = new Set();
    const stageGitBinary = (relPath, required = true) => {
      const src = join(gitRoot, relPath);
      if (!existsSync(src)) {
        if (required) {
          throw new Error(`Required Git for Windows file missing: ${src}`);
        }
        return false;
      }
      const stat = statSync(src);
      if (stat.isDirectory()) {
        const dst = join(outGitRoot, relPath);
        mkdirSync(dirname(dst), { recursive: true });
        cpSync(src, dst, { recursive: true });
        return true;
      }
      copyRelativeFile(gitRoot, outGitRoot, relPath);
      const ext = extname(relPath).toLowerCase();
      if (ext === '.exe' || ext === '.dll') {
        stagedPeRelPaths.add(relPath.replace(/\\/g, '/'));
      }
      return true;
    };

    stageGitBinary('cmd/git.exe', true);
    stageGitBinary('cmd/start-ssh-agent.cmd', false);
    stageGitBinary('cmd/start-ssh-pageant.cmd', false);
    stageGitBinary('bin/bash.exe', true);
    stageGitBinary('bin/sh.exe', true);
    stageGitBinary('bin/git.exe', false);

    stageGitBinary(`${sysPrefix}/bin/git.exe`, false);
    stageGitBinary(`${sysPrefix}/bin/git-receive-pack.exe`, false);
    stageGitBinary(`${sysPrefix}/bin/git-upload-archive.exe`, false);
    stageGitBinary(`${sysPrefix}/bin/git-upload-pack.exe`, false);
    stageGitBinary(`${sysPrefix}/bin/curl.exe`, true);
    stageGitBinary(`${sysPrefix}/bin/headless-git.exe`, false);

    for (const exe of GIT_CORE_REQUIRED_BINARIES) {
      stageGitBinary(`${sysPrefix}/libexec/git-core/${exe}`, true);
    }
    for (const item of GIT_CORE_OPTIONAL_ITEMS) {
      stageGitBinary(`${sysPrefix}/libexec/git-core/${item}`, false);
    }

    for (const tool of REQUIRED_USR_BIN_TOOLS) {
      stageGitBinary(`usr/bin/${tool}`, true);
    }
    for (const tool of OPTIONAL_USR_BIN_TOOLS) {
      stageGitBinary(`usr/bin/${tool}`, false);
    }

    const dirMaps = new Map([
      ['usr/bin', buildCaseInsensitiveDirMap(join(gitRoot, 'usr', 'bin'))],
      [`${sysPrefix}/bin`, buildCaseInsensitiveDirMap(join(gitRoot, sysPrefix, 'bin'))],
      ['bin', buildCaseInsensitiveDirMap(join(gitRoot, 'bin'))],
      ['cmd', buildCaseInsensitiveDirMap(join(gitRoot, 'cmd'))],
    ]);
    const systemRoot = env['SystemRoot'] ?? env['WINDIR'] ?? 'C:\\Windows';
    const system32Map = buildCaseInsensitiveDirMap(join(systemRoot, 'System32'));

    const queue = [...stagedPeRelPaths];
    const inspected = new Set();
    while (queue.length > 0) {
      const relPe = queue.shift();
      const key = relPe.toLowerCase();
      if (inspected.has(key)) continue;
      inspected.add(key);

      const fullPe = join(outGitRoot, relPe);
      const peBytes = readFileSync(fullPe);
      const importedDlls = parsePeImports(peBytes);

      const relDir = dirname(relPe).replace(/\\/g, '/');
      const searchDirs =
        relDir === 'usr/bin'
          ? ['usr/bin']
          : relDir.startsWith(`${sysPrefix}/`)
            ? [`${sysPrefix}/bin`, 'usr/bin']
            : [relDir, `${sysPrefix}/bin`, 'usr/bin'];

      for (const dllName of importedDlls) {
        const lowerDll = dllName.toLowerCase();
        let resolvedRelDll;
        for (const candidateDir of searchDirs) {
          let map = dirMaps.get(candidateDir);
          if (!map) {
            map = buildCaseInsensitiveDirMap(join(gitRoot, candidateDir));
            dirMaps.set(candidateDir, map);
          }
          const hit = map.get(lowerDll);
          if (hit) {
            resolvedRelDll = `${candidateDir}/${hit.name}`;
            break;
          }
        }

        if (resolvedRelDll) {
          if (!stagedPeRelPaths.has(resolvedRelDll)) {
            copyRelativeFile(gitRoot, outGitRoot, resolvedRelDll);
            stagedPeRelPaths.add(resolvedRelDll);
            queue.push(resolvedRelDll);
          }
          continue;
        }

        if (!isWindowsSystemDll(dllName, system32Map)) {
          throw new Error(
            `Missing non-system DLL dependency "${dllName}" imported by "${relPe}" in ${gitRoot}`,
          );
        }
      }
    }

    stageGitBinary('LICENSE.txt', true);
    const hasSysCa = stageGitBinary(`${sysPrefix}/etc/ssl/certs/ca-bundle.crt`, false);
    stageGitBinary(`${sysPrefix}/etc/ssl/certs/ca-bundle.trust.crt`, false);
    const hasUsrCa = stageGitBinary('usr/ssl/certs/ca-bundle.crt', false);
    if (!hasSysCa && !hasUsrCa) {
      throw new Error(`Missing SSL CA bundle under ${gitRoot}`);
    }
    stageGitBinary('usr/ssl/openssl.cnf', false);
    stageGitBinary(`${sysPrefix}/share/git-core/templates`, false);

    for (const etcItem of [
      'etc/profile',
      'etc/bash.bashrc',
      'etc/fstab',
      'etc/nsswitch.conf',
      'etc/DIR_COLORS',
      'etc/gitattributes',
      'etc/hosts',
      'etc/inputrc',
      'etc/networks',
      'etc/protocols',
      'etc/services',
      'etc/msystem.d',
      'etc/ssh',
      'etc/profile.d/env.sh',
      'etc/profile.d/git-prompt.sh',
      'etc/profile.d/lang.sh',
    ]) {
      stageGitBinary(etcItem, etcItem === 'etc/profile' || etcItem === 'etc/msystem.d');
    }

    const rawGitConfig = readFileSync(join(gitRoot, 'etc', 'gitconfig'), 'utf8');
    const outGitConfig = join(outGitRoot, 'etc', 'gitconfig');
    mkdirSync(dirname(outGitConfig), { recursive: true });
    writeFileSync(outGitConfig, sanitizeGitConfig(rawGitConfig), 'utf8');

    const rawMsystem = readFileSync(join(gitRoot, 'etc', 'msystem'), 'utf8');
    writeFileSync(join(outGitRoot, 'etc', 'msystem'), rewriteMsystemDefault(rawMsystem, msystem), 'utf8');

    const rawAliasesPath = join(gitRoot, 'etc', 'profile.d', 'aliases.sh');
    if (existsSync(rawAliasesPath)) {
      const outAliasesPath = join(outGitRoot, 'etc', 'profile.d', 'aliases.sh');
      mkdirSync(dirname(outAliasesPath), { recursive: true });
      writeFileSync(outAliasesPath, sanitizeProfileAliases(readFileSync(rawAliasesPath, 'utf8')), 'utf8');
    }
    mkdirSync(join(outGitRoot, 'etc', 'profile.d'), { recursive: true });
    writeFileSync(
      join(outGitRoot, 'etc', 'profile.d', 'z-kiki-toolchain.sh'),
      createProfileToolchainHook(),
      'utf8',
    );
    mkdirSync(join(outGitRoot, 'tmp'), { recursive: true });
    writeFileSync(join(outGitRoot, 'tmp', '.keep'), '', 'utf8');

    const rgZipBytes = await fetchRgArchive(target, cacheDir, rgArchive);
    const rgExeBytes = extractRgBinaryFromZip(rgZipBytes);
    const rgImports = parsePeImports(rgExeBytes);
    for (const dllName of rgImports) {
      if (!isWindowsSystemDll(dllName, system32Map)) {
        throw new Error(`Bundled rg.exe imports unexpected non-system DLL: ${dllName}`);
      }
    }
    const outRgPath = join(outBinDir, 'rg.exe');
    writeFileSync(outRgPath, rgExeBytes);

    const outNodeCmd = join(outBinDir, 'node.cmd');
    const outNodePosix = join(outBinDir, 'node');
    writeFileSync(outNodeCmd, nodeCmdContent, 'utf8');
    writeFileSync(outNodePosix, nodePosixContent, 'utf8');
    chmodSync(outNodePosix, 0o755);

    const stats = computeDirectoryStats(stagingDir);
    const manifest = {
      schemaVersion: TOOLCHAIN_MANIFEST_SCHEMA,
      target,
      msystem,
      gitFingerprint,
      shimFingerprint,
      rgVersion: RG_VERSION,
      rgSha256: rgSpec.sha256,
      peBinariesVerified: inspected.size + 1,
      files: stats.files,
      bytes: stats.bytes,
    };
    writeFileSync(join(stagingDir, 'toolchain-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    rmSync(resolvedOutput, { recursive: true, force: true });
    mkdirSync(dirname(resolvedOutput), { recursive: true });
    try {
      renameSync(stagingDir, resolvedOutput);
    } catch {
      cpSync(stagingDir, resolvedOutput, { recursive: true });
      rmSync(stagingDir, { recursive: true, force: true });
    }

    return {
      skipped: false,
      reused: false,
      target,
      outputDir: resolvedOutput,
      files: stats.files,
      bytes: stats.bytes,
      peBinariesVerified: manifest.peBinariesVerified,
    };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        target: { type: 'string' },
        output: { type: 'string' },
        'git-root': { type: 'string' },
        'rg-archive': { type: 'string' },
        'cache-dir': { type: 'string' },
        force: { type: 'boolean', default: false },
      },
      strict: true,
    });

    const result = await stageWindowsToolchain({
      target: values.target,
      outputDir: values.output,
      gitRoot: values['git-root'],
      rgArchive: values['rg-archive'],
      cacheDir: values['cache-dir'],
      force: values.force,
    });
    if (result.skipped) {
      process.stdout.write(`[kiki toolchain] skipped (${result.reason} for ${result.target})\n`);
      return;
    }
    const mb = (result.bytes / (1024 * 1024)).toFixed(1);
    const mode = result.reused ? 'reused cached' : 'staged';
    process.stdout.write(
      `[kiki toolchain] ${mode} ${result.files} files (${mb} MiB) for ${result.target}: ${result.outputDir}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `[kiki toolchain] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main();
}
