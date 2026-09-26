import * as pathe from 'pathe';

import { unwrapErrorCause } from '#/_base/errors/errors';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import {
  getShellPathBridge,
  translateShellDrivePath,
  type ShellPathBridge,
} from '#/_base/execEnv/shellPathBridge';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';

export interface WorkspaceConfig {
  readonly workspaceDir: string;
  readonly additionalDirs: readonly string[];
  readonly definitionReadRoots?: readonly string[];
}

const SENSITIVE_BASENAMES = new Set<string>([
  '.env',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'credentials',
]);

const SENSITIVE_PATH_SUFFIXES = [
  ['.aws', 'credentials'],
  ['.gcp', 'credentials'],
];

const ENV_PREFIX = '.env.';
const ENV_EXEMPTIONS = new Set<string>(['.env.example', '.env.sample', '.env.template']);

const SENSITIVE_BASENAME_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials'];
const PUBLIC_KEY_BASENAMES = new Set<string>(['id_rsa.pub', 'id_ed25519.pub', 'id_ecdsa.pub']);
export const SENSITIVE_DOT_VARIANT_SUFFIXES = [
  '.bak',
  '.backup',
  '.copy',
  '.disabled',
  '.key',
  '.old',
  '.orig',
  '.pem',
  '.save',
  '.tmp',
] as const;
const SENSITIVE_DOT_VARIANT_SUFFIX_SET = new Set<string>(SENSITIVE_DOT_VARIANT_SUFFIXES);

function comparable(path: string): string {
  return path.toLowerCase();
}

export function isSensitiveFile(path: string): boolean {
  const name = pathe.basename(path);
  const comparableName = comparable(name).replace(/::\$data$/, '');
  const comparablePath = comparable(path).replace(/::\$data$/, '');

  if (ENV_EXEMPTIONS.has(comparableName)) return false;
  if (PUBLIC_KEY_BASENAMES.has(comparableName)) return false;
  if (SENSITIVE_BASENAMES.has(comparableName)) return true;
  if (comparableName.startsWith(ENV_PREFIX)) return true;

  for (const prefix of SENSITIVE_BASENAME_PREFIXES) {
    if (comparableName === prefix) return true;
    if (comparableName.length > prefix.length && comparableName.startsWith(prefix)) {
      const suffix = comparableName.slice(prefix.length);
      const next = suffix[0];
      if (next === '-' || next === '_') return true;
      if (next === '.' && SENSITIVE_DOT_VARIANT_SUFFIX_SET.has(suffix)) return true;
    }
  }

  for (const suffixParts of SENSITIVE_PATH_SUFFIXES) {
    const suffix = suffixParts.join('/');
    const comparableSuffix = comparable(suffix);
    if (
      comparablePath.endsWith(`/${comparableSuffix}`) ||
      comparablePath.includes(`/${comparableSuffix}/`)
    ) {
      return true;
    }
  }

  return false;
}

export type PathClass = 'posix' | 'win32';
export type PathSecurityCode = 'PATH_OUTSIDE_WORKSPACE' | 'PATH_INVALID';
export type PathAccessOperation = 'read' | 'write' | 'search';
export interface PathAccess {
  readonly path: string;
  readonly outsideWorkspace: boolean;
  readonly implicitExternal?: boolean;
}

export class PathSecurityError extends Error {
  readonly code: PathSecurityCode;
  readonly rawPath: string;
  readonly canonicalPath: string;

  constructor(code: PathSecurityCode, rawPath: string, canonicalPath: string, message: string) {
    super(message);
    this.name = 'PathSecurityError';
    this.code = code;
    this.rawPath = rawPath;
    this.canonicalPath = canonicalPath;
  }
}

const DEFAULT_PATH_CLASS: PathClass = process.platform === 'win32' ? 'win32' : 'posix';

function isWin32DriveRelative(path: string): boolean {
  return /^[A-Za-z]:(?:$|[^\\/])/.test(path);
}

export function normalizeUserPath(path: string, pathClass: PathClass = DEFAULT_PATH_CLASS): string {
  return pathClass === 'win32' ? translateShellDrivePath(path) : path;
}

function expandUserPath(path: string, homeDir: string | undefined, pathClass: PathClass): string {
  if (homeDir === undefined) return path;
  if (path === '~') return homeDir;
  if (path.startsWith('~/') || (pathClass === 'win32' && path.startsWith('~\\'))) {
    return pathe.join(homeDir, path.slice(2));
  }
  return path;
}

export function canonicalizePath(
  path: string,
  cwd: string,
  pathClass: PathClass = DEFAULT_PATH_CLASS,
): string {
  if (path === '') {
    throw new PathSecurityError('PATH_INVALID', path, path, '[invalid_path] Path cannot be empty. Provide a workspace-relative or explicit absolute path.');
  }
  const normalizedPath = normalizeUserPath(path, pathClass);
  if (pathClass === 'win32' && isWin32DriveRelative(normalizedPath)) {
    throw new PathSecurityError(
      'PATH_INVALID',
      path,
      normalizedPath,
      `[invalid_path] Path "${path}" resolves ambiguously to "${normalizedPath}". Use an absolute path like C:\\path or a path relative to the working directory.`,
    );
  }
  if (!pathe.isAbsolute(normalizedPath) && !pathe.isAbsolute(cwd)) {
    throw new PathSecurityError(
      'PATH_INVALID',
      path,
      normalizedPath,
      `[invalid_path] Cannot resolve path "${path}" against non-absolute cwd "${cwd}". Use an absolute working directory or explicit absolute path.`,
    );
  }
  const abs = pathe.isAbsolute(normalizedPath) ? normalizedPath : pathe.resolve(cwd, normalizedPath);
  return pathe.normalize(abs);
}

export function isWithinDirectory(
  candidate: string,
  base: string,
  pathClass: PathClass = DEFAULT_PATH_CLASS,
): boolean {
  const nc = pathe.normalize(candidate);
  const nb = pathe.normalize(base);
  const comparableCandidate = pathClass === 'win32' ? nc.toLowerCase() : nc;
  const comparableBase = pathClass === 'win32' ? nb.toLowerCase() : nb;
  if (comparableCandidate === comparableBase) return true;
  const prefix = comparableBase.endsWith('/') ? comparableBase : comparableBase + '/';
  return comparableCandidate.startsWith(prefix);
}

export function isWithinWorkspace(
  candidate: string,
  config: WorkspaceConfig,
  pathClass: PathClass = DEFAULT_PATH_CLASS,
): boolean {
  if (isWithinDirectory(candidate, config.workspaceDir, pathClass)) return true;
  for (const dir of config.additionalDirs) {
    if (isWithinDirectory(candidate, dir, pathClass)) return true;
  }
  return false;
}

export function withDefinitionReadRoots<T extends WorkspaceConfig>(
  workspace: T,
  skillRoots: readonly string[],
  homeDir: string,
): T & { readonly definitionReadRoots: readonly string[] } {
  const definitionReadRoots = [...new Set([
    ...workspace.definitionReadRoots ?? [],
    ...skillRoots,
    pathe.join(homeDir, '.agents/skills'),
    pathe.join(homeDir, '.agents/agents'),
    pathe.join(homeDir, '.kiki/agents'),
    pathe.join(homeDir, '.kiki/skills'),
    pathe.join(homeDir, '.kiki/commands'),
    pathe.join(homeDir, '.kiki/docs'),
  ])];
  return { ...workspace, definitionReadRoots };
}

export interface ResolvePathAccessOptions {
  readonly operation: PathAccessOperation;
  readonly pathClass?: PathClass | undefined;
  readonly homeDir?: string;
  readonly shellPathBridge?: ShellPathBridge;
}

export interface ResolvePathAccessPathOptions {
  readonly env: Pick<
    IHostEnvironment,
    'pathClass' | 'homeDir' | 'osKind' | 'shellName' | 'shellPath'
  >;
  readonly workspace: WorkspaceConfig;
  readonly operation: PathAccessOperation;
  readonly expandHome?: boolean;
}

function relativeOutsideMessage(path: string, target: string): string {
  return `[external_target_approval] Path "${path}" resolves to external target "${target}". Use an explicit absolute path and obtain approval for access to the target.`;
}

export function resolvePathAccess(
  path: string,
  cwd: string,
  config: WorkspaceConfig,
  options: ResolvePathAccessOptions,
): PathAccess {
  const pathClass = options.pathClass ?? DEFAULT_PATH_CLASS;
  const normalizedPath =
    options.shellPathBridge?.fromShellPath(path) ?? normalizeUserPath(path, pathClass);
  const expandedPath = expandUserPath(normalizedPath, options.homeDir, pathClass);
  const rawIsAbsolute = pathe.isAbsolute(expandedPath);
  const canonical = canonicalizePath(expandedPath, cwd, pathClass);
  const outsideWorkspace = !isWithinWorkspace(canonical, config, pathClass);
  if (outsideWorkspace && !rawIsAbsolute &&
    !(options.operation !== 'write' && config.definitionReadRoots?.some((root) =>
      isWithinDirectory(canonical, root, pathClass)))) {
    throw new PathSecurityError(
      'PATH_OUTSIDE_WORKSPACE', path, canonical, relativeOutsideMessage(path, canonical),
    );
  }

  return { path: canonical, outsideWorkspace };
}

export function resolvePathAccessPath(
  path: string,
  options: ResolvePathAccessPathOptions,
): string {
  const { env, workspace, operation, expandHome = true } = options;
  return resolvePathAccess(path, workspace.workspaceDir, workspace, {
    operation,
    pathClass: env.pathClass,
    homeDir: expandHome ? env.homeDir : undefined,
    shellPathBridge: env.pathClass === 'win32' ? getShellPathBridge(env) : undefined,
  }).path;
}

function isMissingPath(error: unknown): boolean {
  const cause = unwrapErrorCause(error);
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return false;
  return cause.code === 'ENOENT' || cause.code === 'ENOTDIR';
}

async function realPathOrMissingChild(fs: IHostFileSystem, path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    try {
      await fs.lstat(path);
      throw new PathSecurityError('PATH_INVALID', path, path, `[invalid_path] Path "${path}" has an unresolved link target "${path}". Repair the link or provide the actual existing target path.`);
    } catch (lstatError) {
      if (!isMissingPath(lstatError)) throw lstatError;
    }
    const parent = pathe.dirname(path);
    if (parent === path) throw error;
    return pathe.join(await realPathOrMissingChild(fs, parent), pathe.basename(path));
  }
}

export async function resolveRealPathAccess(
  path: string,
  options: ResolvePathAccessPathOptions,
  fs: IHostFileSystem,
): Promise<PathAccess> {
  const lexicalPath = resolvePathAccessPath(path, options);
  const [target, workspaceDir, ...additionalDirs] = await Promise.all([
    realPathOrMissingChild(fs, lexicalPath).catch((error: unknown) => {
      if (error instanceof PathSecurityError && error.code === 'PATH_INVALID') {
        throw new PathSecurityError('PATH_INVALID', path, error.canonicalPath,
          `[invalid_path] Path "${path}" resolves to invalid target "${error.canonicalPath}". Repair the link or provide the actual existing target path.`);
      }
      throw error;
    }),
    fs.realpath(options.workspace.workspaceDir),
    ...options.workspace.additionalDirs.map((dir) => fs.realpath(dir)),
  ]);
  const realWorkspace = { workspaceDir, additionalDirs };
  const realPath = canonicalizePath(target, workspaceDir, options.env.pathClass);
  const outsideWorkspace = !isWithinWorkspace(realPath, realWorkspace, options.env.pathClass);
  const inDefinitionRoot = options.workspace.definitionReadRoots?.some((root) =>
    isWithinDirectory(lexicalPath, root, options.env.pathClass));
  return {
    path: realPath,
    outsideWorkspace,
    implicitExternal: outsideWorkspace && lexicalPath !== realPath &&
      !inDefinitionRoot && isWithinWorkspace(lexicalPath, options.workspace, options.env.pathClass),
  };
}

export async function resolveRealPathAccessPath(
  path: string,
  options: ResolvePathAccessPathOptions,
  fs: IHostFileSystem,
): Promise<string> {
  return (await resolveRealPathAccess(path, options, fs)).path;
}
