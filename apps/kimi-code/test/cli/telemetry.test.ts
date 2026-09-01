/**
 * Tests for the CLI telemetry bootstrap helpers, focusing on the
 * `kimi web` / `kimi server run` host wiring added in `cli/telemetry.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initializeTelemetry: vi.fn(),
  createKimiDeviceId: vi.fn(() => 'device-123'),
  resolveKimiHome: vi.fn(() => '/home/.kimi-code'),
  resolveConfigPath: vi.fn(() => '/home/.kimi-code/config.toml'),
  loadRuntimeConfigSafe: vi.fn(
    (
      _configPath: string,
    ): {
      config: { defaultModel?: string; telemetry?: boolean };
      fileError: Error | undefined;
    } => ({
      config: { defaultModel: 'kimi-k2', telemetry: true },
      fileError: undefined,
    }),
  ),
  getCachedAccessToken: vi.fn(async () => 'tok'),
}));

vi.mock('@moonshot-ai/kimi-telemetry', () => ({
  initializeTelemetry: mocks.initializeTelemetry,
  setTelemetryContext: vi.fn(),
  shouldEnableTelemetry: ({ enabled }: { enabled?: boolean }) => enabled === true,
  track: vi.fn(),
  withTelemetryContext: vi.fn(),
}));

vi.mock('@moonshot-ai/kimi-code-oauth', async (importOriginal) => {
  // Spread the real module: the SDK's v2 client pulls agent-core-v2 into the
  // import graph, which subclasses KimiOAuthToolkit from this package.
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-oauth')>();
  return {
    ...actual,
    createKimiDeviceId: mocks.createKimiDeviceId,
    KIMI_CODE_PROVIDER_NAME: 'managed:kimi-code',
  };
});

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    resolveKimiHome: mocks.resolveKimiHome,
    resolveConfigPath: mocks.resolveConfigPath,
    loadRuntimeConfigSafe: mocks.loadRuntimeConfigSafe,
    KimiAuthFacade: vi.fn(function () {
      return { getCachedAccessToken: mocks.getCachedAccessToken };
    }),
  };
});

describe('initializeCliTelemetry', () => {
  it('passes false when the config toggle is omitted', async () => {
    mocks.initializeTelemetry.mockClear();
    const { initializeCliTelemetry } = await import('#/cli/telemetry');

    initializeCliTelemetry({
      harness: {
        homeDir: '/home/.kimi-code',
        auth: { getCachedAccessToken: mocks.getCachedAccessToken },
        track: vi.fn(),
      },
      bootstrap: {
        homeDir: '/home/.kimi-code',
        deviceId: 'device-123',
        firstLaunch: false,
      },
      config: {},
      version: '1.2.3',
      uiMode: 'shell',
    } as never);

    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  }, 20000);
});

describe('initializeServerTelemetry', () => {
  beforeEach(() => {
    mocks.initializeTelemetry.mockClear();
    mocks.resolveConfigPath.mockClear();
    mocks.resolveConfigPath.mockReturnValue('/home/.kimi-code/config.toml');
    mocks.loadRuntimeConfigSafe.mockClear();
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      config: { defaultModel: 'kimi-k2', telemetry: true },
      fileError: undefined,
    });
  });

  it('configures cloud telemetry after config.toml explicitly opts in', async () => {
    const { initializeServerTelemetry } = await import('#/cli/telemetry');
    const client = initializeServerTelemetry({ version: '1.2.3' });
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: 'kimi-code-cli',
        version: '1.2.3',
        uiMode: 'web',
        model: 'kimi-k2',
        enabled: true,
        deviceId: 'device-123',
        homeDir: '/home/.kimi-code',
      }),
    );
    expect(client).toEqual(
      expect.objectContaining({
        track: expect.any(Function),
        withContext: expect.any(Function),
        setContext: expect.any(Function),
        cloudEnabled: true,
      }),
    );
  }, 20000);

  it('uses an injected telemetry opt-in for both the host sink and engine gate', async () => {
    const injectedConfigPath = '/injected/config.toml';
    mocks.loadRuntimeConfigSafe.mockImplementation((configPath) => ({
      config:
        configPath === injectedConfigPath
          ? { defaultModel: 'injected-model', telemetry: true }
          : { defaultModel: 'home-model' },
      fileError: undefined,
    }));
    const { initializeServerTelemetry } = await import('#/cli/telemetry');

    const client = initializeServerTelemetry({
      version: '1.2.3',
      configPath: injectedConfigPath,
    });

    expect(mocks.resolveConfigPath).not.toHaveBeenCalled();
    expect(mocks.loadRuntimeConfigSafe).toHaveBeenCalledWith(injectedConfigPath);
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, model: 'injected-model' }),
    );
    expect(client.cloudEnabled).toBe(true);
  });

  it('uses the injected config when home and effective telemetry values differ', async () => {
    const injectedConfigPath = '/injected/config.toml';
    mocks.loadRuntimeConfigSafe.mockImplementation((configPath) => ({
      config:
        configPath === injectedConfigPath
          ? { defaultModel: 'injected-model', telemetry: false }
          : { defaultModel: 'home-model', telemetry: true },
      fileError: undefined,
    }));
    const { initializeServerTelemetry } = await import('#/cli/telemetry');

    const client = initializeServerTelemetry({
      version: '1.2.3',
      configPath: injectedConfigPath,
    });

    expect(mocks.loadRuntimeConfigSafe).toHaveBeenCalledWith(injectedConfigPath);
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, model: 'injected-model' }),
    );
    expect(client.cloudEnabled).toBe(false);
  });

  it('disables cloud telemetry when the config toggle is omitted', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      config: { defaultModel: 'kimi-k2' },
      fileError: undefined,
    });
    const { initializeServerTelemetry } = await import('#/cli/telemetry');
    const client = initializeServerTelemetry({ version: '1.2.3' });

    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(client.cloudEnabled).toBe(false);
  });

  it('disables cloud telemetry when config.toml sets telemetry = false', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      config: { defaultModel: 'kimi-k2', telemetry: false },
      fileError: undefined,
    });
    const { initializeServerTelemetry } = await import('#/cli/telemetry');
    const client = initializeServerTelemetry({ version: '1.2.3' });

    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(client.cloudEnabled).toBe(false);
  });

  it('keeps cloud telemetry disabled when config is unreadable', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      config: {},
      fileError: new Error('bad toml'),
    });
    const { initializeServerTelemetry } = await import('#/cli/telemetry');
    const client = initializeServerTelemetry({ version: '1.2.3' });

    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, model: undefined }),
    );
    expect(client.cloudEnabled).toBe(false);
  });
});
