import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HEAVY_EXCLUDED_SEGMENTS = new Set(['node_modules', 'target', '.git']);

export interface GitWipDeltaExportResult {
  readonly wipId: string;
  readonly refName: string;
  readonly baseCommit: string;
  readonly wipCommit: string;
  readonly bundlePath: string;
  readonly bundleBytes: number;
  readonly includedDirtyFiles: readonly string[];
}

export interface GitWipDeltaApplyResult {
  readonly wipId: string;
  readonly refName: string;
  readonly worktreePath: string;
  readonly commit: string;
}

/**
 * Exports uncommitted WIP (staged, unstaged, and untracked non-ignored files, excluding `node_modules`/`target`)
 * onto a lightweight git bundle at `refs/kiki/wip/<id>` without mutating the user's real index or HEAD.
 */
export async function exportGitWipDelta(
  sourceRepoRoot: string,
  outputBundlePath: string,
  wipId: string = randomUUID().slice(0, 12),
): Promise<GitWipDeltaExportResult> {
  if (!/^[a-zA-Z0-9._-]+$/.test(wipId)) {
    throw new Error(`Invalid WIP id: ${wipId}`);
  }
  const repoRoot = resolve(sourceRepoRoot);
  const bundlePath = resolve(outputBundlePath);
  const refName = `refs/kiki/wip/${wipId}`;
  const baseCommit = await gitOrThrow(repoRoot, ['rev-parse', 'HEAD']);
  const tempIndex = join(tmpdir(), `kiki-wip-index-${randomUUID()}`);

  try {
    const gitDir = resolve(repoRoot, await gitOrThrow(repoRoot, ['rev-parse', '--git-dir']));
    const realIndex = join(gitDir, 'index');
    const hasIndex = await stat(realIndex).then((s) => s.isFile()).catch(() => false);
    if (hasIndex) {
      await copyFile(realIndex, tempIndex);
    }

    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    const statusOut = await gitOrThrow(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], env, false);
    const tokens = statusOut.split('\0').filter((token) => token.length > 0);
    const toStage: string[] = [];
    const toRemove: string[] = [];
    const includedDirtyFiles: string[] = [];

    for (let index = 0; index < tokens.length; index += 1) {
      const entry = tokens[index]!;
      const xy = entry.slice(0, 2);
      const relPath = entry.slice(3);
      if (xy.startsWith('R') || xy.startsWith('C')) index += 1;
      if (relPath === '' || isExcludedHeavyPath(relPath)) continue;
      includedDirtyFiles.push(relPath);
      if (xy.includes('D')) {
        toRemove.push(relPath);
      } else {
        toStage.push(relPath);
      }
    }

    if (toStage.length > 0) {
      await gitOrThrow(repoRoot, ['add', '--', ...toStage], env);
    }
    if (toRemove.length > 0) {
      await gitOrThrow(repoRoot, ['rm', '--cached', '--ignore-unmatch', '--', ...toRemove], env);
    }

    const treeSha = await gitOrThrow(repoRoot, ['write-tree'], env);
    const wipCommit = await gitOrThrow(
      repoRoot,
      ['commit-tree', treeSha, '-p', baseCommit, '-m', `kiki-wip:${wipId}`],
      {
        ...env,
        GIT_AUTHOR_NAME: 'Kiki Mesh',
        GIT_AUTHOR_EMAIL: 'mesh@kiki.local',
        GIT_COMMITTER_NAME: 'Kiki Mesh',
        GIT_COMMITTER_EMAIL: 'mesh@kiki.local',
      },
    );

    await gitOrThrow(repoRoot, ['update-ref', refName, wipCommit]);
    await mkdir(dirname(bundlePath), { recursive: true });
    await gitOrThrow(repoRoot, ['bundle', 'create', bundlePath, `${baseCommit}..${refName}`]);
    const bundleStat = await stat(bundlePath);

    return {
      wipId,
      refName,
      baseCommit,
      wipCommit,
      bundlePath,
      bundleBytes: bundleStat.size,
      includedDirtyFiles: includedDirtyFiles.toSorted(),
    };
  } finally {
    await rm(tempIndex, { force: true }).catch(() => undefined);
  }
}

/**
 * Fetches `refs/kiki/wip/<id>` from a lightweight WIP git bundle into `targetRepoRoot`
 * and materializes/updates a persistent per-repo worktree at `worktreePath`.
 */
export async function applyGitWipDelta(
  targetRepoRoot: string,
  bundlePath: string,
  wipId: string,
  worktreePath: string,
): Promise<GitWipDeltaApplyResult> {
  if (!/^[a-zA-Z0-9._-]+$/.test(wipId)) {
    throw new Error(`Invalid WIP id: ${wipId}`);
  }
  const repoRoot = resolve(targetRepoRoot);
  const resolvedBundle = resolve(bundlePath);
  const resolvedWorktree = resolve(worktreePath);
  const refName = `refs/kiki/wip/${wipId}`;

  await gitOrThrow(repoRoot, ['fetch', resolvedBundle, `${refName}:${refName}`]);
  const commit = await gitOrThrow(repoRoot, ['rev-parse', refName]);

  const exists = await stat(resolvedWorktree).then((s) => s.isDirectory()).catch(() => false);
  if (exists) {
    const insideWorktree = await gitOrThrow(resolvedWorktree, ['rev-parse', '--is-inside-work-tree']).catch(() => undefined);
    if (insideWorktree === 'true') {
      await gitOrThrow(resolvedWorktree, ['checkout', '--detach', '--force', commit]);
      await gitOrThrow(resolvedWorktree, ['clean', '-fd']);
      return { wipId, refName, worktreePath: resolvedWorktree, commit };
    }
    await rm(resolvedWorktree, { recursive: true, force: true });
  }

  await mkdir(dirname(resolvedWorktree), { recursive: true });
  await gitOrThrow(repoRoot, ['worktree', 'add', '--detach', '--force', resolvedWorktree, commit]);
  return { wipId, refName, worktreePath: resolvedWorktree, commit };
}

function isExcludedHeavyPath(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((segment) => HEAVY_EXCLUDED_SEGMENTS.has(segment));
}

async function gitOrThrow(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  trim = true,
): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    env,
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return trim ? stdout.trim() : stdout;
}
