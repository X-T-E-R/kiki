/* eslint-disable import/first -- vi.mock setup must run before the imports it stubs out. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  execFile: vi.fn(),
  resolveCommandPath: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
  spawnSync: mocks.spawnSync,
}));

vi.mock('#/utils/process/resolve-command', () => ({
  resolveCommandPath: mocks.resolveCommandPath,
}));

import { createGitStatusCache, formatGitBadge } from '#/utils/git/git-status';

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  mocks.resolveCommandPath.mockImplementation((command: string) => `/usr/bin/${command}`);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('git status cache', () => {
  it('caches branch and status reads asynchronously without spawnSync until their TTL expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    mocks.execFile.mockImplementation(
      (
        cmd: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cmd.endsWith('/gh')) {
          callback(new Error('no pull request'), '', '');
          return;
        }
        if (args.includes('rev-parse')) {
          callback(null, 'true\n', '');
          return;
        }
        if (args.includes('branch')) {
          callback(null, 'main\n', '');
          return;
        }
        if (args.includes('status')) {
          callback(null, '## main...origin/main [ahead 2, behind 1]\n M src/app.ts\n', '');
          return;
        }
        if (args.includes('diff')) {
          callback(null, '4\t1\tsrc/app.ts\n', '');
          return;
        }
        callback(new Error('unexpected git invocation'), '', '');
      },
    );

    const onChange = vi.fn();
    const cache = createGitStatusCache('/tmp/repo', { onChange });

    expect(cache.getStatus()).toBeNull();
    expect(mocks.spawnSync).not.toHaveBeenCalled();

    await flushMicrotasks();

    expect(onChange).toHaveBeenCalled();
    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 2,
      behind: 1,
      diffAdded: 4,
      diffDeleted: 1,
      pullRequest: null,
    });
    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 2,
      behind: 1,
      diffAdded: 4,
      diffDeleted: 1,
      pullRequest: null,
    });
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(mocks.execFile).toHaveBeenCalledTimes(5);

    vi.setSystemTime(new Date('2026-04-24T00:00:06Z'));
    cache.getStatus();
    await flushMicrotasks();
    expect(mocks.execFile).toHaveBeenCalledTimes(6);

    vi.setSystemTime(new Date('2026-04-24T00:00:16Z'));
    cache.getStatus();
    await flushMicrotasks();
    expect(mocks.execFile).toHaveBeenCalledTimes(9);
  });

  it('reads uncommitted diff line counts and current pull request metadata', async () => {
    const onChange = vi.fn();
    mocks.execFile.mockImplementation(
      (
        cmd: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cmd.endsWith('/gh')) {
          callback(null, '{"number":12,"url":"https://github.com/acme/repo/pull/12"}\n', '');
          return;
        }
        if (args.includes('rev-parse')) {
          callback(null, 'true\n', '');
          return;
        }
        if (args.includes('branch')) {
          callback(null, 'feature/footer\n', '');
          return;
        }
        if (args.includes('status')) {
          callback(null, '## feature/footer...origin/feature/footer\n M src/app.ts\n', '');
          return;
        }
        if (args.includes('diff')) {
          callback(null, '10\t3\tsrc/app.ts\n-\t-\timage.png\n0\t5\tdeleted.ts\n', '');
          return;
        }
        callback(new Error('unexpected'), '', '');
      },
    );

    const cache = createGitStatusCache('/tmp/repo', { onChange });
    expect(cache.getStatus()).toBeNull();

    await flushMicrotasks();

    expect(onChange).toHaveBeenCalled();
    expect(cache.getStatus()).toEqual({
      branch: 'feature/footer',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 10,
      diffDeleted: 8,
      pullRequest: {
        number: 12,
        url: 'https://github.com/acme/repo/pull/12',
      },
    });
  });

  it('keeps footer git status working when gh pull-request lookup throws synchronously', async () => {
    const onChange = vi.fn();
    mocks.execFile.mockImplementation(
      (
        cmd: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cmd.endsWith('/gh')) {
          const error = Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' });
          throw error;
        }
        if (args.includes('rev-parse')) {
          callback(null, 'true\n', '');
          return;
        }
        if (args.includes('branch')) {
          callback(null, 'main\n', '');
          return;
        }
        if (args.includes('status')) {
          callback(null, '## main...origin/main\n M src/app.ts\n', '');
          return;
        }
        if (args.includes('diff')) {
          callback(null, '2\t1\tsrc/app.ts\n', '');
          return;
        }
        callback(new Error('unexpected'), '', '');
      },
    );

    const cache = createGitStatusCache('/tmp/repo', { onChange });
    expect(cache.getStatus()).toBeNull();

    await flushMicrotasks();

    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 2,
      diffDeleted: 1,
      pullRequest: null,
    });
  });

  it('returns null without spawning when git cannot be resolved to a safe path', () => {
    mocks.resolveCommandPath.mockReturnValue(undefined);
    expect(createGitStatusCache('/tmp/repo').getStatus()).toBeNull();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('defers the repo probe until the first footer status read and caches a negative result', async () => {
    mocks.execFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(new Error('not a repo'), '', '');
      },
    );
    const cache = createGitStatusCache('/tmp/not-a-repo');
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(cache.getStatus()).toBeNull();
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(cache.getStatus()).toBeNull();
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it('spawns git and gh through their resolved absolute paths', async () => {
    mocks.execFile.mockImplementation(
      (
        cmd: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        if (cmd.endsWith('/gh')) {
          callback(new Error('no pull request'), '', '');
          return;
        }
        if (args.includes('rev-parse')) callback(null, 'true\n', '');
        else if (args.includes('branch')) callback(null, 'main\n', '');
        else if (args.includes('status')) callback(null, '## main...origin/main\n', '');
        else callback(new Error('unexpected'), '', '');
      },
    );

    const cache = createGitStatusCache('/tmp/repo');
    cache.getStatus();
    await flushMicrotasks();

    expect(cache.getStatus()).not.toBeNull();
    expect(mocks.resolveCommandPath).toHaveBeenCalledWith('git', '/tmp/repo');
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(mocks.execFile).toHaveBeenCalledWith(
      '/usr/bin/git',
      expect.any(Array),
      expect.anything(),
      expect.any(Function),
    );
    expect(mocks.execFile).toHaveBeenCalledWith(
      '/usr/bin/gh',
      expect.any(Array),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('returns null when the working directory is not a git repo and formats badges', async () => {
    mocks.execFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(new Error('not a repo'), '', '');
      },
    );
    const cache = createGitStatusCache('/tmp/not-a-repo');
    expect(cache.getStatus()).toBeNull();
    await flushMicrotasks();
    expect(cache.getStatus()).toBeNull();
    expect(
      formatGitBadge({
        branch: 'main',
        dirty: true,
        ahead: 2,
        behind: 1,
        diffAdded: 12,
        diffDeleted: 3,
        pullRequest: null,
      }),
    ).toBe('main [+12 -3 ↑2↓1]');
    expect(
      formatGitBadge({
        branch: 'main',
        dirty: true,
        ahead: 0,
        behind: 0,
        diffAdded: 0,
        diffDeleted: 0,
        pullRequest: null,
      }),
    ).toBe('main [±]');
  });

  it('formats pull request badges as terminal hyperlinks when requested', () => {
    const linked = formatGitBadge(
      {
        branch: 'feature/footer',
        dirty: false,
        ahead: 0,
        behind: 0,
        diffAdded: 0,
        diffDeleted: 0,
        pullRequest: {
          number: 12,
          url: 'https://github.com/acme/repo/pull/12',
        },
      },
      { linkPullRequest: true },
    );

    expect(linked).toContain('[PR#12]');
    expect(linked).toContain('\u001B]8;;https://github.com/acme/repo/pull/12\u0007');
    expect(linked).toContain('\u001B]8;;\u0007');
  });
});
