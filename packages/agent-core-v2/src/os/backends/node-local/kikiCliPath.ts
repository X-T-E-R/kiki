import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { resolveKikiHome } from '@kiki/oauth';

const CLI_ENTRY_BASENAME = 'main.mjs';
const ELECTRON_SERVER_ENTRY_BASENAME = 'server-entry.mjs';
const ELECTRON_SHIM_HEAP_FLAG = '--max-old-space-size=2560';
const SHIM_DIRECTORY = 'shim';
const NODE_SHIM_DIRECTORY = 'node-shim';
const SHIM_FILE_MODE = 0o755;
const POSIX_SHIM_NAME = 'kiki';
const WINDOWS_CMD_SHIM_NAME = 'kiki.cmd';
const POSIX_NODE_SHIM_NAME = 'node';
const WINDOWS_CMD_NODE_SHIM_NAME = 'node.cmd';

export type KikiCliLaunch = KikiCliExecutable | KikiCliNodeEntry;

export interface KikiCliExecutable {
  readonly kind: 'executable';
  readonly executable: string;
}

export interface KikiCliNodeEntry {
  readonly kind: 'node';
  readonly nodePath: string;
  readonly entryPath: string;
  readonly electronRunAsNode?: boolean;
}

export interface KikiCliLaunchDeps {
  readonly isSea: () => boolean;
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly isFile: (path: string) => Promise<boolean>;
}

/**
 * Name the running Kiki CLI, or `undefined` when it cannot be named
 * reliably. A packaged SEA binary is always `process.execPath`. Otherwise
 * only a built `main.mjs` CLI entry is accepted: a development runner (`tsx`
 * on `src/main.ts`), an embedded harness, or an arbitrary Node program
 * cannot tell us which CLI is running, and forwarding to a guessed path
 * would be worse than leaving the user's PATH alone.
 */
export async function resolveKikiCliLaunch(
  deps: KikiCliLaunchDeps,
): Promise<KikiCliLaunch | undefined> {
  if (deps.isSea()) return { kind: 'executable', executable: deps.execPath };
  const entry = deps.argv[1];
  if (entry === undefined || entry.length === 0) return undefined;
  const entryBase = basename(entry);
  if (entryBase !== CLI_ENTRY_BASENAME && entryBase !== ELECTRON_SERVER_ENTRY_BASENAME) {
    return undefined;
  }
  if (!(await deps.isFile(entry))) return undefined;
  return {
    kind: 'node',
    nodePath: deps.execPath,
    entryPath: entry,
    ...(entryBase === ELECTRON_SERVER_ENTRY_BASENAME ? { electronRunAsNode: true } : {}),
  };
}

export interface KikiShimFile {
  readonly name: string;
  readonly content: string;
  readonly mode: number;
}

/**
 * Lexical native → MSYS/Git Bash path translation (`C:\a\b` → `/c/a/b`).
 * Enough for the shim's forwarder arguments, which are always absolute drive
 * paths on Windows.
 */
export function toShellExecutablePath(nativePath: string): string {
  const normalized = nativePath.replaceAll('\\', '/');
  const drive = /^([A-Za-z]):(?:\/|$)/.exec(normalized);
  if (drive === null) return normalized;
  const rest = normalized.slice(2);
  return `/${drive[1]!.toLowerCase()}${rest.startsWith('/') ? rest : `/${rest}`}`;
}

/**
 * Render the launcher files the built-in shell needs for `launch`. POSIX
 * gets one `sh` forwarder; Windows additionally gets a `kiki.cmd` so cmd.exe
 * and PowerShell resolve it too. The content is a plain forwarder to the
 * running build — no pinned version.
 */
export function kikiShimFiles(launch: KikiCliLaunch, platform: string): readonly KikiShimFile[] {
  const shellPath = platform === 'win32' ? toShellExecutablePath : (path: string) => path;
  const electronRunAsNode = launch.kind === 'node' && launch.electronRunAsNode === true;
  const shellArgs =
    launch.kind === 'executable'
      ? [shellPath(launch.executable)]
      : electronRunAsNode
        ? [shellPath(launch.nodePath), ELECTRON_SHIM_HEAP_FLAG, shellPath(launch.entryPath)]
        : [shellPath(launch.nodePath), shellPath(launch.entryPath)];
  const files: KikiShimFile[] = [
    {
      name: POSIX_SHIM_NAME,
      content: renderPosixShim(shellArgs, electronRunAsNode),
      mode: SHIM_FILE_MODE,
    },
  ];
  if (platform === 'win32') {
    files.push({
      name: WINDOWS_CMD_SHIM_NAME,
      content: renderCmdShim(launch),
      mode: SHIM_FILE_MODE,
    });
  }
  return files;
}

function renderPosixShim(args: readonly string[], electronRunAsNode = false): string {
  const prefix = electronRunAsNode ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  return `#!/bin/sh\n${prefix}exec ${args.map(quoteShell).join(' ')} "$@"\n`;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function renderCmdShim(launch: KikiCliLaunch): string {
  if (launch.kind === 'node' && launch.electronRunAsNode === true) {
    return `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n${quoteDouble(launch.nodePath)} ${ELECTRON_SHIM_HEAP_FLAG} ${quoteDouble(launch.entryPath)} %*\r\n`;
  }
  const args =
    launch.kind === 'executable' ? [launch.executable] : [launch.nodePath, launch.entryPath];
  return `@echo off\r\n${args.map(quoteDouble).join(' ')} %*\r\n`;
}

function quoteDouble(value: string): string {
  return `"${value}"`;
}

/**
 * Render fallback `node` / `node.cmd` wrappers targeting Kiki SEA `__plugin_run_node`.
 */
export function kikiNodeShimFiles(
  seaExecutable: string,
  platform: string,
): readonly KikiShimFile[] {
  const shellExec = platform === 'win32' ? toShellExecutablePath(seaExecutable) : seaExecutable;
  const posixContent = [
    '#!/usr/bin/env sh',
    'export KIKI_NODE_SHIM=1',
    'if [ -n "${KIKI_SEA_EXEC:-}" ]; then',
    '  exec "$KIKI_SEA_EXEC" __plugin_run_node "$@"',
    'fi',
    `exec ${quoteShell(shellExec)} __plugin_run_node "$@"`,
    '',
  ].join('\n');
  const files: KikiShimFile[] = [
    { name: POSIX_NODE_SHIM_NAME, content: posixContent, mode: SHIM_FILE_MODE },
  ];
  if (platform === 'win32') {
    const cmdContent = [
      '@echo off',
      'setlocal',
      'set "KIKI_NODE_SHIM=1"',
      'if defined KIKI_SEA_EXEC goto :kiki_run_env',
      `${quoteDouble(seaExecutable)} __plugin_run_node %*`,
      'exit /b %ERRORLEVEL%',
      ':kiki_run_env',
      '"%KIKI_SEA_EXEC%" __plugin_run_node %*',
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n');
    files.push({ name: WINDOWS_CMD_NODE_SHIM_NAME, content: cmdContent, mode: SHIM_FILE_MODE });
  }
  return files;
}

/**
 * Append `entry` to the end of `PATH` only when not already present so user-installed binaries win.
 */
export function appendPathEntry(
  currentPath: string | undefined,
  entry: string,
  separator: string,
  caseInsensitive = false,
): string {
  if (currentPath === undefined || currentPath === '') return entry;
  const parts = currentPath.split(separator);
  if (parts.some((part) => isSamePathEntry(part, entry, caseInsensitive))) {
    return currentPath;
  }
  return currentPath.endsWith(separator) ? `${currentPath}${entry}` : `${currentPath}${separator}${entry}`;
}

/**
 * Synchronously materialise `<kikiHome>/bin/node-shim` for hook and child fallback `PATH`.
 */
export function ensureKikiNodeShimSync(
  kikiHome: string,
  seaExecutable: string,
  platform: string = process.platform,
): string | undefined {
  if (kikiHome.trim().length === 0 || seaExecutable.trim().length === 0) return undefined;
  const shimDir = join(kikiHome, 'bin', NODE_SHIM_DIRECTORY);
  try {
    mkdirSync(shimDir, { recursive: true });
    for (const file of kikiNodeShimFiles(seaExecutable, platform)) {
      const target = join(shimDir, file.name);
      let current: string | undefined;
      try {
        current = readFileSync(target, 'utf8');
      } catch {
        current = undefined;
      }
      if (current === file.content) continue;
      const temp = join(shimDir, `.${file.name}.${String(process.pid)}.${String(Date.now())}.tmp`);
      writeFileSync(temp, file.content, { mode: file.mode });
      try {
        renameSync(temp, target);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    }
    return shimDir;
  } catch {
    return undefined;
  }
}

export interface KikiShimWriter {
  readonly mkdir: (path: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string | undefined>;
  readonly writeFile: (path: string, data: string, mode: number) => Promise<void>;
}

/** Write `files` into `directory`, skipping any file whose bytes already match. */
export async function writeKikiShims(
  directory: string,
  files: readonly KikiShimFile[],
  writer: KikiShimWriter,
): Promise<readonly string[]> {
  await writer.mkdir(directory);
  const written: string[] = [];
  for (const file of files) {
    const path = join(directory, file.name);
    const existing = await writer.readFile(path);
    if (existing === file.content) continue;
    await writer.writeFile(path, file.content, file.mode);
    written.push(path);
  }
  return written;
}

export interface KikiCliEnvOptions {
  readonly platform: string;
  readonly shimDir: string;
  readonly cliPath: string;
}

/**
 * Point the given environment at the shim: `shimDir` goes in front of `PATH`
 * (so the running build wins over any user-wide `kiki`) and `KIKI_CLI`
 * carries the launcher path for scripts.
 */
export function applyKikiCliEnv(
  env: Record<string, string | undefined>,
  options: KikiCliEnvOptions,
): void {
  const windows = options.platform === 'win32';
  env['PATH'] = prependPathEntry(env['PATH'], options.shimDir, windows ? ';' : ':', windows);
  env['KIKI_CLI'] = options.cliPath;
}

/**
 * Prepend `entry` to a PATH string, dropping an existing occurrence so
 * repeated application does not accumulate duplicates. Existing components
 * are otherwise kept verbatim — an empty component is POSIX cwd lookup and
 * must survive. An unset PATH becomes just the entry.
 */
export function prependPathEntry(
  currentPath: string | undefined,
  entry: string,
  separator: string,
  caseInsensitive = false,
): string {
  if (currentPath === undefined) return entry;
  const remaining = currentPath
    .split(separator)
    .filter((part) => !isSamePathEntry(part, entry, caseInsensitive));
  return [entry, ...remaining].join(separator);
}

function isSamePathEntry(left: string, right: string, caseInsensitive: boolean): boolean {
  if (left === right) return true;
  if (!caseInsensitive) return false;
  return left.replaceAll('/', '\\').toLowerCase() === right.replaceAll('/', '\\').toLowerCase();
}

/**
 * `KIKI_CLI` value: a packaged build exposes its executable directly; a
 * Node-hosted CLI has no kiki executable, so the sh launcher (`kiki.cmd` on
 * Windows) stands in for it.
 */
export function kikiCliEnvValue(launch: KikiCliLaunch, shimDir: string, platform: string): string {
  if (launch.kind === 'executable') return launch.executable;
  return join(shimDir, platform === 'win32' ? WINDOWS_CMD_SHIM_NAME : POSIX_SHIM_NAME);
}

export interface EnsureKikiCliShimOptions {
  readonly kikiHome: string;
  readonly platform?: string;
  readonly isSea?: () => boolean;
  readonly execPath?: string;
  readonly argv?: readonly string[];
  readonly isFile?: (path: string) => Promise<boolean>;
  readonly writer?: KikiShimWriter;
}

export interface KikiCliShim {
  readonly shimDir: string;
  readonly cliPath: string;
  readonly writtenFiles: readonly string[];
}

/**
 * Resolve the running CLI and materialise its launcher under
 * `<kikiHome>/bin/shim`. Returns `undefined` when the CLI cannot be named,
 * in which case nothing is written and PATH stays untouched.
 */
export async function ensureKikiCliShim(
  options: EnsureKikiCliShimOptions,
): Promise<KikiCliShim | undefined> {
  const platform = options.platform ?? process.platform;
  const launch = await resolveKikiCliLaunch({
    isSea: options.isSea ?? isSeaFromNode,
    execPath: options.execPath ?? process.execPath,
    argv: options.argv ?? process.argv,
    isFile: options.isFile ?? isFileFromNode,
  });
  if (launch === undefined) return undefined;

  const shimDir = join(options.kikiHome, 'bin', SHIM_DIRECTORY);
  const writtenFiles = await writeKikiShims(
    shimDir,
    kikiShimFiles(launch, platform),
    options.writer ?? nodeShimWriter(platform),
  );
  return { shimDir, cliPath: kikiCliEnvValue(launch, shimDir, platform), writtenFiles };
}

export interface NodeSeaModule {
  isSea(): boolean;
}

let cachedSea: NodeSeaModule | null | undefined;

function loadSeaModule(): NodeSeaModule | null {
  if (cachedSea !== undefined) return cachedSea;
  try {
    cachedSea = createRequire(import.meta.url)('node:sea') as NodeSeaModule;
  } catch {
    cachedSea = null;
  }
  return cachedSea;
}

function isSeaFromNode(): boolean {
  const sea = loadSeaModule();
  if (sea === null) return false;
  try {
    return sea.isSea();
  } catch {
    return false;
  }
}

async function isFileFromNode(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Node defaults for the writer. Replacement goes through a temporary file
 * and an atomic rename, so a child that starts while the shim is refreshed
 * never reads a half-written launcher.
 */
export function nodeShimWriter(platform: string): KikiShimWriter {
  return {
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    readFile: async (path) => {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    writeFile: async (path, data, mode) => {
      await writeShimFileAtomic(path, data, mode, platform);
    },
  };
}

async function writeShimFileAtomic(
  path: string,
  data: string,
  mode: number,
  platform: string,
): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${String(process.pid)}.${String(Date.now())}.tmp`,
  );
  await writeFile(temporary, data, { mode });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  if (platform !== 'win32') await chmod(path, mode);
}

let appliedKikiCliShim: Promise<void> | undefined;

/**
 * Production convenience — build the shim for the running process and apply
 * it to `process.env` once. Memoised: the running CLI cannot change for the
 * lifetime of the process, and repeated service construction must not
 * rewrite the launcher. Best-effort: a failed probe or write leaves the
 * environment untouched instead of breaking startup. Called from
 * `HostEnvironmentService.ready`, which the composition root awaits before
 * any session scope (and therefore any built-in shell) exists.
 */
export function applyKikiCliShimFromNode(): Promise<void> {
  if (appliedKikiCliShim !== undefined) return appliedKikiCliShim;
  appliedKikiCliShim = applyKikiCliShimFromNodeOnce();
  return appliedKikiCliShim;
}

async function applyKikiCliShimFromNodeOnce(): Promise<void> {
  try {
    const kikiHome = resolveKikiHome();
    const shim = await ensureKikiCliShim({ kikiHome });
    if (shim === undefined) return;
    const env = process.env as Record<string, string | undefined>;
    applyKikiCliEnv(env, {
      platform: process.platform,
      shimDir: shim.shimDir,
      cliPath: shim.cliPath,
    });
    if (isSeaFromNode()) {
      env['KIKI_SEA_EXEC'] ??= process.execPath;
      if (process.platform === 'win32') {
        const nodeShimDir = join(kikiHome, 'bin', NODE_SHIM_DIRECTORY);
        await writeKikiShims(
          nodeShimDir,
          kikiNodeShimFiles(process.execPath, process.platform),
          nodeShimWriter(process.platform),
        );
        env['PATH'] = appendPathEntry(env['PATH'], nodeShimDir, ';', true);
      }
    }
  } catch {
  }
}
