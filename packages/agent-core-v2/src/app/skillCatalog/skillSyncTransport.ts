import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { SkillRootSyncPlan } from '@kiki/protocol';

import type { SkillRoot } from './types';

const execFileAsync = promisify(execFile);

export const SKILL_SYNC_IGNORE_PATTERNS: readonly string[] = [
  '.sync-conflict-*',
  '*.sync-conflict-*',
  '.git',
  'node_modules',
];

export interface SkillRootTransportInfo {
  readonly transport: 'git' | 'file_tree';
  readonly gitRoot?: string;
  readonly remoteUrl?: string;
  readonly branch?: string;
}

/** Detects whether a skill root is git-backed so sync uses git transport instead of blind file-tree overwrite. */
export async function detectSkillRootTransport(
  rootPath: string,
  gitRunner: (cwd: string, args: readonly string[]) => Promise<string | undefined> = defaultGitRunner,
): Promise<SkillRootTransportInfo> {
  const resolvedRoot = resolve(rootPath);
  const hasDirectGitMarker = await pathExists(join(resolvedRoot, '.git'));
  const topLevel = await gitRunner(resolvedRoot, ['rev-parse', '--show-toplevel']);
  if (topLevel === undefined && !hasDirectGitMarker) {
    return { transport: 'file_tree' };
  }
  const gitRoot = topLevel === undefined ? resolvedRoot : resolve(topLevel);
  const remoteUrl = await gitRunner(gitRoot, ['remote', 'get-url', 'origin']);
  const branch = await gitRunner(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    transport: 'git',
    gitRoot,
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
    ...(branch === undefined ? {} : { branch }),
  };
}

/** Builds a sync plan for discovered skill roots, selecting git transport for git-backed roots and excluding `.sync-conflict-*` quarantine artifacts. */
export async function planSkillSync(
  roots: readonly SkillRoot[],
  gitRunner?: (cwd: string, args: readonly string[]) => Promise<string | undefined>,
): Promise<readonly SkillRootSyncPlan[]> {
  const plans: SkillRootSyncPlan[] = [];
  for (const root of roots) {
    const info = await detectSkillRootTransport(root.path, gitRunner);
    plans.push({
      path: root.path,
      source: root.source,
      transport: info.transport,
      ...(info.gitRoot === undefined ? {} : { gitRoot: info.gitRoot }),
      ...(info.remoteUrl === undefined ? {} : { remoteUrl: info.remoteUrl }),
      ...(info.branch === undefined ? {} : { branch: info.branch }),
      ignorePatterns: [...SKILL_SYNC_IGNORE_PATTERNS],
    });
  }
  return plans;
}

/** Returns whether a path segment or filename is a `.sync-conflict-*` quarantine artifact. */
export function isSyncConflictArtifact(name: string): boolean {
  return name.includes('.sync-conflict-');
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
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
