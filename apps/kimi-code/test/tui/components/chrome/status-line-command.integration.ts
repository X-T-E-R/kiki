import * as childProcess from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import {
  runStatusLineCommand,
  STATUS_LINE_MAX_CAPTURE_BYTES,
  StatusLineCommandRunner,
  type StatusLinePayload,
} from '#/tui/utils/status-line-command';
import type { AppState } from '#/tui/types';

// Spy through to real subprocesses; ESM's native namespace cannot be redefined.
vi.mock('node:child_process', { spy: true });

const baseState: AppState = {
  version: '1.2.3',
  workDir: '/tmp/project',
  additionalDirs: [],
  sessionId: 'ses-1',
  sessionTitle: null,
  model: 'kimi-k2',
  permissionMode: 'manual',
  thinkingEffort: 'off',
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: 'idle',
  streamingStartTime: 0,
  stepRetry: null,
  planMode: false,
  inputMode: 'prompt',
  swarmMode: false,
  theme: 'dark',
  editorCommand: null,
  notifications: { enabled: true, condition: 'unfocused' },
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
};

const payload: StatusLinePayload = {
  model: 'kimi-k2',
  cwd: '/tmp/project',
  gitBranch: 'main',
  permissionMode: 'manual',
  planMode: false,
  contextUsage: 12,
  contextTokens: 1024,
  maxContextTokens: 8192,
  sessionId: 'ses-1',
  version: '1.2.3',
};

function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

/**
 * A `node -e` status-line fixture that survives both spawn shells.
 *
 * The runner shells out via `sh -c` on POSIX and `cmd /d /s /c` on Windows. On
 * the way to cmd, libuv escapes inner double quotes, which would hand node a
 * quoted script — a bare string literal that runs nothing — so Windows gets the
 * unquoted form instead. That keeps every script space-free and confined to
 * single quotes.
 */
function nodeCommand(script: string): string {
  return process.platform === 'win32' ? `node -e ${script}` : `node -e "${script}"`;
}

describe('runStatusLineCommand', () => {
  it('passes the payload as JSON on stdin and returns the first stdout line', async () => {
    const line = await runStatusLineCommand(
      nodeCommand(`process.stdin.pipe(process.stdout)`),
      payload,
      5_000, // IO contract, not a benchmark of a second Node runtime's startup.
    );

    expect(line).not.toBeNull();
    const parsed = JSON.parse(line!);
    expect(parsed.model).toBe('kimi-k2');
    expect(parsed.gitBranch).toBe('main');
    expect(parsed.cwd).toBe('/tmp/project');
  });

  it('returns null on a nonzero exit', async () => {
    const command = process.platform === 'win32' ? 'echo rejected & exit /b 3' : 'echo rejected; exit 3';
    expect(await runStatusLineCommand(command, payload, 5_000)).toBeNull();
  });

  it('returns null on empty output', async () => {
    const command = process.platform === 'win32' ? 'exit /b 0' : 'exit 0';
    expect(await runStatusLineCommand(command, payload, 5_000)).toBeNull();
  });

  it('returns null when the command overruns the timeout', async () => {
    expect(
      await runStatusLineCommand(nodeCommand(`setTimeout(Object,2000)`), payload, 100),
    ).toBeNull();
  });

  it('trims the line and ignores later lines', async () => {
    const line = await runStatusLineCommand(
      nodeCommand(`process.stdout.write('first\\nsecond\\n')`),
      payload,
      5_000, // IO contract, not a benchmark of a second Node runtime's startup.
    );

    expect(line).toBe('first');
  });

  it('caps the captured output instead of accumulating an unending stream', async () => {
    // 200 KB on a single line, then exit: only the capped prefix is kept.
    const line = await runStatusLineCommand(
      nodeCommand(`process.stdout.write('a'.repeat(200000))`),
      payload,
      5_000, // IO contract, not a benchmark of a second Node runtime's startup.
    );

    expect(line).not.toBeNull();
    expect(line!.length).toBeLessThanOrEqual(STATUS_LINE_MAX_CAPTURE_BYTES);
  });
});

describe('FooterComponent status_line command', () => {
  it('swaps line 1 to the command output once it lands', async () => {
    const state: AppState = {
      ...baseState,
      // Shell builtins exercise real subprocess IO without starting another Node runtime.
      statusLine: { items: null, command: 'echo my-custom-status' },
    };
    const onRefresh = vi.fn();
    const footer = new FooterComponent(state, onRefresh);
    try {
      expect(plain(footer.render(120)[0]!)).toContain('kimi-k2');
      await vi.waitFor(() => expect(onRefresh).toHaveBeenCalled());
      expect(plain(footer.render(120)[0]!)).toContain('my-custom-status');
    } finally {
      footer.setState(baseState); // Disposes the runner, including any queued refresh.
      footer.dispose();
    }
  });

  it('keeps the built-in layout when the command fails', async () => {
    const command = process.platform === 'win32' ? 'echo rejected & exit /b 1' : 'echo rejected; exit 1';
    const footer = new FooterComponent({
      ...baseState,
      statusLine: { items: null, command },
    });
    // Observe the real child closing: rendering before execution proved only the initial fallback.
    const spawn = vi.mocked(childProcess.spawn).mockClear();
    try {
      footer.render(120);
      const child = spawn.mock.results[0]!.value as childProcess.ChildProcess;
      const closed = vi.fn();
      child.once('close', closed);
      await vi.waitFor(() => expect(closed).toHaveBeenCalledWith(1, null));
      const line = plain(footer.render(120)[0]!);
      expect(line).toContain('kimi-k2');
      expect(line).not.toContain('rejected');
    } finally {
      footer.setState(baseState);
      footer.dispose();
      spawn.mockRestore();
    }
  });
});

describe('StatusLineCommandRunner', () => {
  it('caches the last good line and coalesces refreshes in the same interval', async () => {
    const spawn = vi.mocked(childProcess.spawn).mockClear();
    const onUpdate = vi.fn();
    const runner = new StatusLineCommandRunner('echo x', onUpdate);

    try {
      expect(runner.current()).toBeNull();
      runner.maybeRefresh(payload);
      runner.maybeRefresh(payload);
      expect(spawn).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
      expect(runner.current()).toBe('x');
      expect(runner.current()).toBe('x');
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      runner.dispose();
      spawn.mockRestore();
    }
  });

  // POSIX shell 专属行为：这一例靠 `#!/bin/sh` 脚本自增计数器来观察节流补跑，
  // Windows 没有 sh，改写会换掉被测的观察手段而不是修环境差异。
  it.skipIf(process.platform === 'win32')('runs a deferred refresh after the throttle interval instead of dropping it', async () => {
    const dir = join(tmpdir(), `sl-trailing-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      const counterFile = join(dir, 'count');
      const scriptFile = join(dir, 'count.sh');
      writeFileSync(counterFile, '0');
      writeFileSync(
        scriptFile,
        '#!/bin/sh\nn=$(cat "$1")\necho $((n+1)) > "$1"\nprintf "run-%s" "$n"\n',
      );
      const runner = new StatusLineCommandRunner(`sh "${scriptFile}" "${counterFile}"`, () => {});
      try {
        runner.maybeRefresh(payload);
        await vi.waitFor(() => expect(runner.current()).toBe('run-0'));
        runner.maybeRefresh(payload); // throttled: must defer, not drop
        expect(readFileSync(counterFile, 'utf-8').trim()).toBe('1');

        await vi.waitFor(() => expect(runner.current()).toBe('run-1'), { timeout: 2_000 });
        expect(readFileSync(counterFile, 'utf-8').trim()).toBe('2');
      } finally {
        runner.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('recreates the runner when the command changes', async () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: null, command: 'echo aaa' },
    };
    const onRefresh = vi.fn();
    const footer = new FooterComponent(state, onRefresh);
    try {
      footer.render(120);
      await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
      expect(plain(footer.render(120)[0]!)).toContain('aaa');

      footer.setState({
        ...state,
        statusLine: { items: null, command: 'echo bbb' },
      });
      const pending = plain(footer.render(120)[0]!);
      expect(pending).toContain('kimi-k2');
      expect(pending).not.toContain('aaa');
      await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));

      const line1 = plain(footer.render(120)[0]!);
      expect(line1).toContain('bbb');
      expect(line1).not.toContain('aaa');
    } finally {
      footer.setState(baseState);
      footer.dispose();
    }
  });
});
