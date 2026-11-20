import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_WORKDIR_SLUG_LENGTH = 40;
const WORKDIR_KEY_PREFIX = 'wd_';
const PROJECT_ID_PREFIX = 'prj_';
const HASH_LENGTH = 12;
const WORKDIR_ID_PATTERN = /^wd_[a-z0-9._-]+_[0-9a-f]{12}$/;
const EXPLICIT_PROJECT_ID_PATTERN = /^(?:prj_)?[a-z0-9][a-z0-9._-]{0,59}$/i;
const WIN_SHAPED = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;

export const PROJECT_ID_PATTERN = /^prj_[a-z0-9][a-z0-9._-]{0,63}$/;

export type ProjectIdentitySource = 'explicit' | 'git' | 'path_fallback';

export interface ProjectIdentity {
  readonly projectId: string;
  readonly source: ProjectIdentitySource;
  readonly slug: string;
  readonly workDirKey: string;
  readonly gitRoot?: string;
  readonly normalizedRemote?: string;
  readonly rootCommit?: string;
}

export interface ResolveProjectIdentityOptions {
  readonly gitRunner?: (cwd: string, args: readonly string[]) => Promise<string | undefined>;
}

export function slugifyWorkDirName(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, MAX_WORKDIR_SLUG_LENGTH)
    .replaceAll(/^-+|-+$/g, '');
  return slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
}

export function encodeWorkDirKey(workDir: string): string {
  const normalized = workspaceRootKey(workDir);
  return encodeNormalizedWorkDirKey(normalized);
}

export function encodeLegacyWorkDirKey(workDir: string): string {
  const normalized = workDir.replaceAll('\\', '/').replace(/\/+$/, '');
  return encodeNormalizedWorkDirKey(normalized);
}

export function workDirKeyAliases(workDir: string): readonly string[] {
  const canonical = encodeWorkDirKey(workDir);
  const legacy = encodeLegacyWorkDirKey(workDir);
  return canonical === legacy ? [canonical] : [canonical, legacy];
}

export function isWorkDirKeyForRoot(id: string, root: string): boolean {
  return workDirKeyAliases(root).includes(id);
}

export function workspaceIdFromSessionDir(sessionDir: string): string | undefined {
  const parts = sessionDir.replaceAll('\\', '/').split('/').filter((part) => part !== '');
  const candidate = parts.at(-2);
  return candidate !== undefined && WORKDIR_ID_PATTERN.test(candidate) ? candidate : undefined;
}

export function workspaceRootKey(root: string): string {
  const slashed = root.replaceAll('\\', '/');
  if (WIN_SHAPED.test(slashed)) {
    return stripTrailingSeparators(win32.normalize(slashed).replaceAll('\\', '/')).toLowerCase();
  }
  return stripTrailingSeparators(posix.normalize(root));
}

/** Validates whether an identifier is a portable `prj_*` project id. */
export function isValidProjectId(id: string): boolean {
  return PROJECT_ID_PATTERN.test(id);
}

/** Normalizes SSH, HTTPS, and SCP-style git remote URLs into a host/path key shared across machines. */
export function normalizeGitRemoteUrl(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim();
  if (trimmed === '') return undefined;

  const scpMatch = /^(?:[^@\s/]+@)?([a-z0-9.-]+):([^\s]+)$/i.exec(trimmed);
  if (scpMatch !== null && !/^[a-z]:[\\/]/i.test(trimmed) && !trimmed.includes('://')) {
    const host = scpMatch[1]!.toLowerCase();
    const repoPath = normalizeRemotePath(scpMatch[2]!);
    return repoPath === '' ? undefined : `${host}/${repoPath}`;
  }

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (host === '') return undefined;
    const isDefaultPort =
      url.port === '' ||
      (url.protocol === 'https:' && url.port === '443') ||
      (url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'ssh:' && url.port === '22');
    const authority = isDefaultPort ? host : `${host}:${url.port}`;
    const repoPath = normalizeRemotePath(url.pathname);
    return repoPath === '' ? undefined : `${authority}/${repoPath}`;
  } catch {
    return undefined;
  }
}

/** Deterministically computes a cross-machine and cross-worktree `prj_<slug>_<12hex>` identifier from git metadata. */
export function computeGitProjectId(input: {
  readonly normalizedRemote?: string;
  readonly rootCommit: string;
  readonly repoName?: string;
}): { readonly projectId: string; readonly slug: string } {
  const remotePart = input.normalizedRemote ?? '';
  const commitPart = input.rootCommit.trim().toLowerCase();
  const repoSegment =
    input.normalizedRemote?.split('/').at(-1) ??
    input.repoName ??
    'project';
  const slug = slugifyWorkDirName(repoSegment);
  const digest = createHash('sha256')
    .update(`git-v1\0${remotePart}\0${commitPart}`)
    .digest('hex')
    .slice(0, HASH_LENGTH);
  return {
    projectId: `${PROJECT_ID_PREFIX}${slug}_${digest}`,
    slug,
  };
}

/**
 * Resolves a deterministic cross-machine and cross-worktree project identity:
 * 1) explicit `.kiki/project.json` `project_id`,
 * 2) normalized git remote + earliest root initial commit SHA,
 * 3) local `wd_<slug>_<12hex>` path-hash fallback.
 */
export async function resolveProjectIdentity(
  cwd: string,
  options: ResolveProjectIdentityOptions = {},
): Promise<ProjectIdentity> {
  const resolvedCwd = resolve(cwd);
  const workDirKey = encodeWorkDirKey(resolvedCwd);
  const runGit = options.gitRunner ?? defaultGitRunner;

  const gitTopLevel = await runGit(resolvedCwd, ['rev-parse', '--show-toplevel']);
  const normalizedGitRoot = gitTopLevel === undefined ? undefined : resolve(gitTopLevel);

  const explicit = await readExplicitProjectId(resolvedCwd, normalizedGitRoot);
  if (explicit !== undefined) {
    return {
      projectId: explicit.projectId,
      source: 'explicit',
      slug: explicit.slug,
      workDirKey,
      ...(normalizedGitRoot === undefined ? {} : { gitRoot: normalizedGitRoot }),
    };
  }

  if (normalizedGitRoot !== undefined) {
    const rootCommit = await resolveGitRootCommit(normalizedGitRoot, runGit);
    if (rootCommit !== undefined) {
      const rawRemote = await resolveGitPrimaryRemote(normalizedGitRoot, runGit);
      const normalizedRemote = rawRemote === undefined ? undefined : normalizeGitRemoteUrl(rawRemote);
      const commonDir = await runGit(normalizedGitRoot, ['rev-parse', '--git-common-dir']);
      const repoName = deriveRepoName(normalizedGitRoot, commonDir);
      const { projectId, slug } = computeGitProjectId({
        normalizedRemote,
        rootCommit,
        repoName,
      });
      return {
        projectId,
        source: 'git',
        slug,
        workDirKey,
        gitRoot: normalizedGitRoot,
        ...(normalizedRemote === undefined ? {} : { normalizedRemote }),
        rootCommit,
      };
    }
  }

  const normalizedPath = workspaceRootKey(resolvedCwd);
  const slug = slugifyWorkDirName(normalizedPath.split('/').pop() ?? normalizedPath);
  return {
    projectId: workDirKey,
    source: 'path_fallback',
    slug,
    workDirKey,
  };
}

async function readExplicitProjectId(
  startDir: string,
  stopAtDir?: string,
): Promise<{ readonly projectId: string; readonly slug: string } | undefined> {
  let current = startDir;
  const stopKey = stopAtDir === undefined ? undefined : workspaceRootKey(stopAtDir);
  for (;;) {
    const candidatePath = join(current, '.kiki', 'project.json');
    try {
      const text = await readFile(candidatePath, 'utf8');
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const rawId =
        typeof parsed['project_id'] === 'string'
          ? parsed['project_id']
          : typeof parsed['projectId'] === 'string'
            ? parsed['projectId']
            : undefined;
      const normalized = rawId === undefined ? undefined : normalizeExplicitProjectId(rawId);
      if (normalized !== undefined) return normalized;
    } catch {
    }
    if (stopKey !== undefined && workspaceRootKey(current) === stopKey) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function normalizeExplicitProjectId(
  raw: string,
): { readonly projectId: string; readonly slug: string } | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (!EXPLICIT_PROJECT_ID_PATTERN.test(trimmed)) return undefined;
  const projectId = trimmed.startsWith(PROJECT_ID_PREFIX) ? trimmed : `${PROJECT_ID_PREFIX}${trimmed}`;
  if (!PROJECT_ID_PATTERN.test(projectId)) return undefined;
  const slug = slugifyWorkDirName(projectId.slice(PROJECT_ID_PREFIX.length));
  return { projectId, slug };
}

async function resolveGitPrimaryRemote(
  gitRoot: string,
  runGit: (cwd: string, args: readonly string[]) => Promise<string | undefined>,
): Promise<string | undefined> {
  const origin = await runGit(gitRoot, ['remote', 'get-url', 'origin']);
  if (origin !== undefined && origin.length > 0) return origin;
  const remotes = await runGit(gitRoot, ['remote']);
  const first = remotes
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .toSorted()[0];
  if (first === undefined) return undefined;
  return runGit(gitRoot, ['remote', 'get-url', first]);
}

async function resolveGitRootCommit(
  gitRoot: string,
  runGit: (cwd: string, args: readonly string[]) => Promise<string | undefined>,
): Promise<string | undefined> {
  const output = await runGit(gitRoot, ['rev-list', '--max-parents=0', 'HEAD']);
  const commits = (output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => /^[0-9a-f]{40}$/.test(line))
    .toSorted();
  if (commits.length > 0) return commits[0];
  const allOutput = await runGit(gitRoot, ['rev-list', '--max-parents=0', '--all']);
  const allCommits = (allOutput ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => /^[0-9a-f]{40}$/.test(line))
    .toSorted();
  return allCommits[0];
}

function deriveRepoName(gitRoot: string, commonDir: string | undefined): string {
  if (commonDir !== undefined && commonDir.length > 0) {
    const resolvedCommon = resolve(gitRoot, commonDir);
    const commonBase = basename(resolvedCommon);
    if (commonBase === '.git') return basename(dirname(resolvedCommon));
    return commonBase.replace(/\.git$/i, '');
  }
  return basename(gitRoot);
}

async function defaultGitRunner(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      timeout: 5_000,
      windowsHide: true,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeRemotePath(rawPath: string): string {
  return rawPath
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

function encodeNormalizedWorkDirKey(normalized: string): string {
  const base = normalized.split('/').pop() ?? normalized;
  const slug = slugifyWorkDirName(base);
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}

function stripTrailingSeparators(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}
