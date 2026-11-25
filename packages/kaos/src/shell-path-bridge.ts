/**
 * Shell path bridge — translate between native win32 paths and the POSIX
 * path dialect spoken by the MSYS2 / Git Bash shell.
 *
 * The msys runtime gives the shell a POSIX path view native Node.js cannot
 * resolve (`/c/Users/x` is `C:\Users\x`; `/tmp/x` is `%TEMP%\x`, not
 * `<git-root>/tmp`). `toShellPath` renders native paths for bash command
 * lines; `fromShellPath` resolves model/shell-supplied paths for fs access,
 * translating drive-letter forms lexically and other root-relative paths
 * through `cygpath -w` next to the probed bash. Anything unconvertible
 * passes through unchanged, and both directions are identity outside win32
 * bash.
 *
 * Synchronous and self-contained (node builtins only):
 * `createShellPathBridge` takes injectable deps for tests;
 * `getShellPathBridge` bundles the Node defaults, memoised per env object.
 */

import { execFileSync as nodeExecFileSync } from 'node:child_process';
import { existsSync, readFileSync as nodeReadFileSync } from 'node:fs';
import * as nodePath from 'node:path';

import type { Environment } from './environment';

export interface ShellPathBridge {
  /** Native win32 path → shell dialect, for building bash commands. Identity on posix. */
  toShellPath(nativePath: string): string;
  /** Model/shell-supplied path → native, for fs access. Identity when not convertible. */
  fromShellPath(path: string): string;
}

export type ShellPathBridgeEnv = Pick<Environment, 'osKind' | 'shellName' | 'shellPath'>;

export interface ShellPathBridgeDeps {
  readonly execFileSync: (file: string, args: readonly string[]) => string;
  readonly isFile: (path: string) => boolean;
  readonly now?: () => number;
  readonly readFileSync?: (path: string) => string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const CYGPATH_TIMEOUT_MS = 1_000;
const MAX_SEGMENT_CACHE_ENTRIES = 256;
const FAILURE_CACHE_TTL_MS = 30_000;
const MAX_CYGPATH_PROBES_PER_WINDOW = 16;

function normalizeWin32Root(raw: string): string | null {
  const trimmed = raw.trim().replace(/\r?\n$/, '');
  if (!WIN32_DRIVE_ABSOLUTE_RE.test(trimmed) && !trimmed.startsWith('\\\\')) return null;
  return trimmed.replace(/[\\/]$/, '');
}

function unescapeFstabField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function parseMsysFstab(content: string): Map<string, string> {
  const mounts = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 2) continue;
    const source = unescapeFstabField(fields[0]!);
    const target = unescapeFstabField(fields[1]!);
    if (source.toLowerCase() === 'none' || !target.startsWith('/')) continue;
    const normalizedTarget = nodePath.posix.normalize(target);
    if (normalizedTarget === '/' || normalizedTarget.indexOf('/', 1) !== -1) continue;
    const winRoot = normalizeWin32Root(source);
    if (winRoot === null) continue;
    mounts.set(normalizedTarget.slice(1), winRoot);
  }
  return mounts;
}

function inferMsysRoot(shellPath: string, cygpathExe: string): string | null {
  const cygDir = nodePath.win32.dirname(cygpathExe);
  const parent = nodePath.win32.dirname(cygDir);
  if (
    nodePath.win32.basename(cygDir).toLowerCase() === 'bin' &&
    nodePath.win32.basename(parent).toLowerCase() === 'usr'
  ) {
    return normalizeWin32Root(nodePath.win32.dirname(parent));
  }
  if (nodePath.win32.basename(cygDir).toLowerCase() === 'bin') {
    return normalizeWin32Root(parent);
  }
  const shellDir = nodePath.win32.dirname(shellPath);
  return normalizeWin32Root(nodePath.win32.dirname(shellDir));
}

const DRIVE_COLON_RE = /^\/([a-zA-Z]):(?:[\\/]|$)/;
const CYGDRIVE_RE = /^\/cygdrive\/([a-zA-Z])(?:\/|$)/;
const DRIVE_RE = /^\/([a-zA-Z])(?:\/|$)/;

// cygpath semantics are undefined for the virtual filesystems.
const VIRTUAL_FS_PREFIXES: readonly string[] = ['/dev/', '/proc/', '/sys/'];

const WIN32_DRIVE_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;

function joinDrive(letter: string, rest: string): string {
  const normalizedRest = rest.replaceAll('\\', '/');
  return normalizedRest === ''
    ? `${letter.toUpperCase()}:/`
    : `${letter.toUpperCase()}:${normalizedRest}`;
}

/**
 * Lexical translation of shell-dialect drive paths (`/c/x`, `/c:/x`,
 * `/cygdrive/c/x`) to native win32 form — pure string rewriting, no cygpath
 * involved. Anything else is returned unchanged.
 */
export function translateShellDrivePath(path: string): string {
  const colonMatch = DRIVE_COLON_RE.exec(path);
  if (colonMatch !== null) {
    return joinDrive(colonMatch[1]!, path.slice(3));
  }
  const cygdriveMatch = CYGDRIVE_RE.exec(path);
  if (cygdriveMatch !== null) {
    return joinDrive(cygdriveMatch[1]!, path.slice(`/cygdrive/${cygdriveMatch[1]!}`.length));
  }
  const driveMatch = DRIVE_RE.exec(path);
  if (driveMatch !== null) {
    return joinDrive(driveMatch[1]!, path.slice(2));
  }
  return path;
}

export function createShellPathBridge(
  env: ShellPathBridgeEnv,
  deps: ShellPathBridgeDeps,
): ShellPathBridge {
  const enabled = env.osKind === 'Windows' && env.shellName === 'bash';

  // Lazily located on first use; `null` = not found → permanent pass-through.
  let cygpathExe: string | null | undefined;
  // Bounded cache of resolved first segments and short-TTL negative cache for
  // failed/timed-out cygpath probes so repeated failures do not stall the event loop.
  const segmentCache = new Map<string, string>();
  const failureCache = new Map<string, number>();
  const now = deps.now ?? Date.now;
  let mountConfig:
    | { readonly root: string; readonly mounts: ReadonlyMap<string, string> }
    | null
    | undefined;
  let probeWindowStart = 0;
  let probeCountInWindow = 0;

  function loadMountConfig(exe: string): { readonly root: string; readonly mounts: ReadonlyMap<string, string> } | null {
    if (mountConfig !== undefined) return mountConfig;
    if (deps.readFileSync === undefined) {
      mountConfig = null;
      return null;
    }
    const root = inferMsysRoot(env.shellPath, exe);
    if (root === null) {
      mountConfig = null;
      return null;
    }
    const mounts = new Map<string, string>();
    const tempDir = deps.env?.['TEMP'] ?? deps.env?.['TMP'];
    const normalizedTemp = tempDir !== undefined ? normalizeWin32Root(tempDir) : null;
    if (normalizedTemp !== null) {
      mounts.set('tmp', normalizedTemp);
    }
    const fstabContent = deps.readFileSync(nodePath.win32.join(root, 'etc', 'fstab'));
    if (fstabContent !== undefined) {
      for (const [segment, winRoot] of parseMsysFstab(fstabContent)) {
        mounts.set(segment, winRoot);
      }
    }
    mountConfig = { root, mounts };
    return mountConfig;
  }

  function setBounded<V>(cache: Map<string, V>, key: string, value: V): void {
    if (cache.has(key)) cache.delete(key);
    else if (cache.size >= MAX_SEGMENT_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
  }

  function locateCygpath(): string | null {
    if (cygpathExe !== undefined) return cygpathExe;
    const shellDir = nodePath.win32.dirname(env.shellPath);
    const candidates = [nodePath.win32.join(shellDir, 'cygpath.exe')];
    if (nodePath.win32.basename(shellDir).toLowerCase() === 'bin') {
      candidates.push(nodePath.win32.join(shellDir, '..', 'usr', 'bin', 'cygpath.exe'));
    }
    cygpathExe = candidates.find((candidate) => deps.isFile(candidate)) ?? null;
    return cygpathExe;
  }

  function resolveRootSegment(firstSegment: string): string | null {
    const cached = segmentCache.get(firstSegment);
    if (cached !== undefined) return cached;
    const failedUntil = failureCache.get(firstSegment);
    if (failedUntil !== undefined) {
      if (now() < failedUntil) return null;
      failureCache.delete(firstSegment);
    }

    const exe = locateCygpath();
    if (exe === null) return null;

    const mounts = loadMountConfig(exe);
    if (mounts !== null) {
      const mounted = mounts.mounts.get(firstSegment);
      const resolved = mounted ?? `${mounts.root}/${firstSegment}`;
      setBounded(segmentCache, firstSegment, resolved);
      return resolved;
    }

    const currentTime = now();
    if (currentTime - probeWindowStart >= FAILURE_CACHE_TTL_MS) {
      probeWindowStart = currentTime;
      probeCountInWindow = 0;
    }
    if (probeCountInWindow >= MAX_CYGPATH_PROBES_PER_WINDOW) {
      return null;
    }
    probeCountInWindow += 1;

    let resolved: string;
    try {
      const output = deps.execFileSync(exe, ['-w', '-C', 'UTF8', '--', `/${firstSegment}`]);
      const normalized = normalizeWin32Root(output);
      if (normalized === null) {
        setBounded(failureCache, firstSegment, currentTime + FAILURE_CACHE_TTL_MS);
        return null;
      }
      resolved = normalized;
    } catch {
      setBounded(failureCache, firstSegment, currentTime + FAILURE_CACHE_TTL_MS);
      return null;
    }
    setBounded(segmentCache, firstSegment, resolved);
    return resolved;
  }

  function fromShellPath(path: string): string {
    if (!enabled) return path;

    // Keep UNC out first: posix.normalize would collapse the leading `//`.
    if (path.startsWith('//')) return path;

    if (path.startsWith('/')) {
      // Fold dot segments first: `/tmp/..` is `/` in the shell VFS, not `%TEMP%\..`.
      const normalized = nodePath.posix.normalize(path);
      const lexical = translateShellDrivePath(normalized);
      if (lexical !== normalized) return lexical;
      if (normalized === '/') return normalized;
      if (VIRTUAL_FS_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return normalized;
      const firstSegment = normalized.slice(1).split('/')[0]!;
      const prefix = resolveRootSegment(firstSegment);
      if (prefix === null) return normalized;
      const remainder = normalized.slice(firstSegment.length + 1);
      const joined = `${prefix}${remainder}`.replaceAll('\\', '/');
      // A mounted drive root resolved from a bare segment (`D:`) stays absolute.
      return /^[A-Za-z]:$/.test(joined) ? `${joined}/` : joined;
    }

    return path;
  }

  function toShellPath(nativePath: string): string {
    if (!enabled) return nativePath;

    if (nativePath.startsWith('\\\\')) {
      return nativePath.replaceAll('\\', '/');
    }

    const driveMatch = /^([A-Za-z]):(?:[\\/]|$)/.exec(nativePath);
    if (driveMatch !== null) {
      const drive = driveMatch[1]!.toLowerCase();
      const rest = nativePath.slice(2).replaceAll('\\', '/');
      return `/${drive}${rest.startsWith('/') ? rest : `/${rest}`}`;
    }

    return nativePath.replaceAll('\\', '/');
  }

  return { toShellPath, fromShellPath };
}

const bridgeCache = new Map<string, ShellPathBridge>();

/**
 * Production convenience — Node's ambient `execFileSync` / `existsSync`,
 * memoised per shell identity so call sites that wrap the same probed
 * environment in a fresh object still share one bridge.
 */
export function getShellPathBridge(env: ShellPathBridgeEnv): ShellPathBridge {
  const key = `${env.osKind} ${env.shellName} ${env.shellPath}`;
  const cached = bridgeCache.get(key);
  if (cached !== undefined) return cached;
  const bridge = createShellPathBridge(env, {
    execFileSync: (file, args) =>
      nodeExecFileSync(file, [...args], {
        encoding: 'utf8',
        timeout: CYGPATH_TIMEOUT_MS,
        windowsHide: true,
      }),
    isFile: (path) => existsSync(path),
    readFileSync: (path) => {
      try {
        return nodeReadFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    env: process.env,
  });
  bridgeCache.set(key, bridge);
  return bridge;
}
