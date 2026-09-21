import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isTerminalOutputError, runShell } from '#/cli/run-shell';

const uncaughtExceptionListeners = new Set(process.listeners('uncaughtException'));
const unhandledRejectionListeners = new Set(process.listeners('unhandledRejection'));
const sigtermListeners = new Set(process.listeners('SIGTERM'));
const sighupListeners = new Set(process.listeners('SIGHUP'));
const stdoutErrorListeners = new Set(
  process.stdout.listeners('error') as Array<(error: Error) => void>,
);
const stderrErrorListeners = new Set(
  process.stderr.listeners('error') as Array<(error: Error) => void>,
);

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  trust: vi.fn(),
  discover: vi.fn(),
  ensure: vi.fn(),
  harnessEnsureConfigFile: vi.fn(),
  harnessGetConfig: vi.fn(),
  harnessClose: vi.fn(),
  daemonConstructor: vi.fn(),
  legacyConstructor: vi.fn(),
  tuiStart: vi.fn(),
  tuiClose: vi.fn(),
  tuiStop: vi.fn(),
  restoreTerminalModes: vi.fn(),
}));

vi.mock('@kiki/node-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kiki/node-sdk')>();
  return {
    ...actual,
    createKimiHarness: vi.fn(() => ({
      ensureConfigFile: mocks.harnessEnsureConfigFile,
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
    stop = mocks.tuiStop;
    getCurrentSessionId = () => '';
    hasSessionContent = () => false;
  },
}));

vi.mock('../../src/tui/index', () => ({
  KimiTUI: class KimiTUI {
    onExit?: (exitCode?: number) => Promise<void>;

    constructor(...args: unknown[]) {
      mocks.order.push('legacy');
      mocks.legacyConstructor(...args);
    }

    start = async () => {
      mocks.order.push('start');
      await mocks.tuiStart();
    };

    stop = mocks.tuiStop;
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
vi.mock('../../src/utils/terminal-restore', () => ({
  restoreTerminalModes: mocks.restoreTerminalModes,
}));

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
    mocks.harnessGetConfig.mockResolvedValue({ providers: {}, defaultModel: 'k2' });
    mocks.harnessClose.mockResolvedValue(undefined);
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.tuiClose.mockResolvedValue(undefined);
    mocks.tuiStop.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const listener of process.listeners('uncaughtException')) {
      if (!uncaughtExceptionListeners.has(listener)) process.off('uncaughtException', listener);
    }
    for (const listener of process.listeners('unhandledRejection')) {
      if (!unhandledRejectionListeners.has(listener)) process.off('unhandledRejection', listener);
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!sigtermListeners.has(listener)) process.off('SIGTERM', listener);
    }
    for (const listener of process.listeners('SIGHUP')) {
      if (!sighupListeners.has(listener)) process.off('SIGHUP', listener);
    }
    for (const listener of process.stdout.listeners('error') as Array<(error: Error) => void>) {
      if (!stdoutErrorListeners.has(listener)) process.stdout.off('error', listener);
    }
    for (const listener of process.stderr.listeners('error') as Array<(error: Error) => void>) {
      if (!stderrErrorListeners.has(listener)) process.stderr.off('error', listener);
    }
    vi.unstubAllEnvs();
  });

  it('classifies EIO and EPIPE as terminal output shutdown errors', () => {
    expect(isTerminalOutputError(Object.assign(new Error('closed'), { code: 'EIO' }))).toBe(true);
    expect(isTerminalOutputError(Object.assign(new Error('pipe'), { code: 'EPIPE' }))).toBe(true);
    expect(isTerminalOutputError(Object.assign(new Error('other'), { code: 'EINVAL' }))).toBe(false);
  });

  it('attaches the interactive shell to DaemonTUI by default', async () => {
    await runShell(options, '1.0.0');

    expect(mocks.order).toEqual(['trust', 'agent', 'discover', 'daemon', 'start']);
    expect(mocks.daemonConstructor.mock.calls[0]?.[1]).toMatchObject({
      cliOptions: options,
      workDir: process.cwd(),
    });
  });

  it('cannot bypass the daemon or workspace trust through experimental overrides', async () => {
    vi.stubEnv('KIKI_EXPERIMENTAL_FLAG', '0');
    await runShell(options, '1.0.0');
    expect(mocks.order).toEqual(['trust', 'agent', 'discover', 'daemon', 'start']);
    expect(mocks.legacyConstructor).not.toHaveBeenCalled();
    expect(mocks.harnessEnsureConfigFile).not.toHaveBeenCalled();
    expect(mocks.harnessGetConfig).not.toHaveBeenCalled();
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

  it('preserves the startup error when close also fails and restores terminal modes', async () => {
    mocks.tuiStart.mockRejectedValue(new Error('startup failed'));
    mocks.tuiClose.mockRejectedValue(new Error('close failed'));

    await expect(runShell(options, '1.0.0')).rejects.toThrow('startup failed');

    expect(mocks.tuiClose).toHaveBeenCalledOnce();
    expect(mocks.restoreTerminalModes).toHaveBeenCalledOnce();
  });

  it('uses hangup semantics for terminal output errors even when close fails', async () => {
    const prior = new Set(process.stdout.listeners('error'));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    mocks.tuiClose.mockRejectedValue(new Error('close failed'));
    await runShell(options, '1.0.0');
    const listener = process.stdout.listeners('error').find(
      (candidate) => !prior.has(candidate),
    ) as ((error: Error) => void) | undefined;
    expect(listener).toBeDefined();

    listener!(Object.assign(new Error('closed'), { code: 'EPIPE' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.tuiClose).toHaveBeenCalledOnce();
    expect(mocks.restoreTerminalModes).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(129);
    process.stdout.off('error', listener!);
    exit.mockRestore();
  });

  it('routes SIGTERM and POSIX SIGHUP through TUI stop', async () => {
    const priorTerm = new Set(process.listeners('SIGTERM'));
    const priorHup = new Set(process.listeners('SIGHUP'));
    await runShell(options, '1.0.0');
    const term = process.listeners('SIGTERM').find((listener) => !priorTerm.has(listener));
    expect(term).toBeDefined();
    term!('SIGTERM');
    await Promise.resolve();
    expect(mocks.tuiStop).toHaveBeenCalledWith(143);
    process.off('SIGTERM', term!);
    if (process.platform !== 'win32') {
      const hup = process.listeners('SIGHUP').find((listener) => !priorHup.has(listener));
      expect(hup).toBeDefined();
      process.off('SIGHUP', hup!);
    }
  });

  it.skipIf(process.platform === 'win32')('uses the POSIX SIGHUP exit code', async () => {
    const priorTerm = new Set(process.listeners('SIGTERM'));
    const priorHup = new Set(process.listeners('SIGHUP'));
    await runShell(options, '1.0.0');
    const term = process.listeners('SIGTERM').find((listener) => !priorTerm.has(listener));
    const hup = process.listeners('SIGHUP').find((listener) => !priorHup.has(listener));
    expect(hup).toBeDefined();
    hup!('SIGHUP');
    await Promise.resolve();
    expect(mocks.tuiStop).toHaveBeenCalledWith(129);
    if (term !== undefined) process.off('SIGTERM', term);
    process.off('SIGHUP', hup!);
  });
});
