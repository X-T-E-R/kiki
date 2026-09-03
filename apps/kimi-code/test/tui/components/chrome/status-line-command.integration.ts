import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import {
  runStatusLineCommand,
  STATUS_LINE_MAX_CAPTURE_BYTES,
  StatusLineCommandRunner,
  type StatusLinePayload,
} from '#/tui/utils/status-line-command';
import type { AppState } from '#/tui/types';

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
    );

    expect(line).not.toBeNull();
    const parsed = JSON.parse(line!);
    expect(parsed.model).toBe('kimi-k2');
    expect(parsed.gitBranch).toBe('main');
    expect(parsed.cwd).toBe('/tmp/project');
  });

  it('returns null on a nonzero exit', async () => {
    expect(await runStatusLineCommand(nodeCommand(`process.exit(3)`), payload)).toBeNull();
  });

  it('returns null on empty output', async () => {
    expect(await runStatusLineCommand(nodeCommand(`0`), payload)).toBeNull();
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
    );

    expect(line).toBe('first');
  });

  it('caps the captured output instead of accumulating an unending stream', async () => {
    // 200 KB on a single line, then exit: only the capped prefix is kept.
    const line = await runStatusLineCommand(
      nodeCommand(`process.stdout.write('a'.repeat(200000))`),
      payload,
    );

    expect(line).not.toBeNull();
    expect(line!.length).toBeLessThanOrEqual(STATUS_LINE_MAX_CAPTURE_BYTES);
  });
});

describe('FooterComponent status_line command', () => {
  it('swaps line 1 to the command output once it lands', async () => {
    const state: AppState = {
      ...baseState,
      statusLine: {
        items: null,
        command: nodeCommand(`process.stdout.write('my-custom-status')`),
      },
    };
    const footer = new FooterComponent(state);

    // Before the first run completes the built-in layout is still shown.
    expect(plain(footer.render(120)[0]!)).toContain('kimi-k2');

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(plain(footer.render(120)[0]!)).toContain('my-custom-status');
  });

  it('keeps the built-in layout when the command fails', async () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: null, command: nodeCommand(`process.exit(1)`) },
    };
    const footer = new FooterComponent(state);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(plain(footer.render(120)[0]!)).toContain('kimi-k2');
  });
});

describe('StatusLineCommandRunner', () => {
  it('caches the last good line and coalesces refreshes in the same interval', async () => {
    const runner = new StatusLineCommandRunner(
      nodeCommand(`process.stdout.write('x')`),
      () => {},
    );

    runner.maybeRefresh(payload);
    runner.maybeRefresh(payload);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(runner.current()).toBe('x');
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
      const runner = new StatusLineCommandRunner(`sh ${scriptFile} ${counterFile}`, () => {});

      runner.maybeRefresh(payload);
      await new Promise((resolve) => setTimeout(resolve, 250));
      runner.maybeRefresh(payload); // throttled: must defer, not drop
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(readFileSync(counterFile, 'utf-8').trim()).toBe('1');

      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(readFileSync(counterFile, 'utf-8').trim()).toBe('2');
      runner.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('recreates the runner when the command changes', async () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: null, command: nodeCommand(`process.stdout.write('aaa')`) },
    };
    const footer = new FooterComponent(state);
    footer.render(120); // kicks the first run
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(plain(footer.render(120)[0]!)).toContain('aaa');

    footer.setState({
      ...state,
      statusLine: { items: null, command: nodeCommand(`process.stdout.write('bbb')`) },
    });
    footer.render(120); // kicks the replacement run
    await new Promise((resolve) => setTimeout(resolve, 450));

    const line1 = plain(footer.render(120)[0]!);
    expect(line1).toContain('bbb');
    expect(line1).not.toContain('aaa');
  });
});
