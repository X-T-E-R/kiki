/**
 * Registry and token lifecycle for the account sign-in methods that are not
 * Kimi Code. Each method keeps its own token file under the shared
 * credentials directory and runs through the same {@link OAuthManager}
 * (cross-process lock, refresh coalescing, revoked tombstones) as Kimi Code;
 * only the three HTTP hooks differ.
 */

import { join } from 'node:path';

import { createGitHubCopilotMethod, GITHUB_COPILOT_METHOD } from './github-copilot';
import { resolveKikiHome } from './home';
import { OAuthManager, type LoginOptions, type OAuthManagerOptions } from './oauth-manager';
import type { OAuthDeviceMethod, OAuthMethodDescriptor, OAuthMethodId } from './oauth-method-types';
import { createOpenAICodexMethod, OPENAI_CODEX_METHOD } from './openai-codex';
import { FileTokenStorage, type TokenStorage } from './storage';
import type { BearerTokenProvider } from './toolkit';

export const KIMI_CODE_METHOD: OAuthMethodDescriptor = {
  id: 'kimi-code',
  label: 'Kimi Code',
  providerName: 'managed:kimi-code',
  protocol: 'openai',
  defaultBaseUrl: 'https://api.kimi.com/coding/v1',
  oauthKey: 'oauth/kimi-code',
  aliasPrefix: 'kimi-code',
};

/** Every sign-in method Kiki offers, in presentation order. */
export const OAUTH_METHODS: readonly OAuthMethodDescriptor[] = [
  KIMI_CODE_METHOD,
  GITHUB_COPILOT_METHOD,
  OPENAI_CODEX_METHOD,
];

const DEVICE_METHOD_FACTORIES: Readonly<Partial<Record<OAuthMethodId, (fetchImpl: typeof fetch) => OAuthDeviceMethod>>> = {
  'github-copilot': createGitHubCopilotMethod,
  'openai-codex': createOpenAICodexMethod,
};

export function oauthMethodById(id: string): OAuthMethodDescriptor | undefined {
  return OAUTH_METHODS.find((method) => method.id === id);
}

/** Resolve a method from its id or from the provider id it provisions. */
export function oauthMethodFor(idOrProvider: string): OAuthMethodDescriptor | undefined {
  return OAUTH_METHODS.find(
    (method) => method.id === idOrProvider || method.providerName === idOrProvider,
  );
}

/** True for methods implemented by a device-flow port (every method but Kimi Code). */
export function isDeviceOAuthMethod(idOrProvider: string): boolean {
  const method = oauthMethodFor(idOrProvider);
  return method !== undefined && DEVICE_METHOD_FACTORIES[method.id] !== undefined;
}

export function createOAuthDeviceMethod(
  idOrProvider: string,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): OAuthDeviceMethod | undefined {
  const method = oauthMethodFor(idOrProvider);
  if (method === undefined) return undefined;
  return DEVICE_METHOD_FACTORIES[method.id]?.(fetchImpl);
}

function storageNameFor(method: OAuthMethodDescriptor): string {
  return method.oauthKey.startsWith('oauth/') ? method.oauthKey.slice('oauth/'.length) : method.oauthKey;
}

export interface OAuthDeviceMethodsOptions {
  readonly homeDir?: string | undefined;
  readonly credentialsDir?: string | undefined;
  readonly storage?: TokenStorage | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: OAuthManagerOptions['now'];
  readonly sleep?: OAuthManagerOptions['sleep'];
  readonly deviceCodeTimeoutMs?: number | undefined;
  readonly disableCrossProcessLock?: boolean | undefined;
}

/** Token lifecycle for the device-flow methods, one manager per method. */
export class OAuthDeviceMethods {
  private readonly homeDir: string;
  private readonly storage: TokenStorage;
  private readonly options: OAuthDeviceMethodsOptions;
  private readonly managers = new Map<OAuthMethodId, OAuthManager>();
  private readonly methods = new Map<OAuthMethodId, OAuthDeviceMethod>();

  constructor(options: OAuthDeviceMethodsOptions = {}) {
    this.options = options;
    this.homeDir = options.homeDir ?? resolveKikiHome();
    this.storage =
      options.storage ?? new FileTokenStorage(options.credentialsDir ?? join(this.homeDir, 'credentials'));
  }

  method(idOrProvider: string): OAuthDeviceMethod {
    const descriptor = oauthMethodFor(idOrProvider);
    if (descriptor === undefined) throw new Error(`Unknown sign-in method "${idOrProvider}".`);
    let method = this.methods.get(descriptor.id);
    if (method === undefined) {
      method = createOAuthDeviceMethod(descriptor.id, this.options.fetchImpl);
      if (method === undefined) throw new Error(`"${descriptor.label}" has no device sign-in flow.`);
      this.methods.set(descriptor.id, method);
    }
    return method;
  }

  private manager(idOrProvider: string): OAuthManager {
    const method = this.method(idOrProvider);
    let manager = this.managers.get(method.id);
    if (manager !== undefined) return manager;
    manager = new OAuthManager({
      config: { name: storageNameFor(method), oauthHost: method.defaultBaseUrl, clientId: method.id },
      storage: this.storage,
      configDir: this.homeDir,
      now: this.options.now,
      sleep: this.options.sleep,
      deviceCodeTimeoutMs: this.options.deviceCodeTimeoutMs,
      disableCrossProcessLock: this.options.disableCrossProcessLock,
      requestDeviceImpl: () => method.requestDevice(),
      pollDeviceImpl: (_config, deviceCode) => method.pollDevice(deviceCode),
      refreshTokenImpl: (_config, refreshToken) => method.refresh(refreshToken),
    });
    this.managers.set(method.id, manager);
    return manager;
  }

  /** Reuse a still-valid token, otherwise run the device flow. Returns the access token. */
  async login(idOrProvider: string, options: LoginOptions = {}): Promise<string> {
    const manager = this.manager(idOrProvider);
    if (await manager.hasToken()) {
      try {
        return await manager.ensureFresh();
      } catch {
        // Fall through to a fresh device flow when the stored token is dead.
      }
    }
    return (await manager.login(options)).accessToken;
  }

  logout(idOrProvider: string): Promise<void> {
    return this.manager(idOrProvider).logout();
  }

  getCachedAccessToken(idOrProvider: string): Promise<string | undefined> {
    return this.manager(idOrProvider).getCachedAccessToken();
  }

  tokenProvider(idOrProvider: string): BearerTokenProvider {
    return {
      getAccessToken: (options) =>
        this.manager(idOrProvider).ensureFresh({ force: options?.force === true }),
    };
  }
}
