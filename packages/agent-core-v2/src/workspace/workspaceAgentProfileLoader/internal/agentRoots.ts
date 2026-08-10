/**
 * `workspaceAgentProfileLoader` domain — agent-root resolution primitives.
 *
 * Resolves user, project, and configured discovery roots through the `hostFs`
 * filesystem boundary. Pure path probes; no scoped state.
 */

import { dirname, join, resolve } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';

import { isDirectoryPath, pathExists, resolveAgentPath } from './paths';
import type { AgentFileRoot, AgentFileSource } from './types';

export interface AgentRootWarn {
  (message: string, error?: unknown): void;
}

const USER_BRAND_DIRS = ['agents'] as const;
const USER_GENERIC_DIRS = ['.agents/agents'] as const;
const PROJECT_BRAND_DIRS = ['.kimi-code/agents'] as const;
const PROJECT_GENERIC_DIRS = ['.agents/agents'] as const;

export async function userAgentRoots(
  fs: IHostFileSystem,
  homeDir: string,
  osHomeDir: string,
  warn?: AgentRootWarn,
): Promise<readonly AgentFileRoot[]> {
  const roots: AgentFileRoot[] = [];
  await pushFirstExisting(fs, roots, USER_BRAND_DIRS, homeDir, 'user', warn);
  await pushFirstExisting(fs, roots, USER_GENERIC_DIRS, osHomeDir, 'user', warn);
  return roots;
}

export async function projectAgentRoots(
  fs: IHostFileSystem,
  workDir: string,
  warn?: AgentRootWarn,
): Promise<readonly AgentFileRoot[]> {
  const projectRoot = await findProjectRoot(fs, workDir, warn);
  const roots: AgentFileRoot[] = [];
  await pushFirstExisting(fs, roots, PROJECT_BRAND_DIRS, projectRoot, 'project', warn);
  await pushFirstExisting(fs, roots, PROJECT_GENERIC_DIRS, projectRoot, 'project', warn);
  return roots;
}

export interface AgentRootWatchPlan {
  readonly root: string;
  readonly candidates: readonly string[];
}

export function userAgentRootWatchPlans(
  homeDir: string,
  osHomeDir: string,
): readonly AgentRootWatchPlan[] {
  return groupWatchCandidates([
    { root: homeDir, candidate: join(homeDir, USER_BRAND_DIRS[0]) },
    { root: homeDir, candidate: join(homeDir, 'SYSTEM.md') },
    { root: osHomeDir, candidate: join(osHomeDir, USER_GENERIC_DIRS[0]) },
  ]);
}

export interface ProjectAgentRootCandidates {
  readonly projectRoot: string;
  readonly candidates: readonly string[];
}

export async function projectAgentRootCandidates(
  fs: IHostFileSystem,
  workDir: string,
  warn?: AgentRootWarn,
): Promise<ProjectAgentRootCandidates> {
  const projectRoot = await findProjectRoot(fs, workDir, warn);
  return {
    projectRoot,
    candidates: [...PROJECT_BRAND_DIRS, ...PROJECT_GENERIC_DIRS].map((dir) =>
      join(projectRoot, dir),
    ),
  };
}

export async function configuredAgentRoots(
  fs: IHostFileSystem,
  dirs: readonly string[],
  workDir: string,
  osHomeDir: string,
  source: AgentFileSource,
  warn?: AgentRootWarn,
): Promise<readonly AgentFileRoot[]> {
  const projectRoot = await findProjectRoot(fs, workDir, warn);
  const roots: AgentFileRoot[] = [];
  for (const dir of dirs) {
    await pushExistingRoot(fs, roots, resolveAgentPath(dir, projectRoot, osHomeDir), source, warn);
  }
  return roots;
}

export async function configuredAgentRootWatchPlans(
  fs: IHostFileSystem,
  dirs: readonly string[],
  workDir: string,
  osHomeDir: string,
  warn?: AgentRootWarn,
): Promise<readonly AgentRootWatchPlan[]> {
  const projectRoot = await findProjectRoot(fs, workDir, warn);
  const candidates = dirs.map((dir) => resolveAgentPath(dir, projectRoot, osHomeDir));
  const rootedCandidates = await Promise.all(
    candidates.map(async (candidate) => ({
      root: await nearestExistingParent(fs, candidate, warn),
      candidate,
    })),
  );
  return groupWatchCandidates(rootedCandidates);
}

async function nearestExistingParent(
  fs: IHostFileSystem,
  candidate: string,
  warn?: AgentRootWarn,
): Promise<string> {
  let current = dirname(candidate);
  while (true) {
    try {
      if (await isDirectoryPath(fs, current)) return current;
    } catch (error) {
      if (isUnavailable(error)) throw error;
      warn?.(`Skipping unreadable agent watch root ${current}: ${errorMessage(error)}`, error);
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function groupWatchCandidates(
  entries: readonly { readonly root: string; readonly candidate: string }[],
): readonly AgentRootWatchPlan[] {
  const groups = new Map<string, string[]>();
  for (const { root, candidate } of entries) {
    const candidates = groups.get(root) ?? [];
    if (!candidates.includes(candidate)) candidates.push(candidate);
    groups.set(root, candidates);
  }
  return [...groups].map(([root, candidates]) => ({ root, candidates }));
}

async function findProjectRoot(
  fs: IHostFileSystem,
  workDir: string,
  warn?: AgentRootWarn,
): Promise<string> {
  const start = resolve(workDir);
  let current = start;
  while (true) {
    const marker = join(current, '.git');
    try {
      if (await pathExists(fs, marker)) return current;
    } catch (error) {
      if (isUnavailable(error)) throw error;
      warn?.(`Skipping unreadable project marker ${marker}: ${errorMessage(error)}`, error);
    }
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

async function pushFirstExisting(
  fs: IHostFileSystem,
  out: AgentFileRoot[],
  dirs: readonly string[],
  base: string,
  source: AgentFileSource,
  warn?: AgentRootWarn,
): Promise<void> {
  for (const dir of dirs) {
    if (await pushExistingRoot(fs, out, join(base, dir), source, warn)) return;
  }
}

async function pushExistingRoot(
  fs: IHostFileSystem,
  out: AgentFileRoot[],
  dir: string,
  source: AgentFileSource,
  warn?: AgentRootWarn,
): Promise<boolean> {
  try {
    if (!(await isDirectoryPath(fs, dir))) return false;
    const resolved = (await fs.realpath(dir)).replaceAll('\\', '/');
    if (!out.some((root) => root.path === resolved)) out.push({ path: resolved, source });
    return true;
  } catch (error) {
    if (isUnavailable(error)) throw error;
    warn?.(`Skipping unreadable agent root ${dir}: ${errorMessage(error)}`, error);
    return false;
  }
}

function isUnavailable(error: unknown): boolean {
  return error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_UNAVAILABLE;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
