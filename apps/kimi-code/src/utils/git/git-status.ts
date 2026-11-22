/**
 * Cached git branch + working-tree status for the footer/statusline.
 *
 * All git and gh queries run asynchronously via `execFile` so footer rendering
 * never blocks the TUI event loop. `getStatus()` always returns the latest
 * cached snapshot immediately and triggers background refreshes when a TTL
 * expires, notifying `options.onChange` when displayed fields change.
 */

import { execFile, type ChildProcess } from 'node:child_process';

import { resolveCommandPath } from '#/utils/process/resolve-command';

const BRANCH_TTL_MS = 5_000;
const STATUS_TTL_MS = 15_000;
const PULL_REQUEST_TTL_MS = 60_000;
const SPAWN_TIMEOUT_MS = 500;
const PR_SPAWN_TIMEOUT_MS = 5_000;
const HARD_TIMEOUT_GRACE_MS = 250;

export interface GitStatus {
  readonly branch: string;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly diffAdded: number;
  readonly diffDeleted: number;
  readonly pullRequest: PullRequestInfo | null;
}

export interface PullRequestInfo {
  readonly number: number;
  readonly url: string;
}

export interface GitStatusCache {
  /** Returns current cached status, or `null` when workDir is not a git repo or still probing. */
  getStatus(): GitStatus | null;
  /** Stops future refreshes, suppresses `onChange`, and terminates any active child processes. */
  dispose(): void;
}

export interface GitStatusCacheOptions {
  readonly onChange?: () => void;
}

interface BranchState {
  value: string | null;
  fetchedAt: number;
  pending: boolean;
  requestId: number;
}

interface StatusValues {
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly diffAdded: number;
  readonly diffDeleted: number;
}

interface StatusState extends StatusValues {
  fetchedAt: number;
  pending: boolean;
  requestId: number;
}

interface PullRequestState {
  value: PullRequestInfo | null;
  branch: string | null;
  fetchedAt: number;
  pendingBranch: string | null;
  requestId: number;
}

const AHEAD_BEHIND_RE = /\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/;

export function createGitStatusCache(
  workDir: string,
  options: GitStatusCacheOptions = {},
): GitStatusCache {
  // This cache is constructed before the workspace trust gate, so the git
  // binary must be resolved through PATH to an absolute path — a bare name
  // would let cmd.exe pick up a `git.exe` planted in the workspace.
  const git = resolveCommandPath('git', workDir);
  let disposed = false;
  const activeChildren = new Set<ChildProcess>();
  let repoDetected = false;
  let isRepo = false;
  let repoDetectPending = false;
  let branch: BranchState = { value: null, fetchedAt: 0, pending: false, requestId: 0 };
  let status: StatusState = {
    dirty: false,
    ahead: 0,
    behind: 0,
    diffAdded: 0,
    diffDeleted: 0,
    fetchedAt: 0,
    pending: false,
    requestId: 0,
  };
  let pullRequest: PullRequestState = {
    value: null,
    branch: null,
    fetchedAt: 0,
    pendingBranch: null,
    requestId: 0,
  };

  return {
    getStatus: () => {
      if (disposed || git === undefined || (repoDetected && !isRepo)) return null;
      if (!repoDetected) {
        detectGitRepoIfNeeded(git);
        return null;
      }

      const now = Date.now();
      refreshBranchIfNeeded(git, now);
      refreshStatusIfNeeded(git, now);
      if (branch.value === null) return null;

      refreshPullRequestIfNeeded(branch.value, now);

      return {
        branch: branch.value,
        dirty: status.dirty,
        ahead: status.ahead,
        behind: status.behind,
        diffAdded: status.diffAdded,
        diffDeleted: status.diffDeleted,
        pullRequest: pullRequest.branch === branch.value ? pullRequest.value : null,
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const child of activeChildren) {
        killChildProcess(child);
      }
      activeChildren.clear();
    },
  };

  function runTrackedExec(
    command: string,
    args: readonly string[],
    execOptions: Parameters<typeof execFile>[2],
    hardTimeoutMs: number,
  ): Promise<string | null> {
    if (disposed) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      let child: ChildProcess | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        if (hardTimer !== undefined) {
          clearTimeout(hardTimer);
          hardTimer = undefined;
        }
        if (child !== undefined) {
          activeChildren.delete(child);
        }
        resolve(value);
      };
      try {
        child = execFile(command, args, { ...execOptions, windowsHide: true }, (error, stdout) => {
          if (error !== null || disposed) {
            finish(null);
            return;
          }
          finish(typeof stdout === 'string' ? stdout : stdout.toString('utf8'));
        });
      } catch {
        finish(null);
        return;
      }
      if (settled) return;
      if (disposed) {
        killChildProcess(child);
        finish(null);
        return;
      }
      if (child !== undefined) {
        activeChildren.add(child);
      }
      hardTimer = setTimeout(() => {
        killChildProcess(child);
        finish(null);
      }, hardTimeoutMs);
      hardTimer.unref?.();
    });
  }

  function runGit(
    gitBin: string,
    args: readonly string[],
    maxBuffer = 256 * 1024,
  ): Promise<string | null> {
    return runTrackedExec(
      gitBin,
      args,
      {
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
        maxBuffer,
        windowsHide: true,
      },
      SPAWN_TIMEOUT_MS + HARD_TIMEOUT_GRACE_MS,
    );
  }

  function detectGitRepoIfNeeded(gitBin: string): void {
    if (disposed || repoDetected || repoDetectPending) return;
    repoDetectPending = true;
    void detectGitRepo(runGit, gitBin, workDir).then((detected) => {
      repoDetectPending = false;
      if (disposed) return;
      repoDetected = true;
      isRepo = detected;
      if (!detected) return;
      const now = Date.now();
      refreshBranchIfNeeded(gitBin, now);
      refreshStatusIfNeeded(gitBin, now);
    });
  }

  function refreshBranchIfNeeded(gitBin: string, now: number): void {
    if (disposed || branch.pending || now - branch.fetchedAt < BRANCH_TTL_MS) return;
    const requestId = branch.requestId + 1;
    branch = { ...branch, pending: true, requestId };

    void readBranch(runGit, gitBin, workDir).then((value) => {
      if (disposed || branch.requestId !== requestId) return;
      const changed = branch.value !== value;
      branch = {
        value,
        fetchedAt: Date.now(),
        pending: false,
        requestId,
      };
      if (value !== null) {
        refreshPullRequestIfNeeded(value, Date.now());
      }
      if (changed) options.onChange?.();
    });
  }

  function refreshStatusIfNeeded(gitBin: string, now: number): void {
    if (disposed || status.pending || now - status.fetchedAt < STATUS_TTL_MS) return;
    const requestId = status.requestId + 1;
    status = { ...status, pending: true, requestId };

    void readStatus(runGit, gitBin, workDir).then((next) => {
      if (disposed || status.requestId !== requestId) return;
      const changed = !sameStatusValues(status, next);
      status = {
        ...next,
        fetchedAt: Date.now(),
        pending: false,
        requestId,
      };
      if (changed && branch.value !== null) options.onChange?.();
    });
  }

  function refreshPullRequestIfNeeded(branchName: string, now: number): void {
    if (disposed || pullRequest.pendingBranch === branchName) return;
    const fetchedAt = pullRequest.branch === branchName ? pullRequest.fetchedAt : 0;
    if (now - fetchedAt < PULL_REQUEST_TTL_MS) return;

    const requestId = pullRequest.requestId + 1;
    pullRequest = {
      value: pullRequest.branch === branchName ? pullRequest.value : null,
      branch: branchName,
      fetchedAt,
      pendingBranch: branchName,
      requestId,
    };

    void readPullRequest(runTrackedExec, workDir).then((value) => {
      if (disposed || pullRequest.requestId !== requestId) return;

      const previous = pullRequest.branch === branchName ? pullRequest.value : null;
      const changed = !samePullRequest(previous, value);
      pullRequest = {
        value,
        branch: branchName,
        fetchedAt: Date.now(),
        pendingBranch: null,
        requestId,
      };
      if (changed) options.onChange?.();
    });
  }
}

function killChildProcess(child: ChildProcess | undefined): void {
  if (child === undefined || typeof child.kill !== 'function') return;
  try {
    if (!child.kill('SIGKILL')) {
      child.kill();
    }
  } catch {
    try {
      child.kill();
    } catch {
      // Child already exited.
    }
  }
}

type RunGitFn = (
  gitBin: string,
  args: readonly string[],
  maxBuffer?: number,
) => Promise<string | null>;

type RunTrackedExecFn = (
  command: string,
  args: readonly string[],
  execOptions: Parameters<typeof execFile>[2],
  hardTimeoutMs: number,
) => Promise<string | null>;

function sameStatusValues(a: StatusValues, b: StatusValues): boolean {
  return (
    a.dirty === b.dirty &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.diffAdded === b.diffAdded &&
    a.diffDeleted === b.diffDeleted
  );
}

async function detectGitRepo(runGit: RunGitFn, git: string, workDir: string): Promise<boolean> {
  const stdout = await runGit(git, ['-C', workDir, 'rev-parse', '--is-inside-work-tree']);
  return stdout !== null && stdout.trim() === 'true';
}

async function readBranch(runGit: RunGitFn, git: string, workDir: string): Promise<string | null> {
  const stdout = await runGit(git, ['-C', workDir, 'branch', '--show-current']);
  if (stdout === null) return null;
  const name = stdout.trim();
  return name.length > 0 ? name : null;
}

async function readStatus(runGit: RunGitFn, git: string, workDir: string): Promise<StatusValues> {
  const stdout = await runGit(
    git,
    ['-C', workDir, 'status', '--porcelain', '-b'],
    4 * 1024 * 1024,
  );
  if (stdout === null) {
    return { dirty: false, ahead: 0, behind: 0, diffAdded: 0, diffDeleted: 0 };
  }

  let dirty = false;
  let ahead = 0;
  let behind = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('## ')) {
      const m = AHEAD_BEHIND_RE.exec(line);
      if (m) {
        ahead = Number.parseInt(m[1] ?? '0', 10) || 0;
        behind = Number.parseInt(m[2] ?? '0', 10) || 0;
      }
    } else if (line.trim().length > 0) {
      dirty = true;
    }
  }
  const diff = dirty ? await readDiffStats(runGit, git, workDir) : { added: 0, deleted: 0 };
  return {
    dirty,
    ahead,
    behind,
    diffAdded: diff.added,
    diffDeleted: diff.deleted,
  };
}

async function readDiffStats(
  runGit: RunGitFn,
  git: string,
  workDir: string,
): Promise<{ added: number; deleted: number }> {
  const stdout = await runGit(
    git,
    ['-C', workDir, 'diff', '--numstat', 'HEAD', '--'],
    4 * 1024 * 1024,
  );
  if (stdout === null) return { added: 0, deleted: 0 };

  let added = 0;
  let deleted = 0;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [addedText, deletedText] = line.split('\t');
    added += parseDiffNumstatCount(addedText);
    deleted += parseDiffNumstatCount(deletedText);
  }
  return { added, deleted };
}

function parseDiffNumstatCount(value: string | undefined): number {
  if (value === undefined || value === '-') return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function readPullRequest(
  runTrackedExec: RunTrackedExecFn,
  workDir: string,
): Promise<PullRequestInfo | null> {
  // Resolve gh through PATH as well — this runs with cwd = workDir, where a
  // planted `gh.exe` would otherwise be picked up by cmd.exe on Windows.
  const gh = resolveCommandPath('gh', workDir);
  if (gh === undefined) return null;
  const stdout = await runTrackedExec(
    gh,
    ['pr', 'view', '--json', 'number,url'],
    {
      cwd: workDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_NO_UPDATE_NOTIFIER: '1',
        GH_PROMPT_DISABLED: '1',
      },
      timeout: PR_SPAWN_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    },
    PR_SPAWN_TIMEOUT_MS + HARD_TIMEOUT_GRACE_MS,
  );
  return stdout === null ? null : parsePullRequest(stdout);
}

function samePullRequest(a: PullRequestInfo | null, b: PullRequestInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.number === b.number && a.url === b.url;
}

function parsePullRequest(stdout: string): PullRequestInfo | null {
  try {
    const raw = JSON.parse(stdout) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const number = record['number'];
    const url = record['url'];
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;
    if (typeof url !== 'string' || !isSafeHttpUrl(url)) return null;
    return { number, url };
  } catch {
    return null;
  }
}

function isSafeHttpUrl(value: string): boolean {
  if (hasControlChars(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export interface FormatGitBadgeOptions {
  readonly linkPullRequest?: boolean;
}

export function formatGitBadgeBase(status: GitStatus): string {
  const parts: string[] = [];
  const diff = formatDiffStats(status);
  if (diff) parts.push(diff);
  let sync = '';
  if (status.ahead > 0) sync += `↑${status.ahead}`;
  if (status.behind > 0) sync += `↓${status.behind}`;
  if (sync) parts.push(sync);
  return parts.length === 0 ? status.branch : `${status.branch} [${parts.join(' ')}]`;
}

export function formatPullRequestBadge(
  pullRequest: PullRequestInfo,
  options: FormatGitBadgeOptions = {},
): string {
  const prText = `[PR#${String(pullRequest.number)}]`;
  return options.linkPullRequest ? toTerminalHyperlink(prText, pullRequest.url) : prText;
}

export function formatGitBadge(status: GitStatus, options: FormatGitBadgeOptions = {}): string {
  const base = formatGitBadgeBase(status);
  if (status.pullRequest === null) return base;

  return `${base} ${formatPullRequestBadge(status.pullRequest, options)}`;
}

function formatDiffStats(status: GitStatus): string | null {
  const parts: string[] = [];
  if (status.diffAdded > 0) parts.push(`+${String(status.diffAdded)}`);
  if (status.diffDeleted > 0) parts.push(`-${String(status.diffDeleted)}`);
  if (parts.length > 0) return parts.join(' ');
  return status.dirty ? '±' : null;
}

function toTerminalHyperlink(text: string, url: string): string {
  if (!isSafeHttpUrl(url)) return text;
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}
