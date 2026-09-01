import { createKimiDeviceId, KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';
import {
  KimiAuthFacade,
  loadRuntimeConfigSafe,
  resolveConfigPath,
  resolveKimiHome,
  type KimiConfig,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';

import type { PromptHarness } from './prompt-session';
import {
  initializeTelemetry,
  setTelemetryContext,
  shouldEnableTelemetry,
  track,
  withTelemetryContext,
} from '@moonshot-ai/kimi-telemetry';

import { CLI_USER_AGENT_PRODUCT, WEB_UI_MODE } from '#/constant/app';
import { currentKimiProfile } from '#/utils/region';

import { createKimiCodeHostIdentity } from './version';

export interface CliTelemetryBootstrap {
  readonly homeDir: string;
  readonly deviceId: string;
  readonly firstLaunch: boolean;
}

export interface InitializeCliTelemetryOptions {
  readonly harness: PromptHarness;
  readonly bootstrap: CliTelemetryBootstrap;
  readonly config: Pick<KimiConfig, 'defaultModel' | 'telemetry'>;
  readonly version: string;
  readonly uiMode: string;
  readonly model?: string;
  readonly sessionId?: string;
}

export function createCliTelemetryBootstrap(): CliTelemetryBootstrap {
  let firstLaunch = false;
  const homeDir = resolveKimiHome();
  const deviceId = createKimiDeviceId(homeDir, {
    onFirstLaunch: () => {
      firstLaunch = true;
    },
  });
  return { homeDir, deviceId, firstLaunch };
}

export function initializeCliTelemetry(options: InitializeCliTelemetryOptions): void {
  initializeTelemetry({
    homeDir: options.harness.homeDir,
    deviceId: options.bootstrap.deviceId,
    enabled: options.config.telemetry === true,
    appName: CLI_USER_AGENT_PRODUCT,
    version: options.version,
    uiMode: options.uiMode,
    model: options.model ?? options.config.defaultModel,
    sessionId: options.sessionId,
    endpoint: () => currentKimiProfile().telemetryEndpoint,
    getAccessToken: async () =>
      (await options.harness.auth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME)) ?? null,
  });
  if (options.bootstrap.firstLaunch) {
    options.harness.track('first_launch');
  }
}

export interface InitializeServerTelemetryOptions {
  readonly version: string;
  readonly configPath?: string;
}

export interface ServerTelemetryClient extends TelemetryClient {
  readonly cloudEnabled: boolean;
}

/**
 * Bootstrap telemetry for the `kimi web` host.
 *
 * Mirrors {@link initializeCliTelemetry}: mints the device id, reads config to
 * honor the `telemetry` toggle and pick up the default model, and attaches the
 * sink with `ui_mode = "web"` when cloud telemetry is explicitly enabled. The
 * returned client shares the module-level sink, while `cloudEnabled` gates the
 * kap-server cloud appender for the same host process.
 */
export function initializeServerTelemetry(
  options: InitializeServerTelemetryOptions,
): ServerTelemetryClient {
  const bootstrap = createCliTelemetryBootstrap();
  const configPath = options.configPath ?? resolveConfigPath({ homeDir: bootstrap.homeDir });
  const config = readServerTelemetryConfig(configPath);
  const cloudEnabled = shouldEnableTelemetry({ enabled: config.telemetry === true });
  const auth = new KimiAuthFacade({
    homeDir: bootstrap.homeDir,
    configPath,
    identity: createKimiCodeHostIdentity(options.version),
  });

  initializeTelemetry({
    homeDir: bootstrap.homeDir,
    deviceId: bootstrap.deviceId,
    enabled: cloudEnabled,
    appName: CLI_USER_AGENT_PRODUCT,
    version: options.version,
    uiMode: WEB_UI_MODE,
    model: config.defaultModel,
    endpoint: () => currentKimiProfile().telemetryEndpoint,
    getAccessToken: async () => (await auth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME)) ?? null,
  });

  return {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
    cloudEnabled,
  };
}

function readServerTelemetryConfig(
  configPath: string,
): Pick<KimiConfig, 'telemetry' | 'defaultModel'> {
  try {
    const { config, fileError } = loadRuntimeConfigSafe(configPath);
    // A broken config fails the server on its own inside KimiCore; telemetry
    // stays disabled here so config errors never trigger cloud traffic.
    if (fileError !== undefined) return {};
    return config;
  } catch {
    return {};
  }
}
