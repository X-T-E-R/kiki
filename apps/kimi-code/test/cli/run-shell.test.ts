import { execFileSync } from 'node:child_process';

import type { createKimiDeviceId as createKimiDeviceIdFn } from '@moonshot-ai/kimi-code-oauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runShell } from '#/cli/run-shell';
import { refreshKimiRegion } from '#/utils/region';

import { captureProcessWrite, ExitCalled, mockProcessExit } from '../helpers/process';

type CreateKimiDeviceId = typeof createKimiDeviceIdFn;

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

const mocks = vi.hoisted(() => {
  type TuiConfigFallback = {
    theme: 'dark' | 'light' | 'auto';
    editorCommand: string | null;
    notifications: { enabled: boolean; condition: 'unfocused' | 'always' };
  };

  class TuiConfigParseError extends Error {
    readonly fallback: TuiConfigFallback;

    constructor(fallback: TuiConfigFallback) {
      super('Invalid TUI config in ~/.kimi-code/tui.toml; using defaults.');
      this.fallback = fallback;
    }
  }

  return {
    loadTuiConfig: vi.fn(),
    detectTerminalTheme: vi.fn(),
    kimiHarnessConstructor: vi.fn(),
    harnessEnsureConfigFile: vi.fn(),
    harnessGetConfig: vi.fn(async () => ({
      providers: {},
      defaultModel: 'k2',
    })),
    harnessGetConfigDiagnostics: vi.fn(async () => ({ warnings: [] as readonly string[] })),
    harnessGetCachedAccessToken: vi.fn(),
    harnessClose: vi.fn(),
    harnessTrack: vi.fn(),
    kimiTuiConstructor: vi.fn(),
    tuiStart: vi.fn(),
    tuiGetStartupMcpMs: vi.fn(async () => 0),
    tuiGetCurrentSessionId: vi.fn(() => ''),
    tuiHasSessionContent: vi.fn(() => false),
    createKimiDeviceId: vi.fn<CreateKimiDeviceId>(() => 'device-1'),
    resolveKimiHome: vi.fn((homeDir?: string) => homeDir ?? '/tmp/kimi-code-test-home'),
    flushDiagnosticLogsSync: vi.fn(),
    harnessCreatesDeviceIdOnConstruction: false,
    execFileSync: vi.fn(() => ''),
    spawnSync: vi.fn(),
    resolveCommandPath: vi.fn(() => '/bin/stty' as string | undefined),
    TuiConfigParseError,
  };
});

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  const makeHarnessStub = (args: unknown[]) => {
    const options = args[0] as { readonly homeDir?: string } | undefined;
    const homeDir = options?.homeDir ?? '/tmp/kimi-code-test-home';
    return {
      homeDir,
      auth: {
        getCachedAccessToken: mocks.harnessGetCachedAccessToken,
      },
      ensureConfigFile: mocks.harnessEnsureConfigFile,
      getConfig: mocks.harnessGetConfig,
      getConfigDiagnostics: mocks.harnessGetConfigDiagnostics,
      close: mocks.harnessClose,
      track: mocks.harnessTrack,
    };
  };
  return {
    ...actual,
    resolveKimiHome: mocks.resolveKimiHome,
    flushDiagnosticLogsSync: mocks.flushDiagnosticLogsSync,
    createKimiHarness: (...args: unknown[]) => {
      const options = args[0] as { readonly homeDir?: string } | undefined;
      const homeDir = options?.homeDir ?? '/tmp/kimi-code-test-home';
      if (mocks.harnessCreatesDeviceIdOnConstruction) {
        mocks.createKimiDeviceId(homeDir);
      }
      mocks.kimiHarnessConstructor(...args);
      return makeHarnessStub(args);
    },
  };
});

vi.mock('@moonshot-ai/kimi-code-oauth', async () => {
  const actual = await vi.importActual<typeof import('@moonshot-ai/kimi-code-oauth')>(
    '@moonshot-ai/kimi-code-oauth',
  );
  return {
    ...actual,
    createKimiDeviceId: mocks.createKimiDeviceId,
    KIMI_CODE_PROVIDER_NAME: 'kimi-code',
  };
});

vi.mock('../../src/tui/config', () => ({
  loadTuiConfig: mocks.loadTuiConfig,
  TuiConfigParseError: mocks.TuiConfigParseError,
}));

vi.mock('../../src/tui/index', () => ({
  KimiTUI: class {
    onExit?: () => Promise<void>;

    readonly state = { ui: { mode: 'regular' as const } };

    constructor(...args: unknown[]) {
      mocks.kimiTuiConstructor(this, ...args);
    }

    start = mocks.tuiStart;
    getStartupMcpMs = mocks.tuiGetStartupMcpMs;
    getCurrentSessionId = mocks.tuiGetCurrentSessionId;
    hasSessionContent = mocks.tuiHasSessionContent;
  },
}));

vi.mock('../../src/tui/theme/detect', () => ({
  detectTerminalTheme: mocks.detectTerminalTheme,
}));

vi.mock('node:child_process', () => ({
  execFileSync: mocks.execFileSync,
  spawnSync: mocks.spawnSync,
}));

vi.mock('../../src/utils/process/resolve-command', () => ({
  resolveCommandPath: mocks.resolveCommandPath,
}));

describe('runShell', () => {
  beforeEach(() => {
    // Pin region to cn: the telemetry endpoint assertion below must not
    // follow the dev machine's own login/marker state.
    vi.stubEnv('KIMI_CODE_OAUTH_HOST', 'https://auth.kimi.com');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TUI_DAEMON', '0');
    refreshKimiRegion();
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
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    refreshKimiRegion();
    mocks.harnessGetConfig.mockResolvedValue({
      providers: {},
      defaultModel: 'k2',
    });
    mocks.tuiGetStartupMcpMs.mockResolvedValue(0);
    mocks.tuiGetCurrentSessionId.mockReturnValue('');
    mocks.tuiHasSessionContent.mockReturnValue(false);
    mocks.createKimiDeviceId.mockImplementation(() => 'device-1');
    mocks.resolveKimiHome.mockImplementation(
      (homeDir?: string) => homeDir ?? '/tmp/kimi-code-test-home',
    );
    mocks.resolveCommandPath.mockImplementation(() => '/bin/stty');
    mocks.harnessCreatesDeviceIdOnConstruction = false;
  });

  const minimalCliOptions = {
    session: undefined,
    continue: false,
    yolo: false,
    auto: false,
    plan: false,
    model: undefined,
    outputFormat: undefined,
    prompt: undefined,
    skillsDirs: [],
    agent: undefined,
    agentFiles: [],
  };

  function stubTuiStartup(): void {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
  }

  function withEnv(patch: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.keys(patch)) {
      saved[key] = process.env[key];
      const value = patch[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return fn().finally(() => {
      for (const key of Object.keys(patch)) {
        const value = saved[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
  }

  it('builds the SDK harness regardless of the experimental master switch', async () => {
    stubTuiStartup();
    await withEnv({ KIMI_CODE_EXPERIMENTAL_FLAG: undefined }, async () => {
      await runShell(minimalCliOptions, '1.2.3-test');
    });
    expect(mocks.kimiHarnessConstructor).toHaveBeenCalledTimes(1);
  });

  it('constructs KimiHarness and KimiTUI with startup input', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.tuiGetStartupMcpMs.mockResolvedValue(47);
    mocks.tuiGetCurrentSessionId.mockReturnValue('ses-startup');

    const cliOptions = {
      session: undefined,
      continue: false,
      yolo: true,
      auto: false,
      plan: true,
      model: undefined,
      outputFormat: undefined,
      prompt: undefined,
      skillsDirs: [],
      agent: undefined,
      agentFiles: [],
      addDirs: ['../shared', '/tmp/extra'],
    };

    await runShell(cliOptions, '1.2.3-test');

    expect(mocks.kimiHarnessConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          productName: 'kimi-code-cli',
          version: '1.2.3-test',
        }),
      }),
    );
    expect(mocks.harnessEnsureConfigFile).toHaveBeenCalledOnce();
    expect(mocks.harnessEnsureConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.harnessGetConfig.mock.invocationCallOrder[0]!,
    );
    // stty is resolved to an absolute path before the trust gate and skipped
    // entirely on Windows (a bare `stty` name would resolve into the
    // untrusted cwd).
    if (process.platform !== 'win32') {
      expect(execFileSync).toHaveBeenCalledWith('/bin/stty', ['-ixon'], {
        stdio: ['inherit', 'ignore', 'ignore'],
      });
    } else {
      expect(execFileSync).not.toHaveBeenCalled();
    }
    expect(mocks.kimiTuiConstructor).toHaveBeenCalledTimes(1);

    const [, harness, startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(harness).toBeTypeOf('object');
    expect(startupInput).toMatchObject({
      cliOptions,
      additionalDirs: ['../shared', '/tmp/extra'],
      tuiConfig: {
        theme: 'dark',
        editorCommand: null,
        notifications: { enabled: true, condition: 'unfocused' },
      },
      version: '1.2.3-test',
      workDir: process.cwd(),
    });
    expect(mocks.tuiStart).toHaveBeenCalledOnce();
  });

  it('never runs stty on Windows, where it would resolve into the untrusted cwd', async () => {
    stubTuiStartup();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await runShell(minimalCliOptions, '1.2.3-test');
      expect(execFileSync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('skips stty when it cannot be resolved outside the untrusted cwd', async () => {
    stubTuiStartup();
    if (process.platform === 'win32') return;
    mocks.resolveCommandPath.mockReturnValue(undefined);
    await runShell(minimalCliOptions, '1.2.3-test');
    expect(mocks.resolveCommandPath).toHaveBeenCalledWith('stty');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('resolves the --agent profile into the TUI startup input', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
        agent: 'reviewer',
        agentFiles: [],
      },
      '1.2.3-test',
    );

    const [, , startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(startupInput).toMatchObject({ agentProfile: 'reviewer' });
  });

  it('forwards skillsDirs from CLI options to the harness', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: undefined,
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: ['/skills'],
        agent: undefined,
        agentFiles: [],
      },
      '1.2.3-test',
    );

    expect(mocks.kimiHarnessConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ skillDirs: ['/skills'] }),
    );
  });

  it('detects auto theme and forwards config parse warnings as startup notice', async () => {
    mocks.loadTuiConfig.mockRejectedValue(
      new mocks.TuiConfigParseError({
        theme: 'auto',
        editorCommand: 'vim',
        notifications: { enabled: true, condition: 'always' },
      }),
    );
    mocks.detectTerminalTheme.mockResolvedValue('light');
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: '',
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
        agent: undefined,
        agentFiles: [],
      },
      '1.2.3-test',
    );

    expect(mocks.detectTerminalTheme).toHaveBeenCalledOnce();
    const [, , startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(startupInput).toMatchObject({
      startupNotice: 'Invalid TUI config in ~/.kimi-code/tui.toml; using defaults.',
      tuiConfig: {
        theme: 'auto',
        editorCommand: 'vim',
        notifications: { enabled: true, condition: 'always' },
      },
    });
  });

  it('leaves config.toml diagnostics to the TUI instead of the startup notice', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.harnessGetConfigDiagnostics.mockResolvedValue({
      warnings: ['Ignored invalid config in config.toml: loop_control.'],
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    await runShell(
      {
        session: '',
        continue: false,
        yolo: false,
        auto: false,
        plan: false,
        model: undefined,
        outputFormat: undefined,
        prompt: undefined,
        skillsDirs: [],
        agent: undefined,
        agentFiles: [],
      },
      '1.2.3-test',
    );

    // Diagnostics render in warning yellow via `showConfigWarningsIfAny` at
    // `finishStartup`; the (dim) startup notice stays reserved for things like
    // tui.toml parse errors, so the same warning is not shown twice.
    const [, , startupInput] = mocks.kimiTuiConstructor.mock.calls[0]!;
    expect(startupInput).toMatchObject({
      startupNotice: undefined,
    });
  });

  it('flushes diagnostic logs synchronously before exiting on a runtime crash', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    const processOnSpy = vi.spyOn(process, 'on');
    const stdout = captureProcessWrite('stdout');
    const exitSpy = mockProcessExit();

    try {
      await runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
      );

      const handler = processOnSpy.mock.calls.find(
        ([event]) => event === 'uncaughtException',
      )?.[1] as ((error: unknown) => void) | undefined;
      expect(handler).toBeDefined();

      // The async log sink cannot flush before process.exit() runs, so the
      // crash handler must force a synchronous flush or the crash reason is
      // lost (regression: uncaughtException logs never reached disk).
      expect(() => handler?.(new Error('boom'))).toThrow(ExitCalled);
      expect(mocks.flushDiagnosticLogsSync).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mocks.flushDiagnosticLogsSync.mock.invocationCallOrder[0]!).toBeLessThan(
        exitSpy.mock.invocationCallOrder[0]!,
      );
    } finally {
      processOnSpy.mockRestore();
      exitSpy.mockRestore();
      stdout.restore();
    }
  });

  it('flushes diagnostic logs synchronously before exiting on an unhandled rejection', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);

    const processOnSpy = vi.spyOn(process, 'on');
    const stdout = captureProcessWrite('stdout');
    const exitSpy = mockProcessExit();

    try {
      await runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
      );

      const handler = processOnSpy.mock.calls.find(
        ([event]) => event === 'unhandledRejection',
      )?.[1] as ((reason: unknown) => void) | undefined;
      expect(handler).toBeDefined();

      expect(() => handler?.(new Error('boom'))).toThrow(ExitCalled);
      expect(mocks.flushDiagnosticLogsSync).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mocks.flushDiagnosticLogsSync.mock.invocationCallOrder[0]!).toBeLessThan(
        exitSpy.mock.invocationCallOrder[0]!,
      );
    } finally {
      processOnSpy.mockRestore();
      exitSpy.mockRestore();
      stdout.restore();
    }
  });

  it('closes the harness when TUI startup fails', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockRejectedValue(new Error('boom'));

    await expect(
      runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
      ),
    ).rejects.toThrow('boom');

    expect(mocks.harnessClose).toHaveBeenCalledOnce();
  });

  it('prints resume instructions from the TUI exit handler', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.tuiGetCurrentSessionId.mockReturnValue('ses-1');
    mocks.tuiHasSessionContent.mockReturnValue(true);

    const stdout = captureProcessWrite('stdout');
    const stderr = captureProcessWrite('stderr');
    const exitSpy = mockProcessExit();

    try {
      await runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
      );
      const [tui] = mocks.kimiTuiConstructor.mock.calls[0]!;

      await expect((tui as { onExit: () => Promise<void> }).onExit()).rejects.toBeInstanceOf(
        ExitCalled,
      );

      expect(stdout.text()).toContain(' Bye!\n');
      expect(stderr.text()).toContain(' To resume this session: kimi -r ses-1');
    } finally {
      exitSpy.mockRestore();
      stdout.restore();
      stderr.restore();
    }
  });

  it('prints the opened web URL from the TUI exit handler when set', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.tuiStart.mockResolvedValue(undefined);
    mocks.tuiGetCurrentSessionId.mockReturnValue('ses-1');
    mocks.tuiHasSessionContent.mockReturnValue(true);

    const stdout = captureProcessWrite('stdout');
    const stderr = captureProcessWrite('stderr');
    const exitSpy = mockProcessExit();

    try {
      await runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
      );
      const [tui] = mocks.kimiTuiConstructor.mock.calls[0]!;
      const openedUrl = 'http://127.0.0.1:58627/sessions/ses-1#token=tok-1';
      (tui as { exitOpenUrl?: string }).exitOpenUrl = openedUrl;

      await expect((tui as { onExit: () => Promise<void> }).onExit()).rejects.toBeInstanceOf(
        ExitCalled,
      );

      expect(stderr.text()).toContain(' To resume this session: kimi -r ses-1');
      expect(stderr.text()).toContain('open ');
      expect(stderr.text()).toContain(openedUrl);
    } finally {
      exitSpy.mockRestore();
      stdout.restore();
      stderr.restore();
    }
  });

  it('surfaces an invalid target config as an error, not silently', async () => {
    mocks.loadTuiConfig.mockResolvedValue({
      theme: 'dark',
      editorCommand: null,
      notifications: { enabled: true, condition: 'unfocused' },
    });
    mocks.harnessGetConfig.mockRejectedValue(
      new Error('Invalid configuration in ~/.kimi-code/config.toml'),
    );

    // A broken config.toml must fail loudly — startup must not swallow it and
    // proceed, or the user never learns their config is broken.
    await expect(
      runShell(
        {
          session: undefined,
          continue: false,
          yolo: false,
          auto: false,
          plan: false,
          model: undefined,
          outputFormat: undefined,
          prompt: undefined,
          skillsDirs: [],
          agent: undefined,
          agentFiles: [],
        },
        '1.2.3-test',
      ),
    ).rejects.toThrow('Invalid configuration');
    expect(mocks.tuiStart).not.toHaveBeenCalled();
  });
});
