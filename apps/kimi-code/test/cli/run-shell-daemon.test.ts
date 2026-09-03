import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isTuiDaemonEnabled, runShell } from '#/cli/run-shell';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  harnessClose: vi.fn(),
  harnessGetConfig: vi.fn(),
  trust: vi.fn(),
  discover: vi.fn(),
  ensure: vi.fn(),
  legacyConstructor: vi.fn(),
  daemonConstructor: vi.fn(),
  tuiStart: vi.fn(),
  tuiClose: vi.fn(),
}));

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    createKimiHarness: vi.fn(() => ({
      ensureConfigFile: vi.fn(),
      getConfig: mocks.harnessGetConfig,
      close: mocks.harnessClose,
    })),
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

vi.mock('../../src/tui/index', () => ({
  KimiTUI: class KimiTUI {
    onExit?: (exitCode?: number) => Promise<void>;
    readonly exitOpenUrl = undefined;
    readonly exitForegroundTask = undefined;

    constructor(...args: unknown[]) {
      mocks.order.push('legacy');
      mocks.legacyConstructor(...args);
    }

    start = async () => {
      mocks.order.push('start');
      await mocks.tuiStart();
    };

    getCurrentSessionId = () => '';
    hasSessionContent = () => false;
  },
}));

vi.mock('../../src/tui/daemon/daemon-tui', () => ({
  DaemonTUI: class DaemonTUI {
    onExit?: (exitCode?: number) => Promise<void>;
    readonly exitOpenUrl = undefined;
    readonly exitForegroundTask = undefined;

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
vi.mock('../../src/utils/terminal-hyperlink', () => ({ toTerminalHyperlink: vi.fn() }));
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

describe('runShell daemon experiment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.harnessGetConfig.mockResolvedValue({ providers: {} });
    mocks.harnessClose.mockImplementation(async () => {
      mocks.order.push('harness-close');
    });
    mocks.trust.mockResolvedValue(true);
    mocks.discover.mockResolvedValue({ url: 'http://127.0.0.1:57580', token: 'token' });
    mocks.ensure.mockResolvedValue({ url: 'http://127.0.0.1:57580', token: 'token' });
    mocks.tuiStart.mockResolvedValue(undefined);
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TUI_DAEMON', '0');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the legacy KimiTUI as the default path', async () => {
    await runShell(options, '1.0.0');

    expect(mocks.order).toEqual(['agent', 'legacy', 'start']);
    expect(mocks.legacyConstructor).toHaveBeenCalledOnce();
    expect(mocks.daemonConstructor).not.toHaveBeenCalled();
    expect(mocks.trust).not.toHaveBeenCalled();
  });

  it('gates daemon startup behind the per-feature flag and trust check', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TUI_DAEMON', '1');

    await runShell(options, '1.0.0');

    expect(mocks.order).toEqual([
      'harness-close',
      'trust',
      'agent',
      'discover',
      'daemon',
      'start',
    ]);
    expect(mocks.trust).toHaveBeenCalledWith({ homeDir: 'C:\\home', workDir: process.cwd() });
    expect(mocks.daemonConstructor.mock.calls[0]?.[1]).toMatchObject({
      startupNotice: expect.stringContaining('KIMI_CODE_EXPERIMENTAL_TUI_DAEMON'),
    });
  });

  it('uses the shared-home ensure entry when no daemon is already reachable', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TUI_DAEMON', '1');
    mocks.discover.mockResolvedValue(null);

    await runShell(options, '1.0.0');

    expect(mocks.ensure).toHaveBeenCalledWith({
      homeDir: 'C:\\home',
      workspacePath: process.cwd(),
    });
    expect(mocks.order).toContain('ensure');
  });

  it('does not discover or start a daemon when trust is declined', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TUI_DAEMON', '1');
    mocks.trust.mockResolvedValue(false);

    await runShell(options, '1.0.0');

    expect(mocks.order).toEqual(['harness-close', 'trust']);
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.daemonConstructor).not.toHaveBeenCalled();
  });

  it('matches experimental precedence: flag env, config, master env, default', () => {
    expect(isTuiDaemonEnabled(undefined, {})).toBe(false);
    expect(isTuiDaemonEnabled(undefined, { KIMI_CODE_EXPERIMENTAL_FLAG: '1' })).toBe(true);
    expect(
      isTuiDaemonEnabled(
        { tui_daemon: false },
        { KIMI_CODE_EXPERIMENTAL_FLAG: '1' },
      ),
    ).toBe(false);
    expect(
      isTuiDaemonEnabled(
        { tui_daemon: true },
        { KIMI_CODE_EXPERIMENTAL_TUI_DAEMON: '0', KIMI_CODE_EXPERIMENTAL_FLAG: '1' },
      ),
    ).toBe(false);
  });
});
