/**
 * Environment — cross-platform probe of OS / shell.
 *
 * Detection is a pure function of injected probes (`platform` / `arch` /
 * `release` / `env` / `isFile` / `execFileText`) so the same suite runs
 * identically on any host OS. `detectEnvironmentFromNode()` bundles the Node
 * defaults for production callers.
 *
 * On Windows the probe resolves Git Bash from `KIKI_SHELL_PATH`, user `PATH` /
 * standard Git for Windows locations, or a bundled Kiki `toolchain/`, falling
 * back gracefully to PowerShell (`pwsh.exe` / `powershell.exe`) when no Bash
 * shell is available so workspace/profile inspection and file tools never fail
 * on clean hosts.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

// `OsKind` carries 'macOS' / 'Linux' / 'Windows' for known platforms and
// falls back to the raw `process.platform` string for unknown ones (e.g.
// 'freebsd'). Typed as `string` so the union isn't inhabited-by-string.
export type OsKind = string;
export type ShellName = 'bash' | 'sh' | 'powershell' | 'cmd';
export type PathClass = 'posix' | 'win32';

export interface Environment {
  readonly osKind: OsKind;
  readonly osArch: string;
  readonly osVersion: string;
  readonly shellName: ShellName;
  readonly shellPath: string;
  readonly pathClass: PathClass;
  readonly homeDir: string;
}

export type HostEnvironmentInfo = Environment;

export interface EnvironmentDeps {
  // Accepts the full Node `Platform` enum plus arbitrary strings for
  // forward-compatible OS kinds.
  readonly platform: string;
  readonly arch: string;
  readonly release: string;
  readonly homeDir?: string;
  readonly execPath?: string;
  readonly env: Record<string, string | undefined>;
  readonly isFile: (path: string) => Promise<boolean>;
  readonly execFileText: (
    file: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<string | undefined>;
}

export type HostEnvironmentProbeDeps = EnvironmentDeps & { readonly homeDir: string };

const GIT_EXEC_PATH_TIMEOUT_MS = 5_000;

const MINGW_PREFIX_SET: ReadonlySet<string> = new Set([
  'mingw32',
  'mingw64',
  'ucrt64',
  'clang64',
  'clangarm64',
]);

function resolveOsKind(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): OsKind {
  const configured = env['KIKI_PLATFORM']?.trim().toLowerCase();
  if (configured === 'android') return 'Android';
  if (configured === 'ios') return 'iOS';
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    case 'android':
      return 'Android';
    case 'ios':
      return 'iOS';
    case 'win32':
      return 'Windows';
    default:
      return platform;
  }
}

function inferPosixShellName(shellPath: string): 'bash' | 'sh' {
  const base = nodePath.posix.basename(shellPath).toLowerCase();
  return base === 'bash' || base.endsWith('-bash') ? 'bash' : 'sh';
}

function inferWindowsShellName(shellPath: string): ShellName {
  const base = nodePath.win32.basename(normalizeWindowsPath(shellPath)).toLowerCase();
  if (base === 'pwsh' || base === 'pwsh.exe' || base === 'powershell' || base === 'powershell.exe') {
    return 'powershell';
  }
  if (base === 'cmd' || base === 'cmd.exe') return 'cmd';
  if (base === 'sh' || base === 'sh.exe') return 'sh';
  return 'bash';
}

function findEnvPathEntry(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): { readonly key: string; readonly value: string | undefined } {
  if (platform !== 'win32') return { key: 'PATH', value: env['PATH'] };
  if (env['PATH'] !== undefined) return { key: 'PATH', value: env['PATH'] };
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === 'path') return { key, value };
  }
  return { key: 'PATH', value: undefined };
}

export function bundledWindowsToolchainCandidates(
  env: Readonly<Record<string, string | undefined>>,
  execPath?: string,
): readonly string[] {
  if (env['KIKI_DISABLE_BUNDLED_TOOLCHAIN'] === '1') return [];
  const candidates: string[] = [];
  const explicit = env['KIKI_TOOLCHAIN_DIR']?.trim();
  if (explicit !== undefined && explicit.length > 0 && isAbsoluteWindowsPath(explicit)) {
    candidates.push(nodePath.win32.normalize(normalizeWindowsPath(explicit)));
  }
  if (execPath !== undefined && execPath.trim().length > 0 && isAbsoluteWindowsPath(execPath)) {
    const normalizedExec = nodePath.win32.normalize(normalizeWindowsPath(execPath));
    const execDir = nodePath.win32.dirname(normalizedExec);
    const execBase = nodePath.win32.basename(normalizedExec).toLowerCase();
    if (execBase !== 'node.exe' && execBase !== 'node') {
      candidates.push(nodePath.win32.join(execDir, 'toolchain'));
      candidates.push(nodePath.win32.join(execDir, 'resources', 'toolchain'));
      candidates.push(nodePath.win32.normalize(nodePath.win32.join(execDir, '..', 'toolchain')));
      candidates.push(
        nodePath.win32.normalize(nodePath.win32.join(execDir, '..', 'resources', 'toolchain')),
      );
      candidates.push(
        nodePath.win32.normalize(nodePath.win32.join(execDir, '..', '..', 'toolchain')),
      );
    }
  }
  return dedupeWindowsPaths(candidates);
}

export async function locateBundledWindowsToolchainRoot(
  deps: Pick<EnvironmentDeps, 'platform' | 'env' | 'execPath' | 'isFile'>,
): Promise<string | undefined> {
  if (deps.platform !== 'win32') return undefined;
  for (const root of bundledWindowsToolchainCandidates(deps.env, deps.execPath)) {
    const markers = [
      nodePath.win32.join(root, 'git', 'bin', 'bash.exe'),
      nodePath.win32.join(root, 'git', 'usr', 'bin', 'bash.exe'),
      nodePath.win32.join(root, 'bin', 'rg.exe'),
      nodePath.win32.join(root, 'git', 'cmd', 'git.exe'),
    ];
    for (const marker of markers) {
      if (await deps.isFile(marker)) return root;
    }
  }
  return undefined;
}

export async function applyBundledWindowsToolchainPath(
  deps: Pick<EnvironmentDeps, 'platform' | 'env' | 'execPath' | 'isFile'>,
): Promise<string | undefined> {
  if (deps.platform !== 'win32') return undefined;
  const toolchainRoot = await locateBundledWindowsToolchainRoot(deps);
  if (toolchainRoot === undefined) return undefined;

  const dirProbes: readonly { readonly dir: string; readonly markers: readonly string[] }[] = [
    {
      dir: nodePath.win32.join(toolchainRoot, 'git', 'cmd'),
      markers: ['git.exe'],
    },
    {
      dir: nodePath.win32.join(toolchainRoot, 'git', 'mingw64', 'bin'),
      markers: ['git.exe', 'curl.exe'],
    },
    {
      dir: nodePath.win32.join(toolchainRoot, 'git', 'clangarm64', 'bin'),
      markers: ['git.exe', 'curl.exe'],
    },
    {
      dir: nodePath.win32.join(toolchainRoot, 'git', 'usr', 'bin'),
      markers: ['bash.exe', 'sed.exe'],
    },
    {
      dir: nodePath.win32.join(toolchainRoot, 'bin'),
      markers: ['rg.exe', 'node.cmd'],
    },
  ];

  const pathEntry = findEnvPathEntry(deps.env, 'win32');
  const current = pathEntry.value ?? '';
  const existingParts = current.length === 0 ? [] : current.split(';');
  const seen = new Set(
    existingParts
      .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, ''))
      .filter((entry) => entry.length > 0)
      .map((entry) => normalizeWindowsPath(entry).toLowerCase()),
  );
  const additions: string[] = [];
  for (const probe of dirProbes) {
    const key = normalizeWindowsPath(probe.dir).replace(/\\+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    let present = false;
    for (const marker of probe.markers) {
      if (await deps.isFile(nodePath.win32.join(probe.dir, marker))) {
        present = true;
        break;
      }
    }
    if (!present) continue;
    seen.add(key);
    additions.push(probe.dir);
  }
  if (additions.length > 0) {
    const joined = additions.join(';');
    deps.env[pathEntry.key] = current.length === 0
      ? joined
      : current.endsWith(';')
        ? `${current}${joined}`
        : `${current};${joined}`;
  }
  return toolchainRoot;
}

async function runEnvironmentProbe(deps: EnvironmentDeps): Promise<Environment> {
  const osKind = resolveOsKind(deps.platform, deps.env);
  const osArch = deps.arch;
  const osVersion = deps.release;
  const pathClass: PathClass = deps.platform === 'win32' ? 'win32' : 'posix';
  const homeDir = deps.homeDir ?? '';

  if (deps.platform === 'win32') {
    const { shellName, shellPath } = await locateWindowsShell(deps);
    return { osKind, osArch, osVersion, shellName, shellPath, pathClass, homeDir };
  }

  const override = deps.env['KIKI_SHELL_PATH']?.trim();
  if (override !== undefined && override.length > 0 && await deps.isFile(override)) {
    return {
      osKind,
      osArch,
      osVersion,
      shellName: inferPosixShellName(override),
      shellPath: override,
      pathClass,
      homeDir,
    };
  }

  const candidates: readonly string[] = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'];
  let found: string | undefined;
  for (const p of candidates) {
    if (await deps.isFile(p)) {
      found = p;
      break;
    }
  }
  if (found !== undefined) {
    return { osKind, osArch, osVersion, shellName: 'bash', shellPath: found, pathClass, homeDir };
  }

  const isAndroid =
    deps.platform === 'android' || deps.env['KIKI_PLATFORM']?.trim().toLowerCase() === 'android';
  if (!isAndroid && await deps.isFile('/bin/sh')) {
    return { osKind, osArch, osVersion, shellName: 'sh', shellPath: '/bin/sh', pathClass, homeDir };
  }
  if (await deps.isFile('/system/bin/sh')) {
    return {
      osKind,
      osArch,
      osVersion,
      shellName: 'sh',
      shellPath: '/system/bin/sh',
      pathClass,
      homeDir,
    };
  }
  return {
    osKind,
    osArch,
    osVersion,
    shellName: 'sh',
    shellPath: isAndroid ? '/system/bin/sh' : '/bin/sh',
    pathClass,
    homeDir,
  };
}

export async function detectEnvironment(deps: EnvironmentDeps): Promise<Environment> {
  return runEnvironmentProbe(deps);
}

export async function probeHostEnvironment(
  deps: HostEnvironmentProbeDeps,
): Promise<HostEnvironmentInfo> {
  return runEnvironmentProbe(deps);
}

function isWithinWindowsPrefix(candidate: string, prefix: string): boolean {
  const normCandidate = nodePath.win32.normalize(normalizeWindowsPath(candidate)).toLowerCase();
  const normPrefix = nodePath.win32.normalize(normalizeWindowsPath(prefix)).replace(/\\+$/, '').toLowerCase();
  return normCandidate === normPrefix || normCandidate.startsWith(`${normPrefix}\\`);
}

async function locateWindowsShell(
  deps: EnvironmentDeps,
): Promise<{ readonly shellName: ShellName; readonly shellPath: string }> {
  const override = deps.env['KIKI_SHELL_PATH']?.trim();
  if (override !== undefined && override.length > 0 && await deps.isFile(override)) {
    return { shellName: inferWindowsShellName(override), shellPath: override };
  }

  const bundledRoots = bundledWindowsToolchainCandidates(deps.env, deps.execPath);
  const pathValue = findEnvPathEntry(deps.env, 'win32').value;
  const gitExecutables = await findExecutablesOnPath(
    'git.exe',
    pathValue,
    deps.platform,
    deps.isFile,
  );

  for (const gitExe of gitExecutables) {
    if (bundledRoots.some((root) => isWithinWindowsPrefix(gitExe, root))) {
      continue;
    }
    const inferred = gitBashCandidatesFromGitExe(gitExe);
    if (inferred !== undefined) {
      for (const candidate of inferred) {
        if (await deps.isFile(candidate)) {
          return { shellName: 'bash', shellPath: candidate };
        }
      }
    }

    const gitExecPath = await readGitExecPath(deps, gitExe);
    if (gitExecPath === undefined) {
      continue;
    }
    for (const candidate of gitBashCandidatesFromGitExecPath(gitExecPath)) {
      if (await deps.isFile(candidate)) {
        return { shellName: 'bash', shellPath: candidate };
      }
    }
  }

  const programFiles = deps.env['ProgramFiles']?.trim() || 'C:\\Program Files';
  const programFilesX86 = deps.env['ProgramFiles(x86)']?.trim() || 'C:\\Program Files (x86)';
  const systemCandidates: string[] = [
    ...gitBashCandidatesFromGitRoot(nodePath.win32.join(normalizeWindowsPath(programFiles), 'Git')),
    ...gitBashCandidatesFromGitRoot(nodePath.win32.join(normalizeWindowsPath(programFilesX86), 'Git')),
  ];
  const localAppData = deps.env['LOCALAPPDATA']?.trim();
  if (localAppData !== undefined && localAppData.length > 0) {
    systemCandidates.push(
      ...gitBashCandidatesFromGitRoot(nodePath.win32.join(normalizeWindowsPath(localAppData), 'Programs', 'Git')),
    );
  }
  for (const candidate of systemCandidates) {
    if (await deps.isFile(candidate)) {
      return { shellName: 'bash', shellPath: candidate };
    }
  }

  for (const root of bundledRoots) {
    for (const candidate of gitBashCandidatesFromGitRoot(nodePath.win32.join(root, 'git'))) {
      if (await deps.isFile(candidate)) {
        return { shellName: 'bash', shellPath: candidate };
      }
    }
  }

  const pwshOnPath = await findExecutablesOnPath('pwsh.exe', pathValue, deps.platform, deps.isFile);
  if (pwshOnPath.length > 0) {
    return { shellName: 'powershell', shellPath: pwshOnPath[0]! };
  }
  const psOnPath = await findExecutablesOnPath(
    'powershell.exe',
    pathValue,
    deps.platform,
    deps.isFile,
  );
  if (psOnPath.length > 0) {
    return { shellName: 'powershell', shellPath: psOnPath[0]! };
  }

  const systemRoot =
    deps.env['SystemRoot']?.trim() ||
    deps.env['WINDIR']?.trim() ||
    'C:\\Windows';
  const defaultPowerShell = nodePath.win32.join(
    normalizeWindowsPath(systemRoot),
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return { shellName: 'powershell', shellPath: defaultPowerShell };
}

async function readGitExecPath(
  deps: EnvironmentDeps,
  gitExe: string,
): Promise<string | undefined> {
  if (deps.platform === 'win32' && !isAbsoluteWindowsPath(gitExe)) return undefined;

  const stdout = await deps.execFileText(gitExe, ['--exec-path'], GIT_EXEC_PATH_TIMEOUT_MS);
  if (stdout === undefined) return undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const execPath = line.trim();
    if (execPath.length > 0) {
      return execPath;
    }
  }
  return undefined;
}

// Most Git for Windows installs put `git.exe` in `<root>\cmd\git.exe`,
// with bash at `<root>\bin\bash.exe`. Portable installs sometimes put
// both in `<root>\bin\`. Only infer from those anchored layouts; package
// manager shims live elsewhere and must resolve through `git --exec-path`.
function gitBashCandidatesFromGitExe(gitExe: string): readonly string[] | undefined {
  const normalizedGitExe = nodePath.win32.normalize(normalizeWindowsPath(gitExe));
  const gitDir = nodePath.win32.dirname(normalizedGitExe);
  const gitDirName = nodePath.win32.basename(gitDir).toLowerCase();
  if (gitDirName !== 'cmd' && gitDirName !== 'bin') {
    return undefined;
  }
  return gitBashCandidatesFromGitRoot(nodePath.win32.dirname(gitDir));
}

function gitBashCandidatesFromGitExecPath(execPath: string): readonly string[] {
  const normalized = nodePath.win32.normalize(normalizeWindowsPath(execPath));
  const parts = normalized.split('\\');
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const segment = parts[i]?.toLowerCase();
    if (segment !== undefined && MINGW_PREFIX_SET.has(segment)) {
      const root = parts.slice(0, i).join('\\');
      if (root.length > 0) {
        return gitBashCandidatesFromGitRoot(root);
      }
    }
  }

  return gitBashCandidatesFromGitRoot(nodePath.win32.join(normalized, '..', '..'));
}

function gitBashCandidatesFromGitRoot(root: string): readonly string[] {
  return [
    nodePath.win32.normalize(nodePath.win32.join(root, 'bin', 'bash.exe')),
    nodePath.win32.normalize(nodePath.win32.join(root, 'usr', 'bin', 'bash.exe')),
  ];
}

function normalizeWindowsPath(path: string): string {
  return path.replaceAll('/', '\\');
}

function isAbsoluteWindowsPath(path: string): boolean {
  return nodePath.win32.isAbsolute(normalizeWindowsPath(path));
}

function dedupeWindowsPaths(paths: readonly string[]): readonly string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const key = normalizeWindowsPath(path).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(path);
  }
  return deduped;
}

/**
 * Production convenience — derive the deps bag from Node's ambient surface.
 *
 * The result is memoised: subsequent calls return the original promise.
 * `Environment` is immutable for the lifetime of the process (it derives
 * from `process.platform`, `process.arch`, `os.release()`, and one-time
 * shell-path discovery), so caching is sound. Tests that need to probe
 * with different inputs should call {@link detectEnvironment} directly
 * with an injected deps bag.
 */
let detectedEnvironment: Promise<Environment> | undefined;
let probedHostEnvironment: Promise<HostEnvironmentInfo> | undefined;
let appliedBundledToolchainPath: Promise<string | undefined> | undefined;

function createNodeProbeDeps(): HostEnvironmentProbeDeps {
  const platform = process.platform;
  const env = process.env as Record<string, string | undefined>;
  const isFile = async (path: string): Promise<boolean> => {
    try {
      await access(path, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  };
  return {
    platform,
    arch: process.arch,
    release: nodeOs.release(),
    homeDir: nodeOs.homedir(),
    execPath: process.execPath,
    env,
    isFile,
    execFileText,
  };
}

export function detectEnvironmentFromNode(): Promise<Environment> {
  if (detectedEnvironment !== undefined) return detectedEnvironment;
  detectedEnvironment = detectEnvironment(createNodeProbeDeps());
  return detectedEnvironment;
}

export function probeHostEnvironmentFromNode(): Promise<HostEnvironmentInfo> {
  if (probedHostEnvironment !== undefined) return probedHostEnvironment;
  probedHostEnvironment = probeHostEnvironment(createNodeProbeDeps());
  return probedHostEnvironment;
}

export function applyBundledWindowsToolchainPathFromNode(): Promise<string | undefined> {
  if (appliedBundledToolchainPath !== undefined) return appliedBundledToolchainPath;
  appliedBundledToolchainPath = applyBundledWindowsToolchainPath(createNodeProbeDeps());
  return appliedBundledToolchainPath;
}

async function findExecutablesOnPath(
  name: string,
  pathEnv: string | undefined,
  platform: string,
  isFile: (p: string) => Promise<boolean>,
): Promise<readonly string[]> {
  if (pathEnv === undefined || pathEnv.length === 0) return [];
  const listSep = platform === 'win32' ? ';' : ':';
  const dirSep = platform === 'win32' ? '\\' : '/';
  const paths: string[] = [];
  for (const rawDir of pathEnv.split(listSep)) {
    const dir = rawDir.trim();
    if (dir.length === 0) continue;
    if (platform === 'win32' && !isAbsoluteWindowsPath(dir)) continue;
    const candidate = dir.endsWith(dirSep) ? `${dir}${name}` : `${dir}${dirSep}${name}`;
    if (await isFile(candidate)) {
      paths.push(candidate);
    }
  }
  return platform === 'win32' ? dedupeWindowsPaths(paths) : paths;
}

export async function execFileText(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    nodeExecFile(
      file,
      [...args],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve(undefined);
          return;
        }
        resolve(stdout);
      },
    );
  });
}
