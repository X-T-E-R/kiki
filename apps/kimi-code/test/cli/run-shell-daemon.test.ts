import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  trust: vi.fn(),
  discover: vi.fn(),
  ensure: vi.fn(),
  tuiConstructor: vi.fn(),
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
  ensureDaemon: (...args: unknown[]) => mocks.ensure(...args),
}));

vi.mock('../../src/tui/daemon/daemon-tui', () => ({
  DaemonTUI: class DaemonTUI {
    onExit?: (exitCode?: number) => Promise<void>;
    readonly exitOpenUrl = undefined;
    readonly exitForegroundTask = undefined;

    constructor(...args: unknown[]) {
      mocks.order.push('construct');
      mocks.tuiConstructor(...args);
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
  resolveAgentProfileSelection: vi.fn(async () => undefined),
}));

vi.mock('../../src/utils/process/resolve-command', () => ({
  resolveCommandPath: vi.fn(() => 'C:\\bin\\kimi.exe'),
}));

vi.mock('../../src/utils/startup-trace', () => ({ startupTrace: vi.fn() }));
vi.mock('../../src/utils/terminal-hyperlink', () => ({ toTerminalHyperlink: vi.fn() }));
vi.mock('../../src/utils/terminal-restore', () => ({ restoreTerminalModes: vi.fn() }));

import { runShell } from '#/cli/run-shell';

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

describe('runShell daemon trust gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.trust.mockResolvedValue(true);
    mocks.discover.mockResolvedValue({ url: 'http://127.0.0.1:57580', token: 'token' });
    mocks.tuiStart.mockResolvedValue(undefined);
  });

  it('completes workspace trust before daemon discovery and startup', async () => {
    await runShell(options, '1.0.0');

    expect(mocks.order).toEqual(['trust', 'discover', 'construct', 'start']);
    expect(mocks.trust).toHaveBeenCalledWith({ homeDir: 'C:\\home', workDir: process.cwd() });
  });

  it('does not discover or start a daemon when trust is declined', async () => {
    mocks.trust.mockResolvedValue(false);

    await runShell(options, '1.0.0');

    expect(mocks.order).toEqual(['trust']);
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.tuiConstructor).not.toHaveBeenCalled();
  });
});
