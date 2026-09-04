import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runShell } from '#/cli/run-shell';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  trust: vi.fn(),
  discover: vi.fn(),
  ensure: vi.fn(),
  daemonConstructor: vi.fn(),
  tuiStart: vi.fn(),
  tuiClose: vi.fn(),
}));

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    flushDiagnosticLogsSync: vi.fn(),
    log: { info: vi.fn(), error: vi.fn() },
  };
});

vi.mock('../../src/tui/config', () => ({
  TuiConfigParseError: class TuiConfigParseError extends Error {},
  loadTuiConfig: vi.fn(async () => ({
    theme: 'dark',
    editorCommand: null,
    disablePasteBurst: false,
    renderLatex: true,
    cacheExpiryHint: true,
    notifications: { enabled: true, condition: 'unfocused' },
  })),
}));

vi.mock('../../src/tui/theme', () => ({
  currentTheme: { setPalette: vi.fn() },
  getColorPalette: vi.fn(async () => ({})),
}));

vi.mock('../../src/tui/daemon/workspace-trust', () => ({
  runWorkspaceTrustGate: (...args: unknown[]) => {
    mocks.order.push('trust');
    return mocks.trust(...args);
  },
}));

vi.mock('../../src/tui/daemon/discovery', () => ({
  resolveDaemonHome: vi.fn(() => 'C:\\home'),
  discoverDaemon: (...args: unknown[]) => {
    mocks.order.push('discover');
    return mocks.discover(...args);
  },
  ensureDaemon: (...args: unknown[]) => {
    mocks.order.push('ensure');
    return mocks.ensure(...args);
  },
}));

vi.mock('../../src/tui/daemon/daemon-tui', () => ({
  DaemonTUI: class DaemonTUI {
    onExit?: (exitCode?: number) => Promise<void>;

    constructor(...args: unknown[]) {
      mocks.order.push('daemon');
      mocks.daemonConstructor(...args);
    }

    start = async () => {
      mocks.order.push('start');
      await mocks.tuiStart();
    };

    close = mocks.tuiClose;
    getCurrentSessionId = () => '';
    hasSessionContent = () => false;
  },
}));

vi.mock('../../src/cli/agent-selection', () => ({
  resolveAgentProfileSelection: vi.fn(async () => {
    mocks.order.push('agent');
    return undefined;
  }),
}));

vi.mock('../../src/utils/process/resolve-command', () => ({
  resolveCommandPath: vi.fn(() => undefined),
}));

vi.mock('../../src/utils/startup-trace', () => ({ startupTrace: vi.fn() }));
vi.mock('../../src/utils/terminal-restore', () => ({ restoreTerminalModes: vi.fn() }));

const options = {
  session: undefined,
  continue: false,
  yolo: false,
  auto: false,
  plan: false,
  model: undefined,
  thinking: undefined,
  outputFormat: undefined,
  prompt: undefined,
  skillsDirs: [],
  agent: undefined,
  agentFiles: [],
  addDirs: [],
};

describe('runShell daemon startup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.trust.mockResolvedValue(true);
    mocks.discover.mockResolvedValue({ url: 'http://127.0.0.1:57580', token: 'token' });
    mocks.ensure.mockResolvedValue({ url: 'http://127.0.0.1:57580', token: 'token' });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.tuiClose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('always attaches the interactive shell to DaemonTUI', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TUI_DAEMON', '0');

    await runShell(options, '1.0.0');

    expect(mocks.order).toEqual(['trust', 'agent', 'discover', 'daemon', 'start']);
    expect(mocks.daemonConstructor.mock.calls[0]?.[1]).toMatchObject({
      cliOptions: options,
      workDir: process.cwd(),
    });
  });

  it('passes plan mode through to the daemon TUI', async () => {
    await runShell({ ...options, plan: true }, '1.0.0');

    expect(mocks.daemonConstructor.mock.calls[0]?.[1]).toMatchObject({
      cliOptions: { plan: true },
    });
  });

  it('spawns the shared daemon when discovery misses', async () => {
    mocks.discover.mockResolvedValue(null);

    await runShell(options, '1.0.0');

    expect(mocks.ensure).toHaveBeenCalledWith({
      homeDir: 'C:\\home',
      workspacePath: process.cwd(),
    });
    expect(mocks.order).toEqual(['trust', 'agent', 'discover', 'ensure', 'daemon', 'start']);
  });

  it('does not discover or start a daemon when trust is declined', async () => {
    mocks.trust.mockResolvedValue(false);

    await runShell(options, '1.0.0');

    expect(mocks.order).toEqual(['trust']);
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.daemonConstructor).not.toHaveBeenCalled();
  });

  it('closes the daemon client when TUI startup fails', async () => {
    mocks.tuiStart.mockRejectedValue(new Error('startup failed'));

    await expect(runShell(options, '1.0.0')).rejects.toThrow('startup failed');

    expect(mocks.tuiClose).toHaveBeenCalledOnce();
  });
});
